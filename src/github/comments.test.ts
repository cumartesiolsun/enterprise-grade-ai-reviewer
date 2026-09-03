import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Octokit } from '@octokit/rest';
import {
  buildCommentBody,
  sanitizeModelOutput,
  findExistingComment,
  postInlineReview,
} from './comments.js';
import type { ReviewCommentData } from './comments.js';
import type { ScannerResult, RoleCoverage } from '../review/scanner.js';
import type { InlineFinding } from '../review/judge.js';
import type { TruncationInfo, FileDiff, GitHubConfig } from './diff.js';

// --- Octokit mock ---

const { mockOctokit } = vi.hoisted(() => {
  const mockOctokit = {
    paginate: vi.fn(),
    issues: {
      listComments: vi.fn(),
      updateComment: vi.fn(),
      createComment: vi.fn(),
    },
    pulls: {
      createReview: vi.fn(),
      listReviewComments: vi.fn(),
    },
  };
  return { mockOctokit };
});

vi.mock('@octokit/rest', () => ({
  // Regular function (not arrow) so `new Octokit()` works; returning an
  // object from a constructor makes that object the instance.
  Octokit: vi.fn(function (this: unknown) {
    return mockOctokit;
  }),
}));

// Production code obtains its client via the shared factory (client.ts,
// which composes retry/throttling plugins) — route it to the same mock.
vi.mock('./client.js', () => ({
  createGitHubClient: vi.fn(() => mockOctokit),
}));

// --- Helper factories ---

function makeScannerResult(
  overrides: Partial<ScannerResult> = {}
): ScannerResult {
  return {
    model: 'test-model',
    output: 'Looks good.',
    tokensUsed: 100,
    durationMs: 500,
    success: true,
    status: 'OK',
    role: 'general',
    ...overrides,
  };
}

function makeTruncationInfo(
  overrides: Partial<TruncationInfo> = {}
): TruncationInfo {
  return {
    filesFound: 10,
    filesReviewed: 10,
    originalChars: 5000,
    truncatedChars: 5000,
    wasTruncated: false,
    ...overrides,
  };
}

function makeReviewCommentData(
  overrides: Partial<ReviewCommentData> = {}
): ReviewCommentData {
  return {
    judgeOutput: 'No major issues found.',
    scannerResults: [makeScannerResult()],
    truncation: makeTruncationInfo(),
    ...overrides,
  };
}

function makeGitHubConfig(): GitHubConfig {
  return { token: 'test-token', owner: 'test-owner', repo: 'test-repo', prNumber: 1 };
}

function makeFileDiff(overrides: Partial<FileDiff> = {}): FileDiff {
  return {
    filename: 'src/app.ts',
    status: 'modified',
    additions: 5,
    deletions: 0,
    // New-side lines 1-10 are valid inline targets
    patch: '@@ -1,5 +1,10 @@\n context',
    ...overrides,
  };
}

function makeFinding(overrides: Partial<InlineFinding> = {}): InlineFinding {
  return {
    file: 'src/app.ts',
    line: 2,
    severity: 'warning',
    title: 'Test finding',
    body: 'Something looks off.',
    ...overrides,
  };
}

const DEFAULT_MARKER = 'enterprise-ai-review-marker';

const DEGRADED_WARNING = '> ⚠️ Degraded scanner coverage this run — see Sources.';

const FULL_COVERAGE: RoleCoverage[] = [
  { role: 'security', status: 'covered' },
  { role: 'logic', status: 'rescued' },
  { role: 'performance', status: 'uncovered' },
];

const FULL_COVERAGE_LINE =
  'Coverage: security ✅ · logic 🔁 rescued · performance ❌ uncovered';

beforeEach(() => {
  vi.clearAllMocks();
  mockOctokit.paginate.mockResolvedValue([]);
  mockOctokit.pulls.createReview.mockResolvedValue({ data: {} });
  mockOctokit.issues.createComment.mockResolvedValue({ data: {} });
  mockOctokit.issues.updateComment.mockResolvedValue({ data: {} });
});

// --- Tests ---

