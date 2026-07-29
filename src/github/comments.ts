/**
 * GitHub Comments Module - Summary and inline review posting
 */

import type { Octokit } from '@octokit/rest';
import { createGitHubClient } from './client.js';
import type { GitHubConfig, TruncationInfo, FileDiff } from './diff.js';
import { parseDiffHunks, isLineInDiff } from './diff.js';
import type { ScannerResult } from '../review/scanner.js';
import type { InlineFinding } from '../review/judge.js';
import { logger } from '../utils/logger.js';

export interface ReviewCommentData {
  judgeOutput: string;
  scannerResults: ScannerResult[];
  truncation: TruncationInfo;
}

// Max lengths for sanitized model-generated text
const MAX_JUDGE_OUTPUT_LENGTH = 60000;
const MAX_TITLE_LENGTH = 300;
const MAX_BODY_LENGTH = 4000;
const MAX_SOURCES_LENGTH = 200;

/**
 * Sanitize model-generated text before posting it to GitHub.
 *
 * - Strips HTML comments (including unterminated ones) so injected hidden
 *   payloads/markers cannot survive. Our own comment marker is appended by the
 *   templates AFTER sanitization, so it is unaffected.
 * - Neutralizes @-mentions by wrapping them in backticks so the action cannot
 *   be used to ping arbitrary users/teams.
 * - Truncates to maxLength (with a trailing ellipsis).
 */
