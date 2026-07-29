/**
 * Enterprise-Grade AI Reviewer
 * GitHub Action Entry Point (thin orchestrator)
 */

import { parseInputs, getInput } from './config.js';
import { normalizeDiff, getConfigFromEnv } from './github/diff.js';
import type { GitHubConfig, NormalizedDiff, TruncationInfo } from './github/diff.js';
import { postOrUpdateComment } from './github/comments.js';
import { runScanners } from './review/scanner.js';
import type { ScannerConfig, ScannerResult } from './review/scanner.js';
import { runJudge } from './review/judge.js';
import type { JudgeConfig } from './review/judge.js';
import { postResults } from './review/postResults.js';
import type { OpenRouterConfig } from './openrouter/client.js';
import { writeActionOutputs, writeStepSummary } from './utils/actionOutputs.js';
import { logger } from './utils/logger.js';

const EMPTY_TRUNCATION: TruncationInfo = {
  filesFound: 0,
  filesReviewed: 0,
  originalChars: 0,
  truncatedChars: 0,
  wasTruncated: false,
};

/**
 * Reduce an internal/upstream error message to a coarse class or status.
 * Never leaks upstream response bodies into PR comments.
 */
function describeErrorClass(message: string | undefined): string {
  if (!message) {
    return 'unknown error';
  }
  const statusMatch = /OpenRouter API error (\d+)/.exec(message);
  if (statusMatch) {
    return `upstream API error ${statusMatch[1]}`;
  }
  if (/abort|timeout/i.test(message)) {
    return 'request timed out';
  }
  if (/empty response/i.test(message)) {
    return 'empty model response';
  }
  return 'unexpected error';
}

interface RunOutcome {
  scannerResults: ScannerResult[];
  totalTokens: number;
  findingsCount: number;
  durationMs: number;
  truncation?: TruncationInfo | undefined;
}

function buildStepSummary(outcome: RunOutcome): string {
  const lines: string[] = ['## Enterprise AI Review', ''];

  if (outcome.scannerResults.length > 0) {
    lines.push('| Scanner model | Status |', '| --- | --- |');
    for (const result of outcome.scannerResults) {
      lines.push(`| ${result.model} | ${result.status} |`);
    }
    lines.push('');
  }

  lines.push(
    `- Total tokens: ${outcome.totalTokens}`,
    `- Duration: ${(outcome.durationMs / 1000).toFixed(1)}s`
  );
  if (outcome.truncation?.truncationReason) {
    lines.push(`- Truncation: ${outcome.truncation.truncationReason}`);
  }

  return lines.join('\n');
}

/**
 * Best-effort: write action outputs and the step summary.
 * Never throws — failures here must not mask the run result.
 */
