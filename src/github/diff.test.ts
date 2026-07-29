import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseDiffHunks,
  isLineInDiff,
  getConfigFromEnv,
  resolvePrNumber,
  getPRContextFromEnv,
  globToRegExp,
  isPathExcluded,
  applyLimits,
} from './diff.js';
import type { DiffHunkRange, FileDiff } from './diff.js';

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
  it('builds config from explicit token and env record', () => {
    const config = getConfigFromEnv('ghp_test123', {
      GITHUB_REPOSITORY: 'owner/repo',
      PR_NUMBER: '42',
    });

    expect(config).toEqual({
      token: 'ghp_test123',
      owner: 'owner',
      repo: 'repo',
      prNumber: 42,
    });
  });

  it('throws when token is empty', () => {
    expect(() =>
      getConfigFromEnv('', { GITHUB_REPOSITORY: 'owner/repo', PR_NUMBER: '42' })
    ).toThrow('GitHub token is required');
  });

  it('throws when GITHUB_REPOSITORY is missing', () => {
    expect(() => getConfigFromEnv('ghp_test123', { PR_NUMBER: '42' })).toThrow(
      'GITHUB_REPOSITORY environment variable is required'
    );
  });

  it('throws on invalid GITHUB_REPOSITORY format (no slash)', () => {
    expect(() =>
      getConfigFromEnv('ghp_test123', {
        GITHUB_REPOSITORY: 'invalidformat',
        PR_NUMBER: '42',
      })
    ).toThrow('Invalid GITHUB_REPOSITORY format (expected owner/repo)');
  });

  it('throws on GITHUB_REPOSITORY with empty owner or repo part', () => {
    expect(() =>
      getConfigFromEnv('ghp_test123', {
        GITHUB_REPOSITORY: 'owner/',
        PR_NUMBER: '42',
      })
    ).toThrow('Invalid GITHUB_REPOSITORY format (expected owner/repo)');

    expect(() =>
      getConfigFromEnv('ghp_test123', {
        GITHUB_REPOSITORY: '/repo',
        PR_NUMBER: '42',
      })
    ).toThrow('Invalid GITHUB_REPOSITORY format (expected owner/repo)');
  });

  it('resolves PR number from a "<digits>/merge" GITHUB_REF_NAME', () => {
    const config = getConfigFromEnv('ghp_test123', {
      GITHUB_REPOSITORY: 'owner/repo',
      GITHUB_REF_NAME: '99/merge',
    });
    expect(config.prNumber).toBe(99);
  });

  it('throws when no PR number source is available', () => {
    expect(() =>
      getConfigFromEnv('ghp_test123', { GITHUB_REPOSITORY: 'owner/repo' })
    ).toThrow('Could not determine PR number');
  });
});

