/**
 * Concurrency utilities for parallel execution
 */

import { logger } from './logger.js';

export interface PoolOptions {
  /** Maximum concurrent tasks */
  concurrency: number;
  /** Whether to stop on first error */
  stopOnError: boolean;
}

const DEFAULT_POOL_OPTIONS: PoolOptions = {
  concurrency: 4,
  stopOnError: false,
};

export interface TaskResult<T> {
  index: number;
  success: boolean;
  result?: T;
  error?: Error;
  durationMs: number;
}

/**
 * Run tasks in parallel with concurrency limit
 */
export async function parallel<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  options: Partial<PoolOptions> = {}
): Promise<TaskResult<R>[]> {
  const opts = { ...DEFAULT_POOL_OPTIONS, ...options };
  const results: TaskResult<R>[] = new Array(items.length);
  let currentIndex = 0;
  let hasError = false;

  async function runNext(): Promise<void> {
    while (currentIndex < items.length) {
      if (opts.stopOnError && hasError) return;

      const index = currentIndex++;
      const item = items[index];

      if (item === undefined) continue;

      const start = performance.now();

      try {
        const result = await fn(item, index);
        results[index] = {
          index,
          success: true,
          result,
          durationMs: Math.round(performance.now() - start),
        };
      } catch (error) {
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
  const workers = Array.from(
    { length: Math.min(opts.concurrency, items.length) },
    () => runNext()
  );

  await Promise.all(workers);

  return results;
}

/**
 * Run tasks in parallel and return only successful results
 */
export async function parallelFilter<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  options: Partial<PoolOptions> = {}
): Promise<R[]> {
  const results = await parallel(items, fn, { ...options, stopOnError: false });
  return results
    .filter((r): r is TaskResult<R> & { success: true; result: R } => r.success)
    .map((r) => r.result);
}

/**
 * Run all tasks in parallel (no concurrency limit) and wait for all to settle
 */
export async function allSettled<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>
): Promise<TaskResult<R>[]> {
  const start = performance.now();
  const promises = items.map(async (item, index): Promise<TaskResult<R>> => {
    const taskStart = performance.now();
    try {
      const result = await fn(item, index);
      return {
        index,
        success: true,
        result,
        durationMs: Math.round(performance.now() - taskStart),
      };
    } catch (error) {
      return {
        index,
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
        durationMs: Math.round(performance.now() - taskStart),
      };
    }
  });

  const results = await Promise.all(promises);

  logger.debug('Parallel execution completed', {
    total: items.length,
    successful: results.filter((r) => r.success).length,
    failed: results.filter((r) => !r.success).length,
    totalDurationMs: Math.round(performance.now() - start),
  });

  return results;
}