describe('buildCommentBody', () => {
  it('includes the HTML comment marker', () => {
    const marker = 'my-custom-marker';
    const body = buildCommentBody(makeReviewCommentData(), marker);

    expect(body).toContain(`<!-- ${marker} -->`);
  });

  it('includes the judge output text', () => {
    const judgeOutput = 'Critical: SQL injection vulnerability detected in user input handling.';
    const body = buildCommentBody(
      makeReviewCommentData({ judgeOutput }),
      DEFAULT_MARKER
    );

    expect(body).toContain(judgeOutput);
  });

  it('includes scanner model names with status badges', () => {
    const scannerResults = [
      makeScannerResult({ model: 'openai/gpt-4o', status: 'OK' }),
      makeScannerResult({ model: 'anthropic/claude-3.5-sonnet', status: 'SKIPPED' }),
    ];
    const body = buildCommentBody(
      makeReviewCommentData({ scannerResults }),
      DEFAULT_MARKER
    );

    expect(body).toContain('`openai/gpt-4o`');
    expect(body).toContain('`anthropic/claude-3.5-sonnet`');
  });

  it('shows OK badge for successful scanners', () => {
    const scannerResults = [makeScannerResult({ model: 'model-a', status: 'OK' })];
    const body = buildCommentBody(
      makeReviewCommentData({ scannerResults }),
      DEFAULT_MARKER
    );

    expect(body).toContain('`model-a` (general): ✅ OK');
  });

  it('shows SKIPPED badge for skipped scanners', () => {
    const scannerResults = [makeScannerResult({ model: 'model-b', status: 'SKIPPED' })];
    const body = buildCommentBody(
      makeReviewCommentData({ scannerResults }),
      DEFAULT_MARKER
    );

    expect(body).toContain('`model-b` (general): ⏭️ SKIPPED (NO_FINDINGS — scanner ran, nothing to report)');
    expect(body).not.toContain('empty/NO_FINDINGS');
  });

  it('shows FAILED badge with error message for failed scanners', () => {
    const scannerResults = [
      makeScannerResult({
        model: 'model-c',
        status: 'FAILED',
        success: false,
        error: 'Rate limit exceeded',
      }),
    ];
    const body = buildCommentBody(
      makeReviewCommentData({ scannerResults }),
      DEFAULT_MARKER
    );

    expect(body).toContain('`model-c` (general): ❌ FAILED (Rate limit exceeded)');
  });

  it('shows FAILED badge with "unknown error" when no error message is provided', () => {
    const scannerResults = [
      makeScannerResult({
        model: 'model-d',
        status: 'FAILED',
        success: false,
      }),
    ];
    const body = buildCommentBody(
      makeReviewCommentData({ scannerResults }),
      DEFAULT_MARKER
    );

    expect(body).toContain('`model-d` (general): ❌ FAILED (unknown error)');
  });

  it('includes truncation notes when wasTruncated is true', () => {
    const truncation = makeTruncationInfo({
      wasTruncated: true,
      truncationReason: 'Diff exceeded maximum character limit',
    });
    const body = buildCommentBody(
      makeReviewCommentData({ truncation }),
      DEFAULT_MARKER
    );

    expect(body).toContain('### Notes');
    expect(body).toContain('⚠️ Diff exceeded maximum character limit');
  });

  it('does NOT include truncation notes when wasTruncated is false', () => {
    const truncation = makeTruncationInfo({ wasTruncated: false });
    const body = buildCommentBody(
      makeReviewCommentData({ truncation }),
      DEFAULT_MARKER
    );

    expect(body).not.toContain('### Notes');
    expect(body).not.toContain('⚠️');
  });

  it('includes all truncation details (filesFound, filesReviewed, chars)', () => {
    const truncation = makeTruncationInfo({
      wasTruncated: true,
      truncationReason: 'Too many files',
      filesFound: 42,
      filesReviewed: 20,
      originalChars: 150000,
      truncatedChars: 80000,
    });
    const body = buildCommentBody(
      makeReviewCommentData({ truncation }),
      DEFAULT_MARKER
    );

    expect(body).toContain('- Files found: 42');
    expect(body).toContain('- Files reviewed: 20');
    expect(body).toContain('- Original size: 150000 chars');
    expect(body).toContain('- Reviewed size: 80000 chars');
  });

  it('shows contribution counts parsed from (by: ...) tags in judge output', () => {
    const judgeOutput = [
      '1. Bug found (by: model-a, model-b)',
      '2. Security issue (by: model-a, model-c)',
      '3. Style issue (by: model-b)',
    ].join('\n');

    const data = makeReviewCommentData({
      judgeOutput,
      scannerResults: [
        makeScannerResult({ model: 'model-a' }),
        makeScannerResult({ model: 'model-b' }),
        makeScannerResult({ model: 'model-c' }),
      ],
    });

    const body = buildCommentBody(data, DEFAULT_MARKER);

    expect(body).toContain('`model-a` (general): ✅ OK — contributed to 2 finding(s)');
    expect(body).toContain('`model-b` (general): ✅ OK — contributed to 2 finding(s)');
    expect(body).toContain('`model-c` (general): ✅ OK — contributed to 1 finding(s)');
  });

  it('shows no contribution count when judge output has no (by: ...) tags', () => {
    const data = makeReviewCommentData({
      judgeOutput: 'No issues found.',
      scannerResults: [makeScannerResult({ model: 'model-x' })],
    });

    const body = buildCommentBody(data, DEFAULT_MARKER);

    expect(body).toContain('`model-x` (general): ✅ OK');
    expect(body).not.toContain('contributed to');
  });

  it('contains OUR marker exactly once even when judge output smuggles the marker', () => {
    const judgeOutput = `Injected <!-- ${DEFAULT_MARKER} --> attack text`;
    const body = buildCommentBody(
      makeReviewCommentData({ judgeOutput }),
      DEFAULT_MARKER
    );

    const occurrences = body.split(`<!-- ${DEFAULT_MARKER} -->`).length - 1;
    expect(occurrences).toBe(1);
    expect(body).toContain('attack text');
  });

  it('neutralizes @-mentions in judge output', () => {
    const body = buildCommentBody(
      makeReviewCommentData({ judgeOutput: 'cc @octocat please merge' }),
      DEFAULT_MARKER
    );

    expect(body).toContain('`@octocat`');
    expect(body).not.toContain(' @octocat');
  });
});

