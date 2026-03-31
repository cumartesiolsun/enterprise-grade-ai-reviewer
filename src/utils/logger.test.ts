import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger } from './logger.js';

describe('Logger', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('log level filtering', () => {
    it('default level is info — debug messages should be suppressed', () => {
      const logger = new Logger();
      logger.debug('should not appear');
      logger.info('should appear');

      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(logSpy.mock.calls[0]![0]).toContain('should appear');
    });

    it('setting level to debug — all messages should be logged', () => {
      const logger = new Logger('debug');
      logger.debug('debug msg');
      logger.info('info msg');
      logger.warn('warn msg');
      logger.error('error msg');

      expect(logSpy).toHaveBeenCalledTimes(2);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledTimes(1);
    });

    it('setting level to error — only error messages should be logged', () => {
      const logger = new Logger('error');
      logger.debug('debug msg');
      logger.info('info msg');
      logger.warn('warn msg');
      logger.error('error msg');

      expect(logSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0]![0]).toContain('error msg');
    });
  });

  describe('output format', () => {
    it('format includes timestamp, level, and message', () => {
      const logger = new Logger('info');
      logger.info('hello world');

      expect(logSpy).toHaveBeenCalledTimes(1);
      const output = logSpy.mock.calls[0]![0] as string;
      // Timestamp pattern: [YYYY-MM-DDTHH:MM:SS.sssZ]
      expect(output).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z\] INFO: hello world$/);
    });

    it('format includes JSON context when provided', () => {
      const logger = new Logger('info');
      logger.info('with context', { key: 'value', count: 42 });

      expect(logSpy).toHaveBeenCalledTimes(1);
      const output = logSpy.mock.calls[0]![0] as string;
      expect(output).toContain('INFO: with context');
      expect(output).toContain(JSON.stringify({ key: 'value', count: 42 }));
    });

    it('format excludes context when undefined', () => {
      const logger = new Logger('info');
      logger.info('no context');

      const output = logSpy.mock.calls[0]![0] as string;
      // Should end with the message, no trailing JSON
      expect(output).toMatch(/INFO: no context$/);
    });

    it('format excludes context when empty object', () => {
      const logger = new Logger('info');
      logger.info('empty context', {});

      const output = logSpy.mock.calls[0]![0] as string;
      expect(output).toMatch(/INFO: empty context$/);
      expect(output).not.toContain('{}');
    });
  });

  describe('console method routing', () => {
    it('warn() uses console.warn', () => {
      const logger = new Logger('warn');
      logger.warn('warning message');

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]![0]).toContain('WARN: warning message');
      expect(logSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('error() uses console.error', () => {
      const logger = new Logger('error');
      logger.error('error message');

      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0]![0]).toContain('ERROR: error message');
      expect(logSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe('timed()', () => {
    it('returns the function result and logs duration on success', () => {
      const logger = new Logger('debug');
      const result = logger.timed('myTask', () => 42);

      expect(result).toBe(42);
      expect(logSpy).toHaveBeenCalledTimes(1);
      const output = logSpy.mock.calls[0]![0] as string;
      expect(output).toContain('myTask completed');
      expect(output).toContain('"durationMs"');
    });

    it('rethrows error and logs failure with duration', () => {
      const logger = new Logger('debug');
      const err = new Error('boom');

      expect(() => logger.timed('failTask', () => { throw err; })).toThrow(err);

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const output = errorSpy.mock.calls[0]![0] as string;
      expect(output).toContain('failTask failed');
      expect(output).toContain('"durationMs"');
      expect(output).toContain('"error"');
    });
  });

  describe('timedAsync()', () => {
    it('returns the promise result and logs duration on success', async () => {
      const logger = new Logger('debug');
      const result = await logger.timedAsync('asyncTask', async () => 'done');

      expect(result).toBe('done');
      expect(logSpy).toHaveBeenCalledTimes(1);
      const output = logSpy.mock.calls[0]![0] as string;
      expect(output).toContain('asyncTask completed');
      expect(output).toContain('"durationMs"');
    });

    it('rethrows error and logs failure with duration', async () => {
      const logger = new Logger('debug');
      const err = new Error('async boom');

      await expect(
        logger.timedAsync('asyncFailTask', async () => { throw err; })
      ).rejects.toThrow(err);

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const output = errorSpy.mock.calls[0]![0] as string;
      expect(output).toContain('asyncFailTask failed');
      expect(output).toContain('"durationMs"');
      expect(output).toContain('"error"');
    });
  });

  describe('setLevel()', () => {
    it('dynamically changes the minimum log level', () => {
      const logger = new Logger('error');
      logger.info('should not appear');
      expect(logSpy).not.toHaveBeenCalled();

      logger.setLevel('info');
      logger.info('should appear');
      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(logSpy.mock.calls[0]![0]).toContain('should appear');
    });
  });
});
