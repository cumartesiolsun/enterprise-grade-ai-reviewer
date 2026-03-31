import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { parseDiffHunks, isLineInDiff, getConfigFromEnv } from './diff.js';
import type { DiffHunkRange } from './diff.js';

describe('parseDiffHunks', () => {
  it('parses a single hunk header', () => {
    const patch = '@@ -10,5 +20,8 @@\n some diff content';
    const result = parseDiffHunks(patch);
    expect(result).toEqual([{ startLine: 20, endLine: 27 }]);
  });

  it('parses multiple hunk headers', () => {
    const patch = [
      '@@ -1,3 +1,4 @@',
      ' line1',
      '+added line',
      ' line2',
      '@@ -20,5 +21,10 @@',
      ' another section',
    ].join('\n');

    const result = parseDiffHunks(patch);
    expect(result).toEqual([
      { startLine: 1, endLine: 4 },
      { startLine: 21, endLine: 30 },
    ]);
  });

  it('handles hunk with no count (implicit 1)', () => {
    const patch = '@@ -1 +1 @@\n-old\n+new';
    const result = parseDiffHunks(patch);
    expect(result).toEqual([{ startLine: 1, endLine: 1 }]);
  });

  it('returns empty array for patch with no hunk headers', () => {
    const patch = 'This is just some text with no diff headers.';
    const result = parseDiffHunks(patch);
    expect(result).toEqual([]);
  });

  it('handles real-world patch with context lines and content', () => {
    const patch = [
      '@@ -5,7 +5,9 @@ import { something } from "./module";',
      ' ',
      ' const foo = "bar";',
      '-const old = true;',
      '+const new1 = true;',
      '+const new2 = false;',
      ' ',
      ' export default foo;',
      '@@ -50,3 +52,6 @@ function helper() {',
      '   return 1;',
      '+  const x = 2;',
      '+  const y = 3;',
      '+  return x + y;',
      ' }',
    ].join('\n');

    const result = parseDiffHunks(patch);
    expect(result).toEqual([
      { startLine: 5, endLine: 13 },
      { startLine: 52, endLine: 57 },
    ]);
  });
});

describe('isLineInDiff', () => {
  const hunks: DiffHunkRange[] = [
    { startLine: 10, endLine: 20 },
    { startLine: 50, endLine: 60 },
  ];

  it('returns true for line within hunk range', () => {
    expect(isLineInDiff(15, hunks)).toBe(true);
  });

  it('returns true for line at start boundary', () => {
    expect(isLineInDiff(10, hunks)).toBe(true);
  });

  it('returns true for line at end boundary', () => {
    expect(isLineInDiff(20, hunks)).toBe(true);
  });

  it('returns false for line before hunk range', () => {
    expect(isLineInDiff(9, hunks)).toBe(false);
  });

  it('returns false for line after hunk range', () => {
    expect(isLineInDiff(21, hunks)).toBe(false);
  });

  it('returns false for empty hunks array', () => {
    expect(isLineInDiff(15, [])).toBe(false);
  });

  it('returns true when line is in second hunk', () => {
    expect(isLineInDiff(55, hunks)).toBe(true);
  });
});

describe('getConfigFromEnv', () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  it('parses valid environment variables correctly', () => {
    process.env['GITHUB_TOKEN'] = 'ghp_test123';
    process.env['GITHUB_REPOSITORY'] = 'owner/repo';
    process.env['PR_NUMBER'] = '42';

    const config = getConfigFromEnv();
    expect(config).toEqual({
      token: 'ghp_test123',
      owner: 'owner',
      repo: 'repo',
      prNumber: 42,
    });
  });

  it('throws when GITHUB_TOKEN is missing', () => {
    delete process.env['GITHUB_TOKEN'];
    process.env['GITHUB_REPOSITORY'] = 'owner/repo';
    process.env['PR_NUMBER'] = '42';

    expect(() => getConfigFromEnv()).toThrow(
      'GITHUB_TOKEN environment variable is required'
    );
  });

  it('throws when GITHUB_REPOSITORY is missing', () => {
    process.env['GITHUB_TOKEN'] = 'ghp_test123';
    delete process.env['GITHUB_REPOSITORY'];
    process.env['PR_NUMBER'] = '42';

    expect(() => getConfigFromEnv()).toThrow(
      'GITHUB_REPOSITORY environment variable is required'
    );
  });

  it('throws when both PR_NUMBER and GITHUB_REF_NAME are missing', () => {
    process.env['GITHUB_TOKEN'] = 'ghp_test123';
    process.env['GITHUB_REPOSITORY'] = 'owner/repo';
    delete process.env['PR_NUMBER'];
    delete process.env['GITHUB_REF_NAME'];

    expect(() => getConfigFromEnv()).toThrow(
      'PR_NUMBER or valid GITHUB_REF_NAME is required'
    );
  });

  it('falls back to GITHUB_REF_NAME when PR_NUMBER is not set', () => {
    process.env['GITHUB_TOKEN'] = 'ghp_test123';
    process.env['GITHUB_REPOSITORY'] = 'owner/repo';
    delete process.env['PR_NUMBER'];
    process.env['GITHUB_REF_NAME'] = 'refs/pull/99/merge';

    const config = getConfigFromEnv();
    expect(config.prNumber).toBe(99);
  });

  it('throws on invalid GITHUB_REPOSITORY format (no slash)', () => {
    process.env['GITHUB_TOKEN'] = 'ghp_test123';
    process.env['GITHUB_REPOSITORY'] = 'invalidformat';
    process.env['PR_NUMBER'] = '42';

    expect(() => getConfigFromEnv()).toThrow(
      'Invalid GITHUB_REPOSITORY format (expected owner/repo)'
    );
  });
});
