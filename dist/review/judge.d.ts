/**
 * Judge Module - Aggregation and Deduplication Logic
 */
import type { ScannerResult, FinalReview, ReviewConfig } from './types.js';
import type { OutputLanguage } from './prompts.js';
/**
 * Judge and merge findings from multiple scanners
 * IMPORTANT: Judge does NOT add new findings, only aggregates
 */
export declare function judgeReviews(reviews: ScannerResult[], config: ReviewConfig, language?: OutputLanguage): Promise<FinalReview>;
/**
 * Full review pipeline: scan + judge
 */
export declare function runFullReview(diff: string, config: ReviewConfig, language?: OutputLanguage): Promise<FinalReview>;
//# sourceMappingURL=judge.d.ts.map