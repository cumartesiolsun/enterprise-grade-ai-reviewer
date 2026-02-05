"use strict";
/**
 * Simple structured logger for the AI reviewer
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.Logger = exports.logger = void 0;
const LOG_LEVELS = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
};
class Logger {
    minLevel;
    constructor(minLevel = 'info') {
        this.minLevel = minLevel;
    }
    setLevel(level) {
        this.minLevel = level;
    }
    shouldLog(level) {
        return LOG_LEVELS[level] >= LOG_LEVELS[this.minLevel];
    }
    formatEntry(entry) {
        const base = `[${entry.timestamp}] ${entry.level.toUpperCase()}: ${entry.message}`;
        if (entry.context && Object.keys(entry.context).length > 0) {
            return `${base} ${JSON.stringify(entry.context)}`;
        }
        return base;
    }
    log(level, message, context) {
        if (!this.shouldLog(level))
            return;
        const entry = {
            timestamp: new Date().toISOString(),
            level,
            message,
            context,
        };
        const formatted = this.formatEntry(entry);
        switch (level) {
            case 'debug':
            case 'info':
                console.log(formatted);
                break;
            case 'warn':
                console.warn(formatted);
                break;
            case 'error':
                console.error(formatted);
                break;
        }
    }
    debug(message, context) {
        this.log('debug', message, context);
    }
    info(message, context) {
        this.log('info', message, context);
    }
    warn(message, context) {
        this.log('warn', message, context);
    }
    error(message, context) {
        this.log('error', message, context);
    }
    /** Log with timing information */
    timed(label, fn) {
        const start = performance.now();
        try {
            const result = fn();
            const duration = performance.now() - start;
            this.debug(`${label} completed`, { durationMs: Math.round(duration) });
            return result;
        }
        catch (error) {
            const duration = performance.now() - start;
            this.error(`${label} failed`, { durationMs: Math.round(duration), error: String(error) });
            throw error;
        }
    }
    /** Log with async timing information */
    async timedAsync(label, fn) {
        const start = performance.now();
        try {
            const result = await fn();
            const duration = performance.now() - start;
            this.debug(`${label} completed`, { durationMs: Math.round(duration) });
            return result;
        }
        catch (error) {
            const duration = performance.now() - start;
            this.error(`${label} failed`, { durationMs: Math.round(duration), error: String(error) });
            throw error;
        }
    }
}
exports.Logger = Logger;
// Singleton instance
exports.logger = new Logger(process.env['LOG_LEVEL'] ?? 'info');
//# sourceMappingURL=logger.js.map