describe('resolvePrNumber', () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir !== undefined) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  function writeEventFile(content: unknown): string {
    tempDir = mkdtempSync(join(tmpdir(), 'ai-reviewer-diff-test-'));
    const eventPath = join(tempDir, 'event.json');
    const raw = typeof content === 'string' ? content : JSON.stringify(content);
    writeFileSync(eventPath, raw, 'utf8');
    return eventPath;
  }

  it('PR_NUMBER wins over event payload and ref name', () => {
    const eventPath = writeEventFile({ pull_request: { number: 7 } });

    const prNumber = resolvePrNumber({
      PR_NUMBER: '42',
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_REF_NAME: '9/merge',
    });

    expect(prNumber).toBe(42);
  });

  it('trims whitespace around PR_NUMBER', () => {
    expect(resolvePrNumber({ PR_NUMBER: ' 42 ' })).toBe(42);
  });

  it('throws on non-numeric PR_NUMBER instead of falling through', () => {
    expect(() =>
      resolvePrNumber({ PR_NUMBER: 'abc', GITHUB_REF_NAME: '9/merge' })
    ).toThrow("PR_NUMBER must be a positive integer, got 'abc'");
  });

  it('throws on zero or negative PR_NUMBER', () => {
    expect(() => resolvePrNumber({ PR_NUMBER: '0' })).toThrow(
      'PR_NUMBER must be a positive integer'
    );
    expect(() => resolvePrNumber({ PR_NUMBER: '-3' })).toThrow(
      'PR_NUMBER must be a positive integer'
    );
  });

  it('resolves .pull_request.number from the event payload', () => {
    const eventPath = writeEventFile({ pull_request: { number: 123 } });
    expect(resolvePrNumber({ GITHUB_EVENT_PATH: eventPath })).toBe(123);
  });

  it('resolves top-level .number from the event payload (issue-comment style)', () => {
    const eventPath = writeEventFile({ number: 77 });
    expect(resolvePrNumber({ GITHUB_EVENT_PATH: eventPath })).toBe(77);
  });

  it('prefers .pull_request.number over top-level .number', () => {
    const eventPath = writeEventFile({ pull_request: { number: 5 }, number: 9 });
    expect(resolvePrNumber({ GITHUB_EVENT_PATH: eventPath })).toBe(5);
  });

  it('falls back to ref name when the event payload has no PR number', () => {
    const eventPath = writeEventFile({ action: 'created' });
    expect(
      resolvePrNumber({ GITHUB_EVENT_PATH: eventPath, GITHUB_REF_NAME: '55/merge' })
    ).toBe(55);
  });

  it('falls back to ref name when the event payload is invalid JSON', () => {
    const eventPath = writeEventFile('{not valid json');
    expect(
      resolvePrNumber({ GITHUB_EVENT_PATH: eventPath, GITHUB_REF_NAME: '55/merge' })
    ).toBe(55);
  });

  it('falls back to ref name when the event file does not exist', () => {
    expect(
      resolvePrNumber({
        GITHUB_EVENT_PATH: '/nonexistent/path/event.json',
        GITHUB_REF_NAME: '55/merge',
      })
    ).toBe(55);
  });

  it('ignores a non-positive event payload number', () => {
    const eventPath = writeEventFile({ pull_request: { number: 0 } });
    expect(() => resolvePrNumber({ GITHUB_EVENT_PATH: eventPath })).toThrow(
      'Could not determine PR number'
    );
  });

  it('accepts a strict "<digits>/merge" ref name', () => {
    expect(resolvePrNumber({ GITHUB_REF_NAME: '123/merge' })).toBe(123);
  });

  it('rejects a branch name containing digits (release-2024)', () => {
    expect(() => resolvePrNumber({ GITHUB_REF_NAME: 'release-2024' })).toThrow(
      'Could not determine PR number'
    );
  });

  it('rejects a fully-qualified ref (refs/pull/99/merge is not a ref *name*)', () => {
    expect(() => resolvePrNumber({ GITHUB_REF_NAME: 'refs/pull/99/merge' })).toThrow(
      'Could not determine PR number'
    );
  });

  it('throws a clear error when everything is missing', () => {
    expect(() => resolvePrNumber({})).toThrow(
      'Could not determine PR number: set PR_NUMBER, run on a pull_request event'
    );
  });
});

