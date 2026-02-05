/**
 * GitHub Diff Module - PR Diff Fetch and Normalization
 */

import { Octokit } from '@octokit/rest';
import type { GitHubConfig, FileDiff, NormalizedDiff, PRInfo } from './types.js';
import { calculatePRSize } from '../config/models.js';
import { logger } from '../utils/logger.js';

/**
 * Create Octokit instance
 */
function createOctokit(token: string): Octokit {
  return new Octokit({ auth: token });
}

/**
 * Fetch PR information
 */
export async function getPRInfo(config: GitHubConfig): Promise<PRInfo> {
  const octokit = createOctokit(config.token);

  const { data } = await octokit.pulls.get({
    owner: config.owner,
    repo: config.repo,
    pull_number: config.prNumber,
  });

  return {
    number: data.number,
    title: data.title,
    body: data.body,
    state: data.state as PRInfo['state'],
    base: {
      ref: data.base.ref,
      sha: data.base.sha,
    },
    head: {
      ref: data.head.ref,
      sha: data.head.sha,
    },
    user: {
      login: data.user?.login ?? 'unknown',
    },
  };
}

/**
 * Fetch PR diff files
 */
export async function getPRFiles(config: GitHubConfig): Promise<FileDiff[]> {
  const octokit = createOctokit(config.token);

  const { data } = await octokit.pulls.listFiles({
    owner: config.owner,
    repo: config.repo,
    pull_number: config.prNumber,
    per_page: 100, // GitHub API limit
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
 * Normalize diff into a structured format
 */
export async function normalizeDiff(config: GitHubConfig): Promise<NormalizedDiff> {
  logger.info('Fetching PR diff', {
    owner: config.owner,
    repo: config.repo,
    prNumber: config.prNumber,
  });

  const [prInfo, files] = await Promise.all([getPRInfo(config), getPRFiles(config)]);

  // Build combined diff
  const combinedDiff = files
    .filter((f) => f.patch) // Only files with patches
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

  // Calculate size
  const totalAdditions = files.reduce((sum, f) => sum + f.additions, 0);
  const totalDeletions = files.reduce((sum, f) => sum + f.deletions, 0);
  const prSize = calculatePRSize(files.length, totalAdditions, totalDeletions);

  const normalized: NormalizedDiff = {
    files,
    combinedDiff,
    metadata: {
      title: prInfo.title,
      body: prInfo.body,
      baseRef: prInfo.base.ref,
      headRef: prInfo.head.ref,
      author: prInfo.user.login,
    },
    size: {
      filesChanged: files.length,
      totalAdditions,
      totalDeletions,
      category: prSize.category,
    },
  };

  logger.info('PR diff normalized', {
    filesChanged: normalized.size.filesChanged,
    additions: normalized.size.totalAdditions,
    deletions: normalized.size.totalDeletions,
    category: normalized.size.category,
    diffLength: combinedDiff.length,
  });

  return normalized;
}

/**
 * Get diff from GitHub Action context (environment variables)
 */
export function getConfigFromEnv(): GitHubConfig {
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
    prNumber: parseInt(prNumber, 10),
  };
}

/**
 * Filter files by extensions (for focused review)
 */
export function filterFilesByExtension(
  files: FileDiff[],
  extensions: string[]
): FileDiff[] {
  const extSet = new Set(extensions.map((e) => (e.startsWith('.') ? e : `.${e}`)));
  return files.filter((f) => {
    const ext = f.filename.slice(f.filename.lastIndexOf('.'));
    return extSet.has(ext);
  });
}

/**
 * Filter out test files
 */
export function filterOutTestFiles(files: FileDiff[]): FileDiff[] {
  const testPatterns = [
    /\.test\./,
    /\.spec\./,
    /__tests__/,
    /\.stories\./,
    /\.mock\./,
    /test\//,
    /tests\//,
    /spec\//,
  ];

  return files.filter((f) => !testPatterns.some((p) => p.test(f.filename)));
}
