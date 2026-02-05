/**
 * GitHub Diff Module - PR Diff Fetch and Normalization
 * MVP v0.1 - With max_files and max_chars truncation
 */
import { Octokit } from '@octokit/rest';
import { logger } from '../utils/logger.js';
/**
 * Create Octokit instance
 */
function createOctokit(token) {
    return new Octokit({ auth: token });
}
/**
 * Fetch PR head SHA
 */
export async function getPRHeadSha(config) {
    const octokit = createOctokit(config.token);
    const { data } = await octokit.pulls.get({
        owner: config.owner,
        repo: config.repo,
        pull_number: config.prNumber,
    });
    return data.head.sha;
}
/**
 * Fetch PR diff files
 */
export async function getPRFiles(config) {
    const octokit = createOctokit(config.token);
    const { data } = await octokit.pulls.listFiles({
        owner: config.owner,
        repo: config.repo,
        pull_number: config.prNumber,
        per_page: 100, // GitHub API limit
    });
    return data.map((file) => ({
        filename: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        patch: file.patch,
        previousFilename: file.previous_filename,
    }));
}
/**
 * Build combined diff string from files
 */
function buildCombinedDiff(files) {
    return files
        .filter((f) => f.patch)
        .map((f) => {
        const header = `diff --git a/${f.filename} b/${f.filename}`;
        const status = f.status === 'added'
            ? 'new file'
            : f.status === 'removed'
                ? 'deleted file'
                : f.status === 'renamed'
                    ? `renamed from ${f.previousFilename}`
                    : 'modified';
        return `${header}\n--- ${status} ---\n${f.patch}`;
    })
        .join('\n\n');
}
/**
 * Normalize diff with max_files and max_chars truncation
 */
export async function normalizeDiff(config, maxFiles, maxChars) {
    logger.info('Fetching PR diff', {
        owner: config.owner,
        repo: config.repo,
        prNumber: config.prNumber,
    });
    const [headSha, allFiles] = await Promise.all([
        getPRHeadSha(config),
        getPRFiles(config),
    ]);
    const filesFound = allFiles.length;
    let truncationReason;
    // Step 1: Limit number of files
    let files = allFiles;
    if (files.length > maxFiles) {
        // Prioritize files with patches, then by change size
        files = files
            .filter((f) => f.patch)
            .sort((a, b) => (b.additions + b.deletions) - (a.additions + a.deletions))
            .slice(0, maxFiles);
        truncationReason = `Limited to ${maxFiles} files (found ${filesFound})`;
        logger.info('Truncated file count', { found: filesFound, limited: maxFiles });
    }
    // Step 2: Build diff and check char limit
    let combinedDiff = buildCombinedDiff(files);
    const originalChars = combinedDiff.length;
    if (combinedDiff.length > maxChars) {
        // Truncate diff content
        combinedDiff = combinedDiff.slice(0, maxChars);
        // Find last complete file boundary to avoid mid-diff cut
        const lastDiffMarker = combinedDiff.lastIndexOf('\ndiff --git');
        if (lastDiffMarker > maxChars * 0.5) {
            combinedDiff = combinedDiff.slice(0, lastDiffMarker);
        }
        const charReason = `Truncated to ${maxChars} chars (original ${originalChars})`;
        truncationReason = truncationReason
            ? `${truncationReason}; ${charReason}`
            : charReason;
        logger.info('Truncated diff content', {
            original: originalChars,
            truncated: combinedDiff.length
        });
    }
    const truncation = {
        filesFound,
        filesReviewed: files.length,
        originalChars,
        truncatedChars: combinedDiff.length,
        wasTruncated: !!truncationReason,
        truncationReason,
    };
    logger.info('PR diff normalized', {
        filesFound: truncation.filesFound,
        filesReviewed: truncation.filesReviewed,
        diffLength: combinedDiff.length,
        wasTruncated: truncation.wasTruncated,
    });
    return {
        files,
        combinedDiff,
        headSha,
        truncation,
    };
}
/**
 * Get GitHub config from environment variables
 */
export function getConfigFromEnv() {
    const token = process.env['GITHUB_TOKEN'];
    const repository = process.env['GITHUB_REPOSITORY'];
    const prNumber = process.env['PR_NUMBER'] ?? process.env['GITHUB_REF_NAME']?.match(/\d+/)?.[0];
    if (!token) {
        throw new Error('GITHUB_TOKEN environment variable is required');
    }
    if (!repository) {
        throw new Error('GITHUB_REPOSITORY environment variable is required');
    }
    if (!prNumber) {
        throw new Error('PR_NUMBER or valid GITHUB_REF_NAME is required');
    }
    const [owner, repo] = repository.split('/');
    if (!owner || !repo) {
        throw new Error('Invalid GITHUB_REPOSITORY format (expected owner/repo)');
    }
    return {
        token,
        owner,
        repo,
        prNumber: Number.parseInt(prNumber, 10),
    };
}
//# sourceMappingURL=diff.js.map