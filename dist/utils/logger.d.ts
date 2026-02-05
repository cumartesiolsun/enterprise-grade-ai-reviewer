/**
 * Simple structured logger for the AI reviewer
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
declare class Logger {
    private minLevel;
    constructor(minLevel?: LogLevel);
    setLevel(level: LogLevel): void;
    private shouldLog;
    private formatEntry;
    private log;
    debug(message: string, context?: Record<string, unknown>): void;
    info(message: string, context?: Record<string, unknown>): void;
    warn(message: string, context?: Record<string, unknown>): void;
    error(message: string, context?: Record<string, unknown>): void;
    /** Log with timing information */
    timed<T>(label: string, fn: () => T): T;
    /** Log with async timing information */
    timedAsync<T>(label: string, fn: () => Promise<T>): Promise<T>;
}
export declare const logger: Logger;
export { Logger };
//# sourceMappingURL=logger.d.ts.map