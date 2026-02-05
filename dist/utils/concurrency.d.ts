/**
 * Concurrency utilities for parallel execution
 */
export interface PoolOptions {
    /** Maximum concurrent tasks */
    concurrency: number;
    /** Whether to stop on first error */
    stopOnError: boolean;
}
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
export declare function parallel<T, R>(items: T[], fn: (item: T, index: number) => Promise<R>, options?: Partial<PoolOptions>): Promise<TaskResult<R>[]>;
/**
 * Run tasks in parallel and return only successful results
 */
export declare function parallelFilter<T, R>(items: T[], fn: (item: T, index: number) => Promise<R>, options?: Partial<PoolOptions>): Promise<R[]>;
/**
 * Run all tasks in parallel (no concurrency limit) and wait for all to settle
 */
export declare function allSettled<T, R>(items: T[], fn: (item: T, index: number) => Promise<R>): Promise<TaskResult<R>[]>;
//# sourceMappingURL=concurrency.d.ts.map