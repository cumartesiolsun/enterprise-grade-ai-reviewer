/**
 * GitHub Comments Module - Marker-based comment update/create
 * MVP v0.1 - Single PR comment with stable marker
 */
import type { GitHubConfig, TruncationInfo } from './diff.js';
import type { ScannerResult } from '../review/scanner.js';
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
//# sourceMappingURL=comments.d.ts.map