describe('buildCommentBody — origin rendering', () => {
  it('renders (role, rescue) for rescue-origin scanner results', () => {
    const scannerResults = [
      makeScannerResult({ model: 'z-ai/glm-5.2', role: 'logic', origin: 'rescue' }),
    ];
    const body = buildCommentBody(
      makeReviewCommentData({ scannerResults }),
      DEFAULT_MARKER
    );

    expect(body).toContain('`z-ai/glm-5.2` (logic, rescue): ✅ OK');
  });

  it('renders plain (role) for scanner-origin and origin-less results', () => {
    const scannerResults = [
      makeScannerResult({ model: 'model-a', origin: 'scanner' }),
      makeScannerResult({ model: 'model-b' }),
    ];
    const body = buildCommentBody(
      makeReviewCommentData({ scannerResults }),
      DEFAULT_MARKER
    );

    expect(body).toContain('`model-a` (general): ✅ OK');
    expect(body).toContain('`model-b` (general): ✅ OK');
    expect(body).not.toContain('rescue');
  });

  it('renders judge-scan results with the prefixed model name inside backticks and a plain role tag', () => {
    const scannerResults = [
      makeScannerResult({
        model: 'judge-scan:openai/gpt-4o',
        role: 'security',
        origin: 'judge-scan',
      }),
    ];
    const body = buildCommentBody(
      makeReviewCommentData({ scannerResults }),
      DEFAULT_MARKER
    );

    expect(body).toContain('`judge-scan:openai/gpt-4o` (security): ✅ OK');
  });
});

