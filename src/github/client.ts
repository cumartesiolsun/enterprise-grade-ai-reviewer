/**
 * Shared GitHub client factory.
 *
 * Composes @octokit/rest with the official retry and throttling plugins so
 * every GitHub API call in the action transparently survives transient
 * failures and primary/secondary rate limits (403 + Retry-After), instead of
 * failing the whole review on the first throttled request.
 */

import { Octokit } from '@octokit/rest';
import { retry } from '@octokit/plugin-retry';
import { throttling } from '@octokit/plugin-throttling';
import { logger } from '../utils/logger.js';

const OctokitWithPlugins = Octokit.plugin(retry, throttling);

export type GitHubClient = InstanceType<typeof OctokitWithPlugins>;

/** How many times a rate-limited request is retried before giving up. */
const MAX_RATE_LIMIT_RETRIES = 3;

/**
 * Create an authenticated Octokit instance with retry + throttling enabled.
 */
export function createGitHubClient(token: string): GitHubClient {
  return new OctokitWithPlugins({
    auth: token,
    throttle: {
      onRateLimit: (retryAfter, options, _octokit, retryCount) => {
        logger.warn('GitHub API rate limit hit', {
          retryAfter,
          retryCount,
          request: `${options.method} ${options.url}`,
        });
        return retryCount < MAX_RATE_LIMIT_RETRIES;
      },
      onSecondaryRateLimit: (retryAfter, options, _octokit, retryCount) => {
        logger.warn('GitHub API secondary rate limit hit', {
          retryAfter,
          retryCount,
          request: `${options.method} ${options.url}`,
        });
        return retryCount < MAX_RATE_LIMIT_RETRIES;
      },
    },
  });
}
