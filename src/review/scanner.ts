/**
 * Scanner Module - Parallel Multi-LLM Code Review
 * v0.4 - Role-specialized scanners, PR context passthrough, deterministic
 * NO_FINDINGS skip detection
 */

import type { OpenRouterConfig, ChatMessage } from '../openrouter/client.js';
import { callOpenRouter } from '../openrouter/client.js';
import type { ScannerRole } from './prompts.js';
import { buildScannerSystemPrompt, buildScannerUserPrompt } from './prompts.js';
import { logger } from '../utils/logger.js';

export type ScannerStatus = 'OK' | 'SKIPPED' | 'FAILED';

export interface ScannerResult {
  model: string;
  role: ScannerRole;
  output: string;
  tokensUsed: number;
  durationMs: number;
  success: boolean;
  status: ScannerStatus;
  error?: string | undefined;
}

export interface ScannerConfig {
  openrouter: OpenRouterConfig;
  models: string[];
  maxTokens: number;
  language: string;
  /**
   * Scanner roles, index-aligned with `models`. Resolution/validation is the
   * config layer's responsibility — the scanner only consumes the array. When
   * absent (or shorter than `models`), missing entries default to 'general'.
   */
  roles?: ScannerRole[];
  /** PR title/body context forwarded to the scanner user prompt. Default ''. */
  prContext?: string;
}

/**
 * Run a single scanner
 */
async function runSingleScanner(
  config: ScannerConfig,
  model: string,
  role: ScannerRole,
  diff: string
): Promise<ScannerResult> {
  const start = performance.now();

  logger.info(`Scanner started: ${model}`, { role });

  try {
    const messages: ChatMessage[] = [
      { role: 'system', content: buildScannerSystemPrompt(config.language, role) },
      { role: 'user', content: buildScannerUserPrompt(diff, config.prContext ?? '') },
    ];

    const { content, tokensUsed } = await callOpenRouter(
      config.openrouter,
      model,
      messages,
      config.maxTokens,
      0.3
    );

    const durationMs = Math.round(performance.now() - start);

    logger.info(`Scanner finished: ${model}`, {
      role,
      tokensUsed,
      durationMs,
      outputLength: content.length,
    });

    // Determine status (v0.4 deterministic rule): SKIPPED only when the
    // trimmed output is empty or is exactly the 'NO_FINDINGS' sentinel — the
    // scanner system prompt mandates outputting exactly NO_FINDINGS when
    // there is nothing to report. Any other output counts as OK.
    const trimmed = content.trim();
    const status: ScannerStatus =
      trimmed.length === 0 || trimmed === 'NO_FINDINGS' ? 'SKIPPED' : 'OK';

    return {
      model,
      role,
      output: content,
      tokensUsed,
      durationMs,
      success: true,
      status,
    };
  } catch (error) {
    const durationMs = Math.round(performance.now() - start);
    const errorMessage = error instanceof Error ? error.message : String(error);

    logger.error(`Scanner failed: ${model}`, { role, error: errorMessage, durationMs });

    return {
      model,
      role,
      output: '',
      tokensUsed: 0,
      durationMs,
      success: false,
      status: 'FAILED' as ScannerStatus,
      error: errorMessage,
    };
  }
}

/**
 * Run all scanners in parallel
 * IMPORTANT: Scanners never see each other's output
 */
export async function runScanners(
  config: ScannerConfig,
  diff: string
): Promise<ScannerResult[]> {
  // Map each model to its role (index-aligned; missing entries → 'general')
  const assignments: { model: string; role: ScannerRole }[] = config.models.map(
    (model, index) => ({ model, role: config.roles?.[index] ?? 'general' })
  );

  logger.info('Starting parallel scanners', {
    assignments: assignments.map(({ model, role }) => `${model} -> ${role}`),
    diffLength: diff.length,
    language: config.language,
  });

  // Run all scanners in parallel
  const results = await Promise.all(
    assignments.map(({ model, role }) => runSingleScanner(config, model, role, diff))
  );

  // Log summary
  const successful = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;
  const totalTokens = results.reduce((sum, r) => sum + r.tokensUsed, 0);
  const maxDuration = Math.max(...results.map((r) => r.durationMs));

  logger.info('All scanners completed', {
    successful,
    failed,
    totalTokens,
    maxDurationMs: maxDuration,
  });

  return results;
}
