import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GitHubConfig, TruncationInfo } from '../github/diff.js';
import type { ScannerResult, RoleCoverage } from './scanner.js';
import type { InlineFinding } from './judge.js';
import type {
  PostResultsInput,
  PostResultsJudge,
  PostResultsDiff,
  PostResultsExtras,
} from './postResults.js';

vi.mock('../github/comments.js', () => ({
  postOrUpdateComment: vi.fn(),
  postInlineReview: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { postResults } from './postResults.js';
import { postOrUpdateComment, postInlineReview } from '../github/comments.js';
import { logger } from '../utils/logger.js';

const mockedPostOrUpdate = vi.mocked(postOrUpdateComment);
const mockedPostInline = vi.mocked(postInlineReview);
const mockedLogger = vi.mocked(logger);

function makeGitHubConfig(): GitHubConfig {
  return { token: 'test-token', owner: 'test-owner', repo: 'test-repo', prNumber: 1 };
}

function makeTruncation(): TruncationInfo {
  return { filesFound: 3, filesReviewed: 3, originalChars: 500, truncatedChars: 500, wasTruncated: false };
}

function makeScanner(model: string = 'scanner-1'): ScannerResult {
  return { model, output: 'Found issue', tokensUsed: 100, durationMs: 500, success: true, status: 'OK', role: 'general' };
}

function makeDiff(): PostResultsDiff {
  return {
    files: [{ filename: 'src/app.ts', status: 'modified', additions: 5, deletions: 2, patch: '@@ -1,5 +1,8 @@\n code' }],
    headSha: 'abc123',
    truncation: makeTruncation(),
  };
}

describe('postResults', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('inline mode with findings: calls postInlineReview', async () => {
    const inputs: PostResultsInput = { reviewMode: 'inline', commentMarker: 'TEST_MARKER' };
    const findings: InlineFinding[] = [
      { file: 'src/app.ts', line: 5, severity: 'critical', title: 'Bug', body: 'Fix it' },
    ];
    const judge: PostResultsJudge = { output: 'raw output', findings };
    const diff = makeDiff();
    const scanners = [makeScanner()];

    await postResults(inputs, makeGitHubConfig(), judge, diff, scanners);

    expect(mockedPostInline).toHaveBeenCalledOnce();
    expect(mockedPostOrUpdate).not.toHaveBeenCalled();
    expect(mockedPostInline).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'test-owner' }),
      findings,
      diff.files,
      'abc123',
      scanners,
      diff.truncation,
      'TEST_MARKER'
    );
  });

  it('inline mode with empty findings array: posts LGTM message', async () => {
    const inputs: PostResultsInput = { reviewMode: 'inline', commentMarker: 'TEST_MARKER' };
    const judge: PostResultsJudge = { output: '[]', findings: [] };
    const diff = makeDiff();
    const scanners = [makeScanner()];

    await postResults(inputs, makeGitHubConfig(), judge, diff, scanners);

    expect(mockedPostInline).not.toHaveBeenCalled();
    expect(mockedPostOrUpdate).toHaveBeenCalledOnce();
    expect(mockedPostOrUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'test-owner' }),
      expect.objectContaining({
        judgeOutput: expect.stringContaining('No issues found'),
      }),
      'TEST_MARKER'
    );
  });

  it('inline mode with undefined findings (parse failure): falls back to summary', async () => {
    const inputs: PostResultsInput = { reviewMode: 'inline', commentMarker: 'TEST_MARKER' };
    const judge: PostResultsJudge = { output: 'Raw judge text', findings: undefined };
    const diff = makeDiff();
    const scanners = [makeScanner()];

    await postResults(inputs, makeGitHubConfig(), judge, diff, scanners);

    expect(mockedPostInline).not.toHaveBeenCalled();
    expect(mockedPostOrUpdate).toHaveBeenCalledOnce();
    expect(mockedPostOrUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ judgeOutput: 'Raw judge text' }),
      'TEST_MARKER'
    );
    expect(mockedLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('falling back to summary')
    );
  });

  it('summary mode: posts judge output directly', async () => {
    const inputs: PostResultsInput = { reviewMode: 'summary', commentMarker: 'MARKER' };
    const judge: PostResultsJudge = { output: 'Summary review text' };
    const diff = makeDiff();
    const scanners = [makeScanner()];

    await postResults(inputs, makeGitHubConfig(), judge, diff, scanners);

    expect(mockedPostInline).not.toHaveBeenCalled();
    expect(mockedPostOrUpdate).toHaveBeenCalledOnce();
    expect(mockedPostOrUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ judgeOutput: 'Summary review text' }),
      'MARKER'
    );
    expect(mockedLogger.warn).not.toHaveBeenCalled();
  });

  it('summary mode ignores findings even if present', async () => {
    const inputs: PostResultsInput = { reviewMode: 'summary', commentMarker: 'MARKER' };
    const findings: InlineFinding[] = [
      { file: 'src/app.ts', line: 5, severity: 'warning', title: 'Test', body: 'Body' },
    ];
    const judge: PostResultsJudge = { output: 'Summary text', findings };
    const diff = makeDiff();
    const scanners = [makeScanner()];

    await postResults(inputs, makeGitHubConfig(), judge, diff, scanners);

    expect(mockedPostInline).not.toHaveBeenCalled();
    expect(mockedPostOrUpdate).toHaveBeenCalledOnce();
  });

  it('passes scanner results and truncation info correctly', async () => {
    const inputs: PostResultsInput = { reviewMode: 'summary', commentMarker: 'M' };
    const judge: PostResultsJudge = { output: 'text' };
    const truncation = makeTruncation();
    const diff: PostResultsDiff = { files: [], headSha: 'sha', truncation };
    const scanners = [makeScanner('model-a'), makeScanner('model-b')];

    await postResults(inputs, makeGitHubConfig(), judge, diff, scanners);

    const callData = mockedPostOrUpdate.mock.calls[0]![1]!;
    expect(callData.scannerResults).toHaveLength(2);
    expect(callData.truncation).toBe(truncation);
  });
});

