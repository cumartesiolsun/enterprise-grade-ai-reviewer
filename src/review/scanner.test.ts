import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock, MockInstance } from 'vitest';
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

import { runScanners, runJudgeScan } from './scanner.js';
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

/** Shorthand for a successful OpenRouter response. */
const ok = (content: string, tokensUsed = 10) => ({
  content,
  tokensUsed,
  finishReason: 'stop',
});

let perfSpy: MockInstance<() => number> | undefined;

/**
 * Replace performance.now with a strictly increasing counter so durations are
 * deterministic: every call advances time by `step` ms, so a scanner that
 * finishes later (more event-loop turns) gets a strictly larger durationMs.
 */
function mockPerformanceCounter(step = 100): void {
  let t = 0;
  perfSpy = vi.spyOn(performance, 'now').mockImplementation(() => {
    t += step;
    return t;
  });
}

beforeEach(() => {
  // resetAllMocks (not clearAllMocks): drops mockImplementation/Once leftovers
  // between tests and restores the factory impls of the prompt-builder mocks.
  vi.resetAllMocks();
});

afterEach(() => {
  perfSpy?.mockRestore();
  perfSpy = undefined;
});

describe('runScanners', () => {
  it('returns OK status for scanner with meaningful content', async () => {
    mockedCallOpenRouter.mockResolvedValueOnce(
      ok('Found a potential null pointer dereference on line 42.', 150)
    );

    const { results } = await runScanners(mockConfig, 'diff content');

    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('OK');
    expect(results[0]!.success).toBe(true);
    expect(results[0]!.output).toBe('Found a potential null pointer dereference on line 42.');
    expect(results[0]!.origin).toBeUndefined();
  });

  it('returns SKIPPED status when trimmed output is exactly "NO_FINDINGS"', async () => {
    mockedCallOpenRouter.mockResolvedValueOnce(ok('NO_FINDINGS', 5));

    const { results } = await runScanners(mockConfig, 'diff content');

    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('SKIPPED');
    expect(results[0]!.success).toBe(true);
  });

  it('returns SKIPPED status for "NO_FINDINGS" surrounded by whitespace', async () => {
    mockedCallOpenRouter.mockResolvedValueOnce(ok('  NO_FINDINGS\n', 5));

    const { results } = await runScanners(mockConfig, 'diff content');

    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('SKIPPED');
    expect(results[0]!.success).toBe(true);
  });

  it('returns SKIPPED status for empty/whitespace content when finishReason is "stop"', async () => {
    mockedCallOpenRouter.mockResolvedValueOnce({
      content: '   ',
      tokensUsed: 0,
      finishReason: 'stop',
    });

    const { results } = await runScanners(mockConfig, 'diff content');

    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('SKIPPED');
    expect(results[0]!.success).toBe(true);
  });

  it('returns FAILED when content is empty but finishReason is "length"', async () => {
    mockedCallOpenRouter.mockResolvedValueOnce({
      content: '',
      tokensUsed: 42,
      finishReason: 'length',
    });

    const { results, coverage } = await runScanners(mockConfig, 'diff content');

    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('FAILED');
    expect(results[0]!.success).toBe(false);
    expect(results[0]!.error).toContain("finish_reason 'length'");
    expect(results[0]!.output).toBe('');
    // No rescue possible: nothing succeeded and there are no rescue models.
    expect(mockedCallOpenRouter).toHaveBeenCalledTimes(1);
    expect(coverage).toEqual([{ role: 'general', status: 'uncovered' }]);
  });

  it('returns FAILED when content is empty and finishReason is undefined', async () => {
    mockedCallOpenRouter.mockResolvedValueOnce({
      content: '',
      tokensUsed: 0,
      finishReason: undefined,
    });

    const { results } = await runScanners(mockConfig, 'diff content');

    expect(results[0]!.status).toBe('FAILED');
    expect(results[0]!.success).toBe(false);
    expect(results[0]!.error).toContain("finish_reason 'unknown'");
  });

  it('returns OK status for "LGTM!" — the NO_FINDINGS sentinel is the only skip signal', async () => {
    mockedCallOpenRouter.mockResolvedValueOnce(ok('LGTM!', 5));

    const { results } = await runScanners(mockConfig, 'diff content');

    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('OK');
    expect(results[0]!.success).toBe(true);
  });

  it('returns OK status for a short "looks good" reply — no longer a skip signal', async () => {
    mockedCallOpenRouter.mockResolvedValueOnce(
      ok('This looks good to me, nothing to report.', 25)
    );

    const { results } = await runScanners(mockConfig, 'diff content');

    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('OK');
    expect(results[0]!.success).toBe(true);
  });

  it('returns OK status when NO_FINDINGS appears inside a longer review', async () => {
    mockedCallOpenRouter.mockResolvedValueOnce(
      ok('NO_FINDINGS for security, but line 12 has an off-by-one error.', 30)
    );

    const { results } = await runScanners(mockConfig, 'diff content');

    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('OK');
  });

  it('returns FAILED status with the diagnostic message when callOpenRouter throws', async () => {
    mockedCallOpenRouter.mockRejectedValueOnce(new Error('API timeout'));

    const { results, coverage } = await runScanners(mockConfig, 'diff content');

    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('FAILED');
    expect(results[0]!.success).toBe(false);
    expect(results[0]!.error).toBe('API timeout');
    expect(results[0]!.output).toBe('');
    expect(results[0]!.tokensUsed).toBe(0);
    expect(results[0]!.role).toBe('general');
    // Zero successes and no rescue models → role stays uncovered, no rescue call.
    expect(mockedCallOpenRouter).toHaveBeenCalledTimes(1);
    expect(coverage).toEqual([{ role: 'general', status: 'uncovered' }]);
  });

  it('runs multiple scanners in parallel and returns results for each', async () => {
    const multiModelConfig: ScannerConfig = {
      ...mockConfig,
      models: ['model-a', 'model-b', 'model-c'],
    };

    mockedCallOpenRouter
      .mockResolvedValueOnce(ok('Finding from model-a', 100))
      .mockResolvedValueOnce(ok('Finding from model-b', 200))
      .mockResolvedValueOnce(ok('Finding from model-c', 300));

    const { results } = await runScanners(multiModelConfig, 'diff content');

    expect(results).toHaveLength(3);
    expect(results[0]!.model).toBe('model-a');
    expect(results[1]!.model).toBe('model-b');
    expect(results[2]!.model).toBe('model-c');
    expect(mockedCallOpenRouter).toHaveBeenCalledTimes(3);
  });

  it('each result includes model name, role, output, tokensUsed, and durationMs', async () => {
    mockedCallOpenRouter.mockResolvedValueOnce(ok('Security issue: SQL injection risk.', 175));

    const { results } = await runScanners(
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
      .mockResolvedValueOnce(ok('Finding from model-a', 100))
      .mockRejectedValueOnce(new Error('model-b crashed'))
      .mockResolvedValueOnce(ok('Finding from model-c', 300));

    const { results } = await runScanners(multiModelConfig, 'diff content');

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
        .mockResolvedValueOnce(ok('A'))
        .mockResolvedValueOnce(ok('B'))
        .mockResolvedValueOnce(ok('C'));

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

      mockedCallOpenRouter.mockResolvedValueOnce(ok('A')).mockResolvedValueOnce(ok('B'));

      const { results } = await runScanners(config, 'diff content');

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
        .mockResolvedValueOnce(ok('A'))
        .mockResolvedValueOnce(ok('B'))
        .mockResolvedValueOnce(ok('C'));

      const { results } = await runScanners(config, 'diff content');

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

      mockedCallOpenRouter.mockResolvedValueOnce(ok('A')).mockResolvedValueOnce(ok('B'));

      const { results } = await runScanners(config, 'diff content');

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

      mockedCallOpenRouter.mockResolvedValueOnce(ok('A'));

      await runScanners(config, 'diff content');

      expect(mockedBuildScannerUserPrompt).toHaveBeenCalledWith(
        'diff content',
        'PR title: Fix auth bug\nPR body: Rework token refresh.'
      );
    });

    it('defaults prContext to an empty string when absent', async () => {
      mockedCallOpenRouter.mockResolvedValueOnce(ok('A'));

      await runScanners(mockConfig, 'diff content');

      expect(mockedBuildScannerUserPrompt).toHaveBeenCalledWith('diff content', '');
    });
  });

  describe('coverage and rescue', () => {
    it('marks every role covered and makes no extra calls when all scanners succeed', async () => {
      const config: ScannerConfig = {
        ...mockConfig,
        models: ['model-a', 'model-b'],
        roles: ['security', 'logic'],
        rescueModels: ['rescue-1'],
      };

      mockedCallOpenRouter.mockResolvedValueOnce(ok('A')).mockResolvedValueOnce(ok('B'));

      const { results, coverage } = await runScanners(config, 'diff content');

      expect(mockedCallOpenRouter).toHaveBeenCalledTimes(2);
      expect(results).toHaveLength(2);
      expect(results.every((r) => r.origin === undefined)).toBe(true);
      expect(coverage).toEqual([
        { role: 'security', status: 'covered' },
        { role: 'logic', status: 'covered' },
      ]);
    });

    it('counts a SKIPPED scanner as covering its role (no rescue)', async () => {
      const config: ScannerConfig = {
        ...mockConfig,
        models: ['model-a', 'model-b'],
        roles: ['security', 'security'],
        rescueModels: ['rescue-1'],
      };

      mockedCallOpenRouter.mockImplementation(async (_cfg, model) => {
        if (model === 'model-a') throw new Error('model-a down');
        return ok('NO_FINDINGS', 5);
      });

      const { results, coverage } = await runScanners(config, 'diff content');

      expect(mockedCallOpenRouter).toHaveBeenCalledTimes(2);
      expect(results).toHaveLength(2);
      expect(coverage).toEqual([{ role: 'security', status: 'covered' }]);
    });

    it('rescues an uncovered role with the first unused rescue model and the correct role prompt', async () => {
      const config: ScannerConfig = {
        ...mockConfig,
        models: ['model-a', 'model-b'],
        roles: ['security', 'logic'],
        rescueModels: ['rescue-1'],
      };

      mockedCallOpenRouter.mockImplementation(async (_cfg, model) => {
        if (model === 'model-b') throw new Error('model-b down');
        return ok(`Finding from ${model}`);
      });

      const { results, coverage } = await runScanners(config, 'diff content');

      // 2 main-pass calls + 1 rescue call
      expect(mockedCallOpenRouter).toHaveBeenCalledTimes(3);
      expect(mockedCallOpenRouter.mock.calls[2]![1]).toBe('rescue-1');
      // Rescue uses the uncovered role's normal system prompt
      expect(mockedBuildScannerSystemPrompt).toHaveBeenNthCalledWith(3, 'en', 'logic');

      expect(results).toHaveLength(3);
      const rescue = results[2]!;
      expect(rescue.model).toBe('rescue-1');
      expect(rescue.origin).toBe('rescue');
      expect(rescue.role).toBe('logic');
      expect(rescue.status).toBe('OK');

      expect(coverage).toEqual([
        { role: 'security', status: 'covered' },
        { role: 'logic', status: 'rescued' },
      ]);
    });

    it('skips rescueModels entries that are already in the main model list', async () => {
      const config: ScannerConfig = {
        ...mockConfig,
        models: ['model-a', 'model-b'],
        roles: ['security', 'logic'],
        rescueModels: ['model-a', 'rescue-1'],
      };

      mockedCallOpenRouter.mockImplementation(async (_cfg, model) => {
        if (model === 'model-b') throw new Error('model-b down');
        return ok(`Finding from ${model}`);
      });

      const { coverage } = await runScanners(config, 'diff content');

      expect(mockedCallOpenRouter).toHaveBeenCalledTimes(3);
      expect(mockedCallOpenRouter.mock.calls[2]![1]).toBe('rescue-1');
      expect(coverage).toEqual([
        { role: 'security', status: 'covered' },
        { role: 'logic', status: 'rescued' },
      ]);
    });

    it('falls back to the fastest successful model when no rescueModels are configured', async () => {
      mockPerformanceCounter();

      const config: ScannerConfig = {
        ...mockConfig,
        // Slow model listed first to prove selection is by duration, not order
        models: ['model-slow', 'model-fast', 'model-fail'],
        roles: ['security', 'security', 'logic'],
      };

      mockedCallOpenRouter.mockImplementation(async (_cfg, model) => {
        if (model === 'model-fail') throw new Error('model-fail down');
        if (model === 'model-slow') {
          // Extra event-loop turn → later finish → larger mocked durationMs
          await new Promise((resolve) => setImmediate(resolve));
        }
        return ok(`Finding from ${model}`);
      });

      const { results, coverage } = await runScanners(config, 'diff content');

      const slow = results.find((r) => r.model === 'model-slow')!;
      const fast = results.find((r) => r.model === 'model-fast')!;
      expect(slow.durationMs).toBeGreaterThan(fast.durationMs);

      // Rescue for 'logic' uses the fastest model that succeeded this run
      // (model-fail had a small duration too, but success === false excludes it)
      expect(mockedCallOpenRouter).toHaveBeenCalledTimes(4);
      expect(mockedCallOpenRouter.mock.calls[3]![1]).toBe('model-fast');

      const rescue = results.find((r) => r.origin === 'rescue')!;
      expect(rescue.model).toBe('model-fast');
      expect(rescue.role).toBe('logic');

      expect(coverage).toEqual([
        { role: 'security', status: 'covered' },
        { role: 'logic', status: 'rescued' },
      ]);
    });

    it('leaves the role uncovered without a rescue call when nothing succeeded and no rescueModels exist', async () => {
      const config: ScannerConfig = {
        ...mockConfig,
        models: ['model-a', 'model-b'],
        roles: ['security', 'logic'],
      };

      mockedCallOpenRouter.mockImplementation(async () => {
        throw new Error('everything down');
      });

      const { results, coverage } = await runScanners(config, 'diff content');

      expect(mockedCallOpenRouter).toHaveBeenCalledTimes(2);
      expect(results).toHaveLength(2);
      expect(coverage).toEqual([
        { role: 'security', status: 'uncovered' },
        { role: 'logic', status: 'uncovered' },
      ]);
    });

    it('gives the rescue model to the first uncovered role and the fastest successful model to the second', async () => {
      const config: ScannerConfig = {
        ...mockConfig,
        models: ['model-a', 'model-b', 'model-c'],
        roles: ['general', 'security', 'logic'],
        rescueModels: ['rescue-1'],
      };

      mockedCallOpenRouter.mockImplementation(async (_cfg, model) => {
        if (model === 'model-b' || model === 'model-c') {
          throw new Error(`${model} down`);
        }
        return ok(`Finding from ${model}`);
      });

      const { results, coverage } = await runScanners(config, 'diff content');

      // 3 main-pass calls + 2 rescue calls
      expect(mockedCallOpenRouter).toHaveBeenCalledTimes(5);
      expect(mockedCallOpenRouter.mock.calls[3]![1]).toBe('rescue-1');
      // Only rescue model is taken → fastest successful (model-a) is reused
      expect(mockedCallOpenRouter.mock.calls[4]![1]).toBe('model-a');

      const securityRescue = results.find((r) => r.origin === 'rescue' && r.role === 'security')!;
      const logicRescue = results.find((r) => r.origin === 'rescue' && r.role === 'logic')!;
      expect(securityRescue.model).toBe('rescue-1');
      expect(logicRescue.model).toBe('model-a');

      expect(coverage).toEqual([
        { role: 'general', status: 'covered' },
        { role: 'security', status: 'rescued' },
        { role: 'logic', status: 'rescued' },
      ]);
    });

    it('marks the role uncovered when the rescue attempt also fails, and keeps the FAILED rescue result', async () => {
      const config: ScannerConfig = {
        ...mockConfig,
        models: ['model-a', 'model-b'],
        roles: ['security', 'logic'],
        rescueModels: ['rescue-1'],
      };

      mockedCallOpenRouter.mockImplementation(async (_cfg, model) => {
        if (model === 'model-b') throw new Error('model-b down');
        if (model === 'rescue-1') throw new Error('rescue-1 also down');
        return ok(`Finding from ${model}`);
      });

      const { results, coverage } = await runScanners(config, 'diff content');

      expect(mockedCallOpenRouter).toHaveBeenCalledTimes(3);
      expect(results).toHaveLength(3);

      const rescue = results[2]!;
      expect(rescue.origin).toBe('rescue');
      expect(rescue.status).toBe('FAILED');
      expect(rescue.error).toBe('rescue-1 also down');

      expect(coverage).toEqual([
        { role: 'security', status: 'covered' },
        { role: 'logic', status: 'uncovered' },
      ]);
    });
  });
});

