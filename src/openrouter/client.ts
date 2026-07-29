/**
 * OpenRouter API Client
 * MVP v0.1 - Exact spec implementation
 */

import { logger } from '../utils/logger.js';

export interface OpenRouterConfig {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OpenRouterRequest {
  model: string;
  messages: ChatMessage[];
  max_tokens: number;
  temperature: number;
}

export interface OpenRouterResponse {
  id: string;
  choices: Array<{
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface OpenRouterResult {
  content: string;
  tokensUsed: number;
  finishReason: string | undefined;
}

/** Maximum characters of an upstream error body embedded in Error messages */
const MAX_ERROR_BODY_CHARS = 300;

/** Upper bound for any single retry delay (covers Retry-After abuse) */
const MAX_RETRY_DELAY_MS = 30000;

/** Node/undici error codes that indicate a (retryable) network failure */
const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'ECONNRESET',
  'ETIMEDOUT',
]);

/**
 * Error thrown for non-2xx HTTP responses from OpenRouter.
 * Carries the status so the retry loop can classify it without
 * ever falling back to fragile message-substring matching.
 */
export class OpenRouterHttpError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;

  constructor(status: number, message: string, retryAfterMs?: number) {
    super(message);
    this.name = 'OpenRouterHttpError';
    this.status = status;
    this.retryable = isRetryableStatus(status);
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Check if HTTP status is retryable (429, 5xx)
 */
function isRetryableStatus(status: number): boolean {
  // Rate limit
  if (status === 429) return true;

  // Server errors (5xx)
  if (status >= 500 && status < 600) return true;

  return false;
}

/**
 * Timeout errors surface as AbortError (from our AbortController)
 */
function isTimeoutError(error: Error): boolean {
  return error.name === 'AbortError';
}

/**
 * Network errors: undici's fetch throws TypeError for network failures,
 * often with an `error.cause` carrying a typical syscall code.
 */
function isNetworkError(error: Error): boolean {
  if (error instanceof TypeError) return true;

  const cause: unknown = (error as { cause?: unknown }).cause;
  if (cause !== null && typeof cause === 'object' && 'code' in cause) {
    const code: unknown = (cause as { code?: unknown }).code;
    return typeof code === 'string' && NETWORK_ERROR_CODES.has(code);
  }

  return false;
}

/**
 * Truncate an upstream error body before embedding it in an Error message
 */
function truncateErrorBody(text: string): string {
  if (text.length <= MAX_ERROR_BODY_CHARS) return text;
  return `${text.slice(0, MAX_ERROR_BODY_CHARS)}…`;
}

/**
 * Parse a Retry-After header in seconds form. Returns milliseconds,
 * or undefined when the header is absent or unparseable.
 */
function parseRetryAfterMs(response: Response): number | undefined {
  const header = response.headers.get('retry-after');
  if (header === null) return undefined;

  const seconds = Number(header.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;

  return seconds * 1000;
}

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Call OpenRouter API with retry policy
 * - Retry only for 429, 5xx, and network/timeout errors
 * - 4 total attempts (1 initial + 3 retries), exponential backoff between
 *   them: 1s, 2s, 4s
 * - On 429, a Retry-After header (seconds form) is honored:
 *   max(retryAfter, backoff), capped at 30s
 * - Do not retry 400 (or any other non-429/non-5xx status)
 */
export async function callOpenRouter(
  config: OpenRouterConfig,
  model: string,
  messages: ChatMessage[],
  maxTokens: number,
  temperature: number = 0.3
): Promise<OpenRouterResult> {
  const url = `${config.baseUrl}/chat/completions`;
  const maxAttempts = 4; // 1 initial + 3 retries
  const backoffDelays = [1000, 2000, 4000]; // 1s, 2s, 4s

  const requestBody: OpenRouterRequest = {
    model,
    messages,
    max_tokens: maxTokens,
    temperature,
  };

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const controller = new AbortController();
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      logger.debug(`OpenRouter request attempt ${attempt + 1}/${maxAttempts}`, {
        model,
        maxTokens,
      });

      let response: Response;
      try {
        timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);
        response = await fetch(url, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${config.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        });
      } finally {
        // Always clear the abort timer — even when fetch rejects —
        // otherwise the pending timer keeps the process alive.
        clearTimeout(timeoutId);
      }

      if (!response.ok) {
        const errorText = truncateErrorBody(await response.text());
        const retryAfterMs =
          response.status === 429 ? parseRetryAfterMs(response) : undefined;

        throw new OpenRouterHttpError(
          response.status,
          `OpenRouter API error ${response.status}: ${errorText}`,
          retryAfterMs
        );
      }

      const data = (await response.json()) as OpenRouterResponse;

      const choice = data.choices?.[0];
      const content = choice?.message?.content;

      // Empty string ("") is a valid "nothing to report" completion —
      // only missing content (or a missing choice/message) is an error.
      if (content == null) {
        throw new Error('OpenRouter returned empty response');
      }

      const tokensUsed = data.usage?.total_tokens ?? 0;
      const finishReason: string | undefined = choice?.finish_reason;

      if (finishReason === 'length') {
        logger.warn(
          'OpenRouter response was truncated by max_tokens (finish_reason=length)',
          { model, maxTokens }
        );
      }

      logger.debug(`OpenRouter response received`, {
        model,
        tokensUsed,
        contentLength: content.length,
        finishReason,
      });

      return { content, tokensUsed, finishReason };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const isLastAttempt = attempt >= maxAttempts - 1;
      const backoffDelay = backoffDelays[attempt] ?? 4000;

      // Our own HTTP-status errors are classified by status only — they
      // must never be re-classified as network/timeout errors based on
      // whatever the upstream body happened to contain.
      if (lastError instanceof OpenRouterHttpError) {
        if (!lastError.retryable || isLastAttempt) {
          throw lastError;
        }

        let delayMs = backoffDelay;
        if (lastError.retryAfterMs !== undefined) {
          delayMs = Math.min(
            Math.max(lastError.retryAfterMs, backoffDelay),
            MAX_RETRY_DELAY_MS
          );
        }

        logger.warn(`OpenRouter retryable error ${lastError.status}, retrying...`, {
          attempt: attempt + 1,
          delay: delayMs,
        });
        await sleep(delayMs);
        continue;
      }

      // Retry for timeout (AbortError) or network errors
      if ((isTimeoutError(lastError) || isNetworkError(lastError)) && !isLastAttempt) {
        logger.warn(`OpenRouter network/timeout error, retrying...`, {
          error: lastError.message,
          attempt: attempt + 1,
          delay: backoffDelay,
        });
        await sleep(backoffDelay);
        continue;
      }

      // Not retryable or max attempts reached
      throw lastError;
    }
  }

  throw lastError ?? new Error('OpenRouter request failed after retries');
}