describe('buildCommentBody — coverage line', () => {
  it('renders the coverage line in the exact format with all three statuses', () => {
    const body = buildCommentBody(
      makeReviewCommentData({ coverage: FULL_COVERAGE }),
      DEFAULT_MARKER
    );

    expect(body).toContain(FULL_COVERAGE_LINE);
  });

  it('preserves the coverage array order', () => {
    const coverage: RoleCoverage[] = [
      { role: 'performance', status: 'uncovered' },
      { role: 'logic', status: 'rescued' },
      { role: 'security', status: 'covered' },
    ];
    const body = buildCommentBody(
      makeReviewCommentData({ coverage }),
      DEFAULT_MARKER
    );

    expect(body).toContain(
      'Coverage: performance ❌ uncovered · logic 🔁 rescued · security ✅'
    );
  });

  it('renders the coverage line after the scanner source lines', () => {
    const body = buildCommentBody(
      makeReviewCommentData({
        scannerResults: [makeScannerResult({ model: 'model-a' })],
        coverage: FULL_COVERAGE,
      }),
      DEFAULT_MARKER
    );

    const scannerLineIdx = body.indexOf('`model-a` (general)');
    const coverageIdx = body.indexOf('Coverage:');
    expect(scannerLineIdx).toBeGreaterThanOrEqual(0);
    expect(coverageIdx).toBeGreaterThan(scannerLineIdx);
  });

  it('omits the coverage line when coverage is absent', () => {
    const body = buildCommentBody(makeReviewCommentData(), DEFAULT_MARKER);

    expect(body).not.toContain('Coverage:');
  });

  it('omits the coverage line when coverage is empty', () => {
    const body = buildCommentBody(
      makeReviewCommentData({ coverage: [] }),
      DEFAULT_MARKER
    );

    expect(body).not.toContain('Coverage:');
  });
});

describe('buildCommentBody — degraded warning', () => {
  it('inserts the warning after the marker (and its blank line), before Final Review', () => {
    const body = buildCommentBody(
      makeReviewCommentData({ degraded: true }),
      DEFAULT_MARKER
    );

    expect(body).toContain(
      `<!-- ${DEFAULT_MARKER} -->\n\n${DEGRADED_WARNING}\n\n### Final Review`
    );
  });

  it('appears exactly once', () => {
    const body = buildCommentBody(
      makeReviewCommentData({ degraded: true }),
      DEFAULT_MARKER
    );

    expect(body.split(DEGRADED_WARNING).length - 1).toBe(1);
  });

  it('is absent when degraded is false or unset', () => {
    const withFalse = buildCommentBody(
      makeReviewCommentData({ degraded: false }),
      DEFAULT_MARKER
    );
    const unset = buildCommentBody(makeReviewCommentData(), DEFAULT_MARKER);

    expect(withFalse).not.toContain(DEGRADED_WARNING);
    expect(unset).not.toContain(DEGRADED_WARNING);
  });
});

describe('buildCommentBody — backward compatibility', () => {
  it('produces byte-identical output with and without undefined coverage/degraded', () => {
    const without = buildCommentBody(makeReviewCommentData(), DEFAULT_MARKER);
    const withUndefined = buildCommentBody(
      makeReviewCommentData({ coverage: undefined, degraded: undefined }),
      DEFAULT_MARKER
    );

    expect(withUndefined).toBe(without);
  });
});

describe('sanitizeModelOutput', () => {
  it('strips HTML comments including a smuggled marker', () => {
    const input = 'Before <!-- ENTERPRISE_AI_REVIEW --> after';
    expect(sanitizeModelOutput(input, 1000)).toBe('Before  after');
  });

  it('strips multiple and multiline HTML comments', () => {
    const input = 'a <!-- one -->b<!--\nmulti\nline\n--> c';
    expect(sanitizeModelOutput(input, 1000)).toBe('a b c');
  });

  it('strips unterminated HTML comments to end of text', () => {
    expect(sanitizeModelOutput('Visible <!-- hidden payload with no close', 1000)).toBe('Visible ');
  });

  it('wraps @-mentions in backticks', () => {
    expect(sanitizeModelOutput('thanks @alice and @bob-smith', 1000)).toBe(
      'thanks `@alice` and `@bob-smith`'
    );
  });

  it('wraps a mention at the start of the text', () => {
    expect(sanitizeModelOutput('@team please look', 1000)).toBe('`@team` please look');
  });

  it('does not double-wrap already backticked mentions', () => {
    expect(sanitizeModelOutput('ping `@alice` now', 1000)).toBe('ping `@alice` now');
  });

  it('does not treat email-like text as a mention', () => {
    expect(sanitizeModelOutput('contact user@example.com', 1000)).toBe(
      'contact user@example.com'
    );
  });

  it('truncates to maxLength with a trailing ellipsis', () => {
    const out = sanitizeModelOutput('a'.repeat(50), 10);
    expect(out).toBe(`${'a'.repeat(10)}…`);
  });

  it('does not truncate text at or below maxLength', () => {
    expect(sanitizeModelOutput('short', 10)).toBe('short');
  });

  it('leaves normal markdown intact', () => {
    const md = '## Heading\n\n- **bold** item\n- `code` span\n\n```ts\nconst x = 1;\n```';
    expect(sanitizeModelOutput(md, 1000)).toBe(md);
  });
});

