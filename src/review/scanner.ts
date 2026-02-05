/**
 * Scanner Module - Parallel Multi-LLM Code Review
 */

import type { ScannerResult, ReviewConfig } from './types.js';
import { callOpenRouter } from '../openrouter/client.js';
import type { OutputLanguage } from './prompts.js';
import { buildScannerPrompt, SCANNER_SYSTEM_PROMPT, truncateDiff } from './prompts.js';
import { allSettled } from '../utils/concurrency.js';
import { logger } from '../utils/logger.js';

/**
 * Run a single scanner
 */
async function runSingleScanner(
  model: string,
  diff: string,
  config: ReviewConfig,
  language: OutputLanguage = 'en'
): Promise<ScannerResult> {
  const start = performance.now();

  try {
    const prompt = buildScannerPrompt(diff, language);

    const { content, tokensUsed } = await callOpenRouter(model, prompt, {
      systemPrompt: SCANNER_SYSTEM_PROMPT,
      maxTokens: config.maxScannerTokens,
      temperature: config.scannerTemperature,
    });

    return {
      model,
      findings: [], // Will be parsed by judge
      rawResponse: content,
      tokensUsed,
      durationMs: Math.round(performance.now() - start),
      success: true,
    };
  } catch (error) {
    logger.error(`Scanner failed: ${model}`, { error: String(error) });

    return {
      model,
      findings: [],
      rawResponse: '',
      tokensUsed: 0,
      durationMs: Math.round(performance.now() - start),
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Run all scanners in parallel
 * IMPORTANT: Scanners never see each other's output
 */
export async function runScanners(
  diff: string,
  config: ReviewConfig,
  language: OutputLanguage = 'en'
): Promise<ScannerResult[]> {
  const truncatedDiff = truncateDiff(diff);

  logger.info('Starting parallel scanners', {
    models: config.scannerModels,
    diffLength: diff.length,
    truncatedLength: truncatedDiff.length,
    language,
  });

  const results = await allSettled(config.scannerModels, (model) =>
    runSingleScanner(model, truncatedDiff, config, language)
  );

  // Extract results
  const scannerResults = results
    .filter((r) => r.success && r.result)
    .map((r) => r.result as ScannerResult);

  // Log summary
  const successful = scannerResults.filter((r) => r.success).length;
  const failed = scannerResults.filter((r) => !r.success).length;
  const totalTokens = scannerResults.reduce((sum, r) => sum + r.tokensUsed, 0);
  const totalDuration = Math.max(...scannerResults.map((r) => r.durationMs));

  logger.info('Scanners completed', {
    successful,
    failed,
    totalTokens,
    totalDurationMs: totalDuration,
  });

  return scannerResults;
}

/**
 * Run scanners with automatic model selection based on PR size
 */
export async function runScannersWithAutoConfig(
  diff: string,
  models: string[],
  options: Partial<ReviewConfig> = {},
  language: OutputLanguage = 'en'
): Promise<ScannerResult[]> {
  const config: ReviewConfig = {
    scannerModels: models,
    judgeModel: 'claude-sonnet-judge',
    maxScannerTokens: options.maxScannerTokens ?? 1000,
    maxJudgeTokens: options.maxJudgeTokens ?? 2000,
    scannerTemperature: options.scannerTemperature ?? 0.3,
    judgeTemperature: options.judgeTemperature ?? 0.2,
  };

  return runScanners(diff, config, language);
}
