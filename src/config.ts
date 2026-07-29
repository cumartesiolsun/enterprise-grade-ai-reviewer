/**
 * Action input parsing and validation.
 *
 * All functions are pure over an env record (callers pass process.env),
 * which keeps them fully unit-testable without mutating global state.
 */

import type { ReviewMode } from './review/judge.js';

/**
 * Action inputs from environment
 */
export interface ActionInputs {
  openrouterApiKey: string;
  githubToken: string;
  baseUrl: string;
  scannerModels: string[];
  judgeModel: string;
  language: string;
  autoSelectModels: boolean;
  maxFiles: number;
  maxChars: number;
  timeoutMs: number;
  maxTokensScanner: number;
  maxTokensJudge: number;
  commentMarker: string;
  reviewMode: ReviewMode;
  excludePaths: string[];
}

/**
 * Default glob patterns excluded from review when exclude-paths is not set.
 * Lockfiles, minified assets, snapshots, and build/vendor output add noise
 * without being human-authored code.
 */
export const DEFAULT_EXCLUDE_PATHS: string[] = [
  '**/package-lock.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
  '**/*.min.js',
  '**/*.min.css',
  '**/*.snap',
  '**/dist/**',
  '**/build/**',
  '**/vendor/**',
];

const COMMENT_MARKER_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Get action input with default (kebab-case input names)
 * GitHub Actions preserves hyphens in env var names (INPUT_GITHUB-TOKEN)
 * See: https://github.com/actions/runner/issues/2283
 */
export function getInput(
  env: Record<string, string | undefined>,
  name: string,
  defaultValue: string
): string {
  // GitHub Actions: github-token -> INPUT_GITHUB-TOKEN (hyphens preserved)
  const envName = `INPUT_${name.toUpperCase()}`;
  return env[envName] ?? defaultValue;
}

/**
 * Get required input (throws if missing)
 */
export function getRequiredInput(
  env: Record<string, string | undefined>,
  name: string
): string {
  const value = getInput(env, name, '');
  if (!value) {
    throw new Error(`Required input '${name}' is missing`);
  }
  return value;
}

/**
 * Parse a positive integer input value.
 * Throws a clear error naming the input when the value is not a finite
 * positive integer (e.g. "80k", "3m", "-5", "0", "1.5").
 */
export function parsePositiveInt(name: string, raw: string): number {
  const trimmed = raw.trim();
  const value = Number(trimmed);

  if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `Input '${name}' must be a positive integer, got '${raw}'`
    );
  }

  return value;
}

/**
 * Parse a list-style input (supports JSON array, multiline, or CSV).
 *
 * If the value looks like a JSON array (starts with '[') but fails to parse,
 * this throws instead of silently degrading to CSV splitting, which would
 * produce broken entries like "[gpt-4o".
 */
export function parseListInput(name: string, input: string): string[] {
  const trimmed = input.trim();

  if (trimmed.length === 0) {
    return [];
  }

  // JSON array
  if (trimmed.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error(
        `Input '${name}' looks like a JSON array but failed to parse — ` +
          'quote the values (e.g. ["a/b", "c/d"]) or use CSV/multiline input'
      );
    }
    if (!Array.isArray(parsed)) {
      throw new Error(
        `Input '${name}' must be a JSON array, CSV, or multiline list`
      );
    }
    return parsed
      .map((item) => String(item).trim())
      .filter((item) => item.length > 0);
  }

  // Multiline (contains newlines)
  if (trimmed.includes('\n')) {
    return trimmed
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  // Fallback to CSV
  return trimmed
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * Parse scanner-models input (supports JSON array, multiline, or CSV)
 */
export function parseScannerModels(input: string): string[] {
  return parseListInput('scanner-models', input);
}

/**
 * Parse exclude-paths input.
 * - Empty input -> DEFAULT_EXCLUDE_PATHS
 * - The literal value "none" (case-insensitive) -> no exclusions
 * - Otherwise parsed like scanner-models (JSON array, multiline, or CSV)
 */
export function parseExcludePaths(input: string): string[] {
  const trimmed = input.trim();

  if (trimmed.length === 0) {
    return [...DEFAULT_EXCLUDE_PATHS];
  }

  if (trimmed.toLowerCase() === 'none') {
    return [];
  }

  return parseListInput('exclude-paths', trimmed);
}

/**
 * Parse action inputs from an env record (callers pass process.env)
 */
export function parseInputs(env: Record<string, string | undefined>): ActionInputs {
  const autoSelectModels =
    getInput(env, 'auto-select-models', 'false').toLowerCase() === 'true';
  const scannerModelsRaw = getInput(env, 'scanner-models', '');
  const scannerModels = parseScannerModels(scannerModelsRaw);
  const judgeModel = getInput(env, 'judge-model', '');

  // Validate auto-select-models first (not implemented in MVP)
  if (autoSelectModels) {
    throw new Error(
      'auto-select-models is not implemented in MVP. Please provide scanner-models explicitly and set auto-select-models to false.'
    );
  }

  // Validate scanner-models
  if (scannerModels.length === 0) {
    throw new Error(
      "Required input 'scanner-models' is missing. Provide a list of models (CSV, multiline, or JSON array)."
    );
  }

  // Validate judge-model
  if (!judgeModel) {
    throw new Error("Required input 'judge-model' is missing.");
  }

  // Parse and validate review mode
  const reviewModeRaw = getInput(env, 'review-mode', 'summary').toLowerCase();
  if (reviewModeRaw !== 'summary' && reviewModeRaw !== 'inline') {
    throw new Error(
      `Invalid review-mode '${reviewModeRaw}'. Must be 'summary' or 'inline'.`
    );
  }
  const reviewMode: ReviewMode = reviewModeRaw;

  // Validate comment-marker: it is interpolated into an HTML comment, so it
  // must stay a safe token (no "-->", spaces, or markup).
  const commentMarker = getInput(env, 'comment-marker', 'ENTERPRISE_AI_REVIEW');
  if (!COMMENT_MARKER_PATTERN.test(commentMarker)) {
    throw new Error(
      `Input 'comment-marker' must match ${COMMENT_MARKER_PATTERN.source} ` +
        `(letters, digits, underscore, hyphen), got '${commentMarker}'`
    );
  }

  return {
    openrouterApiKey: getRequiredInput(env, 'openrouter-api-key'),
    githubToken: getRequiredInput(env, 'github-token'),
    baseUrl: getInput(env, 'base-url', 'https://openrouter.ai/api/v1'),
    scannerModels,
    judgeModel,
    language: getInput(env, 'language', 'tr'),
    autoSelectModels,
    maxFiles: parsePositiveInt('max-files', getInput(env, 'max-files', '10')),
    maxChars: parsePositiveInt('max-chars', getInput(env, 'max-chars', '80000')),
    timeoutMs: parsePositiveInt('timeout-ms', getInput(env, 'timeout-ms', '180000')),
    maxTokensScanner: parsePositiveInt(
      'max-tokens-scanner',
      getInput(env, 'max-tokens-scanner', '2000')
    ),
    maxTokensJudge: parsePositiveInt(
      'max-tokens-judge',
      getInput(env, 'max-tokens-judge', '4000')
    ),
    commentMarker,
    reviewMode,
    excludePaths: parseExcludePaths(getInput(env, 'exclude-paths', '')),
  };
}