export function sanitizeModelOutput(text: string, maxLength: number): string {
  // Strip HTML comments, non-greedy; an unterminated "<!--" is stripped to end
  let sanitized = text.replace(/<!--[\s\S]*?(?:-->|$)/g, '');

  // Neutralize @-mentions (skip ones already preceded by a backtick)
  sanitized = sanitized.replace(/(^|[^\w`])@([a-zA-Z0-9-]+)/g, '$1`@$2`');

  if (sanitized.length > maxLength) {
    sanitized = `${sanitized.slice(0, maxLength)}…`;
  }

  return sanitized;
}

/**
 * Check whether a comment author is a bot (GitHub App or *[bot] account).
 * Used to ignore marker/inline comments planted by arbitrary PR participants.
 */
interface CommentAuthor {
  login?: string | undefined;
  type?: string | undefined;
}

function isBotAuthor(user: CommentAuthor | null | undefined): boolean {
  if (!user) return false;
  return user.type === 'Bot' || user.login?.endsWith('[bot]') === true;
}

/**
 * Get status badge for scanner result
 */
function getStatusBadge(result: ScannerResult): string {
  switch (result.status) {
    case 'OK':
      return '✅ OK';
    case 'SKIPPED':
      return '⏭️ SKIPPED (empty/NO_FINDINGS)';
    case 'FAILED':
      return `❌ FAILED (${result.error ?? 'unknown error'})`;
    default:
      return '❓ UNKNOWN';
  }
}

/**
 * Parse "(by: model-a, model-b)" tags from free-form judge output
 * and count how many findings each model contributed to.
 */
function countContributionsFromText(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  // Note: no \s* before the capture — models are trimmed below, and the
  // simpler pattern avoids super-linear backtracking.
  const byTagRegex = /\(by:([^)]+)\)/g;

  let match: RegExpExecArray | null;
  while ((match = byTagRegex.exec(text)) !== null) {
    const models = match[1]!.split(',').map((m) => m.trim()).filter((m) => m.length > 0);
    for (const model of models) {
      counts.set(model, (counts.get(model) ?? 0) + 1);
    }
  }

  return counts;
}

/**
 * Build the comment body with marker
 */
export function buildCommentBody(
  data: ReviewCommentData,
  commentMarker: string
): string {
  // Sanitize model output first — our own marker is added after, so it survives
  const judgeOutput = sanitizeModelOutput(data.judgeOutput, MAX_JUDGE_OUTPUT_LENGTH);
  const contributions = countContributionsFromText(judgeOutput);

  const sections: string[] = [
    '## Enterprise AI Review',
    '',
    `<!-- ${commentMarker} -->`,
    '',
    '### Final Review',
    '',
    judgeOutput,
    '',
    '### Sources',
    '',
  ];

  // Add scanner results with status badges and contribution counts
  for (const result of data.scannerResults) {
    const count = contributions.get(result.model);
    const contrib = count ? ` — contributed to ${count} finding(s)` : '';
    sections.push(`- \`${result.model}\` (${result.role}): ${getStatusBadge(result)}${contrib}`);
  }
  sections.push('');

  // Notes section (if truncation occurred)
  if (data.truncation.wasTruncated) {
    sections.push(
      '### Notes',
      '',
      `⚠️ ${data.truncation.truncationReason}`,
      '',
      `- Files found: ${data.truncation.filesFound}`,
      `- Files reviewed: ${data.truncation.filesReviewed}`,
      `- Original size: ${data.truncation.originalChars} chars`,
      `- Reviewed size: ${data.truncation.truncatedChars} chars`,
      ''
    );
  }

  return sections.join('\n');
}

/**
 * Find existing comment with the marker.
 * Paginates through ALL comments (marker comment may be beyond page 1) and
 * only considers bot-authored comments so a participant cannot hijack the
 * review slot by pre-posting a comment containing the marker.
 */
export async function findExistingComment(
  octokit: Octokit,
  config: GitHubConfig,
  commentMarker: string
): Promise<number | null> {
  const markerPattern = `<!-- ${commentMarker} -->`;

  // Fetch all comments on the PR (all pages)
  const comments = await octokit.paginate(octokit.issues.listComments, {
    owner: config.owner,
    repo: config.repo,
    issue_number: config.prNumber,
    per_page: 100,
  });

  // Find bot-authored comment containing the marker
  for (const comment of comments) {
    if (!isBotAuthor(comment.user)) continue;
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
export async function postOrUpdateComment(
  config: GitHubConfig,
  data: ReviewCommentData,
  commentMarker: string
): Promise<void> {
  const octokit = createGitHubClient(config.token);
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
  } else {
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

// --- Inline review mode ---

interface ValidatedFindings {
  matched: InlineFinding[];
  unmatched: InlineFinding[];
}

/**
 * Validate findings against actual PR diff files.
 * Findings whose file/line doesn't match the diff are separated as "unmatched".
 */
function validateFindings(
  findings: InlineFinding[],
  files: FileDiff[]
): ValidatedFindings {
  const matched: InlineFinding[] = [];
  const unmatched: InlineFinding[] = [];

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
    } else {
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
function getSeverityEmoji(severity: InlineFinding['severity']): string {
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
function formatSourcesTag(sources: string[] | undefined): string {
  if (!sources || sources.length === 0) return '';
  return `\n\n_by: ${sanitizeModelOutput(sources.join(', '), MAX_SOURCES_LENGTH)}_`;
}

function formatInlineComment(finding: InlineFinding): string {
  const title = sanitizeModelOutput(finding.title, MAX_TITLE_LENGTH);
  const body = sanitizeModelOutput(finding.body, MAX_BODY_LENGTH);
  return `${getSeverityEmoji(finding.severity)} **${title}**\n\n${body}${formatSourcesTag(finding.sources)}`;
}

/**
 * Format a finding as a markdown list item for summary sections.
 */
function formatFindingListItem(finding: InlineFinding): string {
  const emoji = getSeverityEmoji(finding.severity);
  const title = sanitizeModelOutput(finding.title, MAX_TITLE_LENGTH);
  const body = sanitizeModelOutput(finding.body, MAX_BODY_LENGTH);
  const sourcesTag = finding.sources?.length
    ? ` (by: ${sanitizeModelOutput(finding.sources.join(', '), MAX_SOURCES_LENGTH)})`
    : '';
  return `- ${emoji} **${title}** (\`${finding.file}:${finding.line}\`)${sourcesTag}\n  ${body}`;
}

/**
 * Build the review body (summary section) for an inline review.
 */
function countContributions(findings: InlineFinding[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const f of findings) {
    if (f.sources) {
      for (const model of f.sources) {
        counts.set(model, (counts.get(model) ?? 0) + 1);
      }
    }
  }
  return counts;
}

function buildInlineReviewBody(
  matched: InlineFinding[],
  unmatched: InlineFinding[],
  scannerResults: ScannerResult[],
  truncation: TruncationInfo
): string {
  const allFindings = [...matched, ...unmatched];
  const contributions = countContributions(allFindings);

  const bodyLines: string[] = [
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
    bodyLines.push(`- \`${result.model}\` (${result.role}): ${getStatusBadge(result)}${contrib}`);
  }
  bodyLines.push('');

  if (truncation.wasTruncated) {
    bodyLines.push(
      '### Notes',
      '',
      `⚠️ ${truncation.truncationReason}`,
      ''
    );
  }

  if (unmatched.length > 0) {
    bodyLines.push(
      '### Additional Findings',
      '',
      '> Could not be placed inline (file/line not in current diff)',
      ''
    );

    for (const finding of unmatched) {
      bodyLines.push(formatFindingListItem(finding), '');
    }
  }

  return bodyLines.join('\n');
}

/**
 * Extract the finding title from a previously posted inline comment body.
 * formatInlineComment() writes bodies as `EMOJI **title**\n\n...`.
 */
function extractTitleFromCommentBody(body: string | undefined): string | null {
  if (!body) return null;
  const match = /\*\*(.+?)\*\*/.exec(body);
  return match?.[1] ?? null;
}

function findingKey(path: string, line: number, title: string): string {
  return `${path}:${line}:${title}`;
}

/**
 * Filter out matched findings that were already posted as inline review
 * comments by this action (or another bot) on a previous run, so repeated
 * pushes don't pile up duplicate inline comments.
 */
async function filterAlreadyPostedFindings(
  octokit: Octokit,
  config: GitHubConfig,
  matched: InlineFinding[]
): Promise<InlineFinding[]> {
  const existingComments = await octokit.paginate(octokit.pulls.listReviewComments, {
    owner: config.owner,
    repo: config.repo,
    pull_number: config.prNumber,
    per_page: 100,
  });

  const existingKeys = new Set<string>();
  for (const comment of existingComments) {
    if (!isBotAuthor(comment.user)) continue;
    if (comment.line === undefined || comment.line === null) continue;
    const title = extractTitleFromCommentBody(comment.body);
    if (title === null) continue;
    existingKeys.add(findingKey(comment.path, comment.line, title));
  }

  return matched.filter((finding) => {
    const key = findingKey(
      finding.file,
      finding.line,
      sanitizeModelOutput(finding.title, MAX_TITLE_LENGTH)
    );
    if (existingKeys.has(key)) {
      logger.info('Skipping already-posted inline finding', {
        file: finding.file,
        line: finding.line,
      });
      return false;
    }
    return true;
  });
}

/**
 * Post an inline PR review using pulls.createReview().
 * Unmatched findings fall back to the review body summary.
 */
export async function postInlineReview(
  config: GitHubConfig,
  findings: InlineFinding[],
  files: FileDiff[],
  headSha: string,
  scannerResults: ScannerResult[],
  truncation: TruncationInfo,
  commentMarker: string
): Promise<void> {
  const octokit = createGitHubClient(config.token);
  const { matched, unmatched } = validateFindings(findings, files);

  logger.info('Findings validation complete', {
    total: findings.length,
    matched: matched.length,
    unmatched: unmatched.length,
  });

  // Idempotency: skip matched findings already posted inline on a previous run
  let newMatched = matched;
  if (matched.length > 0) {
    newMatched = await filterAlreadyPostedFindings(octokit, config, matched);

    if (newMatched.length === 0 && unmatched.length === 0) {
      logger.info('All inline findings already posted, nothing new to post');
      return;
    }
  }

  if (newMatched.length > 0) {
    const reviewComments = newMatched.map((f) => ({
      path: f.file,
      line: f.line,
      side: 'RIGHT' as const,
      body: formatInlineComment(f),
    }));

    const reviewBody = buildInlineReviewBody(newMatched, unmatched, scannerResults, truncation);

    logger.info('Posting inline review', { commentsCount: reviewComments.length, headSha });

    try {
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
    } catch (error) {
      // 422s can occur on edge cases in line placement — don't fail the run,
      // fall back to a summary comment carrying all findings instead.
      logger.warn('Failed to create inline review, falling back to summary comment', {
        error: error instanceof Error ? error.message : String(error),
      });

      const judgeOutput = [...newMatched, ...unmatched]
        .map(formatFindingListItem)
        .join('\n\n');

      await postOrUpdateComment(
        config,
        { judgeOutput, scannerResults, truncation },
        commentMarker
      );
    }
    return;
  }

  // No (new) matched findings — fall back to summary comment
  logger.info('No matched inline findings, falling back to summary');

  const judgeOutput = unmatched.length > 0
    ? unmatched.map(formatFindingListItem).join('\n\n')
    : 'No issues found in this PR. LGTM! ✅';

  await postOrUpdateComment(
    config,
    { judgeOutput, scannerResults, truncation },
    commentMarker
  );
}
