import { describe, it, expect } from 'vitest';
import type { ScannerResult } from './scanner.js';
import type { ScannerRole } from './prompts.js';
import {
  hasUsableOutput,
  classifyScannerPool,
  buildAllClearVerdict,
  buildIncompleteVerdict,
  formatDegradedSuffix,
  appendDegradedSuffix,
} from './verdict.js';

/**
 * Fixture shape of the motivating run (VaultLend #76, run 33799224076):
 * nine scanners plus the judge scan, every one of them NO_FINDINGS, except
 * deepseek-v4-pro which returned an empty completion at 16000 tokens.
 */
const EMPTY_AT_16000 =
  'OpenRouter returned empty response (finish_reason=length, completion_tokens=16000, reasoning=absent)';
const FAILED_MODEL = 'deepseek/deepseek-v4-pro-0813';
const ROLES: ScannerRole[] = ['security', 'logic', 'performance'];

function skipped(model: string, role: ScannerRole, origin?: ScannerResult['origin']): ScannerResult {
  return {
    model,
    role,
    output: 'NO_FINDINGS',
    tokensUsed: 5,
    durationMs: 900,
    success: true,
    status: 'SKIPPED',
    ...(origin ? { origin } : {}),
  };
}

function ok(model: string, role: ScannerRole, output = '- [WARNING] src/a.ts:3 — x (confidence: high)'): ScannerResult {
  return { model, role, output, tokensUsed: 120, durationMs: 1200, success: true, status: 'OK' };
}

function failed(model: string, role: ScannerRole, error = EMPTY_AT_16000): ScannerResult {
  return { model, role, output: '', tokensUsed: 0, durationMs: 60000, success: false, status: 'FAILED', error };
}

/** 9 regular scanners, all NO_FINDINGS. */
function nineClean(): ScannerResult[] {
  return Array.from({ length: 9 }, (_, i) => skipped(`vendor/scanner-${i + 1}`, ROLES[i % 3]!));
}

const JUDGE_SCAN_CLEAN = skipped('judge-scan:anthropic/claude-sonnet-5', 'general', 'judge-scan');

/** Fixture (a): 10/10 clean — 9 scanners + judge scan. */
const ALL_CLEAR_POOL = [...nineClean(), JUDGE_SCAN_CLEAN];

/** Fixture (b): the #76 shape — 9 clean + deepseek empty at 16000 tokens. */
const INCOMPLETE_POOL = [
  ...nineClean().slice(0, 8),
  failed(FAILED_MODEL, 'logic'),
  JUDGE_SCAN_CLEAN,
];

/** Fixture (c): one real finding, eight clean, one failed. */
const FINDINGS_DEGRADED_POOL = [
  ok('vendor/scanner-1', 'security'),
  ...nineClean().slice(1, 8),
  failed(FAILED_MODEL, 'logic'),
  JUDGE_SCAN_CLEAN,
];

describe('hasUsableOutput', () => {
  it('is true only for a successful result with real, non-sentinel output', () => {
    expect(hasUsableOutput(ok('m', 'general'))).toBe(true);
    expect(hasUsableOutput(skipped('m', 'general'))).toBe(false);
    expect(hasUsableOutput(failed('m', 'general'))).toBe(false);
    expect(hasUsableOutput({ ...ok('m', 'general'), output: '   \n' })).toBe(false);
    expect(hasUsableOutput({ ...ok('m', 'general'), output: '  NO_FINDINGS\n' })).toBe(false);
    expect(hasUsableOutput({ ...ok('m', 'general'), output: 'NO_FINDINGS for A, but B has a bug' })).toBe(true);
  });
});

