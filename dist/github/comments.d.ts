/**
 * GitHub Comments Module - Summary and inline review posting
 */
import type { GitHubConfig, TruncationInfo, FileDiff } from './diff.js';
import type { ScannerResult } from '../review/scanner.js';
import type { InlineFinding } from '../review/judge.js';
export interface ReviewCommentData {
    judgeOutput: string;
    scannerResults: ScannerResult[];
    truncation: TruncationInfo;
}
/**
 * Build the comment body with marker
 */
export declare function buildCommentBody(data: ReviewCommentData, commentMarker: string): string;
/**
 * Post or update PR comment using marker-based detection
 */
export declare function postOrUpdateComment(config: GitHubConfig, data: ReviewCommentData, commentMarker: string): Promise<void>;
/**
 * Post an inline PR review using pulls.createReview().
 * Unmatched findings fall back to the review body summary.
 */
export declare function postInlineReview(config: GitHubConfig, findings: InlineFinding[], files: FileDiff[], headSha: string, scannerResults: ScannerResult[], truncation: TruncationInfo, commentMarker: string): Promise<void>;
//# sourceMappingURL=comments.d.ts.map