describe('getPRContextFromEnv', () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir !== undefined) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  function writeEventFile(content: unknown): string {
    tempDir = mkdtempSync(join(tmpdir(), 'ai-reviewer-context-test-'));
    const eventPath = join(tempDir, 'event.json');
    const raw = typeof content === 'string' ? content : JSON.stringify(content);
    writeFileSync(eventPath, raw, 'utf8');
    return eventPath;
  }

  it('builds "Title: <title>\\n\\n<body>" when both are present', () => {
    const eventPath = writeEventFile({
      pull_request: { title: 'Add retry logic', body: 'Retries failed requests 3 times.' },
    });

    expect(getPRContextFromEnv({ GITHUB_EVENT_PATH: eventPath })).toBe(
      'Title: Add retry logic\n\nRetries failed requests 3 times.'
    );
  });

  it('uses the "Title: " prefix only for the title part', () => {
    const eventPath = writeEventFile({
      pull_request: { title: 'My PR', body: 'Body text.' },
    });

    const context = getPRContextFromEnv({ GITHUB_EVENT_PATH: eventPath });

    expect(context.startsWith('Title: My PR')).toBe(true);
    expect(context).not.toContain('Title: Body text.');
  });

  it('omits the body when it is missing or null', () => {
    const missing = writeEventFile({ pull_request: { title: 'Only title' } });
    expect(getPRContextFromEnv({ GITHUB_EVENT_PATH: missing })).toBe('Title: Only title');

    const nulled = writeEventFile({ pull_request: { title: 'Only title', body: null } });
    expect(getPRContextFromEnv({ GITHUB_EVENT_PATH: nulled })).toBe('Title: Only title');
  });

  it('omits the title when it is missing or null (no "Title:" prefix)', () => {
    const eventPath = writeEventFile({
      pull_request: { title: null, body: 'Just a body.' },
    });

    expect(getPRContextFromEnv({ GITHUB_EVENT_PATH: eventPath })).toBe('Just a body.');
  });

  it('returns empty string when both title and body are absent', () => {
    const eventPath = writeEventFile({ pull_request: { number: 42 } });
    expect(getPRContextFromEnv({ GITHUB_EVENT_PATH: eventPath })).toBe('');
  });

  it('returns empty string when the payload has no pull_request', () => {
    const eventPath = writeEventFile({ number: 42 });
    expect(getPRContextFromEnv({ GITHUB_EVENT_PATH: eventPath })).toBe('');
  });

  it('returns empty string when GITHUB_EVENT_PATH is not set', () => {
    expect(getPRContextFromEnv({})).toBe('');
  });

  it('returns empty string when the event file does not exist', () => {
    expect(
      getPRContextFromEnv({ GITHUB_EVENT_PATH: '/nonexistent/path/event.json' })
    ).toBe('');
  });

  it('returns empty string on invalid JSON', () => {
    const eventPath = writeEventFile('{not valid json');
    expect(getPRContextFromEnv({ GITHUB_EVENT_PATH: eventPath })).toBe('');
  });

  it('strips HTML comments from the body', () => {
    const eventPath = writeEventFile({
      pull_request: {
        title: 'Clean PR',
        body: 'Before <!-- hidden template instructions --> after <!-- another -->end',
      },
    });

    const context = getPRContextFromEnv({ GITHUB_EVENT_PATH: eventPath });

    expect(context).not.toContain('hidden template instructions');
    expect(context).not.toContain('another');
    expect(context).not.toContain('<!--');
    expect(context).toContain('Before');
    expect(context).toContain('end');
  });

  it('strips an unterminated HTML comment through to the end', () => {
    const eventPath = writeEventFile({
      pull_request: {
        title: 'PR',
        body: 'Visible part <!-- unterminated injection payload',
      },
    });

    const context = getPRContextFromEnv({ GITHUB_EVENT_PATH: eventPath });

    expect(context).toBe('Title: PR\n\nVisible part');
    expect(context).not.toContain('unterminated injection payload');
  });

  it('returns only the title when the body is entirely an HTML comment', () => {
    const eventPath = writeEventFile({
      pull_request: { title: 'T', body: '<!-- template boilerplate -->' },
    });

    expect(getPRContextFromEnv({ GITHUB_EVENT_PATH: eventPath })).toBe('Title: T');
  });

  it('trims leading and trailing whitespace', () => {
    const eventPath = writeEventFile({
      pull_request: { body: '\n\n   hello world   \n\n' },
    });

    expect(getPRContextFromEnv({ GITHUB_EVENT_PATH: eventPath })).toBe('hello world');
  });

  it('hard-truncates the context to 4000 characters', () => {
    const eventPath = writeEventFile({
      pull_request: { title: 'Big', body: 'A'.repeat(5000) },
    });

    const context = getPRContextFromEnv({ GITHUB_EVENT_PATH: eventPath });

    expect(context).toHaveLength(4000);
    expect(context.startsWith('Title: Big\n\nAAA')).toBe(true);
  });

  it('leaves content at exactly 4000 characters untouched', () => {
    const body = 'B'.repeat(4000);
    const eventPath = writeEventFile({ pull_request: { body } });

    expect(getPRContextFromEnv({ GITHUB_EVENT_PATH: eventPath })).toBe(body);
  });
});

