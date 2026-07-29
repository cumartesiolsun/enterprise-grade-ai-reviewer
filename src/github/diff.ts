/**
 * GitHub Diff Module - PR Diff Fetch and Normalization
 * With exclude-paths filtering, max_files and max_chars truncation
 */

import { readFileSync } from 'node:fs';
import { createGitHubClient } from './client.js';
import { logger } from '../utils/logger.js';

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
  /** Number of files skipped via exclude-paths patterns (optional, additive) */
  filesExcluded?: number | undefined;
  /** Number of files with no reviewable patch, e.g. binary or too large (optional, additive) */
  filesWithoutPatch?: number | undefined;
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
export async function getPRHeadSha(config: GitHubConfig): Promise<string> {
  const octokit = createGitHubClient(config.token);

  const { data } = await octokit.pulls.get({
    owner: config.owner,
    repo: config.repo,
    pull_number: config.prNumber,
  });

  return data.head.sha;
}

/**
 * Fetch PR diff files (paginated — PRs can have more than 100 files)
 */
export async function getPRFiles(config: GitHubConfig): Promise<FileDiff[]> {
  const octokit = createGitHubClient(config.token);

  const data = await octokit.paginate(octokit.pulls.listFiles, {
    owner: config.owner,
    repo: config.repo,
    pull_number: config.prNumber,
    per_page: 100,
  });

  return data.map((file) => ({
    filename: file.filename,
    status: file.status as FileDiff['status'],
    additions: file.additions,
    deletions: file.deletions,
    patch: file.patch,
    previousFilename: file.previous_filename,
  }));
}

/**
 * Build combined diff string from files
 */
function buildCombinedDiff(files: FileDiff[]): string {
  return files
    .filter((f) => f.patch)
    .map((f) => {
      const header = `diff --git a/${f.filename} b/${f.filename}`;
      const status =
        f.status === 'added'
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

// --- Glob matching (dependency-free) for exclude-paths ---

/**
 * Convert a glob pattern to an anchored RegExp.
 * - `**` matches any characters including `/` (a `**` / segment also matches
 *   zero directories, so `**\/foo` matches both `foo` and `a/b/foo`)
 * - `*` matches any characters except `/`
 * - `?` matches a single non-`/` character
 * - All regex metacharacters are escaped; the pattern is anchored at both ends.
 */
export function globToRegExp(pattern: string): RegExp {
  let source = '^';
  let i = 0;

  while (i < pattern.length) {
    const ch = pattern[i]!;

    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          // '**/' — zero or more whole directory segments
          source += '(?:.*/)?';
          i += 3;
        } else {
          // '**' — anything, including '/'
          source += '.*';
          i += 2;
        }
      } else {
        // '*' — anything except '/'
        source += '[^/]*';
        i += 1;
      }
    } else if (ch === '?') {
      source += '[^/]';
      i += 1;
    } else if ('\\^$.|+()[]{}'.includes(ch)) {
      source += `\\${ch}`;
      i += 1;
    } else {
      source += ch;
      i += 1;
    }
  }

  return new RegExp(`${source}$`);
}

/**
 * Check whether a path matches any of the given glob patterns.
 * A pattern without '/' also matches against the path's basename
 * (so `*.min.js` excludes `src/app.min.js`).
 */
export function isPathExcluded(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    const regex = globToRegExp(pattern);
    if (regex.test(path)) {
      return true;
    }
    if (!pattern.includes('/')) {
      const basename = path.split('/').pop() ?? path;
      return regex.test(basename);
    }
    return false;
  });
}

// --- Pure truncation / limiting logic (exported for testability) ---

export interface DiffLimitsResult {
  files: FileDiff[];
  combinedDiff: string;
  truncation: TruncationInfo;
}

/**
 * Apply exclude-paths filtering, max_files and max_chars limits to a file list.
 * Pure function: no I/O, fully unit-testable.
 */