describe('findExistingComment', () => {
  it('searches all pages via octokit.paginate', async () => {
    const comments = Array.from({ length: 150 }, (_, i) => ({
      id: i + 1,
      body: `comment ${i + 1}`,
      user: { login: 'someone', type: 'User' },
    }));
    // Marker comment "beyond page 1"
    comments.push({
      id: 999,
      body: `hello <!-- ${DEFAULT_MARKER} --> world`,
      user: { login: 'github-actions[bot]', type: 'Bot' },
    });
    mockOctokit.paginate.mockResolvedValue(comments);

    const octokit = new Octokit({ auth: 'x' });
    const id = await findExistingComment(octokit, makeGitHubConfig(), DEFAULT_MARKER);

    expect(id).toBe(999);
    expect(mockOctokit.paginate).toHaveBeenCalledWith(mockOctokit.issues.listComments, {
      owner: 'test-owner',
      repo: 'test-repo',
      issue_number: 1,
      per_page: 100,
    });
    // Must not fetch a single page directly
    expect(mockOctokit.issues.listComments).not.toHaveBeenCalled();
  });

  it('ignores a marker comment posted by a human user', async () => {
    mockOctokit.paginate.mockResolvedValue([
      {
        id: 7,
        body: `<!-- ${DEFAULT_MARKER} -->`,
        user: { login: 'attacker', type: 'User' },
      },
    ]);

    const octokit = new Octokit({ auth: 'x' });
    const id = await findExistingComment(octokit, makeGitHubConfig(), DEFAULT_MARKER);

    expect(id).toBeNull();
  });

  it('finds a bot-authored marker comment (type Bot)', async () => {
    mockOctokit.paginate.mockResolvedValue([
      { id: 1, body: 'unrelated', user: { login: 'human', type: 'User' } },
      {
        id: 42,
        body: `## Review\n<!-- ${DEFAULT_MARKER} -->\ntext`,
        user: { login: 'github-actions[bot]', type: 'Bot' },
      },
    ]);

    const octokit = new Octokit({ auth: 'x' });
    const id = await findExistingComment(octokit, makeGitHubConfig(), DEFAULT_MARKER);

    expect(id).toBe(42);
  });

  it('finds a marker comment authored by a [bot] login even without Bot type', async () => {
    mockOctokit.paginate.mockResolvedValue([
      {
        id: 43,
        body: `<!-- ${DEFAULT_MARKER} -->`,
        user: { login: 'my-app[bot]', type: 'User' },
      },
    ]);

    const octokit = new Octokit({ auth: 'x' });
    const id = await findExistingComment(octokit, makeGitHubConfig(), DEFAULT_MARKER);

    expect(id).toBe(43);
  });

  it('returns null when comments have no author', async () => {
    mockOctokit.paginate.mockResolvedValue([
      { id: 5, body: `<!-- ${DEFAULT_MARKER} -->`, user: null },
    ]);

    const octokit = new Octokit({ auth: 'x' });
    const id = await findExistingComment(octokit, makeGitHubConfig(), DEFAULT_MARKER);

    expect(id).toBeNull();
  });
});

