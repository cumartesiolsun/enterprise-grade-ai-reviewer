import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import type { ScannerConfig } from './scanner.js';
import type { ScannerRole } from './prompts.js';

vi.mock('../openrouter/client.js', () => ({
  callOpenRouter: vi.fn(),
}));

vi.mock('./prompts.js', () => ({
  buildScannerSystemPrompt: vi.fn(() => 'SYSTEM_PROMPT'),
  buildScannerUserPrompt: vi.fn(() => 'USER_PROMPT'),
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
import { buildScannerSystemPrompt, buildScannerUserPrompt } from './prompts.js';

const mockedCallOpenRouter = vi.mocked(callOpenRouter);
// Cast against the v0.4 signatures so assertions typecheck regardless of
// whether the concurrent prompts.ts rewrite has landed yet.
const mockedBuildScannerSystemPrompt = buildScannerSystemPrompt as Mock<
  (language: string, role?: ScannerRole) => string
>;
const mockedBuildScannerUserPrompt = buildScannerUserPrompt as Mock<
  (diff: string, prContext?: string) => string
>;

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

  it('returns SKIPPED status when trimmed output is exactly "NO_FINDINGS"', async () => {
    mockedCallOpenRouter.mockResolvedValueOnce({
      content: 'NO_FINDINGS',
      tokensUsed: 5,
      finishReason: 'stop',
    });

    const results = await runScanners(mockConfig, 'diff content');

    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('SKIPPED');
    expect(results[0]!.success).toBe(true);
  });

  it('returns SKIPPED status for "NO_FINDINGS" surrounded by whitespace', async () => {
    mockedCallOpenRouter.mockResolvedValueOnce({
      content: '  NO_FINDINGS\n',
      tokensUsed: 5,
      finishReason: 'stop',
    });

    const results = await runScanners(mockConfig, 'diff content');

    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('SKIPPED');
    expect(results[0]!.success).toBe(true);
  });

  it('returns SKIPPED status when content is empty or whitespace', async () => {
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

  it('returns OK status for "LGTM!" — the NO_FINDINGS sentinel is the only skip signal', async () => {
    mockedCallOpenRouter.mockResolvedValueOnce({
      content: 'LGTM!',
      tokensUsed: 5,
      finishReason: 'stop',
    });

    const results = await runScanners(mockConfig, 'diff content');

    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('OK');
    expect(results[0]!.success).toBe(true);
  });

  it('returns OK status for a short "looks good" reply — no longer a skip signal', async () => {
    mockedCallOpenRouter.mockResolvedValueOnce({
      content: 'This looks good to me, nothing to report.',
      tokensUsed: 25,
      finishReason: 'stop',
    });

    const results = await runScanners(mockConfig, 'diff content');

    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('OK');
    expect(results[0]!.success).toBe(true);
  });

  it('returns OK status when NO_FINDINGS appears inside a longer review', async () => {
    mockedCallOpenRouter.mockResolvedValueOnce({
      content: 'NO_FINDINGS for security, but line 12 has an off-by-one error.',
      tokensUsed: 30,
      finishReason: 'stop',
    });

    const results = await runScanners(mockConfig, 'diff content');

    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('OK');
  });

  it('returns OK status for a short finding', async () => {
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
    expect(results[0]!.role).toBe('general');
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

  it('each result includes model name, role, output, tokensUsed, and durationMs', async () => {
    mockedCallOpenRouter.mockResolvedValueOnce({
      content: 'Security issue: SQL injection risk.',
      tokensUsed: 175,
      finishReason: 'stop',
    });

    const results = await runScanners(
      { ...mockConfig, roles: ['security'] },
      'diff content'
    );

    const result = results[0]!;
    expect(result.model).toBe('model-a');
    expect(result.role).toBe('security');
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

  describe('roles', () => {
    it('threads each role to buildScannerSystemPrompt by index', async () => {
      const config: ScannerConfig = {
        ...mockConfig,
        models: ['model-a', 'model-b', 'model-c'],
        roles: ['security', 'logic', 'performance'],
      };

      mockedCallOpenRouter
        .mockResolvedValueOnce({ content: 'A', tokensUsed: 10, finishReason: 'stop' })
        .mockResolvedValueOnce({ content: 'B', tokensUsed: 10, finishReason: 'stop' })
        .mockResolvedValueOnce({ content: 'C', tokensUsed: 10, finishReason: 'stop' });

      await runScanners(config, 'diff content');

      expect(mockedBuildScannerSystemPrompt).toHaveBeenCalledTimes(3);
      expect(mockedBuildScannerSystemPrompt).toHaveBeenNthCalledWith(1, 'en', 'security');
      expect(mockedBuildScannerSystemPrompt).toHaveBeenNthCalledWith(2, 'en', 'logic');
      expect(mockedBuildScannerSystemPrompt).toHaveBeenNthCalledWith(3, 'en', 'performance');
    });

    it('defaults every role to "general" when roles is absent', async () => {
      const config: ScannerConfig = {
        ...mockConfig,
        models: ['model-a', 'model-b'],
      };

      mockedCallOpenRouter
        .mockResolvedValueOnce({ content: 'A', tokensUsed: 10, finishReason: 'stop' })
        .mockResolvedValueOnce({ content: 'B', tokensUsed: 10, finishReason: 'stop' });

      const results = await runScanners(config, 'diff content');

      expect(mockedBuildScannerSystemPrompt).toHaveBeenNthCalledWith(1, 'en', 'general');
      expect(mockedBuildScannerSystemPrompt).toHaveBeenNthCalledWith(2, 'en', 'general');
      expect(results[0]!.role).toBe('general');
      expect(results[1]!.role).toBe('general');
    });

    it('fills missing entries with "general" when roles is shorter than models', async () => {
      const config: ScannerConfig = {
        ...mockConfig,
        models: ['model-a', 'model-b', 'model-c'],
        roles: ['security'],
      };

      mockedCallOpenRouter
        .mockResolvedValueOnce({ content: 'A', tokensUsed: 10, finishReason: 'stop' })
        .mockResolvedValueOnce({ content: 'B', tokensUsed: 10, finishReason: 'stop' })
        .mockResolvedValueOnce({ content: 'C', tokensUsed: 10, finishReason: 'stop' });

      const results = await runScanners(config, 'diff content');

      expect(mockedBuildScannerSystemPrompt).toHaveBeenNthCalledWith(1, 'en', 'security');
      expect(mockedBuildScannerSystemPrompt).toHaveBeenNthCalledWith(2, 'en', 'general');
      expect(mockedBuildScannerSystemPrompt).toHaveBeenNthCalledWith(3, 'en', 'general');
      expect(results[0]!.role).toBe('security');
      expect(results[1]!.role).toBe('general');
      expect(results[2]!.role).toBe('general');
    });

    it('includes the assigned role in each result', async () => {
      const config: ScannerConfig = {
        ...mockConfig,
        models: ['model-a', 'model-b'],
        roles: ['performance', 'logic'],
      };

      mockedCallOpenRouter
        .mockResolvedValueOnce({ content: 'A', tokensUsed: 10, finishReason: 'stop' })
        .mockResolvedValueOnce({ content: 'B', tokensUsed: 10, finishReason: 'stop' });

      const results = await runScanners(config, 'diff content');

      expect(results[0]!.role).toBe('performance');
      expect(results[1]!.role).toBe('logic');
    });
  });

  describe('prContext', () => {
    it('passes prContext through to buildScannerUserPrompt', async () => {
      const config: ScannerConfig = {
        ...mockConfig,
        prContext: 'PR title: Fix auth bug\nPR body: Rework token refresh.',
      };

      mockedCallOpenRouter.mockResolvedValueOnce({
        content: 'A',
        tokensUsed: 10,
        finishReason: 'stop',
      });

      await runScanners(config, 'diff content');

      expect(mockedBuildScannerUserPrompt).toHaveBeenCalledWith(
        'diff content',
        'PR title: Fix auth bug\nPR body: Rework token refresh.'
      );
    });

    it('defaults prContext to an empty string when absent', async () => {
      mockedCallOpenRouter.mockResolvedValueOnce({
        content: 'A',
        tokensUsed: 10,
        finishReason: 'stop',
      });

      await runScanners(mockConfig, 'diff content');

      expect(mockedBuildScannerUserPrompt).toHaveBeenCalledWith('diff content', '');
    });
  });
});
