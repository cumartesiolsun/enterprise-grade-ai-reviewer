/**
 * Judge Module - Aggregation and Merge Logic
 * Supports summary (free-form) and inline (structured JSON) review modes
 */

import type { OpenRouterConfig, ChatMessage } from '../openrouter/client.js';
import { callOpenRouter } from '../openrouter/client.js';
import type { ScannerResult } from './scanner.js';
import {
  buildJudgeSystemPrompt,
  buildJudgeUserPrompt,
  buildJudgeSystemPromptInline,
  buildJudgeUserPromptInline,
} from './prompts.js';
import { logger } from '../utils/logger.js';

export type ReviewMode = 'summary' | 'inline';

export interface InlineFinding {
  file: string;
  line: number;
  severity: 'critical' | 'warning' | 'info';
  title: string;
  body: string;
  sources?: string[] | undefined;
}

export interface JudgeConfig {
  openrouter: OpenRouterConfig;
  model: string;
  maxTokens: number;
  language: string;
  reviewMode: ReviewMode;
  /** PR title/body context forwarded to the judge prompts (default ''). */
  prContext?: string | undefined;
}

export interface JudgeResult {
  output: string;
  tokensUsed: number;
  durationMs: number;
  success: boolean;
  error?: string | undefined;
  findings?: InlineFinding[] | undefined;
}

/**
 * Appended to the judge output when the model stopped at the max-tokens-judge
 * limit (finish_reason=length): a truncated review must never read as a
 * complete one in the posted comment.
 */
export const TRUNCATION_MARKER =
  '\n\n---\n⚠️ **[TRUNCATED]** — the judge hit its `max-tokens-judge` limit' +
  ' (`finish_reason=length`); this review is incomplete. Raise `max-tokens-judge` and re-run.';

/** Maximum number of inline findings posted to a PR. */
const MAX_FINDINGS = 30;
/** Maximum length of a finding title (including the ellipsis when truncated). */
const MAX_TITLE_LENGTH = 300;
/** Maximum length of a finding body (including the ellipsis when truncated). */
const MAX_BODY_LENGTH = 4000;

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

/**
 * Attempt to parse the judge's JSON output into InlineFinding[].
 * Returns undefined if parsing fails (caller falls back to summary).
 */
function extractJsonArray(content: string): string | undefined {
  const trimmed = content.trim();

  // 1. Try as-is (pure JSON). Requires a closing bracket too — otherwise the
  // model appended trailing prose and we must fall through to extraction.
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed;
  }

  // 2. Strip markdown code fences
  const fenceRegex = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/;
  const fenceMatch = fenceRegex.exec(trimmed);
  if (fenceMatch?.[1]?.trim().startsWith('[')) {
    return fenceMatch[1].trim();
  }

  // 3. Extract JSON array from mixed prose + JSON content
  const firstBracket = trimmed.indexOf('[');
  const lastBracket = trimmed.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    return trimmed.slice(firstBracket, lastBracket + 1);
  }

  return undefined;
}

function parseSources(
  rec: Record<string, unknown>,
  validModels: readonly string[]
): string[] | undefined {
  if (!Array.isArray(rec['sources'])) return undefined;
  // Whitelist: sources come from model output (ultimately attacker-influenced
  // via the diff), so only keep names of scanners that actually ran.
  const filtered = (rec['sources'] as unknown[]).filter(
    (s): s is string => typeof s === 'string' && validModels.includes(s)
  );
  return filtered.length > 0 ? filtered : undefined;
}

function validateFindingItem(
  item: unknown,
  validModels: readonly string[]
): InlineFinding | undefined {
  if (typeof item !== 'object' || item === null) return undefined;

  const required = ['file', 'line', 'severity', 'title', 'body'] as const;
  if (!required.every((key) => key in item)) return undefined;

  const rec = item as Record<string, unknown>;
  const severity = rec['severity'];

  if (
    typeof rec['file'] !== 'string' ||
    typeof rec['line'] !== 'number' ||
    typeof rec['title'] !== 'string' ||
    typeof rec['body'] !== 'string' ||
    (severity !== 'critical' && severity !== 'warning' && severity !== 'info')
  ) {
    return undefined;
  }

  const sources = parseSources(rec, validModels);

  return {
    file: rec['file'],
    line: rec['line'],
    severity,
    title: truncate(rec['title'], MAX_TITLE_LENGTH),
    body: truncate(rec['body'], MAX_BODY_LENGTH),
    ...(sources ? { sources } : {}),
  };
}

