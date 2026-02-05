/**
 * GitHub Integration Types
 */
export interface GitHubConfig {
    /** GitHub token for API access */
    token: string;
    /** Repository owner */
    owner: string;
    /** Repository name */
    repo: string;
    /** Pull request number */
    prNumber: number;
}
export interface FileDiff {
    /** File path */
    filename: string;
    /** File status */
    status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed';
    /** Number of additions */
    additions: number;
    /** Number of deletions */
    deletions: number;
    /** Raw patch content */
    patch?: string | undefined;
    /** Previous filename (for renames) */
    previousFilename?: string | undefined;
}
export interface NormalizedDiff {
    /** All file diffs */
    files: FileDiff[];
    /** Combined diff as a single string */
    combinedDiff: string;
    /** PR metadata */
    metadata: {
        title: string;
        body: string | null;
        baseRef: string;
        headRef: string;
        author: string;
    };
    /** Size categorization */
    size: {
        filesChanged: number;
        totalAdditions: number;
        totalDeletions: number;
        category: 'small' | 'medium' | 'large';
    };
}
export interface ReviewComment {
    /** Comment body */
    body: string;
    /** File path (for inline comments) */
    path?: string | undefined;
    /** Line number (for inline comments) */
    line?: number | undefined;
    /** Side of the diff (LEFT or RIGHT) */
    side?: 'LEFT' | 'RIGHT' | undefined;
    /** Commit SHA */
    commitId?: string | undefined;
}
export interface PostCommentOptions {
    /** Whether to post as a PR review */
    asReview: boolean;
    /** Review event type */
    event?: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
    /** Whether to include inline comments */
    includeInlineComments: boolean;
}
export interface PRInfo {
    /** PR number */
    number: number;
    /** PR title */
    title: string;
    /** PR body/description */
    body: string | null;
    /** PR state */
    state: 'open' | 'closed';
    /** Base branch */
    base: {
        ref: string;
        sha: string;
    };
    /** Head branch */
    head: {
        ref: string;
        sha: string;
    };
    /** PR author */
    user: {
        login: string;
    };
}
//# sourceMappingURL=types.d.ts.map