describe('runJudgeScan', () => {
  it('makes one scanner-style call with judge-scan identity and the scanner token budget', async () => {
    mockedCallOpenRouter.mockResolvedValueOnce(ok('Judge-scan finding', 60));

    const result = await runJudgeScan(mockConfig, 'diff content', 'judge-model', 'security');

    expect(result.model).toBe('judge-scan:judge-model');
    expect(result.origin).toBe('judge-scan');
    expect(result.role).toBe('security');
    expect(result.status).toBe('OK');
    expect(result.success).toBe(true);
    expect(result.output).toBe('Judge-scan finding');

    // One call, against the RAW model name, with the scanner maxTokens (not the judge budget)
    expect(mockedCallOpenRouter).toHaveBeenCalledTimes(1);
    expect(mockedCallOpenRouter).toHaveBeenCalledWith(
      mockConfig.openrouter,
      'judge-model',
      expect.any(Array),
      1000,
      0.3
    );
    // Uses the scanner system prompt for the given role
    expect(mockedBuildScannerSystemPrompt).toHaveBeenCalledWith('en', 'security');
    expect(mockedBuildScannerUserPrompt).toHaveBeenCalledWith('diff content', '');
  });

  it('returns SKIPPED for NO_FINDINGS while keeping the judge-scan identity', async () => {
    mockedCallOpenRouter.mockResolvedValueOnce(ok('NO_FINDINGS', 5));

    const result = await runJudgeScan(mockConfig, 'diff content', 'judge-model', 'logic');

    expect(result.status).toBe('SKIPPED');
    expect(result.model).toBe('judge-scan:judge-model');
    expect(result.origin).toBe('judge-scan');
    expect(result.role).toBe('logic');
  });

  it('returns FAILED with the diagnostic message when the client throws', async () => {
    mockedCallOpenRouter.mockRejectedValueOnce(new Error('rate limited after retries'));

    const result = await runJudgeScan(mockConfig, 'diff content', 'judge-model', 'performance');

    expect(result.status).toBe('FAILED');
    expect(result.success).toBe(false);
    expect(result.model).toBe('judge-scan:judge-model');
    expect(result.origin).toBe('judge-scan');
    expect(result.error).toBe('rate limited after retries');
  });
});
