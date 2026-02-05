/**
 * Enterprise-Grade AI Reviewer
 * MVP v0.1 - GitHub Action Entry Point
 */

import { normalizeDiff, getConfigFromEnv } from './github/diff.js';
import type { GitHubConfig } from './github/diff.js';
import { postOrUpdateComment } from './github/comments.js';
import { runScanners } from './review/scanner.js';
import type { ScannerConfig } from './review/scanner.js';
import { runJudge } from './review/judge.js';
import type { JudgeConfig } from './review/judge.js';
import type { OpenRouterConfig } from './openrouter/client.js';
import { logger } from './utils/logger.js';

/**
 * Action inputs from environment
 */
interface ActionInputs {
  openrouterApiKey: string;
  githubToken: string;
  baseUrl: string;
  scannerModels: string[];
  judgeModel: string;
  language: string;
  autoSelectModels: boolean;
  maxFiles: number;
  maxChars: number;
  timeoutMs: number;
  maxTokensScanner: number;
  maxTokensJudge: number;
  commentMarker: string;
}

/**
 * Get action input with default (kebab-case input names)
 * GitHub Actions converts kebab-case to uppercase with underscores
 */
function getInput(name: string, defaultValue: string): string {
  // GitHub Actions: openrouter-api-key -> INPUT_OPENROUTER_API_KEY
  const envName = `INPUT_${name.toUpperCase().replaceAll('-', '_')}`;
  return process.env[envName] ?? defaultValue;
}

/**
 * Get required input (throws if missing)
 */
function getRequiredInput(name: string): string {
  const value = getInput(name, '');
  if (!value) {
    throw new Error(`Required input '${name}' is missing`);
  }
  return value;
}

/**
 * Parse scanner-models input (supports JSON array, multiline, or CSV)
 */
