/**
 * GitHub Comments Module - Summary and Inline Comment Writer
 */
import type { GitHubConfig, PostCommentOptions } from './types.js';
import type { FinalReview } from '../review/types.js';
import type { OutputLanguage } from '../review/prompts.js';
/**
 * Format the final review as a markdown comment
 */
export declare function formatReviewComment(review: FinalReview, language?: OutputLanguage): string;
/**
 * Post a summary comment on the PR
 */
export declare function postSummaryComment(config: GitHubConfig, review: FinalReview, language?: OutputLanguage): Promise<void>;
/**
 * Post a PR review with optional inline comments
 */
export declare function postPRReview(config: GitHubConfig, review: FinalReview, commitSha: string, options?: PostCommentOptions, language?: OutputLanguage): Promise<void>;
/**
 * Post the review to GitHub (auto-selects best method)
 */
export declare function postToGitHub(config: GitHubConfig, review: FinalReview, commitSha?: string, language?: OutputLanguage): Promise<void>;
//# sourceMappingURL=comments.d.ts.map