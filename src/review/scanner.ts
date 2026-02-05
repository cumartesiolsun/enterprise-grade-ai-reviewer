/**
 * Scanner Module - Parallel Multi-LLM Code Review
 * MVP v0.1 - Configurable models, parallel execution
 */

import type { OpenRouterConfig, ChatMessage } from '../openrouter/client.js';
import { callOpenRouter } from '../openrouter/client.js';
import { logger } from '../utils/logger.js';

export interface ScannerResult {
  model: string;
  output: string;
  tokensUsed: number;
  durationMs: number;
  success: boolean;
  error?: string | undefined;
}

export interface ScannerConfig {
  openrouter: OpenRouterConfig;
  models: string[];
  maxTokens: number;
  language: string;
}

/**
 * Get language instruction for system prompt
 */
function getLanguageInstruction(language: string): string {
  const lang = language.toLowerCase();

  if (lang === 'turkish' || lang === 'tr') {
    return 'You MUST respond in Turkish. Tüm çıktılarınız Türkçe olmalıdır.';
  }

  if (lang === 'english' || lang === 'en') {
    return 'You MUST respond in English.';
  }

  return `You MUST respond in ${language}.`;
}

/**
 * Build scanner system prompt (language-aware)
 */
function buildSystemPrompt(language: string): string {
  const languageInstruction = getLanguageInstruction(language);

  return `You are an expert code reviewer. Analyze the provided code diff and identify:

1. **Security Issues**: SQL injection, XSS, authentication flaws, secrets exposure
2. **Bugs**: Logic errors, null pointer exceptions, race conditions
3. **Performance**: N+1 queries, memory leaks, inefficient algorithms
4. **Code Quality**: DRY violations, complexity issues, naming conventions

${languageInstruction}

Provide a concise but thorough review. Focus on actionable issues.
Do NOT include any JSON formatting. Output plain text only.`;
}

/**
 * Build scanner user prompt
 */
function buildUserPrompt(diff: string): string {
  return `Review the following code diff:

\`\`\`diff
${diff}
\`\`\`

Provide your code review focusing on security, bugs, performance, and code quality issues.`;
}

/**
 * Run a single scanner
 */
async function runSingleScanner(
  config: ScannerConfig,
  model: string,
  diff: string
): Promise<ScannerResult> {
  const start = performance.now();

  try {
    const messages: ChatMessage[] = [
      { role: 'system', content: buildSystemPrompt(config.language) },
      { role: 'user', content: buildUserPrompt(diff) },
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
      tokensUsed,
      durationMs,
      outputLength: content.length,
    });

    return {
      model,
      output: content,
      tokensUsed,
      durationMs,
      success: true,
    };
  } catch (error) {
    const durationMs = Math.round(performance.now() - start);
    const errorMessage = error instanceof Error ? error.message : String(error);

    logger.error(`Scanner failed: ${model}`, { error: errorMessage, durationMs });

    return {
      model,
      output: '',
      tokensUsed: 0,
      durationMs,
      success: false,
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
  logger.info('Starting parallel scanners', {
    models: config.models,
    diffLength: diff.length,
    language: config.language,
  });

  // Run all scanners in parallel
  const results = await Promise.all(
    config.models.map((model) => runSingleScanner(config, model, diff))
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