describe('classifyScannerPool', () => {
  it('(a) 10/10 NO_FINDINGS → all-clear, no action failure', () => {
    const pool = classifyScannerPool(ALL_CLEAR_POOL);

    expect(pool.kind).toBe('all-clear');
    expect(pool.ran).toBe(10);
    expect(pool.usable).toEqual([]);
    expect(pool.failed).toEqual([]);
    expect(pool.failAction).toBe(false);
  });

  it('(b) 9 NO_FINDINGS + 1 empty-at-16000 FAILED → incomplete, action fails', () => {
    const pool = classifyScannerPool(INCOMPLETE_POOL);

    expect(pool.kind).toBe('incomplete');
    expect(pool.ran).toBe(9);
    expect(pool.usable).toEqual([]);
    expect(pool.failed.map((r) => r.model)).toEqual([FAILED_MODEL]);
    expect(pool.failed[0]!.error).toBe(EMPTY_AT_16000);
    expect(pool.failAction).toBe(true);
  });

  it('(c) 1 OK + 8 NO_FINDINGS + 1 FAILED → findings (judge path), failure carried for the headline', () => {
    const pool = classifyScannerPool(FINDINGS_DEGRADED_POOL);

    expect(pool.kind).toBe('findings');
    expect(pool.usable.map((r) => r.model)).toEqual(['vendor/scanner-1']);
    expect(pool.failed.map((r) => r.model)).toEqual([FAILED_MODEL]);
    expect(pool.ran).toBe(9);
    expect(pool.failAction).toBe(false);
  });

  it('(c) 1 OK + 9 NO_FINDINGS, nothing failed → findings with an empty failed list', () => {
    const pool = classifyScannerPool([ok('vendor/scanner-1', 'security'), ...nineClean().slice(1), JUDGE_SCAN_CLEAN]);

    expect(pool.kind).toBe('findings');
    expect(pool.failed).toEqual([]);
    expect(pool.failAction).toBe(false);
  });

  it('an empty pool is incomplete, never an all-clear', () => {
    const pool = classifyScannerPool([]);

    expect(pool.kind).toBe('incomplete');
    expect(pool.ran).toBe(0);
    expect(pool.failAction).toBe(true);
  });

  it('a pool where everything failed is incomplete', () => {
    const pool = classifyScannerPool([failed('a', 'security'), failed('b', 'logic', 'API timeout')]);

    expect(pool.kind).toBe('incomplete');
    expect(pool.ran).toBe(0);
    expect(pool.failed).toHaveLength(2);
    expect(pool.failAction).toBe(true);
  });

  it('a single clean scanner is enough for an all-clear', () => {
    const pool = classifyScannerPool([skipped('only', 'general')]);

    expect(pool.kind).toBe('all-clear');
    expect(pool.ran).toBe(1);
  });
});

describe('buildAllClearVerdict', () => {
  const pool = classifyScannerPool(ALL_CLEAR_POOL);

  it('English: explicit APPROVE naming the number of scanners that ran, no judge call implied', () => {
    const text = buildAllClearVerdict(pool, 'en');

    expect(text).toContain('## 1. Verdict');
    expect(text).toContain('**APPROVE**');
    expect(text).toContain('all 10 scanners that ran reported `NO_FINDINGS`');
    expect(text).toContain('the judge model was not called');
    expect(text).toContain('## 2. Findings');
    expect(text).not.toMatch(/could not be completed|tamamlanamadı/i);
  });

  it('Turkish (default language): APPROVE under a Hüküm heading', () => {
    const text = buildAllClearVerdict(pool, 'tr');

    expect(text).toContain('## 1. Hüküm');
    expect(text).toContain('**APPROVE**');
    expect(text).toContain('koşan 10 tarayıcının tamamı');
    expect(text).toContain('yargıç modeli çağrılmadı');
    expect(text).not.toMatch(/could not be completed|tamamlanamadı/i);
  });

  it('language resolution: "turkish" is Turkish, anything else falls back to English', () => {
    expect(buildAllClearVerdict(pool, 'Turkish')).toContain('## 1. Hüküm');
    expect(buildAllClearVerdict(pool, 'de')).toContain('## 1. Verdict');
  });

  it('uses the singular for one scanner', () => {
    const single = classifyScannerPool([skipped('only', 'general')]);
    expect(buildAllClearVerdict(single, 'en')).toContain('all 1 scanner that ran');
  });
});

