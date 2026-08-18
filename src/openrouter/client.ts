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
  /**
   * OpenRouter unified reasoning parameter (subset used by this client).
   * Only ever added on retries that follow an empty-content response —
   * first-attempt request bodies never include it.
   */
  reasoning?: {
    exclude?: boolean;
    effort?: 'low' | 'medium' | 'high';
  };
}

export interface OpenRouterResponse {
  id: string;
  choices: Array<{
    message: {
      role: string;
      /** May be a plain string or an array of content parts */
      content: string | Array<{ type?: string; text?: string }> | null;
      /** Hidden reasoning emitted by reasoning models — never review content */
      reasoning?: string;
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
  /**
   * Set only when the model legitimately returned an empty completion
   * (e.g. 'stop' with no hidden reasoning) — lets callers distinguish
   * "nothing to report" from an error. Undefined on non-empty results.
   */
  emptyReason?: string | undefined;
}

/** Maximum characters of an upstream error body embedded in Error messages */
const MAX_ERROR_BODY_CHARS = 300;

/** Upper bound for any single retry delay (covers Retry-After abuse) */
const MAX_RETRY_DELAY_MS = 30000;

/** Cap for adaptive max_tokens growth on empty-content retries */
const EMPTY_RETRY_MAX_TOKENS_CAP = 16000;

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
 * Error thrown when OpenRouter returns a 2xx response whose extracted
 * content is missing/empty and it is NOT a legitimate empty completion.
 * The common real-world cause: reasoning models burn the whole max_tokens
 * budget on hidden reasoning and return an empty/absent content field.
 *
 * Always retryable — the retry loop reacts by doubling max_tokens and
 * asking the provider to suppress reasoning output.
 *
 * The message surfaces verbatim in the PR comment's Sources line, so it
 * embeds finish_reason, completion_tokens, and reasoning presence/length
 * to make failures diagnosable at a glance.
 */
export class OpenRouterEmptyError extends Error {
  readonly retryable = true;
  readonly finishReason: string | undefined;
  readonly completionTokens: number | undefined;
  readonly reasoningLength: number | undefined;

  constructor(details: {
    finishReason: string | undefined;
    completionTokens: number | undefined;
    reasoningLength: number | undefined;
  }) {
    const reasoningInfo =
      details.reasoningLength !== undefined
        ? `present (${details.reasoningLength} chars)`
        : 'absent';
    super(
      `OpenRouter returned empty response ` +
        `(finish_reason=${details.finishReason ?? 'unknown'}, ` +
        `completion_tokens=${details.completionTokens ?? 'unknown'}, ` +
        `reasoning=${reasoningInfo})`
    );
    this.name = 'OpenRouterEmptyError';
    this.finishReason = details.finishReason;
    this.completionTokens = details.completionTokens;
    this.reasoningLength = details.reasoningLength;
  }
}

/**
 * Extract the review text from a message content field.
 * OpenRouter providers return either a plain string or an array of parts
 * like [{ type: 'text', text: '...' }] — join the text of text-type parts
 * and ignore everything else. Returns null when content is absent or has
 * an unrecognized shape.
 */
function extractTextContent(content: unknown): string | null {
  if (typeof content === 'string') return content;

  if (Array.isArray(content)) {
    let text = '';
    for (const part of content as unknown[]) {
      if (part === null || typeof part !== 'object') continue;
      const candidate = part as { type?: unknown; text?: unknown };
      if (candidate.type === 'text' && typeof candidate.text === 'string') {
        text += candidate.text;
      }
    }
    return text;
  }

  return null;
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
 * Interpret a 2xx OpenRouter response body.
 * - Non-empty extracted content → normal result (with 'length' warning)
 * - finish_reason 'content_filter' → non-retryable failure regardless of
 *   content: the provider blocked or censored the completion, so retrying
 *   (or trusting partial output) cannot help
 * - Empty content + finish_reason 'stop' + no hidden reasoning →
 *   legitimate empty completion: result with content '' and emptyReason
 * - Everything else empty (finish_reason 'length', reasoning present,
 *   missing choice/message, or any other/undefined finish_reason —
 *   interpreted conservatively as a failure, since we cannot prove the
 *   model had nothing to say) → OpenRouterEmptyError
 */
function interpretResponse(
  data: OpenRouterResponse,
  model: string,
  maxTokens: number
): OpenRouterResult {
  const choice = data.choices?.[0];
  const message = choice?.message;
  const content = extractTextContent(message?.content);
  const reasoning =
    typeof message?.reasoning === 'string' ? message.reasoning : undefined;
  const hasReasoning = reasoning !== undefined && reasoning.length > 0;
  const finishReason: string | undefined = choice?.finish_reason;
  const tokensUsed = data.usage?.total_tokens ?? 0;

  // Fail fast on provider content filtering: a plain (non-retryable) error —
  // adaptive retry cannot un-censor a completion, and partial filtered output
  // is not trustworthy review content.
  if (finishReason === 'content_filter') {
    throw new Error(
      `OpenRouter response blocked by provider content filter ` +
        `(finish_reason=content_filter, completion_tokens=${data.usage?.completion_tokens ?? 'unknown'})`
    );
  }

  if (message === undefined || content === null || content === '') {
    if (message !== undefined && finishReason === 'stop' && !hasReasoning) {
      // Legitimate "nothing to report" completion — upstream classifies
      // this as SKIPPED via the empty content.
      logger.debug('OpenRouter returned a legitimate empty completion', {
        model,
        finishReason,
      });
      return { content: '', tokensUsed, finishReason, emptyReason: finishReason };
    }

    throw new OpenRouterEmptyError({
      finishReason,
      completionTokens: data.usage?.completion_tokens,
      reasoningLength: hasReasoning ? reasoning.length : undefined,
    });
  }

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
    reasoningPresent: hasReasoning,
    reasoningLength: reasoning?.length ?? 0,
  });

  return { content, tokensUsed, finishReason };
}

/**
 * Call OpenRouter API with retry policy
 * - Retry only for 429, 5xx, network/timeout errors, and empty-content
 *   responses (OpenRouterEmptyError)
 * - 4 total attempts (1 initial + 3 retries), exponential backoff between
 *   them: 1s, 2s, 4s
 * - On 429, a Retry-After header (seconds form) is honored:
 *   max(retryAfter, backoff), capped at 30s
 * - Do not retry 400 (or any other non-429/non-5xx status), EXCEPT a 400
 *   for a request body that carried the `reasoning` parameter — that is
 *   treated as "provider rejects the reasoning field": it is dropped for
 *   all subsequent attempts (keeping the raised max_tokens) and retried
 * - After an empty-content response, the retry doubles max_tokens
 *   (compounding, capped at 16000) and adds
 *   `reasoning: { exclude: true, effort: 'low' }` so reasoning models
 *   stop burning the whole budget on hidden reasoning. First attempts
 *   never carry the reasoning field.
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

  let currentMaxTokens = maxTokens;
  let useReasoningExclude = false; // set after an empty-content response
  let reasoningRejected = false; // set after a 400 on a reasoning-carrying body

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const includeReasoning = useReasoningExclude && !reasoningRejected;
    const requestBody: OpenRouterRequest = {
      model,
      messages,
      max_tokens: currentMaxTokens,
      temperature,
    };
    if (includeReasoning) {
      requestBody.reasoning = { exclude: true, effort: 'low' };
    }

    try {
      const controller = new AbortController();
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      logger.debug(`OpenRouter request attempt ${attempt + 1}/${maxAttempts}`, {
        model,
        maxTokens: currentMaxTokens,
        excludeReasoning: includeReasoning,
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

      return interpretResponse(data, model, currentMaxTokens);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const isLastAttempt = attempt >= maxAttempts - 1;
      const backoffDelay = backoffDelays[attempt] ?? 4000;

      // Our own HTTP-status errors are classified by status only — they
      // must never be re-classified as network/timeout errors based on
      // whatever the upstream body happened to contain.
      if (lastError instanceof OpenRouterHttpError) {
        // A 400 for a body that carried the unified `reasoning` parameter
        // usually means this provider rejects that field. Instead of
        // hard-failing (400 is normally non-retryable), drop the field
        // for all subsequent attempts, keep the raised max_tokens, and
        // retry within the remaining attempt budget. A 400 on a body
        // without `reasoning` stays non-retryable as before.
        if (lastError.status === 400 && includeReasoning && !isLastAttempt) {
          reasoningRejected = true;
          logger.warn(
            'OpenRouter rejected the reasoning parameter (400), retrying without it',
            {
              attempt: attempt + 1,
              delay: backoffDelay,
              maxTokens: currentMaxTokens,
            }
          );
          await sleep(backoffDelay);
          continue;
        }

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

      // Empty-content responses are retryable: double the token budget
      // (the usual cause is a reasoning model burning all of max_tokens
      // on hidden reasoning) and ask the provider to suppress reasoning
      // on the next attempt. The doubling compounds across consecutive
      // empty retries, capped at EMPTY_RETRY_MAX_TOKENS_CAP.
      if (lastError instanceof OpenRouterEmptyError) {
        if (isLastAttempt) {
          throw lastError;
        }

        currentMaxTokens = Math.min(
          currentMaxTokens * 2,
          EMPTY_RETRY_MAX_TOKENS_CAP
        );
        useReasoningExclude = true;

        logger.warn('OpenRouter returned empty content, retrying with adjusted request', {
          error: lastError.message,
          attempt: attempt + 1,
          delay: backoffDelay,
          nextMaxTokens: currentMaxTokens,
          excludeReasoning: !reasoningRejected,
        });
        await sleep(backoffDelay);
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