describe('globToRegExp', () => {
  it('** crosses directory separators (and matches zero directories)', () => {
    const re = globToRegExp('**/package-lock.json');
    expect(re.test('package-lock.json')).toBe(true);
    expect(re.test('apps/web/package-lock.json')).toBe(true);
    expect(re.test('apps/web/package-lock.json.bak')).toBe(false);
  });

  it('* does not cross directory separators', () => {
    const re = globToRegExp('src/*.js');
    expect(re.test('src/app.js')).toBe(true);
    expect(re.test('src/nested/app.js')).toBe(false);
  });

  it('? matches exactly one non-slash character', () => {
    const re = globToRegExp('file?.ts');
    expect(re.test('file1.ts')).toBe(true);
    expect(re.test('file12.ts')).toBe(false);
    expect(re.test('file.ts')).toBe(false);
    expect(globToRegExp('a?b').test('a/b')).toBe(false);
  });

  it('treats "." as a literal, not a regex wildcard', () => {
    const re = globToRegExp('*.min.js');
    expect(re.test('app.min.js')).toBe(true);
    expect(re.test('appzminzjs')).toBe(false);
  });

  it('escapes regex metacharacters in patterns without throwing', () => {
    expect(() => globToRegExp('a{2}|b^$.(x)+[y].ts')).not.toThrow();

    const re = globToRegExp('file(1)+[a].ts');
    expect(re.test('file(1)+[a].ts')).toBe(true);
    expect(re.test('file1a.ts')).toBe(false);
  });

  it('**/dist/** matches files contained in any dist directory', () => {
    const re = globToRegExp('**/dist/**');
    expect(re.test('dist/index.js')).toBe(true);
    expect(re.test('packages/core/dist/chunks/a.js')).toBe(true);
    expect(re.test('distx/index.js')).toBe(false);
    expect(re.test('src/redist/index.js')).toBe(false);
  });

  it('anchors the pattern at both ends', () => {
    const re = globToRegExp('dist');
    expect(re.test('dist')).toBe(true);
    expect(re.test('dist/file.js')).toBe(false);
    expect(re.test('my-dist')).toBe(false);
  });
});

describe('isPathExcluded', () => {
  it('matches **/package-lock.json against nested paths', () => {
    expect(isPathExcluded('package-lock.json', ['**/package-lock.json'])).toBe(true);
    expect(isPathExcluded('apps/web/package-lock.json', ['**/package-lock.json'])).toBe(
      true
    );
    expect(isPathExcluded('src/index.ts', ['**/package-lock.json'])).toBe(false);
  });

  it('matches slash-less patterns against the basename', () => {
    expect(isPathExcluded('src/deep/app.min.js', ['*.min.js'])).toBe(true);
    expect(isPathExcluded('app.min.js', ['*.min.js'])).toBe(true);
    expect(isPathExcluded('src/app.js', ['*.min.js'])).toBe(false);
  });

  it('does not apply basename matching for patterns containing a slash', () => {
    expect(isPathExcluded('src/a.js', ['src/*.js'])).toBe(true);
    expect(isPathExcluded('deep/nested/src/a.js', ['src/*.js'])).toBe(false);
  });

  it('matches **/dist/** for contained files', () => {
    expect(isPathExcluded('dist/index.js', ['**/dist/**'])).toBe(true);
    expect(isPathExcluded('packages/a/dist/chunk.js', ['**/dist/**'])).toBe(true);
    expect(isPathExcluded('src/distribution.ts', ['**/dist/**'])).toBe(false);
  });

  it('returns true when any of several patterns matches', () => {
    const patterns = ['**/yarn.lock', '*.snap', '**/vendor/**'];
    expect(isPathExcluded('a/b/yarn.lock', patterns)).toBe(true);
    expect(isPathExcluded('tests/__snapshots__/x.snap', patterns)).toBe(true);
    expect(isPathExcluded('src/main.ts', patterns)).toBe(false);
  });

  it('returns false for an empty pattern list', () => {
    expect(isPathExcluded('anything.ts', [])).toBe(false);
  });

  it('does not blow up on regex metachars in patterns', () => {
    expect(isPathExcluded('weird(file)+name.ts', ['weird(file)+name.ts'])).toBe(true);
    expect(isPathExcluded('weirdfile.ts', ['weird(file)+name.ts'])).toBe(false);
  });
});