describe('postInlineReview', () => {
  it('does not double-count unmatched findings in the review body', async () => {
    // 5 findings: 3 matched (lines within the hunk), 2 unmatched (file not in diff)
    const findings = [
      makeFinding({ line: 1, title: 'A', sources: ['model-a'] }),
      makeFinding({ line: 2, title: 'B', sources: ['model-a'] }),
      makeFinding({ line: 3, title: 'C', sources: ['model-a'] }),
      makeFinding({ file: 'src/missing.ts', line: 99, title: 'D', sources: ['model-a'] }),
      makeFinding({ file: 'src/missing.ts', line: 100, title: 'E', sources: ['model-a'] }),
    ];

    await postInlineReview(
      makeGitHubConfig(),
      findings,
      [makeFileDiff()],
      'sha123',
      [makeScannerResult({ model: 'model-a' })],
      makeTruncationInfo(),
      DEFAULT_MARKER
    );

    expect(mockOctokit.pulls.createReview).toHaveBeenCalledOnce();
    const reviewArg = mockOctokit.pulls.createReview.mock.calls[0]![0]!;

    expect(reviewArg.comments).toHaveLength(3);
    expect(reviewArg.body).toContain('Found **5** finding(s)');
    expect(reviewArg.body).toContain('`model-a` (general): ✅ OK — contributed to 5 finding(s)');
    expect(reviewArg.body).not.toContain('Found **7**');
    expect(reviewArg.body).not.toContain('contributed to 7 finding(s)');
  });

  it('(c) stamps the degraded suffix on the "Found N finding(s)" headline when given', async () => {
    const suffix = '⚠️ DEGRADED — 1 scanner failed: `deepseek/deepseek-v4-pro-0813`';
    const findings = [makeFinding({ line: 1, title: 'A', sources: ['model-a'] })];

    await postInlineReview(
      makeGitHubConfig(),
      findings,
      [makeFileDiff()],
      'sha123',
      [
        makeScannerResult({ model: 'model-a' }),
        makeScannerResult({
          model: 'deepseek/deepseek-v4-pro-0813',
          status: 'FAILED',
          success: false,
          error: 'OpenRouter returned empty response (finish_reason=length, completion_tokens=16000, reasoning=absent)',
        }),
      ],
      makeTruncationInfo(),
      DEFAULT_MARKER,
      { degradedSuffix: suffix }
    );

    const reviewArg = mockOctokit.pulls.createReview.mock.calls[0]![0]!;
    expect(reviewArg.body).toContain(`Found **1** finding(s): 0 critical, 1 warning, 0 info — ${suffix}`);
    expect(reviewArg.body).toContain('`deepseek/deepseek-v4-pro-0813` (general): ❌ FAILED (OpenRouter returned empty response');
  });

  it('leaves the headline unchanged when no degraded suffix is given', async () => {
    await postInlineReview(
      makeGitHubConfig(),
      [makeFinding({ line: 1, title: 'A' })],
      [makeFileDiff()],
      'sha123',
      [makeScannerResult({ model: 'model-a' })],
      makeTruncationInfo(),
      DEFAULT_MARKER,
      { degraded: false }
    );

    const reviewArg = mockOctokit.pulls.createReview.mock.calls[0]![0]!;
    expect(reviewArg.body).toContain('Found **1** finding(s): 0 critical, 1 warning, 0 info\n');
    expect(reviewArg.body).not.toContain('DEGRADED');
  });

  it('falls back to a summary comment when createReview fails', async () => {
    mockOctokit.pulls.createReview.mockRejectedValue(
      new Error('Unprocessable Entity: 422')
    );

    const findings = [
      makeFinding({ line: 2, title: 'Matched issue' }),
      makeFinding({ file: 'src/missing.ts', line: 99, title: 'Unmatched issue' }),
    ];

    await expect(
      postInlineReview(
        makeGitHubConfig(),
        findings,
        [makeFileDiff()],
        'sha123',
        [makeScannerResult()],
        makeTruncationInfo(),
        DEFAULT_MARKER
      )
    ).resolves.toBeUndefined();

    expect(mockOctokit.pulls.createReview).toHaveBeenCalledOnce();
    expect(mockOctokit.issues.createComment).toHaveBeenCalledOnce();

    const body = mockOctokit.issues.createComment.mock.calls[0]![0]!.body as string;
    expect(body).toContain('Matched issue');
    expect(body).toContain('Unmatched issue');
    expect(body).toContain(`<!-- ${DEFAULT_MARKER} -->`);
  });

  it('skips findings already posted inline by a bot on a previous run', async () => {
    const existingReviewComments = [
      {
        user: { login: 'github-actions[bot]', type: 'Bot' },
        path: 'src/app.ts',
        line: 2,
        body: '🟡 **Existing bug**\n\nAlready reported.',
      },
    ];
    mockOctokit.paginate.mockImplementation(async (endpoint: unknown) =>
      endpoint === mockOctokit.pulls.listReviewComments ? existingReviewComments : []
    );

    const findings = [
      makeFinding({ line: 2, title: 'Existing bug' }),
      makeFinding({ line: 3, title: 'New bug' }),
    ];

    await postInlineReview(
      makeGitHubConfig(),
      findings,
      [makeFileDiff()],
      'sha123',
      [makeScannerResult()],
      makeTruncationInfo(),
      DEFAULT_MARKER
    );

    expect(mockOctokit.pulls.createReview).toHaveBeenCalledOnce();
    const reviewArg = mockOctokit.pulls.createReview.mock.calls[0]![0]!;

    expect(reviewArg.comments).toHaveLength(1);
    expect(reviewArg.comments[0].body).toContain('New bug');
    expect(reviewArg.comments[0].line).toBe(3);
    expect(reviewArg.body).toContain('Found **1** finding(s)');
  });

  it('posts nothing when all findings are duplicates and none are unmatched', async () => {
    const existingReviewComments = [
      {
        user: { login: 'github-actions[bot]', type: 'Bot' },
        path: 'src/app.ts',
        line: 2,
        body: '🟡 **Existing bug**\n\nAlready reported.',
      },
    ];
    mockOctokit.paginate.mockImplementation(async (endpoint: unknown) =>
      endpoint === mockOctokit.pulls.listReviewComments ? existingReviewComments : []
    );

    await postInlineReview(
      makeGitHubConfig(),
      [makeFinding({ line: 2, title: 'Existing bug' })],
      [makeFileDiff()],
      'sha123',
      [makeScannerResult()],
      makeTruncationInfo(),
      DEFAULT_MARKER
    );

    expect(mockOctokit.pulls.createReview).not.toHaveBeenCalled();
    expect(mockOctokit.issues.createComment).not.toHaveBeenCalled();
    expect(mockOctokit.issues.updateComment).not.toHaveBeenCalled();
  });

  it('does not dedupe against human-authored review comments', async () => {
    const existingReviewComments = [
      {
        user: { login: 'attacker', type: 'User' },
        path: 'src/app.ts',
        line: 2,
        body: '🟡 **Existing bug**\n\nPlanted to suppress the review.',
      },
    ];
    mockOctokit.paginate.mockImplementation(async (endpoint: unknown) =>
      endpoint === mockOctokit.pulls.listReviewComments ? existingReviewComments : []
    );

    await postInlineReview(
      makeGitHubConfig(),
      [makeFinding({ line: 2, title: 'Existing bug' })],
      [makeFileDiff()],
      'sha123',
      [makeScannerResult()],
      makeTruncationInfo(),
      DEFAULT_MARKER
    );

    expect(mockOctokit.pulls.createReview).toHaveBeenCalledOnce();
    const reviewArg = mockOctokit.pulls.createReview.mock.calls[0]![0]!;
    expect(reviewArg.comments).toHaveLength(1);
  });

  it('falls back to summary comment when no findings match the diff', async () => {
    await postInlineReview(
      makeGitHubConfig(),
      [makeFinding({ file: 'src/missing.ts', line: 99, title: 'Off-diff issue' })],
      [makeFileDiff()],
      'sha123',
      [makeScannerResult()],
      makeTruncationInfo(),
      DEFAULT_MARKER
    );

    expect(mockOctokit.pulls.createReview).not.toHaveBeenCalled();
    expect(mockOctokit.issues.createComment).toHaveBeenCalledOnce();
    const body = mockOctokit.issues.createComment.mock.calls[0]![0]!.body as string;
    expect(body).toContain('Off-diff issue');
  });

  it('sanitizes model-generated titles and bodies in inline comments', async () => {
    const findings = [
      makeFinding({
        line: 2,
        title: 'Bug <!-- hidden --> here',
        body: 'Please fix @maintainer <!-- sneaky -->',
      }),
    ];

    await postInlineReview(
      makeGitHubConfig(),
      findings,
      [makeFileDiff()],
      'sha123',
      [makeScannerResult()],
      makeTruncationInfo(),
      DEFAULT_MARKER
    );

    const reviewArg = mockOctokit.pulls.createReview.mock.calls[0]![0]!;
    const commentBody = reviewArg.comments[0].body as string;
    expect(commentBody).not.toContain('<!--');
    expect(commentBody).not.toContain('hidden');
    expect(commentBody).not.toContain('sneaky');
    expect(commentBody).toContain('`@maintainer`');
  });
});

