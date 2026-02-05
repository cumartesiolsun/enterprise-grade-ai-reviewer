"use strict";
/**
 * Enterprise-Grade AI Reviewer
 * Entry point for GitHub Action and CLI
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.calculatePRSize = exports.selectModelsForPRSize = exports.createReviewConfig = exports.formatReviewComment = exports.postToGitHub = exports.runFullReview = exports.judgeReviews = exports.runScanners = exports.normalizeDiff = void 0;
exports.reviewPR = reviewPR;
const diff_js_1 = require("./github/diff.js");
Object.defineProperty(exports, "normalizeDiff", { enumerable: true, get: function () { return diff_js_1.normalizeDiff; } });
const comments_js_1 = require("./github/comments.js");
Object.defineProperty(exports, "postToGitHub", { enumerable: true, get: function () { return comments_js_1.postToGitHub; } });
Object.defineProperty(exports, "formatReviewComment", { enumerable: true, get: function () { return comments_js_1.formatReviewComment; } });
const scanner_js_1 = require("./review/scanner.js");
Object.defineProperty(exports, "runScanners", { enumerable: true, get: function () { return scanner_js_1.runScanners; } });
const judge_js_1 = require("./review/judge.js");
Object.defineProperty(exports, "judgeReviews", { enumerable: true, get: function () { return judge_js_1.judgeReviews; } });
Object.defineProperty(exports, "runFullReview", { enumerable: true, get: function () { return judge_js_1.runFullReview; } });
const models_js_1 = require("./config/models.js");
Object.defineProperty(exports, "createReviewConfig", { enumerable: true, get: function () { return models_js_1.createReviewConfig; } });
Object.defineProperty(exports, "selectModelsForPRSize", { enumerable: true, get: function () { return models_js_1.selectModelsForPRSize; } });
Object.defineProperty(exports, "calculatePRSize", { enumerable: true, get: function () { return models_js_1.calculatePRSize; } });
const logger_js_1 = require("./utils/logger.js");
/** Supported output languages */
const SUPPORTED_LANGUAGES = ['en', 'tr', 'ja', 'de', 'fr', 'es', 'pt', 'zh', 'ko'];
/**
 * Main review function
 */
async function reviewPR(githubConfig, options = {}) {
    const startTime = performance.now();
    const language = options.language ?? 'en';
    logger_js_1.logger.info('Starting AI code review', {
        repo: `${githubConfig.owner}/${githubConfig.repo}`,
        pr: githubConfig.prNumber,
        autoSelect: options.autoSelectModels ?? true,
        language,
    });
    // Fetch and normalize the diff
    const diff = await (0, diff_js_1.normalizeDiff)(githubConfig);
    // Determine which models to use
    let reviewConfig;
    if (options.autoSelectModels !== false) {
        // Auto-select based on PR size (cost optimization)
        const { scanners, judge } = (0, models_js_1.selectModelsForPRSize)(diff.size);
        reviewConfig = (0, models_js_1.createReviewConfig)({
            scannerModels: options.scannerModels ?? scanners,
            judgeModel: options.judgeModel ?? judge,
        });
        logger_js_1.logger.info('Models auto-selected based on PR size', {
            size: diff.size.category,
            scanners: reviewConfig.scannerModels,
            judge: reviewConfig.judgeModel,
        });
    }
    else {
        const overrides = {};
        if (options.scannerModels)
            overrides.scannerModels = options.scannerModels;
        if (options.judgeModel)
            overrides.judgeModel = options.judgeModel;
        reviewConfig = (0, models_js_1.createReviewConfig)(overrides);
    }
    // Run the review pipeline with language support
    const scannerResults = await (0, scanner_js_1.runScanners)(diff.combinedDiff, reviewConfig, language);
    const finalReview = await (0, judge_js_1.judgeReviews)(scannerResults, reviewConfig, language);
    // Post to GitHub if requested
    if (options.postToGitHub !== false) {
        const prInfo = await (0, diff_js_1.getPRInfo)(githubConfig);
        await (0, comments_js_1.postToGitHub)(githubConfig, finalReview, prInfo.head.sha, language);
    }
    const totalDuration = Math.round(performance.now() - startTime);
    logger_js_1.logger.info('Review completed', {
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
async function main() {
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
        const outputFormat = outputIndex !== -1 ? args[outputIndex + 1] : 'markdown';
        const modelsIndex = args.indexOf('--models');
        const scannerModels = modelsIndex !== -1 ? args[modelsIndex + 1]?.split(',') : undefined;
        const judgeIndex = args.indexOf('--judge');
        const judgeModel = judgeIndex !== -1 ? args[judgeIndex + 1] : undefined;
        const languageIndex = args.indexOf('--language');
        let language = 'en';
        if (languageIndex !== -1) {
            const langArg = args[languageIndex + 1];
            if (SUPPORTED_LANGUAGES.includes(langArg)) {
                language = langArg;
            }
            else {
                logger_js_1.logger.warn(`Unsupported language: ${langArg}, defaulting to English`);
            }
        }
        // Get GitHub config from environment
        const githubConfig = (0, diff_js_1.getConfigFromEnv)();
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
                console.log((0, comments_js_1.formatReviewComment)(review, language));
        }
        // Exit with error code if critical issues found
        if (review.stats.critical > 0) {
            process.exit(1);
        }
    }
    catch (error) {
        logger_js_1.logger.error('Review failed', { error: String(error) });
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
//# sourceMappingURL=index.js.map