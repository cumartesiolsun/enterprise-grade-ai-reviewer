/**
 * OpenRouter API Client
 * MVP v0.1 - Exact spec implementation
 */
import { logger } from '../utils/logger.js';
/**
 * Check if error is retryable (429, 5xx, network/timeout)
 */
function isRetryableStatus(status) {
    // Rate limit
    if (status === 429)
        return true;
    // Server errors (5xx)
    if (status >= 500 && status < 600)
        return true;
    return false;
}
/**
 * Sleep for specified milliseconds
 */
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
/**
 * Call OpenRouter API with retry policy
 * - Retry only for 429, 5xx, and network/timeout errors
 * - Exponential backoff: 1s, 2s, 4s (max 3 tries)
 * - Do not retry 400
 */
export async function callOpenRouter(config, model, messages, maxTokens, temperature = 0.3) {
    const url = `${config.baseUrl}/chat/completions`;
    const maxRetries = 3;
    const backoffDelays = [1000, 2000, 4000]; // 1s, 2s, 4s
    const requestBody = {
        model,
        messages,
        max_tokens: maxTokens,
        temperature,
    };
    let lastError = null;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);
            logger.debug(`OpenRouter request attempt ${attempt + 1}/${maxRetries}`, {
                model,
                maxTokens,
            });
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${config.apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(requestBody),
                signal: controller.signal,
            });
            clearTimeout(timeoutId);
            if (!response.ok) {
                const errorText = await response.text();
                // Don't retry 400 errors - fail immediately
                if (response.status === 400) {
                    throw new Error(`OpenRouter API error 400: ${errorText}`);
                }
                // Check if retryable (429, 5xx)
                if (isRetryableStatus(response.status) && attempt < maxRetries - 1) {
                    logger.warn(`OpenRouter retryable error ${response.status}, retrying...`, {
                        attempt: attempt + 1,
                        delay: backoffDelays[attempt],
                    });
                    await sleep(backoffDelays[attempt]);
                    continue;
                }
                throw new Error(`OpenRouter API error ${response.status}: ${errorText}`);
            }
            const data = (await response.json());
            if (!data.choices?.[0]?.message?.content) {
                throw new Error('OpenRouter returned empty response');
            }
            const content = data.choices[0].message.content;
            const tokensUsed = data.usage?.total_tokens ?? 0;
            logger.debug(`OpenRouter response received`, {
                model,
                tokensUsed,
                contentLength: content.length,
            });
            return { content, tokensUsed };
        }
        catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
            // Check if it's an abort/timeout error
            const isTimeout = lastError.name === 'AbortError' ||
                lastError.message.includes('abort') ||
                lastError.message.includes('timeout');
            // Check if it's a network error
            const isNetworkError = lastError.message.includes('fetch') ||
                lastError.message.includes('network') ||
                lastError.message.includes('ECONNREFUSED') ||
                lastError.message.includes('ENOTFOUND');
            // Retry for timeout or network errors
            if ((isTimeout || isNetworkError) && attempt < maxRetries - 1) {
                logger.warn(`OpenRouter network/timeout error, retrying...`, {
                    error: lastError.message,
                    attempt: attempt + 1,
                    delay: backoffDelays[attempt],
                });
                await sleep(backoffDelays[attempt]);
                continue;
            }
            // Not retryable or max retries reached
            throw lastError;
        }
    }
    throw lastError ?? new Error('OpenRouter request failed after retries');
}
//# sourceMappingURL=client.js.map