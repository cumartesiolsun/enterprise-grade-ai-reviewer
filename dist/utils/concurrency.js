"use strict";
/**
 * Concurrency utilities for parallel execution
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.parallel = parallel;
exports.parallelFilter = parallelFilter;
exports.allSettled = allSettled;
const logger_js_1 = require("./logger.js");
const DEFAULT_POOL_OPTIONS = {
    concurrency: 4,
    stopOnError: false,
};
/**
 * Run tasks in parallel with concurrency limit
 */
async function parallel(items, fn, options = {}) {
    const opts = { ...DEFAULT_POOL_OPTIONS, ...options };
    const results = new Array(items.length);
    let currentIndex = 0;
    let hasError = false;
    async function runNext() {
        while (currentIndex < items.length) {
            if (opts.stopOnError && hasError)
                return;
            const index = currentIndex++;
            const item = items[index];
            if (item === undefined)
                continue;
            const start = performance.now();
            try {
                const result = await fn(item, index);
                results[index] = {
                    index,
                    success: true,
                    result,
                    durationMs: Math.round(performance.now() - start),
                };
            }
            catch (error) {
                hasError = true;
                results[index] = {
                    index,
                    success: false,
                    error: error instanceof Error ? error : new Error(String(error)),
                    durationMs: Math.round(performance.now() - start),
                };
                if (opts.stopOnError) {
                    throw error;
                }
            }
        }
    }
    // Start workers up to concurrency limit
    const workers = Array.from({ length: Math.min(opts.concurrency, items.length) }, () => runNext());
    await Promise.all(workers);
    return results;
}
/**
 * Run tasks in parallel and return only successful results
 */
async function parallelFilter(items, fn, options = {}) {
    const results = await parallel(items, fn, { ...options, stopOnError: false });
    return results
        .filter((r) => r.success)
        .map((r) => r.result);
}
/**
 * Run all tasks in parallel (no concurrency limit) and wait for all to settle
 */
async function allSettled(items, fn) {
    const start = performance.now();
    const promises = items.map(async (item, index) => {
        const taskStart = performance.now();
        try {
            const result = await fn(item, index);
            return {
                index,
                success: true,
                result,
                durationMs: Math.round(performance.now() - taskStart),
            };
        }
        catch (error) {
            return {
                index,
                success: false,
                error: error instanceof Error ? error : new Error(String(error)),
                durationMs: Math.round(performance.now() - taskStart),
            };
        }
    });
    const results = await Promise.all(promises);
    logger_js_1.logger.debug('Parallel execution completed', {
        total: items.length,
        successful: results.filter((r) => r.success).length,
        failed: results.filter((r) => !r.success).length,
        totalDurationMs: Math.round(performance.now() - start),
    });
    return results;
}
//# sourceMappingURL=concurrency.js.map