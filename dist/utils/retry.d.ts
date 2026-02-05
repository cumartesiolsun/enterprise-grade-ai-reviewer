/**
 * Retry utility with exponential backoff
 */
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
export declare function withRetry<T>(fn: () => Promise<T>, options?: Partial<RetryOptions>): Promise<T>;
/** Create a retry wrapper with preset options */
export declare function createRetrier(options: Partial<RetryOptions>): <T>(fn: () => Promise<T>) => Promise<T>;
//# sourceMappingURL=retry.d.ts.map