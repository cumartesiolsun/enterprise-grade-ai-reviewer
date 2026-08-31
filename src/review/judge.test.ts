import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ScannerResult } from './scanner.js';
import type { JudgeConfig, InlineFinding } from './judge.js';

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

vi.mock('./prompts.js', () => ({
  buildJudgeSystemPrompt: vi.fn(() => 'system-summary'),
  buildJudgeUserPrompt: vi.fn(() => 'user-summary'),
  buildJudgeSystemPromptInline: vi.fn(() => 'system-inline'),
  buildJudgeUserPromptInline: vi.fn(() => 'user-inline'),
}));

import { runJudge, TRUNCATION_MARKER } from './judge.js';
import { callOpenRouter } from '../openrouter/client.js';
import { buildJudgeUserPrompt, buildJudgeUserPromptInline } from './prompts.js';

const mockedCallOpenRouter = vi.mocked(callOpenRouter);
const mockedBuildJudgeUserPrompt = vi.mocked(buildJudgeUserPrompt);
const mockedBuildJudgeUserPromptInline = vi.mocked(buildJudgeUserPromptInline);

function makeConfig(overrides: Partial<JudgeConfig> = {}): JudgeConfig {
  return {
    openrouter: { apiKey: 'test-key', baseUrl: 'https://api.test', timeoutMs: 30000 },
    model: 'test/judge-model',
    maxTokens: 4000,
    language: 'en',
    reviewMode: 'summary',
    ...overrides,
  };
}

function makeSuccessfulScanner(model: string = 'scanner-1', output: string = 'Found issue X'): ScannerResult {
  return {
    model,
    output,
    tokensUsed: 100,
    durationMs: 500,
    success: true,
    status: 'OK',
  };
}

function makeFailedScanner(model: string = 'scanner-fail'): ScannerResult {
  return {
    model,
    output: '',
    tokensUsed: 0,
    durationMs: 100,
    success: false,
    status: 'FAILED',
    error: 'API error',
  };
}