function parseInlineFindings(
  content: string,
  validModels: readonly string[]
): InlineFinding[] | undefined {
  try {
    const jsonStr = extractJsonArray(content);

    if (!jsonStr) {
      logger.warn('Could not extract JSON array from judge inline output');
      return undefined;
    }

    const parsed = JSON.parse(jsonStr) as unknown;

    if (!Array.isArray(parsed)) {
      logger.warn('Judge inline output is not an array, falling back to summary');
      return undefined;
    }

    const findings: InlineFinding[] = [];

    for (const item of parsed) {
      const finding = validateFindingItem(item, validModels);
      if (finding) {
        findings.push(finding);
      } else {
        logger.warn('Skipping invalid finding item', { item });
      }
    }

    // The judge produced findings but none survived validation. Returning []
    // here would post a false "LGTM" all-clear — fall back to summary instead.
    if (parsed.length > 0 && findings.length === 0) {
      logger.warn('All parsed finding items were invalid, falling back to summary', {
        itemCount: parsed.length,
      });
      return undefined;
    }

    if (findings.length > MAX_FINDINGS) {
      logger.warn('Capping inline findings', {
        total: findings.length,
        kept: MAX_FINDINGS,
        dropped: findings.length - MAX_FINDINGS,
      });
      return findings.slice(0, MAX_FINDINGS);
    }

    return findings;
  } catch (error) {
    logger.warn('Failed to parse judge inline output as JSON', {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/**
 * Run the judge to merge scanner outputs
 */
export async function runJudge(
  config: JudgeConfig,
  scannerResults: ScannerResult[],
  diff: string
): Promise<JudgeResult> {
  const start = performance.now();

  const successfulScanners = scannerResults.filter((r) => r.success);

  logger.info('Starting judge aggregation', {
    judgeModel: config.model,
    scannersToMerge: successfulScanners.length,
    language: config.language,
    reviewMode: config.reviewMode,
  });

  if (successfulScanners.length === 0) {
    logger.error('No successful scanner results to judge');
    return {
      output: 'Review could not be completed - all scanners failed.',
      tokensUsed: 0,
      durationMs: Math.round(performance.now() - start),
      success: false,
      error: 'No successful scanner results',
    };
  }

  try {
    // Select prompts based on review mode
    const systemPrompt = config.reviewMode === 'inline'
      ? buildJudgeSystemPromptInline(config.language)
      : buildJudgeSystemPrompt(config.language);

    const prContext = config.prContext ?? '';
    const userPrompt = config.reviewMode === 'inline'
      ? buildJudgeUserPromptInline(scannerResults, diff, prContext)
      : buildJudgeUserPrompt(scannerResults, diff, prContext);

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];

    const { content, tokensUsed, finishReason } = await callOpenRouter(
      config.openrouter,
      config.model,
      messages,
      config.maxTokens,
      0.2
    );

    const durationMs = Math.round(performance.now() - start);
    const truncated = finishReason === 'length';

    logger.info('Judge finished', {
      tokensUsed,
      durationMs,
      outputLength: content.length,
      finishReason,
    });

    // Parse findings for inline mode
    let findings: InlineFinding[] | undefined;
    if (config.reviewMode === 'inline') {
      if (truncated) {
        // A truncated JSON array can still parse (bracket extraction) and would
        // post a findings list that silently pretends to be complete — fall back
        // to the summary path, which carries the visible marker.
        logger.warn('Judge output truncated — skipping inline findings parse');
      } else {
        const validModels = successfulScanners.map((r) => r.model);
        findings = parseInlineFindings(content, validModels);
        logger.info('Inline findings parsed', {
          findingsCount: findings?.length ?? 0,
          parsedSuccessfully: findings !== undefined,
        });
      }
    }

    return {
      output: truncated ? content + TRUNCATION_MARKER : content,
      tokensUsed,
      durationMs,
      success: true,
      findings,
    };
  } catch (error) {
    const durationMs = Math.round(performance.now() - start);
    const errorMessage = error instanceof Error ? error.message : String(error);

    logger.error('Judge failed', { error: errorMessage, durationMs });

    return {
      output: `Review aggregation failed: ${errorMessage}`,
      tokensUsed: 0,
      durationMs,
      success: false,
      error: errorMessage,
    };
  }
}