export function applyLimits(
  allFiles: FileDiff[],
  maxFiles: number,
  maxChars: number,
  excludePatterns?: string[]
): DiffLimitsResult {
  const filesFound = allFiles.length;
  const reasons: string[] = [];

  // Step 1: exclude-paths filtering (before max-files logic)
  let files = allFiles;
  let filesExcluded = 0;
  if (excludePatterns !== undefined && excludePatterns.length > 0) {
    files = files.filter((f) => !isPathExcluded(f.filename, excludePatterns));
    filesExcluded = filesFound - files.length;
    if (filesExcluded > 0) {
      reasons.push(`excluded ${filesExcluded} file(s) by exclude-paths`);
      logger.info('Excluded files by exclude-paths', {
        excluded: filesExcluded,
        remaining: files.length,
      });
    }
  }

  // Step 2: count files without a reviewable patch (binary or too large).
  // These are silently dropped by buildCombinedDiff, so surface them.
  const filesWithoutPatch = files.filter((f) => !f.patch).length;
  if (filesWithoutPatch > 0) {
    reasons.push(
      `${filesWithoutPatch} file(s) had no reviewable diff (binary or too large)`
    );
    logger.info('Files without reviewable patch', { count: filesWithoutPatch });
  }

  // Step 3: limit number of files
  const candidateCount = files.length;
  if (files.length > maxFiles) {
    // Prioritize files with patches, then by change size
    files = files
      .filter((f) => f.patch)
      .sort((a, b) => (b.additions + b.deletions) - (a.additions + a.deletions))
      .slice(0, maxFiles);
    reasons.push(`Limited to ${maxFiles} files (found ${candidateCount})`);
    logger.info('Truncated file count', { found: candidateCount, limited: maxFiles });
  }

  // Step 4: build diff and check char limit
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

    reasons.push(`Truncated to ${maxChars} chars (original ${originalChars})`);
    logger.info('Truncated diff content', {
      original: originalChars,
      truncated: combinedDiff.length,
    });
  }

  const truncation: TruncationInfo = {
    filesFound,
    filesReviewed: files.filter((f) => f.patch).length,
    originalChars,
    truncatedChars: combinedDiff.length,
    wasTruncated: reasons.length > 0,
    truncationReason: reasons.length > 0 ? reasons.join('; ') : undefined,
    ...(filesExcluded > 0 ? { filesExcluded } : {}),
    ...(filesWithoutPatch > 0 ? { filesWithoutPatch } : {}),
  };

  return { files, combinedDiff, truncation };
}

/**
 * Normalize diff with exclude-paths filtering and max_files/max_chars truncation
 */
