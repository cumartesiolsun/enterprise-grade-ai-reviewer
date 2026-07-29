/**
 * GitHub Actions outputs and step summary helpers.
 *
 * Both functions are no-ops when the corresponding env var is not set,
 * so they are safe to call outside of GitHub Actions (e.g. local runs).
 */

import { appendFileSync } from 'node:fs';

/**
 * Append `key=value` lines to the file at env.GITHUB_OUTPUT.
 * No-op when GITHUB_OUTPUT is not set.
 * Values are flattened to a single line (GITHUB_OUTPUT's simple format is
 * line-based; all values written by this action are scalars).
 */
export function writeActionOutputs(
  outputs: Record<string, string>,
  env: Record<string, string | undefined> = process.env
): void {
  const outputFile = env['GITHUB_OUTPUT'];
  if (!outputFile) {
    return;
  }

  const entries = Object.entries(outputs);
  if (entries.length === 0) {
    return;
  }

  const lines = entries
    .map(([key, value]) => `${key}=${value.replace(/\r?\n/g, ' ')}`)
    .join('\n');

  appendFileSync(outputFile, `${lines}\n`, 'utf8');
}

/**
 * Append markdown to the file at env.GITHUB_STEP_SUMMARY.
 * No-op when GITHUB_STEP_SUMMARY is not set.
 */
export function writeStepSummary(
  markdown: string,
  env: Record<string, string | undefined> = process.env
): void {
  const summaryFile = env['GITHUB_STEP_SUMMARY'];
  if (!summaryFile) {
    return;
  }

  const content = markdown.endsWith('\n') ? markdown : `${markdown}\n`;
  appendFileSync(summaryFile, content, 'utf8');
}
