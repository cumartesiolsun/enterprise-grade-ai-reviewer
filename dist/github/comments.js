/**
 * GitHub Comments Module - Marker-based comment update/create
 * MVP v0.1 - Single PR comment with stable marker
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
 * Get status badge for scanner result
 */
function getStatusBadge(result) {
    switch (result.status) {
        case 'OK':
            return '✅ OK';
        case 'SKIPPED':
            return '⏭️ SKIPPED (empty/LGTM)';
        case 'FAILED':
            return `❌ FAILED (${result.error ?? 'unknown error'})`;
        default:
            return '❓ UNKNOWN';
    }
}
/**
 * Build the comment body with marker
 */
export function buildCommentBody(data, commentMarker) {
    const sections = [
        '## Enterprise AI Review',
        '',
        `<!-- ${commentMarker} -->`,
        '',
        '### Final Review',
        '',
        data.judgeOutput,
        '',
        '### Sources',
        '',
    ];
    // Add scanner results with status badges
    for (const result of data.scannerResults) {
        sections.push(`- \`${result.model}\`: ${getStatusBadge(result)}`);
    }
    sections.push('');
    // Notes section (if truncation occurred)
    if (data.truncation.wasTruncated) {
        sections.push('### Notes', '', `⚠️ ${data.truncation.truncationReason}`, '', `- Files found: ${data.truncation.filesFound}`, `- Files reviewed: ${data.truncation.filesReviewed}`, `- Original size: ${data.truncation.originalChars} chars`, `- Reviewed size: ${data.truncation.truncatedChars} chars`, '');
    }
    return sections.join('\n');
}
/**
 * Find existing comment with the marker
 */
async function findExistingComment(octokit, config, commentMarker) {
    const markerPattern = `<!-- ${commentMarker} -->`;
    // Fetch all comments on the PR
    const { data: comments } = await octokit.issues.listComments({
        owner: config.owner,
        repo: config.repo,
        issue_number: config.prNumber,
        per_page: 100,
    });
    // Find comment containing the marker
    for (const comment of comments) {
        if (comment.body?.includes(markerPattern)) {
            logger.debug('Found existing comment', { commentId: comment.id });
            return comment.id;
        }
    }
    return null;
}
/**
 * Post or update PR comment using marker-based detection
 */
export async function postOrUpdateComment(config, data, commentMarker) {
    const octokit = createOctokit(config.token);
    const body = buildCommentBody(data, commentMarker);
    logger.info('Checking for existing comment', {
        owner: config.owner,
        repo: config.repo,
        prNumber: config.prNumber,
        marker: commentMarker,
    });
    // Try to find existing comment
    const existingCommentId = await findExistingComment(octokit, config, commentMarker);
    if (existingCommentId) {
        // Update existing comment
        logger.info('Updating existing comment', { commentId: existingCommentId });
        await octokit.issues.updateComment({
            owner: config.owner,
            repo: config.repo,
            comment_id: existingCommentId,
            body,
        });
        logger.info('Comment updated successfully');
    }
    else {
        // Create new comment
        logger.info('Creating new comment');
        await octokit.issues.createComment({
            owner: config.owner,
            repo: config.repo,
            issue_number: config.prNumber,
            body,
        });
        logger.info('Comment created successfully');
    }
}
//# sourceMappingURL=comments.js.map