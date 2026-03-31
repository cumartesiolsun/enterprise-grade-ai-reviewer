/**
 * Post review results to GitHub based on review mode and findings
 */
import type { GitHubConfig, FileDiff, TruncationInfo } from '../github/diff.js';
import type { ScannerResult } from './scanner.js';
import type { InlineFinding, ReviewMode } from './judge.js';
export interface PostResultsInput {
    reviewMode: ReviewMode;
    commentMarker: string;
}
export interface PostResultsJudge {
    output: string;
    findings?: InlineFinding[] | undefined;
}
export interface PostResultsDiff {
    files: FileDiff[];
    headSha: string;
    truncation: TruncationInfo;
}
export declare function postResults(inputs: PostResultsInput, githubConfig: GitHubConfig, judgeResult: PostResultsJudge, diff: PostResultsDiff, scannerResults: ScannerResult[]): Promise<void>;
//# sourceMappingURL=postResults.d.ts.map