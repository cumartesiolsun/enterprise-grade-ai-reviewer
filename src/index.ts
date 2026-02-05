/**
 * Enterprise-Grade AI Reviewer
 * Entry point for GitHub Action and CLI
 */

import { normalizeDiff, getConfigFromEnv, getPRInfo } from './github/diff.js';
import { postToGitHub, formatReviewComment } from './github/comments.js';
import { runScanners } from './review/scanner.js';
import { judgeReviews, runFullReview } from './review/judge.js';
import type { OutputLanguage } from './review/prompts.js';
import {
  createReviewConfig,
  selectModelsForPRSize,
  calculatePRSize,
} from './config/models.js';
import { logger } from './utils/logger.js';
import type { ReviewConfig, FinalReview } from './review/types.js';
import type { GitHubConfig, NormalizedDiff } from './github/types.js';

/** Supported output languages */
const SUPPORTED_LANGUAGES: OutputLanguage[] = ['en', 'tr', 'ja', 'de', 'fr', 'es', 'pt', 'zh', 'ko'];

export interface ReviewOptions {
  /** Override scanner models */
  scannerModels?: string[] | undefined;
  /** Override judge model */
  judgeModel?: string | undefined;
  /** Auto-select models based on PR size */
  autoSelectModels?: boolean | undefined;
  /** Post result to GitHub */
  postToGitHub?: boolean | undefined;
  /** Output format for CLI */
  outputFormat?: 'json' | 'markdown' | 'summary' | undefined;
  /** Output language for AI review */
  language?: OutputLanguage | undefined;
}

/**
 * Main review function
 */
export async function reviewPR(
  githubConfig: GitHubConfig,
  options: ReviewOptions = {}
): Promise<FinalReview> {
  const startTime = performance.now();
  const language = options.language ?? 'en';

  logger.info('Starting AI code review', {
    repo: `${githubConfig.owner}/${githubConfig.repo}`,
    pr: githubConfig.prNumber,
    autoSelect: options.autoSelectModels ?? true,
    language,
  });

  // Fetch and normalize the diff
  const diff = await normalizeDiff(githubConfig);

  // Determine which models to use
  let reviewConfig: ReviewConfig;

  if (options.autoSelectModels !== false) {
    // Auto-select based on PR size (cost optimization)
    const { scanners, judge } = selectModelsForPRSize(diff.size);
    reviewConfig = createReviewConfig({
      scannerModels: options.scannerModels ?? scanners,
      judgeModel: options.judgeModel ?? judge,
    });

    logger.info('Models auto-selected based on PR size', {
      size: diff.size.category,
      scanners: reviewConfig.scannerModels,
      judge: reviewConfig.judgeModel,
    });
  } else {
    const overrides: Partial<ReviewConfig> = {};
    if (options.scannerModels) overrides.scannerModels = options.scannerModels;
    if (options.judgeModel) overrides.judgeModel = options.judgeModel;
    reviewConfig = createReviewConfig(overrides);
  }

  // Run the review pipeline with language support
  const scannerResults = await runScanners(diff.combinedDiff, reviewConfig, language);
  const finalReview = await judgeReviews(scannerResults, reviewConfig, language);

  // Post to GitHub if requested
  if (options.postToGitHub !== false) {
    const prInfo = await getPRInfo(githubConfig);
    await postToGitHub(githubConfig, finalReview, prInfo.head.sha, language);
  }

  const totalDuration = Math.round(performance.now() - startTime);

  logger.info('Review completed', {
    findings: finalReview.findings.length,
    verdict: finalReview.verdict,
    cost: `$${finalReview.estimatedCost.toFixed(4)}`,
    durationMs: totalDuration,
  });

  return finalReview;
}

/**
 * CLI entry point
 */
async function main(): Promise<void> {
  try {
    // Parse CLI arguments or use environment variables
    const args = process.argv.slice(2);

    // Check for help flag
    if (args.includes('--help') || args.includes('-h')) {
      console.log(`
Enterprise-Grade AI Reviewer

Usage:
  npx enterprise-grade-ai-reviewer [options]

Options:
  --help, -h              Show this help message
  --dry-run               Run review but don't post to GitHub
  --output <format>       Output format: json, markdown, summary (default: markdown)
  --models <list>         Comma-separated list of scanner models
  --judge <model>         Judge model to use
  --language <lang>       Output language: en, tr, ja, de, fr, es, pt, zh, ko (default: en)
  --no-auto-select        Disable automatic model selection based on PR size

Environment Variables:
  GITHUB_TOKEN            GitHub API token (required)
  GITHUB_REPOSITORY       Repository in owner/repo format (required)
  PR_NUMBER               Pull request number (required)
  OPENROUTER_API_KEY      OpenRouter API key (required)
  LOG_LEVEL               Log level: debug, info, warn, error (default: info)
`);
      process.exit(0);
    }

    // Parse options
    const dryRun = args.includes('--dry-run');
    const noAutoSelect = args.includes('--no-auto-select');

    const outputIndex = args.indexOf('--output');
    const outputFormat =
      outputIndex !== -1 ? (args[outputIndex + 1] as ReviewOptions['outputFormat']) : 'markdown';

    const modelsIndex = args.indexOf('--models');
    const scannerModels = modelsIndex !== -1 ? args[modelsIndex + 1]?.split(',') : undefined;

    const judgeIndex = args.indexOf('--judge');
    const judgeModel = judgeIndex !== -1 ? args[judgeIndex + 1] : undefined;

    const languageIndex = args.indexOf('--language');
    let language: OutputLanguage = 'en';
    if (languageIndex !== -1) {
      const langArg = args[languageIndex + 1] as OutputLanguage;
      if (SUPPORTED_LANGUAGES.includes(langArg)) {
        language = langArg;
      } else {
        logger.warn(`Unsupported language: ${langArg}, defaulting to English`);
      }
    }

    // Get GitHub config from environment
    const githubConfig = getConfigFromEnv();

    // Run the review
    const review = await reviewPR(githubConfig, {
      scannerModels,
      judgeModel,
      autoSelectModels: !noAutoSelect,
      postToGitHub: !dryRun,
      outputFormat,
      language,
    });

    // Output result
    switch (outputFormat) {
      case 'json':
        console.log(JSON.stringify(review, null, 2));
        break;
      case 'summary':
        console.log(`
Review Complete
===============
Verdict: ${review.verdict}
Findings: ${review.findings.length}
  - Critical: ${review.stats.critical}
  - High: ${review.stats.high}
  - Medium: ${review.stats.medium}
  - Low: ${review.stats.low}
  - Info: ${review.stats.info}
Cost: $${review.estimatedCost.toFixed(4)}
`);
        break;
      case 'markdown':
      default:
        console.log(formatReviewComment(review, language));
    }

    // Exit with error code if critical issues found
    if (review.stats.critical > 0) {
      process.exit(1);
    }
  } catch (error) {
    logger.error('Review failed', { error: String(error) });
    console.error('Error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

// Run if executed directly (check if this is the main module)
// Using a workaround for ESM module detection that works with NodeNext
main().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});

// Export for programmatic use
export {
  normalizeDiff,
  runScanners,
  judgeReviews,
  runFullReview,
  postToGitHub,
  formatReviewComment,
  createReviewConfig,
  selectModelsForPRSize,
  calculatePRSize,
};

export type { ReviewConfig, FinalReview, GitHubConfig, NormalizedDiff, OutputLanguage };
