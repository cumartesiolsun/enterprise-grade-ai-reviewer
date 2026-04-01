import { describe, it, expect } from 'vitest';
import { buildCommentBody } from './comments.js';
import type { ReviewCommentData } from './comments.js';
import type { ScannerResult } from '../review/scanner.js';
import type { TruncationInfo } from './diff.js';

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

const DEFAULT_MARKER = 'enterprise-ai-review-marker';

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

    expect(body).toContain('`model-a`: ✅ OK');
  });

  it('shows SKIPPED badge for skipped scanners', () => {
    const scannerResults = [makeScannerResult({ model: 'model-b', status: 'SKIPPED' })];
    const body = buildCommentBody(
      makeReviewCommentData({ scannerResults }),
      DEFAULT_MARKER
    );

    expect(body).toContain('`model-b`: ⏭️ SKIPPED (empty/LGTM)');
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

    expect(body).toContain('`model-c`: ❌ FAILED (Rate limit exceeded)');
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

    expect(body).toContain('`model-d`: ❌ FAILED (unknown error)');
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

    expect(body).toContain('`model-a`: ✅ OK — contributed to 2 finding(s)');
    expect(body).toContain('`model-b`: ✅ OK — contributed to 2 finding(s)');
    expect(body).toContain('`model-c`: ✅ OK — contributed to 1 finding(s)');
  });

  it('shows no contribution count when judge output has no (by: ...) tags', () => {
    const data = makeReviewCommentData({
      judgeOutput: 'No issues found.',
      scannerResults: [makeScannerResult({ model: 'model-x' })],
    });

    const body = buildCommentBody(data, DEFAULT_MARKER);

    expect(body).toContain('`model-x`: ✅ OK');
    expect(body).not.toContain('contributed to');
  });
});
