"use strict";
/**
 * Retry utility with exponential backoff
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.withRetry = withRetry;
exports.createRetrier = createRetrier;
const logger_js_1 = require("./logger.js");
const DEFAULT_OPTIONS = {
    maxAttempts: 3,
    initialDelayMs: 1000,
    maxDelayMs: 30000,
    backoffMultiplier: 2,
    jitter: true,
};
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function calculateDelay(attempt, options) {
    let delay = options.initialDelayMs * Math.pow(options.backoffMultiplier, attempt - 1);
    delay = Math.min(delay, options.maxDelayMs);
    if (options.jitter) {
        // Add random jitter between 0-25% of the delay
        const jitterAmount = delay * 0.25 * Math.random();
        delay += jitterAmount;
    }
    return Math.round(delay);
}
function isRetryableError(error) {
    // Retry on network errors and rate limits
    if (error instanceof Error) {
        const message = error.message.toLowerCase();
        return (message.includes('timeout') ||
            message.includes('econnreset') ||
            message.includes('econnrefused') ||
            message.includes('rate limit') ||
            message.includes('429') ||
            message.includes('503') ||
            message.includes('502'));
    }
    return false;
}
async function withRetry(fn, options = {}) {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const shouldRetry = opts.isRetryable ?? isRetryableError;
    let lastError;
    for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
        try {
            return await fn();
        }
        catch (error) {
            lastError = error;
            if (attempt === opts.maxAttempts || !shouldRetry(error)) {
                throw error;
            }
            const delay = calculateDelay(attempt, opts);
            logger_js_1.logger.warn(`Attempt ${attempt}/${opts.maxAttempts} failed, retrying in ${delay}ms`, {
                error: String(error),
            });
            await sleep(delay);
        }
    }
    // This should never be reached, but TypeScript needs it
    throw lastError;
}
/** Create a retry wrapper with preset options */
function createRetrier(options) {
    return (fn) => withRetry(fn, options);
}
//# sourceMappingURL=retry.js.map