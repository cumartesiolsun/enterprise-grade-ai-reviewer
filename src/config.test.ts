import { describe, it, expect } from 'vitest';
import {
  DEFAULT_EXCLUDE_PATHS,
  getInput,
  getRequiredInput,
  parsePositiveInt,
  parseListInput,
  parseScannerModels,
  parseExcludePaths,
  parseInputs,
} from './config.js';

type Env = Record<string, string | undefined>;

/** Minimal valid env for parseInputs (all required inputs present). */
function baseEnv(overrides: Env = {}): Env {
  return {
    'INPUT_OPENROUTER-API-KEY': 'sk-or-test',
    'INPUT_GITHUB-TOKEN': 'ghp_test',
    'INPUT_SCANNER-MODELS': 'openai/gpt-4o,anthropic/claude-3.5-sonnet',
    'INPUT_JUDGE-MODEL': 'openai/gpt-4o',
    ...overrides,
  };
}

describe('getInput', () => {
  it('reads INPUT_ env vars with hyphens preserved', () => {
    expect(getInput({ 'INPUT_GITHUB-TOKEN': 'abc' }, 'github-token', '')).toBe('abc');
  });

  it('uppercases the input name', () => {
    expect(getInput({ 'INPUT_MAX-FILES': '5' }, 'max-files', '10')).toBe('5');
  });

  it('returns the default when the env var is not set', () => {
    expect(getInput({}, 'language', 'tr')).toBe('tr');
  });
});

describe('getRequiredInput', () => {
  it('returns the value when present', () => {
    expect(getRequiredInput({ 'INPUT_JUDGE-MODEL': 'x/y' }, 'judge-model')).toBe('x/y');
  });

  it('throws a clear error when missing', () => {
    expect(() => getRequiredInput({}, 'judge-model')).toThrow(
      "Required input 'judge-model' is missing"
    );
  });

  it('throws when the value is an empty string', () => {
    expect(() => getRequiredInput({ 'INPUT_JUDGE-MODEL': '' }, 'judge-model')).toThrow(
      "Required input 'judge-model' is missing"
    );
  });
});

describe('parsePositiveInt', () => {
  it('parses a valid positive integer', () => {
    expect(parsePositiveInt('max-chars', '80000')).toBe(80000);
  });

  it('accepts surrounding whitespace', () => {
    expect(parsePositiveInt('max-files', ' 42 ')).toBe(42);
  });

  it.each([
    ['80k'],
    ['garbage'],
    ['-5'],
    ['0'],
    ['1.5'],
    [''],
    ['1e3'],
  ])('throws a clear error naming the input for %j', (raw) => {
    expect(() => parsePositiveInt('max-chars', raw)).toThrow(
      `Input 'max-chars' must be a positive integer, got '${raw}'`
    );
  });
});

describe('parseScannerModels / parseListInput', () => {
  it('parses a JSON array', () => {
    expect(parseScannerModels('["openai/gpt-4o", "x/grok-2"]')).toEqual([
      'openai/gpt-4o',
      'x/grok-2',
    ]);
  });

  it('trims and drops empty entries in a JSON array', () => {
    expect(parseScannerModels('[" a ", "", "  "]')).toEqual(['a']);
  });

  it('parses multiline input', () => {
    expect(parseScannerModels('openai/gpt-4o\nx/grok-2\n\n  \n')).toEqual([
      'openai/gpt-4o',
      'x/grok-2',
    ]);
  });

  it('parses CSV input', () => {
    expect(parseScannerModels('openai/gpt-4o, x/grok-2 ,')).toEqual([
      'openai/gpt-4o',
      'x/grok-2',
    ]);
  });

  it('parses a single value', () => {
    expect(parseScannerModels('openai/gpt-4o')).toEqual(['openai/gpt-4o']);
  });

  it('returns [] for empty input', () => {
    expect(parseScannerModels('')).toEqual([]);
    expect(parseScannerModels('   ')).toEqual([]);
  });

  it('throws on near-JSON (starts with "[" but invalid) instead of CSV-splitting', () => {
    expect(() => parseScannerModels('[openai/gpt-4o, x/grok-2]')).toThrow(
      /Input 'scanner-models' looks like a JSON array but failed to parse/
    );
  });

  it('parseListInput names the failing input in the near-JSON error', () => {
    expect(() => parseListInput('exclude-paths', '[**/dist/**')).toThrow(
      /Input 'exclude-paths' looks like a JSON array but failed to parse/
    );
  });
});