function parseScannerModels(input: string): string[] {
  const trimmed = input.trim();

  if (trimmed.length === 0) {
    return [];
  }

  // Try JSON array first
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) {
        return parsed
          .map((item) => String(item).trim())
          .filter((item) => item.length > 0);
      }
    } catch {
      // Not valid JSON, fall through to other methods
    }
  }

  // Try multiline (contains newlines)
  if (trimmed.includes('\n')) {
    return trimmed
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  // Fallback to CSV
  return trimmed
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * Parse action inputs from environment
 */
function parseInputs(): ActionInputs {
  const autoSelectModels = getInput('auto-select-models', 'false').toLowerCase() === 'true';
  const scannerModelsRaw = getInput('scanner-models', '');
  const scannerModels = parseScannerModels(scannerModelsRaw);
  const judgeModel = getInput('judge-model', '');

  // Validate scanner-models
  if (scannerModels.length === 0) {
    if (autoSelectModels) {
      // Auto-select not implemented in MVP
      throw new Error(
        'auto-select-models is not implemented in MVP. Please provide scanner-models explicitly.'
      );
    } else {
      throw new Error(
        "Required input 'scanner-models' is missing. Provide a list of models (CSV, multiline, or JSON array)."
      );
    }
  }

  // Validate judge-model
  if (!judgeModel) {
    throw new Error("Required input 'judge-model' is missing.");
  }

  return {
    openrouterApiKey: getRequiredInput('openrouter-api-key'),
    githubToken: getRequiredInput('github-token'),
    baseUrl: getInput('base-url', 'https://openrouter.ai/api/v1'),
    scannerModels,
    judgeModel,
    language: getInput('language', 'tr'),
    autoSelectModels,
    maxFiles: Number.parseInt(getInput('max-files', '10'), 10),
    maxChars: Number.parseInt(getInput('max-chars', '80000'), 10),
    timeoutMs: Number.parseInt(getInput('timeout-ms', '180000'), 10),
    maxTokensScanner: Number.parseInt(getInput('max-tokens-scanner', '600'), 10),
    maxTokensJudge: Number.parseInt(getInput('max-tokens-judge', '800'), 10),
    commentMarker: getInput('comment-marker', 'ENTERPRISE_AI_REVIEW'),
  };
}

/**
 * Main review function
 */
async function run(): Promise<void> {
  const startTime = performance.now();

  try {
    // Parse inputs
    const inputs = parseInputs();

    logger.info('Starting Enterprise AI Review', {
      scannerModels: inputs.scannerModels,
      judgeModel: inputs.judgeModel,
      language: inputs.language,
      maxFiles: inputs.maxFiles,
      maxChars: inputs.maxChars,
    });

    // Set up GitHub config from environment
    // Override token with action input
    process.env['GITHUB_TOKEN'] = inputs.githubToken;
    const githubConfig: GitHubConfig = getConfigFromEnv();

    logger.info('GitHub config loaded', {
      owner: githubConfig.owner,
      repo: githubConfig.repo,
      prNumber: githubConfig.prNumber,
    });

    // Set up OpenRouter config
    const openrouterConfig: OpenRouterConfig = {
      apiKey: inputs.openrouterApiKey,
      baseUrl: inputs.baseUrl,
      timeoutMs: inputs.timeoutMs,
    };

    // Step 1: Fetch and normalize diff
    const diff = await normalizeDiff(githubConfig, inputs.maxFiles, inputs.maxChars);

    logger.info('Diff fetched', {
      filesFound: diff.truncation.filesFound,
      filesReviewed: diff.truncation.filesReviewed,
      diffLength: diff.combinedDiff.length,
      wasTruncated: diff.truncation.wasTruncated,
    });

    if (diff.combinedDiff.length === 0) {
      logger.warn('No diff content to review');
      await postOrUpdateComment(
        githubConfig,
        {
          judgeOutput: 'No code changes detected in this PR.',
          scannerModels: [],
          truncation: diff.truncation,
        },
        inputs.commentMarker
      );
      return;
    }

    // Step 2: Run scanners in parallel
    const scannerConfig: ScannerConfig = {
      openrouter: openrouterConfig,
      models: inputs.scannerModels,
      maxTokens: inputs.maxTokensScanner,
      language: inputs.language,
    };

    const scannerResults = await runScanners(scannerConfig, diff.combinedDiff);

    const successfulScanners = scannerResults.filter((r) => r.success);
    const failedScanners = scannerResults.filter((r) => !r.success);

    logger.info('Scanners completed', {
      successful: successfulScanners.length,
      failed: failedScanners.length,
    });

    if (successfulScanners.length === 0) {
      logger.error('All scanners failed');
      await postOrUpdateComment(
        githubConfig,
        {
          judgeOutput: 'Review failed - all scanner models returned errors.',
          scannerModels: inputs.scannerModels,
          truncation: diff.truncation,
        },
        inputs.commentMarker
      );
      return;
    }

    // Step 3: Run judge to merge results
    const judgeConfig: JudgeConfig = {
      openrouter: openrouterConfig,
      model: inputs.judgeModel,
      maxTokens: inputs.maxTokensJudge,
      language: inputs.language,
    };

    const judgeResult = await runJudge(judgeConfig, scannerResults);

    logger.info('Judge completed', {
      success: judgeResult.success,
      tokensUsed: judgeResult.tokensUsed,
      durationMs: judgeResult.durationMs,
    });

    // Step 4: Post comment to GitHub
    await postOrUpdateComment(
      githubConfig,
      {
        judgeOutput: judgeResult.output,
        scannerModels: successfulScanners.map((r) => r.model),
        truncation: diff.truncation,
      },
      inputs.commentMarker
    );

    const totalDuration = Math.round(performance.now() - startTime);
    const totalTokens = scannerResults.reduce((sum, r) => sum + r.tokensUsed, 0) + judgeResult.tokensUsed;

    logger.info('Review completed successfully', {
      totalDurationMs: totalDuration,
      totalTokens,
      scannersUsed: successfulScanners.length,
    });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Review failed', { error: errorMessage });

    // Try to post error comment
    try {
      process.env['GITHUB_TOKEN'] = process.env['INPUT_GITHUB_TOKEN'];
      const githubConfig = getConfigFromEnv();
      const commentMarker = getInput('comment-marker', 'ENTERPRISE_AI_REVIEW');

      await postOrUpdateComment(
        githubConfig,
        {
          judgeOutput: `Review failed with error: ${errorMessage}`,
          scannerModels: [],
          truncation: {
            filesFound: 0,
            filesReviewed: 0,
            originalChars: 0,
            truncatedChars: 0,
            wasTruncated: false,
          },
        },
        commentMarker
      );
    } catch {
      // Ignore error posting failure
    }

    process.exit(1);
  }
}

// Run the action
await run();