describe('postResults — coverage/degraded extras', () => {
  const coverage: RoleCoverage[] = [
    { role: 'security', status: 'covered' },
    { role: 'logic', status: 'rescued' },
    { role: 'performance', status: 'uncovered' },
  ];
  const extras: PostResultsExtras = { coverage, degraded: true };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('threads extras into postInlineReview in inline mode with findings', async () => {
    const inputs: PostResultsInput = { reviewMode: 'inline', commentMarker: 'TEST_MARKER' };
    const findings: InlineFinding[] = [
      { file: 'src/app.ts', line: 5, severity: 'critical', title: 'Bug', body: 'Fix it' },
    ];
    const judge: PostResultsJudge = { output: 'raw output', findings };
    const diff = makeDiff();
    const scanners = [makeScanner()];

    await postResults(inputs, makeGitHubConfig(), judge, diff, scanners, extras);

    expect(mockedPostInline).toHaveBeenCalledOnce();
    expect(mockedPostInline).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'test-owner' }),
      findings,
      diff.files,
      'abc123',
      scanners,
      diff.truncation,
      'TEST_MARKER',
      extras
    );
  });

  it('does not append an extras argument when none is given (inline mode)', async () => {
    const inputs: PostResultsInput = { reviewMode: 'inline', commentMarker: 'TEST_MARKER' };
    const findings: InlineFinding[] = [
      { file: 'src/app.ts', line: 5, severity: 'critical', title: 'Bug', body: 'Fix it' },
    ];
    const judge: PostResultsJudge = { output: 'raw output', findings };

    await postResults(inputs, makeGitHubConfig(), judge, makeDiff(), [makeScanner()]);

    expect(mockedPostInline.mock.calls[0]).toHaveLength(7);
  });

  it('threads extras into the LGTM comment in inline mode with empty findings', async () => {
    const inputs: PostResultsInput = { reviewMode: 'inline', commentMarker: 'TEST_MARKER' };
    const judge: PostResultsJudge = { output: '[]', findings: [] };

    await postResults(inputs, makeGitHubConfig(), judge, makeDiff(), [makeScanner()], extras);

    expect(mockedPostInline).not.toHaveBeenCalled();
    expect(mockedPostOrUpdate).toHaveBeenCalledOnce();
    expect(mockedPostOrUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ coverage, degraded: true }),
      'TEST_MARKER'
    );
  });

  it('(c) stamps the degraded suffix on the inline LGTM line when the judge kept no findings', async () => {
    const inputs: PostResultsInput = { reviewMode: 'inline', commentMarker: 'TEST_MARKER' };
    const judge: PostResultsJudge = { output: '[]', findings: [] };
    const suffix = '⚠️ DEGRADED — 1 scanner failed: `deepseek/deepseek-v4-pro-0813`';

    await postResults(inputs, makeGitHubConfig(), judge, makeDiff(), [makeScanner()], {
      ...extras,
      degradedSuffix: suffix,
    });

    expect(mockedPostOrUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        judgeOutput: `No issues found in this PR. LGTM! ✅ — ${suffix}`,
        coverage,
        degraded: true,
      }),
      'TEST_MARKER'
    );
  });

  it('threads extras into the summary fallback when findings failed to parse', async () => {
    const inputs: PostResultsInput = { reviewMode: 'inline', commentMarker: 'TEST_MARKER' };
    const judge: PostResultsJudge = { output: 'Raw judge text', findings: undefined };

    await postResults(inputs, makeGitHubConfig(), judge, makeDiff(), [makeScanner()], extras);

    expect(mockedPostInline).not.toHaveBeenCalled();
    expect(mockedPostOrUpdate).toHaveBeenCalledOnce();
    expect(mockedPostOrUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        judgeOutput: 'Raw judge text',
        coverage,
        degraded: true,
      }),
      'TEST_MARKER'
    );
  });

  it('threads extras into postOrUpdateComment in summary mode', async () => {
    const inputs: PostResultsInput = { reviewMode: 'summary', commentMarker: 'MARKER' };
    const judge: PostResultsJudge = { output: 'Summary review text' };

    await postResults(inputs, makeGitHubConfig(), judge, makeDiff(), [makeScanner()], extras);

    expect(mockedPostOrUpdate).toHaveBeenCalledOnce();
    expect(mockedPostOrUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        judgeOutput: 'Summary review text',
        coverage,
        degraded: true,
      }),
      'MARKER'
    );
  });

  it('leaves coverage and degraded undefined in summary mode without extras', async () => {
    const inputs: PostResultsInput = { reviewMode: 'summary', commentMarker: 'MARKER' };
    const judge: PostResultsJudge = { output: 'Summary review text' };

    await postResults(inputs, makeGitHubConfig(), judge, makeDiff(), [makeScanner()]);

    const callData = mockedPostOrUpdate.mock.calls[0]![1]!;
    expect(callData.coverage).toBeUndefined();
    expect(callData.degraded).toBeUndefined();
  });
});