describe('runJudge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns error result when no successful scanner results', async () => {
    const config = makeConfig();
    const scannerResults = [makeFailedScanner('model-a'), makeFailedScanner('model-b')];

    const result = await runJudge(config, scannerResults, 'mock diff content');

    expect(result.success).toBe(false);
    expect(result.error).toBe('No successful scanner results');
    expect(result.tokensUsed).toBe(0);
    expect(result.output).toContain('all scanners failed');
    expect(mockedCallOpenRouter).not.toHaveBeenCalled();
  });

  it('returns error result when scanner results array is empty', async () => {
    const config = makeConfig();

    const result = await runJudge(config, [], 'mock diff content');

    expect(result.success).toBe(false);
    expect(result.error).toBe('No successful scanner results');
    expect(mockedCallOpenRouter).not.toHaveBeenCalled();
  });

  it('summary mode: calls callOpenRouter and returns output', async () => {
    const config = makeConfig({ reviewMode: 'summary' });
    const scannerResults = [makeSuccessfulScanner()];

    mockedCallOpenRouter.mockResolvedValueOnce({
      content: 'Summary review output',
      tokensUsed: 250,
    });

    const result = await runJudge(config, scannerResults, 'mock diff content');

    expect(result.success).toBe(true);
    expect(result.output).toBe('Summary review output');
    expect(result.tokensUsed).toBe(250);
    expect(result.findings).toBeUndefined();
    expect(mockedCallOpenRouter).toHaveBeenCalledOnce();
    expect(mockedCallOpenRouter).toHaveBeenCalledWith(
      config.openrouter,
      config.model,
      expect.arrayContaining([
        expect.objectContaining({ role: 'system' }),
        expect.objectContaining({ role: 'user' }),
      ]),
      config.maxTokens,
      0.2,
    );
  });

  it('inline mode with valid JSON array: parses findings correctly', async () => {
    const config = makeConfig({ reviewMode: 'inline' });
    const scannerResults = [makeSuccessfulScanner()];
    const findings: InlineFinding[] = [
      { file: 'src/app.ts', line: 10, severity: 'critical', title: 'SQL Injection', body: 'Use parameterized queries.' },
      { file: 'src/utils.ts', line: 42, severity: 'warning', title: 'Unused variable', body: 'Remove unused variable x.' },
      { file: 'src/config.ts', line: 5, severity: 'info', title: 'Consider const', body: 'Use const instead of let.' },
    ];

    mockedCallOpenRouter.mockResolvedValueOnce({
      content: JSON.stringify(findings),
      tokensUsed: 300,
    });

    const result = await runJudge(config, scannerResults, 'mock diff content');

    expect(result.success).toBe(true);
    expect(result.findings).toBeDefined();
    expect(result.findings).toHaveLength(3);
    expect(result.findings![0]).toEqual({
      file: 'src/app.ts',
      line: 10,
      severity: 'critical',
      title: 'SQL Injection',
      body: 'Use parameterized queries.',
    });
    expect(result.findings![1]!.severity).toBe('warning');
    expect(result.findings![2]!.severity).toBe('info');
  });

  it('inline mode with JSON wrapped in markdown fences: strips fences and parses', async () => {
    const config = makeConfig({ reviewMode: 'inline' });
    const scannerResults = [makeSuccessfulScanner()];
    const findings: InlineFinding[] = [
      { file: 'src/handler.ts', line: 15, severity: 'warning', title: 'Error handling', body: 'Missing try-catch block.' },
    ];
    const fencedContent = '```json\n' + JSON.stringify(findings) + '\n```';

    mockedCallOpenRouter.mockResolvedValueOnce({
      content: fencedContent,
      tokensUsed: 200,
    });

    const result = await runJudge(config, scannerResults, 'mock diff content');

    expect(result.success).toBe(true);
    expect(result.findings).toBeDefined();
    expect(result.findings).toHaveLength(1);
    expect(result.findings![0]).toEqual(findings[0]);
  });

  it('inline mode with fences without json tag: strips fences and parses', async () => {
    const config = makeConfig({ reviewMode: 'inline' });
    const scannerResults = [makeSuccessfulScanner()];
    const findings: InlineFinding[] = [
      { file: 'src/index.ts', line: 1, severity: 'info', title: 'Import order', body: 'Sort imports alphabetically.' },
    ];
    const fencedContent = '```\n' + JSON.stringify(findings) + '\n```';

    mockedCallOpenRouter.mockResolvedValueOnce({
      content: fencedContent,
      tokensUsed: 150,
    });

    const result = await runJudge(config, scannerResults, 'mock diff content');

    expect(result.success).toBe(true);
    expect(result.findings).toBeDefined();
    expect(result.findings).toHaveLength(1);
    expect(result.findings![0]!.title).toBe('Import order');
  });

  it('inline mode with prose text before JSON array: extracts and parses', async () => {
    const config = makeConfig({ reviewMode: 'inline' });
    const scannerResults = [makeSuccessfulScanner()];
    const findings: InlineFinding[] = [
      { file: 'src/chart.tsx', line: 10, severity: 'warning', title: 'Misleading label', body: 'Fix the label.' },
    ];
    const mixedContent = `Looking at the reviews, here are the findings:\n\n${JSON.stringify(findings)}`;

    mockedCallOpenRouter.mockResolvedValueOnce({
      content: mixedContent,
      tokensUsed: 200,
    });

    const result = await runJudge(config, scannerResults, 'mock diff content');

    expect(result.success).toBe(true);
    expect(result.findings).toBeDefined();
    expect(result.findings).toHaveLength(1);
    expect(result.findings![0]!.title).toBe('Misleading label');
  });

  it('inline mode with prose text before and after JSON array: extracts correctly', async () => {
    const config = makeConfig({ reviewMode: 'inline' });
    const scannerResults = [makeSuccessfulScanner()];
    const findings: InlineFinding[] = [
      { file: 'src/app.ts', line: 5, severity: 'critical', title: 'Bug found', body: 'Fix it.' },
    ];
    const mixedContent = `I'll consolidate the findings.\n\n${JSON.stringify(findings)}\n\nThese are the results.`;

    mockedCallOpenRouter.mockResolvedValueOnce({
      content: mixedContent,
      tokensUsed: 200,
    });

    const result = await runJudge(config, scannerResults, 'mock diff content');

    expect(result.success).toBe(true);
    expect(result.findings).toBeDefined();
    expect(result.findings).toHaveLength(1);
    expect(result.findings![0]!.title).toBe('Bug found');
  });

  it('inline mode with invalid JSON: returns findings as undefined', async () => {
    const config = makeConfig({ reviewMode: 'inline' });
    const scannerResults = [makeSuccessfulScanner()];

    mockedCallOpenRouter.mockResolvedValueOnce({
      content: 'This is not valid JSON at all and has no brackets',
      tokensUsed: 100,
    });

    const result = await runJudge(config, scannerResults, 'mock diff content');

    expect(result.success).toBe(true);
    expect(result.findings).toBeUndefined();
  });

  it('inline mode with non-array JSON: returns findings as undefined', async () => {
    const config = makeConfig({ reviewMode: 'inline' });
    const scannerResults = [makeSuccessfulScanner()];

    mockedCallOpenRouter.mockResolvedValueOnce({
      content: JSON.stringify({ file: 'src/app.ts', line: 10, severity: 'critical', title: 'Bug', body: 'Fix it' }),
      tokensUsed: 100,
    });

    const result = await runJudge(config, scannerResults, 'mock diff content');

    expect(result.success).toBe(true);
    expect(result.findings).toBeUndefined();
  });

  it('inline mode with findings missing required fields: skips invalid items', async () => {
    const config = makeConfig({ reviewMode: 'inline' });
    const scannerResults = [makeSuccessfulScanner()];

    const mixedFindings = [
      { file: 'src/valid.ts', line: 10, severity: 'critical', title: 'Valid finding', body: 'This is valid.' },
      { file: 'src/missing-body.ts', line: 5, severity: 'warning', title: 'Missing body' },
      { severity: 'info', title: 'No file or line', body: 'Missing file and line.' },
      { file: 'src/missing-line.ts', severity: 'warning', title: 'No line', body: 'Missing line field.' },
      { file: 'src/missing-title.ts', line: 20, severity: 'info', body: 'Missing title field.' },
      'not an object',
      null,
      42,
    ];

    mockedCallOpenRouter.mockResolvedValueOnce({
      content: JSON.stringify(mixedFindings),
      tokensUsed: 200,
    });

    const result = await runJudge(config, scannerResults, 'mock diff content');

    expect(result.success).toBe(true);
    expect(result.findings).toBeDefined();
    expect(result.findings).toHaveLength(1);
    expect(result.findings![0]!.file).toBe('src/valid.ts');
  });

  it('inline mode with invalid severity value: skips that finding', async () => {
    const config = makeConfig({ reviewMode: 'inline' });
    const scannerResults = [makeSuccessfulScanner()];

    const findings = [
      { file: 'src/a.ts', line: 1, severity: 'critical', title: 'Valid', body: 'Good.' },
      { file: 'src/b.ts', line: 2, severity: 'high', title: 'Invalid severity', body: 'Bad severity.' },
      { file: 'src/c.ts', line: 3, severity: 'error', title: 'Also invalid', body: 'Not a valid severity.' },
      { file: 'src/d.ts', line: 4, severity: 'INFO', title: 'Case sensitive', body: 'Uppercase INFO is invalid.' },
      { file: 'src/e.ts', line: 5, severity: 'warning', title: 'Another valid', body: 'Good too.' },
    ];

    mockedCallOpenRouter.mockResolvedValueOnce({
      content: JSON.stringify(findings),
      tokensUsed: 200,
    });

    const result = await runJudge(config, scannerResults, 'mock diff content');

    expect(result.success).toBe(true);
    expect(result.findings).toBeDefined();
    expect(result.findings).toHaveLength(2);
    expect(result.findings![0]!.severity).toBe('critical');
    expect(result.findings![1]!.severity).toBe('warning');
  });

  it('handles callOpenRouter throwing an error gracefully', async () => {
    const config = makeConfig({ reviewMode: 'summary' });
    const scannerResults = [makeSuccessfulScanner()];

    mockedCallOpenRouter.mockRejectedValueOnce(new Error('OpenRouter API error 500: Internal Server Error'));

    const result = await runJudge(config, scannerResults, 'mock diff content');

    expect(result.success).toBe(false);
    expect(result.error).toBe('OpenRouter API error 500: Internal Server Error');
    expect(result.output).toContain('Review aggregation failed');
    expect(result.tokensUsed).toBe(0);
  });

  it('handles callOpenRouter throwing a non-Error gracefully', async () => {
    const config = makeConfig({ reviewMode: 'inline' });
    const scannerResults = [makeSuccessfulScanner()];

    mockedCallOpenRouter.mockRejectedValueOnce('string error');

    const result = await runJudge(config, scannerResults, 'mock diff content');

    expect(result.success).toBe(false);
    expect(result.error).toBe('string error');
    expect(result.output).toContain('Review aggregation failed');
  });

  it('inline mode with empty array: returns empty findings array', async () => {
    const config = makeConfig({ reviewMode: 'inline' });
    const scannerResults = [makeSuccessfulScanner()];

    mockedCallOpenRouter.mockResolvedValueOnce({
      content: '[]',
      tokensUsed: 50,
    });

    const result = await runJudge(config, scannerResults, 'mock diff content');

    expect(result.success).toBe(true);
    expect(result.findings).toBeDefined();
    expect(result.findings).toHaveLength(0);
  });

  it('filters out failed scanners and only uses successful ones', async () => {
    const config = makeConfig({ reviewMode: 'summary' });
    const scannerResults = [
      makeSuccessfulScanner('model-a', 'Output A'),
      makeFailedScanner('model-b'),
      makeSuccessfulScanner('model-c', 'Output C'),
    ];

    mockedCallOpenRouter.mockResolvedValueOnce({
      content: 'Merged output',
      tokensUsed: 300,
    });

    const result = await runJudge(config, scannerResults, 'mock diff content');

    expect(result.success).toBe(true);
    expect(mockedCallOpenRouter).toHaveBeenCalledOnce();
  });

  it('inline mode: parses sources array from findings', async () => {
    const config = makeConfig({ reviewMode: 'inline' });
    const scannerResults = [makeSuccessfulScanner('model-a'), makeSuccessfulScanner('model-b')];
    const findings = [
      { file: 'src/app.ts', line: 10, severity: 'critical', title: 'Bug', body: 'Fix', sources: ['model-a', 'model-b'] },
      { file: 'src/app.ts', line: 20, severity: 'info', title: 'Style', body: 'Nit', sources: ['model-a'] },
    ];

    mockedCallOpenRouter.mockResolvedValueOnce({
      content: JSON.stringify(findings),
      tokensUsed: 200,
    });

    const result = await runJudge(config, scannerResults, 'mock diff content');

    expect(result.findings).toBeDefined();
    expect(result.findings![0]!.sources).toEqual(['model-a', 'model-b']);
    expect(result.findings![1]!.sources).toEqual(['model-a']);
  });

  it('inline mode: omits sources when not provided', async () => {
    const config = makeConfig({ reviewMode: 'inline' });
    const scannerResults = [makeSuccessfulScanner()];
    const findings = [
      { file: 'src/app.ts', line: 10, severity: 'warning', title: 'Issue', body: 'Detail' },
    ];

    mockedCallOpenRouter.mockResolvedValueOnce({
      content: JSON.stringify(findings),
      tokensUsed: 100,
    });

    const result = await runJudge(config, scannerResults, 'mock diff content');

    expect(result.findings).toBeDefined();
    expect(result.findings![0]!.sources).toBeUndefined();
  });

  it('inline mode: filters non-string items from sources array', async () => {
    const config = makeConfig({ reviewMode: 'inline' });
    const scannerResults = [makeSuccessfulScanner('model-a'), makeSuccessfulScanner('model-b')];
    const findings = [
      { file: 'src/a.ts', line: 1, severity: 'info', title: 'Test', body: 'Body', sources: ['model-a', 42, null, 'model-b'] },
    ];

    mockedCallOpenRouter.mockResolvedValueOnce({
      content: JSON.stringify(findings),
      tokensUsed: 100,
    });

    const result = await runJudge(config, scannerResults, 'mock diff content');

    expect(result.findings![0]!.sources).toEqual(['model-a', 'model-b']);
  });

  it('inline mode: parses JSON array followed by trailing prose', async () => {
    const config = makeConfig({ reviewMode: 'inline' });
    const scannerResults = [makeSuccessfulScanner()];
    const findings: InlineFinding[] = [
      { file: 'src/app.ts', line: 7, severity: 'critical', title: 'Null deref', body: 'Guard against null.' },
    ];
    const content = `${JSON.stringify(findings)}\n\nLet me know if you need more detail on any finding.`;

    mockedCallOpenRouter.mockResolvedValueOnce({
      content,
      tokensUsed: 200,
    });

    const result = await runJudge(config, scannerResults, 'mock diff content');

    expect(result.success).toBe(true);
    expect(result.findings).toBeDefined();
    expect(result.findings).toHaveLength(1);
    expect(result.findings![0]!.title).toBe('Null deref');
  });

  it('inline mode: returns undefined when all items fail validation (no false LGTM)', async () => {
    const config = makeConfig({ reviewMode: 'inline' });
    const scannerResults = [makeSuccessfulScanner()];
    const invalidItems = [
      { file: 'src/a.ts', severity: 'warning', title: 'No line', body: 'Missing line.' },
      { line: 3, severity: 'info', title: 'No file', body: 'Missing file.' },
      'not an object',
    ];

    mockedCallOpenRouter.mockResolvedValueOnce({
      content: JSON.stringify(invalidItems),
      tokensUsed: 150,
    });

    const result = await runJudge(config, scannerResults, 'mock diff content');

    expect(result.success).toBe(true);
    expect(result.findings).toBeUndefined();
  });

  it('inline mode: drops spoofed sources not in the scanner whitelist', async () => {
    const config = makeConfig({ reviewMode: 'inline' });
    const scannerResults = [makeSuccessfulScanner('model-a'), makeSuccessfulScanner('model-b')];
    const findings = [
      {
        file: 'src/app.ts',
        line: 10,
        severity: 'critical',
        title: 'Bug',
        body: 'Fix',
        sources: ['model-a', 'evil-injected-model'],
      },
    ];

    mockedCallOpenRouter.mockResolvedValueOnce({
      content: JSON.stringify(findings),
      tokensUsed: 100,
    });

    const result = await runJudge(config, scannerResults, 'mock diff content');

    expect(result.findings![0]!.sources).toEqual(['model-a']);
  });

  it('inline mode: omits sources when intersection with scanner whitelist is empty', async () => {
    const config = makeConfig({ reviewMode: 'inline' });
    const scannerResults = [makeSuccessfulScanner('model-a')];
    const findings = [
      {
        file: 'src/app.ts',
        line: 10,
        severity: 'warning',
        title: 'Issue',
        body: 'Detail',
        sources: ['spoofed-model-1', 'spoofed-model-2'],
      },
    ];

    mockedCallOpenRouter.mockResolvedValueOnce({
      content: JSON.stringify(findings),
      tokensUsed: 100,
    });

    const result = await runJudge(config, scannerResults, 'mock diff content');

    expect(result.findings).toHaveLength(1);
    expect(result.findings![0]!.sources).toBeUndefined();
  });

  it('inline mode: does not count sources from failed scanners as valid', async () => {
    const config = makeConfig({ reviewMode: 'inline' });
    const scannerResults = [makeSuccessfulScanner('model-a'), makeFailedScanner('model-b')];
    const findings = [
      { file: 'src/app.ts', line: 10, severity: 'info', title: 'Note', body: 'Detail', sources: ['model-a', 'model-b'] },
    ];

    mockedCallOpenRouter.mockResolvedValueOnce({
      content: JSON.stringify(findings),
      tokensUsed: 100,
    });

    const result = await runJudge(config, scannerResults, 'mock diff content');

    expect(result.findings![0]!.sources).toEqual(['model-a']);
  });

  it('inline mode: caps findings at 30, keeping order', async () => {
    const config = makeConfig({ reviewMode: 'inline' });
    const scannerResults = [makeSuccessfulScanner()];
    const findings = Array.from({ length: 31 }, (_, i) => ({
      file: `src/file-${i}.ts`,
      line: i + 1,
      severity: 'info',
      title: `Finding ${i}`,
      body: `Body ${i}`,
    }));

    mockedCallOpenRouter.mockResolvedValueOnce({
      content: JSON.stringify(findings),
      tokensUsed: 500,
    });

    const result = await runJudge(config, scannerResults, 'mock diff content');

    expect(result.findings).toHaveLength(30);
    expect(result.findings![0]!.title).toBe('Finding 0');
    expect(result.findings![29]!.title).toBe('Finding 29');
  });

  it('inline mode: truncates long title to 300 chars and body to 4000 chars with ellipsis', async () => {
    const config = makeConfig({ reviewMode: 'inline' });
    const scannerResults = [makeSuccessfulScanner()];
    const findings = [
      {
        file: 'src/app.ts',
        line: 1,
        severity: 'warning',
        title: 'T'.repeat(500),
        body: 'B'.repeat(5000),
      },
    ];

    mockedCallOpenRouter.mockResolvedValueOnce({
      content: JSON.stringify(findings),
      tokensUsed: 100,
    });

    const result = await runJudge(config, scannerResults, 'mock diff content');

    const finding = result.findings![0]!;
    expect(finding.title).toHaveLength(300);
    expect(finding.title.endsWith('…')).toBe(true);
    expect(finding.body).toHaveLength(4000);
    expect(finding.body.endsWith('…')).toBe(true);
  });

  it('summary mode: passes prContext as the third argument to buildJudgeUserPrompt', async () => {
    const config = makeConfig({
      reviewMode: 'summary',
      prContext: 'Title: My PR\n\nAdds retry logic.',
    });
    const scannerResults = [makeSuccessfulScanner()];

    mockedCallOpenRouter.mockResolvedValueOnce({ content: 'out', tokensUsed: 10 });

    await runJudge(config, scannerResults, 'mock diff content');

    expect(mockedBuildJudgeUserPrompt).toHaveBeenCalledWith(
      scannerResults,
      'mock diff content',
      'Title: My PR\n\nAdds retry logic.'
    );
    expect(mockedBuildJudgeUserPromptInline).not.toHaveBeenCalled();
  });

  it('inline mode: passes prContext as the third argument to buildJudgeUserPromptInline', async () => {
    const config = makeConfig({
      reviewMode: 'inline',
      prContext: 'Title: Inline PR\n\nContext body.',
    });
    const scannerResults = [makeSuccessfulScanner()];

    mockedCallOpenRouter.mockResolvedValueOnce({ content: '[]', tokensUsed: 10 });

    await runJudge(config, scannerResults, 'mock diff content');

    expect(mockedBuildJudgeUserPromptInline).toHaveBeenCalledWith(
      scannerResults,
      'mock diff content',
      'Title: Inline PR\n\nContext body.'
    );
    expect(mockedBuildJudgeUserPrompt).not.toHaveBeenCalled();
  });

  it('summary mode: passes empty string when prContext is absent (backward compat)', async () => {
    const config = makeConfig({ reviewMode: 'summary' });
    const scannerResults = [makeSuccessfulScanner()];

    mockedCallOpenRouter.mockResolvedValueOnce({ content: 'out', tokensUsed: 10 });

    await runJudge(config, scannerResults, 'mock diff content');

    expect(mockedBuildJudgeUserPrompt).toHaveBeenCalledWith(
      scannerResults,
      'mock diff content',
      ''
    );
  });

  it('inline mode: passes empty string when prContext is absent (backward compat)', async () => {
    const config = makeConfig({ reviewMode: 'inline' });
    const scannerResults = [makeSuccessfulScanner()];

    mockedCallOpenRouter.mockResolvedValueOnce({ content: '[]', tokensUsed: 10 });

    await runJudge(config, scannerResults, 'mock diff content');

    expect(mockedBuildJudgeUserPromptInline).toHaveBeenCalledWith(
      scannerResults,
      'mock diff content',
      ''
    );
  });

  it('inline mode: leaves short title and body untouched', async () => {
    const config = makeConfig({ reviewMode: 'inline' });
    const scannerResults = [makeSuccessfulScanner()];
    const findings = [
      { file: 'src/app.ts', line: 1, severity: 'info', title: 'Short title', body: 'Short body' },
    ];

    mockedCallOpenRouter.mockResolvedValueOnce({
      content: JSON.stringify(findings),
      tokensUsed: 100,
    });

    const result = await runJudge(config, scannerResults, 'mock diff content');

    expect(result.findings![0]!.title).toBe('Short title');
    expect(result.findings![0]!.body).toBe('Short body');
  });

  it('summary mode: appends the truncation marker when finish_reason is length', async () => {
    const config = makeConfig();
    const scannerResults = [makeSuccessfulScanner()];

    mockedCallOpenRouter.mockResolvedValueOnce({
      content: 'Partial review that stopped mid-sen',
      tokensUsed: 4000,
      finishReason: 'length',
    });

    const result = await runJudge(config, scannerResults, 'mock diff content');

    expect(result.success).toBe(true);
    expect(result.output).toBe(`Partial review that stopped mid-sen${TRUNCATION_MARKER}`);
    expect(result.output).toContain('[TRUNCATED]');
  });

  it('inline mode: truncated output skips findings parse and falls back to summary with the marker', async () => {
    const config = makeConfig({ reviewMode: 'inline' });
    const scannerResults = [makeSuccessfulScanner()];
    // A complete-looking JSON array: without the truncation guard this would
    // parse and post as a findings list that silently pretends to be complete.
    const findings = [
      { file: 'src/app.ts', line: 1, severity: 'info', title: 'Only surviving finding', body: 'x' },
    ];

    mockedCallOpenRouter.mockResolvedValueOnce({
      content: JSON.stringify(findings),
      tokensUsed: 4000,
      finishReason: 'length',
    });

    const result = await runJudge(config, scannerResults, 'mock diff content');

    expect(result.success).toBe(true);
    expect(result.findings).toBeUndefined();
    expect(result.output).toContain('[TRUNCATED]');
  });

  it('does not append the marker on a normal stop', async () => {
    const config = makeConfig();
    const scannerResults = [makeSuccessfulScanner()];

    mockedCallOpenRouter.mockResolvedValueOnce({
      content: 'Complete review',
      tokensUsed: 500,
      finishReason: 'stop',
    });

    const result = await runJudge(config, scannerResults, 'mock diff content');

    expect(result.output).toBe('Complete review');
    expect(result.output).not.toContain('[TRUNCATED]');
  });
});