export async function normalizeDiff(
  config: GitHubConfig,
  maxFiles: number,
  maxChars: number,
  excludePatterns?: string[]
): Promise<NormalizedDiff> {
  logger.info('Fetching PR diff', {
    owner: config.owner,
    repo: config.repo,
    prNumber: config.prNumber,
  });

  const [headSha, allFiles] = await Promise.all([
    getPRHeadSha(config),
    getPRFiles(config),
  ]);

  const { files, combinedDiff, truncation } = applyLimits(
    allFiles,
    maxFiles,
    maxChars,
    excludePatterns
  );

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

// --- Hunk validation utilities for inline review mode ---

export interface DiffHunkRange {
  startLine: number;
  endLine: number;
}

/**
 * Parse diff hunk headers to extract valid new-side line ranges.
 * Hunk headers: @@ -old_start,old_count +new_start,new_count @@
 */
export function parseDiffHunks(patch: string): DiffHunkRange[] {
  const ranges: DiffHunkRange[] = [];
  const hunkHeaderRegex = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;

  let match: RegExpExecArray | null;
  while ((match = hunkHeaderRegex.exec(patch)) !== null) {
    const startLine = Number.parseInt(match[1]!, 10);
    const count = match[2] !== undefined ? Number.parseInt(match[2], 10) : 1;
    ranges.push({
      startLine,
      endLine: startLine + count - 1,
    });
  }

  return ranges;
}

/**
 * Check whether a line number falls within any diff hunk range.
 */
export function isLineInDiff(line: number, hunks: DiffHunkRange[]): boolean {
  return hunks.some((h) => line >= h.startLine && line <= h.endLine);
}

// --- Environment / event resolution ---

/**
 * Read and parse the GitHub event payload at GITHUB_EVENT_PATH.
 * Returns undefined when the path is unset, and warns-and-returns-undefined
 * when the file is unreadable or not valid JSON.
 */
function readEventPayload(
  env: Record<string, string | undefined>
): Record<string, unknown> | undefined {
  const eventPath = env['GITHUB_EVENT_PATH'];
  if (!eventPath) {
    return undefined;
  }

  try {
    return JSON.parse(readFileSync(eventPath, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    logger.warn('Could not read GitHub event payload', {
      eventPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/** Maximum number of PR title/body characters passed to the models. */
const MAX_PR_CONTEXT_CHARS = 4000;

/**
 * Extract PR title and body from the GitHub event payload as review context.
 *
 * Produces `Title: <title>\n\n<body>`, omitting either part when absent.
 * HTML comments are stripped (PR templates leave comment noise, and hidden
 * comments are an injection vector), including an unterminated `<!--` running
 * to the end. The result is trimmed and hard-truncated to
 * MAX_PR_CONTEXT_CHARS. Never throws — any failure yields ''.
 */
export function getPRContextFromEnv(
  env: Record<string, string | undefined> = process.env
): string {
  try {
    const payload = readEventPayload(env);
    if (!payload) {
      return '';
    }

    const pullRequest =
      typeof payload['pull_request'] === 'object' && payload['pull_request'] !== null
        ? (payload['pull_request'] as Record<string, unknown>)
        : undefined;
    if (!pullRequest) {
      return '';
    }

    const title = typeof pullRequest['title'] === 'string' ? pullRequest['title'] : '';
    const body = typeof pullRequest['body'] === 'string' ? pullRequest['body'] : '';

    const parts: string[] = [];
    if (title.trim().length > 0) {
      parts.push(`Title: ${title}`);
    }
    if (body.trim().length > 0) {
      parts.push(body);
    }
    if (parts.length === 0) {
      return '';
    }

    // Strip HTML comments (non-greedy), including an unterminated '<!--'
    // that runs to the end of the text.
    const stripped = parts.join('\n\n').replace(/<!--[\s\S]*?(?:-->|$)/g, '');

    return stripped.trim().slice(0, MAX_PR_CONTEXT_CHARS);
  } catch (error) {
    logger.warn('Could not extract PR context from event payload', {
      error: error instanceof Error ? error.message : String(error),
    });
    return '';
  }
}

/**
 * Extract a positive integer PR number from an event payload
 * (.pull_request.number ?? .number), or undefined when absent/invalid.
 */
function readPrNumberFromPayload(
  payload: Record<string, unknown>
): number | undefined {
  const pullRequest =
    typeof payload['pull_request'] === 'object' && payload['pull_request'] !== null
      ? (payload['pull_request'] as Record<string, unknown>)
      : undefined;
  const eventNumber = pullRequest?.['number'] ?? payload['number'];
  if (
    typeof eventNumber === 'number' &&
    Number.isInteger(eventNumber) &&
    eventNumber > 0
  ) {
    return eventNumber;
  }
  return undefined;
}

/**
 * Resolve the PR number from the environment:
 * 1. Explicit PR_NUMBER env var
 * 2. GitHub event payload at GITHUB_EVENT_PATH (.pull_request.number ?? .number)
 * 3. GITHUB_REF_NAME, only when it strictly matches "<digits>/merge"
 */
export function resolvePrNumber(env: Record<string, string | undefined>): number {
  // 1. Explicit PR_NUMBER
  const explicit = env['PR_NUMBER'];
  if (explicit !== undefined && explicit.trim().length > 0) {
    const trimmed = explicit.trim();
    if (!/^\d+$/.test(trimmed)) {
      throw new Error(`PR_NUMBER must be a positive integer, got '${explicit}'`);
    }
    const parsed = Number.parseInt(trimmed, 10);
    if (parsed <= 0) {
      throw new Error(`PR_NUMBER must be a positive integer, got '${explicit}'`);
    }
    return parsed;
  }

  // 2. Event payload
  const eventPath = env['GITHUB_EVENT_PATH'];
  if (eventPath) {
    const payload = readEventPayload(env);
    if (payload) {
      const eventNumber = readPrNumberFromPayload(payload);
      if (eventNumber !== undefined) {
        return eventNumber;
      }
      logger.warn('Event payload has no PR number', { eventPath });
    }
  }

  // 3. Strict ref-name match ("123/merge" only — never digits inside branch names)
  const refName = env['GITHUB_REF_NAME'];
  if (refName) {
    const refMatch = /^(\d+)\/merge$/.exec(refName);
    if (refMatch?.[1]) {
      return Number.parseInt(refMatch[1], 10);
    }
  }

  throw new Error(
    'Could not determine PR number: set PR_NUMBER, run on a pull_request event ' +
      '(GITHUB_EVENT_PATH), or use a "<number>/merge" GITHUB_REF_NAME'
  );
}

/**
 * Get GitHub config from a token and environment variables.
 * The token is passed explicitly by the caller (action input) instead of
 * being read from a mutated process.env.
 */
export function getConfigFromEnv(
  token: string,
  env: Record<string, string | undefined> = process.env
): GitHubConfig {
  if (!token) {
    throw new Error('GitHub token is required');
  }

  const repository = env['GITHUB_REPOSITORY'];
  if (!repository) {
    throw new Error('GITHUB_REPOSITORY environment variable is required');
  }

  const [owner, repo] = repository.split('/');
  if (!owner || !repo) {
    throw new Error('Invalid GITHUB_REPOSITORY format (expected owner/repo)');
  }

  return {
    token,
    owner,
    repo,
    prNumber: resolvePrNumber(env),
  };
}