describe('applyLimits', () => {
  function makeFile(
    filename: string,
    additions: number,
    deletions: number,
    patch?: string
  ): FileDiff {
    return { filename, status: 'modified', additions, deletions, patch };
  }

  it('passes everything through when no limit is hit', () => {
    const files = [makeFile('a.ts', 1, 1, '@@ -1 +1 @@\n+a')];

    const result = applyLimits(files, 10, 10000);

    expect(result.files).toEqual(files);
    expect(result.combinedDiff).toContain('diff --git a/a.ts b/a.ts');
    expect(result.truncation).toEqual({
      filesFound: 1,
      filesReviewed: 1,
      originalChars: result.combinedDiff.length,
      truncatedChars: result.combinedDiff.length,
      wasTruncated: false,
      truncationReason: undefined,
    });
  });

  it('limits file count, prioritizing by additions+deletions', () => {
    const files = [
      makeFile('small.ts', 1, 0, '+s'),
      makeFile('large.ts', 50, 20, '+l'),
      makeFile('medium.ts', 10, 5, '+m'),
      makeFile('tiny.ts', 0, 1, '+t'),
    ];

    const result = applyLimits(files, 2, 10000);

    expect(result.files.map((f) => f.filename)).toEqual(['large.ts', 'medium.ts']);
    expect(result.truncation.filesFound).toBe(4);
    expect(result.truncation.filesReviewed).toBe(2);
    expect(result.truncation.wasTruncated).toBe(true);
    expect(result.truncation.truncationReason).toContain('Limited to 2 files (found 4)');
    expect(result.combinedDiff).not.toContain('small.ts');
    expect(result.combinedDiff).not.toContain('tiny.ts');
  });

  it('drops patch-less files first when limiting file count', () => {
    const files = [
      makeFile('huge-binary.png', 100, 0, undefined),
      makeFile('a.ts', 5, 5, '+a'),
      makeFile('b.ts', 3, 3, '+b'),
    ];

    const result = applyLimits(files, 2, 10000);

    // The binary has the most changes but no patch, so it must not win a slot
    expect(result.files.map((f) => f.filename)).toEqual(['a.ts', 'b.ts']);
    expect(result.truncation.filesWithoutPatch).toBe(1);
    expect(result.truncation.truncationReason).toContain(
      '1 file(s) had no reviewable diff'
    );
    expect(result.truncation.truncationReason).toContain('Limited to 2 files');
  });

  it('counts patch-less files even when under the file limit', () => {
    const files = [
      makeFile('image.png', 10, 0, undefined),
      makeFile('a.ts', 1, 1, '+a'),
    ];

    const result = applyLimits(files, 10, 10000);

    expect(result.truncation.filesWithoutPatch).toBe(1);
    expect(result.truncation.filesReviewed).toBe(1);
    expect(result.truncation.wasTruncated).toBe(true);
    expect(result.truncation.truncationReason).toContain(
      '1 file(s) had no reviewable diff (binary or too large)'
    );
    expect(result.combinedDiff).not.toContain('image.png');
  });

  it('filters excluded paths and reports count and reason', () => {
    const files = [
      makeFile('package-lock.json', 500, 500, '+lock'),
      makeFile('src/app.min.js', 10, 0, '+min'),
      makeFile('src/app.ts', 1, 1, '+app'),
    ];

    const result = applyLimits(files, 10, 10000, [
      '**/package-lock.json',
      '*.min.js',
    ]);

    expect(result.files.map((f) => f.filename)).toEqual(['src/app.ts']);
    expect(result.truncation.filesFound).toBe(3);
    expect(result.truncation.filesExcluded).toBe(2);
    expect(result.truncation.wasTruncated).toBe(true);
    expect(result.truncation.truncationReason).toContain(
      'excluded 2 file(s) by exclude-paths'
    );
    expect(result.combinedDiff).not.toContain('package-lock.json');
    expect(result.combinedDiff).not.toContain('app.min.js');
  });

  it('reports no exclusions when patterns are omitted or empty', () => {
    const files = [makeFile('package-lock.json', 1, 1, '+x')];

    expect(applyLimits(files, 10, 10000).truncation.filesExcluded).toBeUndefined();
    expect(applyLimits(files, 10, 10000, []).truncation.filesExcluded).toBeUndefined();
  });

  it('cuts at the last file boundary when the marker is past half of maxChars', () => {
    // File A section is ~642 chars, so the boundary sits past maxChars * 0.5 (500)
    const files = [
      makeFile('a.ts', 1, 1, 'A'.repeat(600)),
      makeFile('b.ts', 1, 1, 'B'.repeat(600)),
    ];

    const result = applyLimits(files, 10, 1000);

    expect(result.truncation.wasTruncated).toBe(true);
    expect(result.truncation.truncationReason).toContain('Truncated to 1000 chars');
    expect(result.combinedDiff).toContain('diff --git a/a.ts b/a.ts');
    // File B is cut off entirely at the boundary — no partial diff fragment
    expect(result.combinedDiff).not.toContain('diff --git a/b.ts b/b.ts');
    expect(result.combinedDiff).not.toContain('B');
    expect(result.truncation.truncatedChars).toBe(result.combinedDiff.length);
    expect(result.truncation.truncatedChars).toBeLessThan(1000);
    expect(result.truncation.originalChars).toBeGreaterThan(1000);
  });

  it('keeps the raw char cut when the last boundary is before half of maxChars', () => {
    // File A section is ~52 chars, so the boundary is well before maxChars * 0.5
    const files = [
      makeFile('a.ts', 1, 1, 'A'.repeat(10)),
      makeFile('b.ts', 1, 1, 'B'.repeat(2000)),
    ];

    const result = applyLimits(files, 10, 1000);

    expect(result.combinedDiff).toHaveLength(1000);
    expect(result.combinedDiff).toContain('diff --git a/b.ts b/b.ts');
    // Mid-file cut: file B's patch is included but truncated
    expect(result.combinedDiff.endsWith('B')).toBe(true);
    expect(result.truncation.truncatedChars).toBe(1000);
    expect(result.truncation.truncationReason).toContain('Truncated to 1000 chars');
  });

  it('joins multiple truncation reasons with "; "', () => {
    const files = [
      makeFile('vendor/lib.js', 5, 5, '+v'),
      makeFile('image.png', 10, 0, undefined),
      makeFile('a.ts', 1, 1, '+a'),
    ];

    const result = applyLimits(files, 10, 10000, ['**/vendor/**']);

    expect(result.truncation.truncationReason).toBe(
      'excluded 1 file(s) by exclude-paths; 1 file(s) had no reviewable diff (binary or too large)'
    );
  });
});
