/**
 * Retry utility with exponential backoff
 */

import { logger } from './logger.js';

export interface RetryOptions {
  /** Maximum number of attempts */
  maxAttempts: number;
  /** Initial delay in milliseconds */
  initialDelayMs: number;
  /** Maximum delay in milliseconds */
  maxDelayMs: number;
  /** Backoff multiplier */
  backoffMultiplier: number;
  /** Whether to add jitter to delays */
  jitter: boolean;
  /** Function to determine if error is retryable */
  isRetryable?: (error: unknown) => boolean;
}

const DEFAULT_OPTIONS: RetryOptions = {
  maxAttempts: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
  jitter: true,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function calculateDelay(attempt: number, options: RetryOptions): number {
  let delay = options.initialDelayMs * Math.pow(options.backoffMultiplier, attempt - 1);
  delay = Math.min(delay, options.maxDelayMs);

  if (options.jitter) {
    // Add random jitter between 0-25% of the delay
    const jitterAmount = delay * 0.25 * Math.random();
    delay += jitterAmount;
  }

  return Math.round(delay);
}

function isRetryableError(error: unknown): boolean {
  // Retry on network errors and rate limits
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return (
      message.includes('timeout') ||
      message.includes('econnreset') ||
      message.includes('econnrefused') ||
      message.includes('rate limit') ||
      message.includes('429') ||
      message.includes('503') ||
      message.includes('502')
    );
  }
  return false;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: Partial<RetryOptions> = {}
): Promise<T> {
  const opts: RetryOptions = { ...DEFAULT_OPTIONS, ...options };
  const shouldRetry = opts.isRetryable ?? isRetryableError;

  let lastError: unknown;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt === opts.maxAttempts || !shouldRetry(error)) {
        throw error;
      }

      const delay = calculateDelay(attempt, opts);
      logger.warn(`Attempt ${attempt}/${opts.maxAttempts} failed, retrying in ${delay}ms`, {
        error: String(error),
      });

      await sleep(delay);
    }
  }

  // This should never be reached, but TypeScript needs it
  throw lastError;
}

/** Create a retry wrapper with preset options */
export function createRetrier(options: Partial<RetryOptions>) {
  return <T>(fn: () => Promise<T>): Promise<T> => withRetry(fn, options);
}
