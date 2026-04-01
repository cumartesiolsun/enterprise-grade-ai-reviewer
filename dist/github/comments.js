/**
 * GitHub Comments Module - Summary and inline review posting
 */
import { Octokit } from '@octokit/rest';
import { parseDiffHunks, isLineInDiff } from './diff.js';
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
/**
 * Parse "(by: model-a, model-b)" tags from free-form judge output
 * and count how many findings each model contributed to.
 */
function countContributionsFromText(text) {
    const counts = new Map();
    const byTagRegex = /\(by:\s*([^)]+)\)/g;
    let match;
    while ((match = byTagRegex.exec(text)) !== null) {
        const models = match[1].split(',').map((m) => m.trim()).filter((m) => m.length > 0);
        for (const model of models) {
            counts.set(model, (counts.get(model) ?? 0) + 1);
        }
    }
    return counts;
}
export function buildCommentBody(data, commentMarker) {
    const contributions = countContributionsFromText(data.judgeOutput);
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
    // Add scanner results with status badges and contribution counts
    for (const result of data.scannerResults) {
        const count = contributions.get(result.model);
        const contrib = count ? ` — contributed to ${count} finding(s)` : '';
        sections.push(`- \`${result.model}\`: ${getStatusBadge(result)}${contrib}`);
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
/**
 * Validate findings against actual PR diff files.
 * Findings whose file/line doesn't match the diff are separated as "unmatched".
 */
function validateFindings(findings, files) {
    const matched = [];
    const unmatched = [];
    for (const finding of findings) {
        const diffFile = files.find((f) => f.filename === finding.file);
        if (!diffFile?.patch) {
            logger.warn('Finding file not in diff', { file: finding.file });
            unmatched.push(finding);
            continue;
        }
        const hunks = parseDiffHunks(diffFile.patch);
        if (isLineInDiff(finding.line, hunks)) {
            matched.push(finding);
        }
        else {
            logger.warn('Finding line not in diff hunks', {
                file: finding.file,
                line: finding.line,
            });
            unmatched.push(finding);
        }
    }
    return { matched, unmatched };
}
/**
 * Get severity emoji for a finding.
 */
function getSeverityEmoji(severity) {
    switch (severity) {
        case 'critical':
            return '🔴';
        case 'warning':
            return '🟡';
        case 'info':
            return '🔵';
    }
}
/**
 * Format an inline finding as a review comment body.
 */
function formatSourcesTag(sources) {
    if (!sources || sources.length === 0)
        return '';
    return `\n\n_by: ${sources.join(', ')}_`;
}
function formatInlineComment(finding) {
    return `${getSeverityEmoji(finding.severity)} **${finding.title}**\n\n${finding.body}${formatSourcesTag(finding.sources)}`;
}
/**
 * Format a finding as a markdown list item for summary sections.
 */
function formatFindingListItem(finding) {
    const emoji = getSeverityEmoji(finding.severity);
    const sourcesTag = finding.sources?.length ? ` (by: ${finding.sources.join(', ')})` : '';
    return `- ${emoji} **${finding.title}** (\`${finding.file}:${finding.line}\`)${sourcesTag}\n  ${finding.body}`;
}
/**
 * Build the review body (summary section) for an inline review.
 */
function countContributions(findings) {
    const counts = new Map();
    for (const f of findings) {
        if (f.sources) {
            for (const model of f.sources) {
                counts.set(model, (counts.get(model) ?? 0) + 1);
            }
        }
    }
    return counts;
}
function buildInlineReviewBody(findings, unmatched, scannerResults, truncation) {
    const allFindings = [...findings, ...unmatched];
    const contributions = countContributions(allFindings);
    const bodyLines = [
        '## Enterprise AI Review',
        '',
        `Found **${allFindings.length}** finding(s): ` +
            `${allFindings.filter((f) => f.severity === 'critical').length} critical, ` +
            `${allFindings.filter((f) => f.severity === 'warning').length} warning, ` +
            `${allFindings.filter((f) => f.severity === 'info').length} info`,
        '',
        '### Sources',
        '',
    ];
    for (const result of scannerResults) {
        const count = contributions.get(result.model);
        const contrib = count ? ` — contributed to ${count} finding(s)` : '';
        bodyLines.push(`- \`${result.model}\`: ${getStatusBadge(result)}${contrib}`);
    }
    bodyLines.push('');
    if (truncation.wasTruncated) {
        bodyLines.push('### Notes', '', `⚠️ ${truncation.truncationReason}`, '');
    }
    if (unmatched.length > 0) {
        bodyLines.push('### Additional Findings', '', '> Could not be placed inline (file/line not in current diff)', '');
        for (const finding of unmatched) {
            bodyLines.push(formatFindingListItem(finding), '');
        }
    }
    return bodyLines.join('\n');
}
/**
 * Post an inline PR review using pulls.createReview().
 * Unmatched findings fall back to the review body summary.
 */
export async function postInlineReview(config, findings, files, headSha, scannerResults, truncation, commentMarker) {
    const octokit = createOctokit(config.token);
    const { matched, unmatched } = validateFindings(findings, files);
    logger.info('Findings validation complete', {
        total: findings.length,
        matched: matched.length,
        unmatched: unmatched.length,
    });
    if (matched.length > 0) {
        const reviewComments = matched.map((f) => ({
            path: f.file,
            line: f.line,
            side: 'RIGHT',
            body: formatInlineComment(f),
        }));
        const reviewBody = buildInlineReviewBody(findings, unmatched, scannerResults, truncation);
        logger.info('Posting inline review', { commentsCount: reviewComments.length, headSha });
        await octokit.pulls.createReview({
            owner: config.owner,
            repo: config.repo,
            pull_number: config.prNumber,
            commit_id: headSha,
            event: 'COMMENT',
            body: reviewBody,
            comments: reviewComments,
        });
        logger.info('Inline review posted successfully');
        return;
    }
    // No matched findings — fall back to summary comment
    logger.info('No matched inline findings, falling back to summary');
    const judgeOutput = unmatched.length > 0
        ? unmatched.map(formatFindingListItem).join('\n\n')
        : 'No issues found in this PR. LGTM! ✅';
    await postOrUpdateComment(config, { judgeOutput, scannerResults, truncation }, commentMarker);
}
//# sourceMappingURL=comments.js.map