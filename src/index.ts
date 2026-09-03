/**
 * Enterprise-Grade AI Reviewer
 * GitHub Action Entry Point (thin orchestrator)
 */

import { parseInputs, getInput } from './config.js';
import { normalizeDiff, getConfigFromEnv, getPRContextFromEnv } from './github/diff.js';
import type { GitHubConfig, NormalizedDiff, TruncationInfo } from './github/diff.js';
import { postOrUpdateComment } from './github/comments.js';
import { runScanners, runJudgeScan } from './review/scanner.js';
import type { ScannerConfig, ScannerResult } from './review/scanner.js';
import { runJudge } from './review/judge.js';
import type { JudgeConfig } from './review/judge.js';
import {
  classifyScannerPool,
  buildAllClearVerdict,
  buildIncompleteVerdict,
  formatDegradedSuffix,
  appendDegradedSuffix,
} from './review/verdict.js';
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

    // PR title/body context for the models. Log only its length — PR bodies
    // are untrusted input and must never be echoed into the logs.
    const prContext = getPRContextFromEnv();
    logger.info('PR context extracted', { prContextLength: prContext.length });

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

    // Step 2: Run scanners in parallel (rescue pass included), plus the
    // optional judge scan.
    const scannerConfig: ScannerConfig = {
      openrouter: openrouterConfig,
      models: inputs.scannerModels,
      maxTokens: inputs.maxTokensScanner,
      language: inputs.language,
      roles: inputs.scannerRoles,
      prContext,
      rescueModels: inputs.rescueModels,
    };

    // Judge-scan isolation: the aggregation judge must stay a pure verifier —
    // a model cannot be an honest referee of its own in-prompt findings — so
    // the judge model's own scan is a separate call whose result enters the
    // scanner-results pool like any other scanner source (see runJudgeScan).
    const judgeScanPromise =
      inputs.judgeScan === 'always'
        ? runJudgeScan(
            scannerConfig,
            diff.combinedDiff,
            inputs.judgeScanModel,
            inputs.judgeScanRole
          )
        : undefined;

    const scanOutcome = await runScanners(scannerConfig, diff.combinedDiff);
    const coverage = scanOutcome.coverage;
    scannerResults = scanOutcome.results;

    let fallbackJudgeScanRan = false;
    let judgeScanResult = judgeScanPromise ? await judgeScanPromise : undefined;

    if (!judgeScanResult && inputs.judgeScan === 'fallback') {
      const anyUncovered = coverage.some((c) => c.status === 'uncovered');
      const zeroSuccessful = !scannerResults.some((r) => r.success);
      if (anyUncovered || zeroSuccessful) {
        logger.warn('Running fallback judge scan', { anyUncovered, zeroSuccessful });
        judgeScanResult = await runJudgeScan(
          scannerConfig,
          diff.combinedDiff,
          inputs.judgeScanModel,
          'general'
        );
        fallbackJudgeScanRan = true;
      }
    }

    if (judgeScanResult) {
      scannerResults = [...scannerResults, judgeScanResult];
    }

    // An always-mode judge scan is normal operation; degradation means a role
    // needed rescue, stayed uncovered, or a fallback judge scan had to run.
    const degraded =
      fallbackJudgeScanRan || coverage.some((c) => c.status !== 'covered');

    const successfulScanners = scannerResults.filter((r) => r.success);
    const failedScanners = scannerResults.filter((r) => !r.success);

    logger.info('Scanners completed', {
      successful: successfulScanners.length,
      failed: failedScanners.length,
      coverage,
      judgeScan: inputs.judgeScan,
      fallbackJudgeScanRan,
    });

    // Minimum-success gate: the pool (regular + rescue + judge scan) must
    // contain at least min-successful-scanners successful entries; 0 disables.
    if (
      inputs.minSuccessfulScanners > 0 &&
      successfulScanners.length < inputs.minSuccessfulScanners
    ) {
      logger.error('Not enough successful scanners', {
        successful: successfulScanners.length,
        required: inputs.minSuccessfulScanners,
      });
      await postOrUpdateComment(
        githubConfig,
        {
          judgeOutput: `⚠️ AI review could not be completed — only ${successfulScanners.length} scanner(s) succeeded (minimum required: ${inputs.minSuccessfulScanners}). Check the Actions run log for details.`,
          scannerResults,
          truncation: diff.truncation,
          coverage,
          degraded,
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

    // Step 2b (v0.5.3): classify the pool before the judge. The judge only
    // ever aggregates findings; an all-clear or incomplete pool gets a
    // deterministic verdict instead of a model call.
    const pool = classifyScannerPool(scannerResults);
    const scannerTokens = scannerResults.reduce((sum, r) => sum + r.tokensUsed, 0);

    logger.info('Scanner pool classified', {
      kind: pool.kind,
      ran: pool.ran,
      usable: pool.usable.length,
      failed: pool.failed.map((r) => r.model),
    });

    if (pool.kind === 'all-clear') {
      // Every scanner that ran reported NO_FINDINGS and nothing failed:
      // explicit APPROVE, no judge call. Inline mode takes the existing
      // empty-findings LGTM path.
      await postResults(
        inputs,
        githubConfig,
        {
          output: buildAllClearVerdict(pool, inputs.language),
          findings: inputs.reviewMode === 'inline' ? [] : undefined,
        },
        diff,
        scannerResults,
        { coverage, degraded }
      );

      const totalDuration = Math.round(performance.now() - startTime);
      logger.info('Review completed: all-clear (judge not called)', {
        totalDurationMs: totalDuration,
        totalTokens: scannerTokens,
        scannersRan: pool.ran,
      });
      reportRunOutcome({
        scannerResults,
        totalTokens: scannerTokens,
        findingsCount: 0,
        durationMs: totalDuration,
        truncation: diff.truncation,
      });
      return;
    }

    if (pool.kind === 'incomplete') {
      // No findings, but part of the pool is missing: a clean result cannot
      // be claimed. Post the INCOMPLETE verdict and fail closed — a workflow
      // re-run repeats the scan.
      logger.error('Review incomplete: no findings and at least one scanner failed', {
        ran: pool.ran,
        failed: pool.failed.map((r) => `${r.model}: ${r.error ?? 'unknown error'}`),
      });
      await postOrUpdateComment(
        githubConfig,
        {
          judgeOutput: buildIncompleteVerdict(pool, inputs.language),
          scannerResults,
          truncation: diff.truncation,
          coverage,
          degraded,
        },
        inputs.commentMarker
      );
      reportRunOutcome({
        scannerResults,
        totalTokens: scannerTokens,
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
      prContext,
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
          coverage,
          degraded,
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

    // FAILED scanners in a findings run do not change the verdict (the judge
    // saw every usable output), but the loss is stamped on the verdict
    // headline so it is visible without reading Sources.
    const degradedSuffix = formatDegradedSuffix(pool, inputs.language);
    const postedJudge =
      degradedSuffix === undefined
        ? judgeResult
        : { ...judgeResult, output: appendDegradedSuffix(judgeResult.output, degradedSuffix) };

    // Step 4: Post results to GitHub
    await postResults(inputs, githubConfig, postedJudge, diff, scannerResults, {
      coverage,
      degraded,
      degradedSuffix,
    });

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
