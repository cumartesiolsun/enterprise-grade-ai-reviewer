/**
 * Enterprise-Grade AI Reviewer
 * Entry point for GitHub Action and CLI
 */
import { normalizeDiff } from './github/diff.js';
import { postToGitHub, formatReviewComment } from './github/comments.js';
import { runScanners } from './review/scanner.js';
import { judgeReviews, runFullReview } from './review/judge.js';
import type { OutputLanguage } from './review/prompts.js';
import { createReviewConfig, selectModelsForPRSize, calculatePRSize } from './config/models.js';
import type { ReviewConfig, FinalReview } from './review/types.js';
import type { GitHubConfig, NormalizedDiff } from './github/types.js';
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
export declare function reviewPR(githubConfig: GitHubConfig, options?: ReviewOptions): Promise<FinalReview>;
export { normalizeDiff, runScanners, judgeReviews, runFullReview, postToGitHub, formatReviewComment, createReviewConfig, selectModelsForPRSize, calculatePRSize, };
export type { ReviewConfig, FinalReview, GitHubConfig, NormalizedDiff, OutputLanguage };
//# sourceMappingURL=index.d.ts.map