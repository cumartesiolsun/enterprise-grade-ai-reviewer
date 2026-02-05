/**
 * GitHub Diff Module - PR Diff Fetch and Normalization
 */
import type { GitHubConfig, FileDiff, NormalizedDiff, PRInfo } from './types.js';
/**
 * Fetch PR information
 */
export declare function getPRInfo(config: GitHubConfig): Promise<PRInfo>;
/**
 * Fetch PR diff files
 */
export declare function getPRFiles(config: GitHubConfig): Promise<FileDiff[]>;
/**
 * Normalize diff into a structured format
 */
export declare function normalizeDiff(config: GitHubConfig): Promise<NormalizedDiff>;
/**
 * Get diff from GitHub Action context (environment variables)
 */
export declare function getConfigFromEnv(): GitHubConfig;
/**
 * Filter files by extensions (for focused review)
 */
export declare function filterFilesByExtension(files: FileDiff[], extensions: string[]): FileDiff[];
/**
 * Filter out test files
 */
export declare function filterOutTestFiles(files: FileDiff[]): FileDiff[];
//# sourceMappingURL=diff.d.ts.map