describe('parseExcludePaths', () => {
  it('returns the default patterns when input is empty', () => {
    expect(parseExcludePaths('')).toEqual(DEFAULT_EXCLUDE_PATHS);
    expect(parseExcludePaths('  ')).toEqual(DEFAULT_EXCLUDE_PATHS);
  });

  it('returns a copy of the defaults, not the shared array', () => {
    const result = parseExcludePaths('');
    expect(result).not.toBe(DEFAULT_EXCLUDE_PATHS);
    result.push('mutated');
    expect(DEFAULT_EXCLUDE_PATHS).not.toContain('mutated');
  });

  it('returns [] for the literal "none" (case-insensitive)', () => {
    expect(parseExcludePaths('none')).toEqual([]);
    expect(parseExcludePaths('NONE')).toEqual([]);
    expect(parseExcludePaths(' None ')).toEqual([]);
  });

  it('parses custom CSV patterns', () => {
    expect(parseExcludePaths('**/*.gen.ts, docs/**')).toEqual([
      '**/*.gen.ts',
      'docs/**',
    ]);
  });

  it('parses custom JSON array patterns', () => {
    expect(parseExcludePaths('["**/*.gen.ts", "docs/**"]')).toEqual([
      '**/*.gen.ts',
      'docs/**',
    ]);
  });
});

