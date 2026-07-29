import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ScannerConfig } from './scanner.js';

vi.mock('../openrouter/client.js', () => ({
  callOpenRouter: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { runScanners } from './scanner.js';
import { callOpenRouter } from '../openrouter/client.js';

const mockedCallOpenRouter = vi.mocked(callOpenRouter);

const mockConfig: ScannerConfig = {
  openrouter: { apiKey: 'test-key', baseUrl: 'https://test.api', timeoutMs: 5000 },
  models: ['model-a'],
  maxTokens: 1000,
  language: 'en',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runScanners', () => {
  it('returns OK status for scanner with meaningful content', async () => {
    mockedCallOpenRouter.mockResolvedValueOnce({
      content: 'Found a potential null pointer dereference on line 42.',
      tokensUsed: 150,
      finishReason: 'stop',
    });

    const results = await runScanners(mockConfig, 'diff content');

    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('OK');
    expect(results[0]!.success).toBe(true);
    expect(results[0]!.output).toBe('Found a potential null pointer dereference on line 42.');
  });

  it('returns SKIPPED status for a short reply containing "LGTM"', async () => {
    mockedCallOpenRouter.mockResolvedValueOnce({
      content: 'LGTM, no issues found.',
      tokensUsed: 20,
      finishReason: 'stop',
    });

    const results = await runScanners(mockConfig, 'diff content');

    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('SKIPPED');
    expect(results[0]!.success).toBe(true);
  });

  it('returns SKIPPED status for a short reply containing "looks good"', async () => {
    mockedCallOpenRouter.mockResolvedValueOnce({
      content: 'This looks good to me, nothing to report.',
      tokensUsed: 25,
      finishReason: 'stop',
    });

    const results = await runScanners(mockConfig, 'diff content');

    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('SKIPPED');
    expect(results[0]!.success).toBe(true);
  });

  it('returns SKIPPED status when content is empty', async () => {
    mockedCallOpenRouter.mockResolvedValueOnce({
      content: '   ',
      tokensUsed: 0,
      finishReason: 'stop',
    });

    const results = await runScanners(mockConfig, 'diff content');

    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('SKIPPED');
    expect(results[0]!.success).toBe(true);
  });

  it('returns SKIPPED status for exactly "LGTM!"', async () => {
    mockedCallOpenRouter.mockResolvedValueOnce({
      content: 'LGTM!',
      tokensUsed: 5,
      finishReason: 'stop',
    });

    const results = await runScanners(mockConfig, 'diff content');

    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('SKIPPED');
    expect(results[0]!.success).toBe(true);
  });

  it('returns OK status for a long review that mentions "looks good" mid-review', async () => {
    const longReview =
      'The auth flow looks good overall, but there is a critical SQL injection ' +
      'vulnerability on line 40: user input is concatenated directly into the ' +
      'query string. Use parameterized queries instead. Also consider adding ' +
      'rate limiting to the login endpoint.';
    mockedCallOpenRouter.mockResolvedValueOnce({
      content: longReview,
      tokensUsed: 120,
      finishReason: 'stop',
    });

    const results = await runScanners(mockConfig, 'diff content');

    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('OK');
    expect(results[0]!.output).toBe(longReview);
  });

  it('returns OK status for a short finding that does not match the LGTM pattern', async () => {
    mockedCallOpenRouter.mockResolvedValueOnce({
      content: 'Possible XSS on line 12.',
      tokensUsed: 10,
      finishReason: 'stop',
    });

    const results = await runScanners(mockConfig, 'diff content');

    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('OK');
  });

  it('returns FAILED status when callOpenRouter throws', async () => {
    mockedCallOpenRouter.mockRejectedValueOnce(new Error('API timeout'));

    const results = await runScanners(mockConfig, 'diff content');

    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('FAILED');
    expect(results[0]!.success).toBe(false);
    expect(results[0]!.error).toBe('API timeout');
    expect(results[0]!.output).toBe('');
    expect(results[0]!.tokensUsed).toBe(0);
  });

  it('runs multiple scanners in parallel and returns results for each', async () => {
    const multiModelConfig: ScannerConfig = {
      ...mockConfig,
      models: ['model-a', 'model-b', 'model-c'],
    };

    mockedCallOpenRouter
      .mockResolvedValueOnce({ content: 'Finding from model-a', tokensUsed: 100, finishReason: 'stop' })
      .mockResolvedValueOnce({ content: 'Finding from model-b', tokensUsed: 200, finishReason: 'stop' })
      .mockResolvedValueOnce({ content: 'Finding from model-c', tokensUsed: 300, finishReason: 'stop' });

    const results = await runScanners(multiModelConfig, 'diff content');

    expect(results).toHaveLength(3);
    expect(results[0]!.model).toBe('model-a');
    expect(results[1]!.model).toBe('model-b');
    expect(results[2]!.model).toBe('model-c');
    expect(mockedCallOpenRouter).toHaveBeenCalledTimes(3);
  });

  it('each result includes model name, output, tokensUsed, and durationMs', async () => {
    mockedCallOpenRouter.mockResolvedValueOnce({
      content: 'Security issue: SQL injection risk.',
      tokensUsed: 175,
      finishReason: 'stop',
    });

    const results = await runScanners(mockConfig, 'diff content');

    const result = results[0]!;
    expect(result.model).toBe('model-a');
    expect(result.output).toBe('Security issue: SQL injection risk.');
    expect(result.tokensUsed).toBe(175);
    expect(typeof result.durationMs).toBe('number');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('failed scanners do not prevent other scanners from completing', async () => {
    const multiModelConfig: ScannerConfig = {
      ...mockConfig,
      models: ['model-a', 'model-b', 'model-c'],
    };

    mockedCallOpenRouter
      .mockResolvedValueOnce({ content: 'Finding from model-a', tokensUsed: 100, finishReason: 'stop' })
      .mockRejectedValueOnce(new Error('model-b crashed'))
      .mockResolvedValueOnce({ content: 'Finding from model-c', tokensUsed: 300, finishReason: 'stop' });

    const results = await runScanners(multiModelConfig, 'diff content');

    expect(results).toHaveLength(3);

    expect(results[0]!.status).toBe('OK');
    expect(results[0]!.success).toBe(true);
    expect(results[0]!.model).toBe('model-a');

    expect(results[1]!.status).toBe('FAILED');
    expect(results[1]!.success).toBe(false);
    expect(results[1]!.model).toBe('model-b');
    expect(results[1]!.error).toBe('model-b crashed');

    expect(results[2]!.status).toBe('OK');
    expect(results[2]!.success).toBe(true);
    expect(results[2]!.model).toBe('model-c');
  });
});