describe('postInlineReview — coverage/degraded extras', () => {
  it('threads coverage, degraded, and rescue tags into the inline review body', async () => {
    await postInlineReview(
      makeGitHubConfig(),
      [makeFinding({ line: 2, title: 'A' })],
      [makeFileDiff()],
      'sha123',
      [makeScannerResult({ model: 'model-a', role: 'logic', origin: 'rescue' })],
      makeTruncationInfo(),
      DEFAULT_MARKER,
      { coverage: FULL_COVERAGE, degraded: true }
    );

    expect(mockOctokit.pulls.createReview).toHaveBeenCalledOnce();
    const body = mockOctokit.pulls.createReview.mock.calls[0]![0]!.body as string;

    expect(body).toContain(FULL_COVERAGE_LINE);
    expect(body).toContain('`model-a` (logic, rescue): ✅ OK');
    // Degraded warning sits right after the "## Enterprise AI Review" heading
    expect(body.startsWith(`## Enterprise AI Review\n\n${DEGRADED_WARNING}\n\n`)).toBe(true);
    expect(body.split(DEGRADED_WARNING).length - 1).toBe(1);
    // Coverage line comes after the scanner source lines
    expect(body.indexOf('Coverage:')).toBeGreaterThan(body.indexOf('`model-a`'));
  });

  it('omits coverage and degraded lines when extras are not provided', async () => {
    await postInlineReview(
      makeGitHubConfig(),
      [makeFinding({ line: 2, title: 'A' })],
      [makeFileDiff()],
      'sha123',
      [makeScannerResult()],
      makeTruncationInfo(),
      DEFAULT_MARKER
    );

    const body = mockOctokit.pulls.createReview.mock.calls[0]![0]!.body as string;
    expect(body).not.toContain('Coverage:');
    expect(body).not.toContain(DEGRADED_WARNING);
  });

  it('threads extras into the summary fallback when createReview fails', async () => {
    mockOctokit.pulls.createReview.mockRejectedValue(
      new Error('Unprocessable Entity: 422')
    );

    await postInlineReview(
      makeGitHubConfig(),
      [makeFinding({ line: 2, title: 'Matched issue' })],
      [makeFileDiff()],
      'sha123',
      [makeScannerResult()],
      makeTruncationInfo(),
      DEFAULT_MARKER,
      { coverage: FULL_COVERAGE, degraded: true }
    );

    expect(mockOctokit.issues.createComment).toHaveBeenCalledOnce();
    const body = mockOctokit.issues.createComment.mock.calls[0]![0]!.body as string;
    expect(body).toContain(FULL_COVERAGE_LINE);
    expect(body).toContain(
      `<!-- ${DEFAULT_MARKER} -->\n\n${DEGRADED_WARNING}\n\n### Final Review`
    );
  });

  it('threads extras into the summary fallback when no findings match the diff', async () => {
    await postInlineReview(
      makeGitHubConfig(),
      [makeFinding({ file: 'src/missing.ts', line: 99, title: 'Off-diff issue' })],
      [makeFileDiff()],
      'sha123',
      [makeScannerResult()],
      makeTruncationInfo(),
      DEFAULT_MARKER,
      { coverage: FULL_COVERAGE, degraded: true }
    );

    expect(mockOctokit.pulls.createReview).not.toHaveBeenCalled();
    expect(mockOctokit.issues.createComment).toHaveBeenCalledOnce();
    const body = mockOctokit.issues.createComment.mock.calls[0]![0]!.body as string;
    expect(body).toContain('Off-diff issue');
    expect(body).toContain(FULL_COVERAGE_LINE);
    expect(body).toContain(DEGRADED_WARNING);
  });
});