describe('parseInputs', () => {
  it('parses a full happy path with defaults applied', () => {
    expect(parseInputs(baseEnv())).toEqual({
      openrouterApiKey: 'sk-or-test',
      githubToken: 'ghp_test',
      baseUrl: 'https://openrouter.ai/api/v1',
      scannerModels: ['openai/gpt-4o', 'anthropic/claude-3.5-sonnet'],
      judgeModel: 'openai/gpt-4o',
      language: 'tr',
      autoSelectModels: false,
      maxFiles: 10,
      maxChars: 80000,
      timeoutMs: 180000,
      maxTokensScanner: 2000,
      maxTokensJudge: 4000,
      commentMarker: 'ENTERPRISE_AI_REVIEW',
      reviewMode: 'summary',
      excludePaths: DEFAULT_EXCLUDE_PATHS,
    });
  });

  it('parses a full happy path with every input customized', () => {
    const env = baseEnv({
      'INPUT_BASE-URL': 'https://proxy.example.com/v1',
      'INPUT_SCANNER-MODELS': '["a/one", "b/two"]',
      'INPUT_JUDGE-MODEL': 'c/judge',
      'INPUT_LANGUAGE': 'en',
      'INPUT_MAX-FILES': '25',
      'INPUT_MAX-CHARS': '120000',
      'INPUT_TIMEOUT-MS': '60000',
      'INPUT_MAX-TOKENS-SCANNER': '1500',
      'INPUT_MAX-TOKENS-JUDGE': '3000',
      'INPUT_COMMENT-MARKER': 'My_Marker-01',
      'INPUT_REVIEW-MODE': 'inline',
      'INPUT_EXCLUDE-PATHS': '**/*.lock,generated/**',
    });

    expect(parseInputs(env)).toEqual({
      openrouterApiKey: 'sk-or-test',
      githubToken: 'ghp_test',
      baseUrl: 'https://proxy.example.com/v1',
      scannerModels: ['a/one', 'b/two'],
      judgeModel: 'c/judge',
      language: 'en',
      autoSelectModels: false,
      maxFiles: 25,
      maxChars: 120000,
      timeoutMs: 60000,
      maxTokensScanner: 1500,
      maxTokensJudge: 3000,
      commentMarker: 'My_Marker-01',
      reviewMode: 'inline',
      excludePaths: ['**/*.lock', 'generated/**'],
    });
  });

  it('accepts review-mode case-insensitively', () => {
    expect(parseInputs(baseEnv({ 'INPUT_REVIEW-MODE': 'INLINE' })).reviewMode).toBe(
      'inline'
    );
    expect(parseInputs(baseEnv({ 'INPUT_REVIEW-MODE': 'Summary' })).reviewMode).toBe(
      'summary'
    );
  });

  it('rejects an unknown review-mode', () => {
    expect(() => parseInputs(baseEnv({ 'INPUT_REVIEW-MODE': 'both' }))).toThrow(
      "Invalid review-mode 'both'. Must be 'summary' or 'inline'."
    );
  });

  it('throws when auto-select-models is true (not implemented in MVP)', () => {
    expect(() =>
      parseInputs(baseEnv({ 'INPUT_AUTO-SELECT-MODELS': 'true' }))
    ).toThrow('auto-select-models is not implemented in MVP');

    expect(() =>
      parseInputs(baseEnv({ 'INPUT_AUTO-SELECT-MODELS': 'TRUE' }))
    ).toThrow('auto-select-models is not implemented in MVP');
  });

  it('maps exclude-paths "none" to an empty list', () => {
    expect(parseInputs(baseEnv({ 'INPUT_EXCLUDE-PATHS': 'none' })).excludePaths).toEqual(
      []
    );
  });

  it('accepts a safe comment-marker', () => {
    expect(
      parseInputs(baseEnv({ 'INPUT_COMMENT-MARKER': 'my-Marker_42' })).commentMarker
    ).toBe('my-Marker_42');
  });

  it('rejects a comment-marker that could break out of the HTML comment', () => {
    expect(() =>
      parseInputs(baseEnv({ 'INPUT_COMMENT-MARKER': 'X--><script>alert(1)</script>' }))
    ).toThrow(/comment-marker/);
  });

  it('rejects a comment-marker containing spaces', () => {
    expect(() =>
      parseInputs(baseEnv({ 'INPUT_COMMENT-MARKER': 'has space' }))
    ).toThrow(/comment-marker/);
  });

  it.each([
    ['max-files', 'INPUT_MAX-FILES', 'abc'],
    ['max-chars', 'INPUT_MAX-CHARS', '80k'],
    ['timeout-ms', 'INPUT_TIMEOUT-MS', '-1'],
    ['max-tokens-scanner', 'INPUT_MAX-TOKENS-SCANNER', '0'],
    ['max-tokens-judge', 'INPUT_MAX-TOKENS-JUDGE', '4.5'],
  ])('rejects invalid numeric input %s with an error naming it', (name, envKey, raw) => {
    expect(() => parseInputs(baseEnv({ [envKey]: raw }))).toThrow(
      `Input '${name}' must be a positive integer, got '${raw}'`
    );
  });

  it('throws when scanner-models is missing', () => {
    expect(() => parseInputs(baseEnv({ 'INPUT_SCANNER-MODELS': undefined }))).toThrow(
      "Required input 'scanner-models' is missing"
    );
  });

  it('throws on near-JSON scanner-models instead of degrading to CSV', () => {
    expect(() =>
      parseInputs(baseEnv({ 'INPUT_SCANNER-MODELS': '[a/one, b/two]' }))
    ).toThrow(/looks like a JSON array but failed to parse/);
  });

  it('throws when judge-model is missing', () => {
    expect(() => parseInputs(baseEnv({ 'INPUT_JUDGE-MODEL': undefined }))).toThrow(
      "Required input 'judge-model' is missing"
    );
  });

  it('throws when openrouter-api-key is missing', () => {
    expect(() =>
      parseInputs(baseEnv({ 'INPUT_OPENROUTER-API-KEY': undefined }))
    ).toThrow("Required input 'openrouter-api-key' is missing");
  });

  it('throws when github-token is missing', () => {
    expect(() => parseInputs(baseEnv({ 'INPUT_GITHUB-TOKEN': undefined }))).toThrow(
      "Required input 'github-token' is missing"
    );
  });
});
