/**
 * GitHub Diff Module - PR Diff Fetch and Normalization
 * MVP v0.1 - With max_files and max_chars truncation
 */
export interface GitHubConfig {
    token: string;
    owner: string;
    repo: string;
    prNumber: number;
}
export interface FileDiff {
    filename: string;
    status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed';
    additions: number;
    deletions: number;
    patch?: string | undefined;
    previousFilename?: string | undefined;
}
export interface TruncationInfo {
    filesFound: number;
    filesReviewed: number;
    originalChars: number;
    truncatedChars: number;
    wasTruncated: boolean;
    truncationReason?: string | undefined;
}
export interface NormalizedDiff {
    files: FileDiff[];
    combinedDiff: string;
    headSha: string;
    truncation: TruncationInfo;
}
/**
 * Fetch PR head SHA
 */
export declare function getPRHeadSha(config: GitHubConfig): Promise<string>;
/**
 * Fetch PR diff files
 */
export declare function getPRFiles(config: GitHubConfig): Promise<FileDiff[]>;
/**
 * Normalize diff with max_files and max_chars truncation
 */
export declare function normalizeDiff(config: GitHubConfig, maxFiles: number, maxChars: number): Promise<NormalizedDiff>;
/**
 * Get GitHub config from environment variables
 */
export declare function getConfigFromEnv(): GitHubConfig;
//# sourceMappingURL=diff.d.ts.map