function reportRunOutcome(outcome: RunOutcome): void {
  try {
    const scannersFailed = outcome.scannerResults.filter((r) => !r.success).length;
    writeActionOutputs({
      'total-tokens': String(outcome.totalTokens),
      'findings-count': String(outcome.findingsCount),
      'scanners-failed': String(scannersFailed),
    });
    writeStepSummary(buildStepSummary(outcome));
  } catch (error) {
    logger.warn('Failed to write action outputs/step summary', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Main review function
 */
async function run(): Promise<void> {
  const startTime = performance.now();

  // Tracked outside the try block so the catch path can report what is known
  let scannerResults: ScannerResult[] = [];
  let judgeTokens = 0;
  let findingsCount = 0;
  let diff: NormalizedDiff | undefined;

  try {
    // Parse inputs
    const inputs = parseInputs(process.env);

    logger.info('Starting Enterprise AI Review', {
      scannerModels: inputs.scannerModels,
      judgeModel: inputs.judgeModel,
      language: inputs.language,
      maxFiles: inputs.maxFiles,
      maxChars: inputs.maxChars,
      reviewMode: inputs.reviewMode,
      excludePaths: inputs.excludePaths,
    });

    // Set up GitHub config (token passed explicitly, no process.env mutation)
    const githubConfig: GitHubConfig = getConfigFromEnv(inputs.githubToken);

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
    diff = await normalizeDiff(
      githubConfig,
      inputs.maxFiles,
      inputs.maxChars,
      inputs.excludePaths
    );

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
          scannerResults: [],
          truncation: diff.truncation,
        },
        inputs.commentMarker
      );
      reportRunOutcome({
        scannerResults: [],
        totalTokens: 0,
        findingsCount: 0,
        durationMs: Math.round(performance.now() - startTime),
        truncation: diff.truncation,
      });
      return;
    }

    // Step 2: Run scanners in parallel
    const scannerConfig: ScannerConfig = {
      openrouter: openrouterConfig,
      models: inputs.scannerModels,
      maxTokens: inputs.maxTokensScanner,
      language: inputs.language,
    };

    scannerResults = await runScanners(scannerConfig, diff.combinedDiff);

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
          judgeOutput:
            '⚠️ AI review could not be completed — all scanner models failed. Check the Actions run log for details.',
          scannerResults,
          truncation: diff.truncation,
        },
        inputs.commentMarker
      );
      reportRunOutcome({
        scannerResults,
        totalTokens: scannerResults.reduce((sum, r) => sum + r.tokensUsed, 0),
        findingsCount: 0,
        durationMs: Math.round(performance.now() - startTime),
        truncation: diff.truncation,
      });
      process.exit(1);
    }

    // Step 3: Run judge to merge results
    const judgeConfig: JudgeConfig = {
      openrouter: openrouterConfig,
      model: inputs.judgeModel,
      maxTokens: inputs.maxTokensJudge,
      language: inputs.language,
      reviewMode: inputs.reviewMode,
    };

    const judgeResult = await runJudge(judgeConfig, scannerResults, diff.combinedDiff);
    judgeTokens = judgeResult.tokensUsed;

    logger.info('Judge completed', {
      success: judgeResult.success,
      tokensUsed: judgeResult.tokensUsed,
      durationMs: judgeResult.durationMs,
      reviewMode: inputs.reviewMode,
      findingsCount: judgeResult.findings?.length,
    });

    const totalTokens =
      scannerResults.reduce((sum, r) => sum + r.tokensUsed, 0) + judgeResult.tokensUsed;

    // A failed judge means the review did not happen — fail the action instead
    // of posting the failure text as if it were the review (and going green).
    if (!judgeResult.success) {
      logger.error('Judge aggregation failed', { error: judgeResult.error });

      await postOrUpdateComment(
        githubConfig,
        {
          judgeOutput: `⚠️ AI review could not be completed (judge aggregation failed: ${describeErrorClass(judgeResult.error)}). Check the Actions run log for details.`,
          scannerResults,
          truncation: diff.truncation,
        },
        inputs.commentMarker
      );

      reportRunOutcome({
        scannerResults,
        totalTokens,
        findingsCount: 0,
        durationMs: Math.round(performance.now() - startTime),
        truncation: diff.truncation,
      });

      process.exit(1);
    }

    findingsCount = judgeResult.findings?.length ?? 0;

    // Step 4: Post results to GitHub
    await postResults(inputs, githubConfig, judgeResult, diff, scannerResults);

    const totalDuration = Math.round(performance.now() - startTime);

    logger.info('Review completed successfully', {
      totalDurationMs: totalDuration,
      totalTokens,
      scannersUsed: successfulScanners.length,
    });

    reportRunOutcome({
      scannerResults,
      totalTokens,
      findingsCount,
      durationMs: totalDuration,
      truncation: diff.truncation,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Review failed', { error: errorMessage });

    // PR comments only get a generic message plus at most the first line of
    // the error (truncated) — full details stay in the Actions log.
    const firstLine = (errorMessage.split('\n')[0] ?? '').slice(0, 200);

    try {
      const fallbackToken = getInput(process.env, 'github-token', '');
      const githubConfig = getConfigFromEnv(fallbackToken);
      const commentMarker = getInput(process.env, 'comment-marker', 'ENTERPRISE_AI_REVIEW');
      const errorSuffix = firstLine ? `\n\nError: ${firstLine}` : '';

      await postOrUpdateComment(
        githubConfig,
        {
          judgeOutput: `⚠️ AI review failed to complete. Check the Actions run log for details.${errorSuffix}`,
          scannerResults: [],
          truncation: diff?.truncation ?? EMPTY_TRUNCATION,
        },
        commentMarker
      );
    } catch {
      // Ignore error posting failure
    }

    reportRunOutcome({
      scannerResults,
      totalTokens: scannerResults.reduce((sum, r) => sum + r.tokensUsed, 0) + judgeTokens,
      findingsCount,
      durationMs: Math.round(performance.now() - startTime),
      truncation: diff?.truncation,
    });

    process.exit(1);
  }
}

// Run the action
await run();