describe('buildIncompleteVerdict', () => {
  const pool = classifyScannerPool(INCOMPLETE_POOL);

  it('English: INCOMPLETE naming the failed model and asking for a re-run', () => {
    const text = buildIncompleteVerdict(pool, 'en');

    expect(text).toContain('## 1. Verdict');
    expect(text).toContain('**INCOMPLETE**');
    expect(text).toContain(`but 1 scanner failed: \`${FAILED_MODEL}\`.`);
    expect(text).toContain('marked failed');
    expect(text).toContain('Re-run the workflow');
    expect(text).not.toContain('APPROVE');
  });

  it('Turkish: INCOMPLETE under a Hüküm heading, failed model named', () => {
    const text = buildIncompleteVerdict(pool, 'tr');

    expect(text).toContain('## 1. Hüküm');
    expect(text).toContain('**INCOMPLETE**');
    expect(text).toContain(`ancak 1 tarayıcı başarısız oldu: \`${FAILED_MODEL}\`.`);
    expect(text).toContain('yeniden çalıştırın');
    expect(text).not.toContain('APPROVE');
  });

  it('lists every failed model when more than one failed', () => {
    const two = classifyScannerPool([skipped('c', 'general'), failed('a', 'security'), failed('b', 'logic')]);
    expect(buildIncompleteVerdict(two, 'en')).toContain('but 2 scanners failed: `a`, `b`.');
  });

  it('says so when nothing ran at all', () => {
    const empty = classifyScannerPool([]);
    expect(buildIncompleteVerdict(empty, 'en')).toContain('but no scanner ran at all.');
    expect(buildIncompleteVerdict(empty, 'tr')).toContain('ancak hiçbir tarayıcı çalışmadı.');
  });
});

describe('formatDegradedSuffix', () => {
  it('is undefined when nothing failed', () => {
    expect(formatDegradedSuffix(classifyScannerPool(ALL_CLEAR_POOL), 'en')).toBeUndefined();
  });

  it('(c) English: names the count and the failed models', () => {
    const suffix = formatDegradedSuffix(classifyScannerPool(FINDINGS_DEGRADED_POOL), 'en');
    expect(suffix).toBe(`⚠️ DEGRADED — 1 scanner failed: \`${FAILED_MODEL}\``);
  });

  it('(c) Turkish: same shape in Turkish, plural handled by the count', () => {
    const two = classifyScannerPool([ok('x', 'security'), failed('a', 'security'), failed('b', 'logic')]);
    expect(formatDegradedSuffix(two, 'tr')).toBe('⚠️ DEGRADED — 2 tarayıcı başarısız: `a`, `b`');
    expect(formatDegradedSuffix(two, 'en')).toBe('⚠️ DEGRADED — 2 scanners failed: `a`, `b`');
  });
});

describe('appendDegradedSuffix', () => {
  const suffix = `⚠️ DEGRADED — 1 scanner failed: \`${FAILED_MODEL}\``;
  const judgeOutput = [
    '## 1. Hüküm',
    '',
    '**APPROVE WITH NITS** — yalnızca düşük önemli bulgular.',
    '',
    '## 2. Bulgular',
    '',
    '- `src/a.ts:3` — x (by: vendor/scanner-1)',
  ].join('\n');

  it('(c) appends to the verdict line, leaving the heading and findings untouched', () => {
    const result = appendDegradedSuffix(judgeOutput, suffix);
    const lines = result.split('\n');

    expect(lines[0]).toBe('## 1. Hüküm');
    expect(lines[2]).toBe(`**APPROVE WITH NITS** — yalnızca düşük önemli bulgular. — ${suffix}`);
    expect(lines.slice(3)).toEqual(judgeOutput.split('\n').slice(3));
    expect(result.match(/DEGRADED/g)).toHaveLength(1);
  });

  it('recognizes REQUEST CHANGES and plain APPROVE verdict lines', () => {
    expect(appendDegradedSuffix('**REQUEST CHANGES** — blocker', suffix)).toBe(
      `**REQUEST CHANGES** — blocker — ${suffix}`
    );
    expect(appendDegradedSuffix('Verdict: APPROVE', suffix)).toBe(`Verdict: APPROVE — ${suffix}`);
  });

  it('stamps only the first verdict line when a token recurs later', () => {
    const output = '**APPROVE**\n\nA later line that also says APPROVE.';
    const result = appendDegradedSuffix(output, suffix);

    expect(result.split('\n')[0]).toBe(`**APPROVE** — ${suffix}`);
    expect(result).toContain('A later line that also says APPROVE.');
    expect(result.match(/DEGRADED/g)).toHaveLength(1);
  });

  it('prepends the suffix as its own line when the judge output has no verdict token', () => {
    const output = 'Free-form judge text without a verdict token.';
    expect(appendDegradedSuffix(output, suffix)).toBe(`${suffix}\n\n${output}`);
  });
});
