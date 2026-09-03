/**
 * Verdict Module - Scanner-pool classification and deterministic verdicts
 *
 * v0.5.3: the judge is only ever asked to aggregate findings. Before the
 * judge runs, the scanner pool is classified into one of three classes:
 *
 *   - 'findings'   — at least one scanner produced usable findings; the judge
 *                    aggregates them (existing path). FAILED scanners in the
 *                    pool are tolerated but surfaced in the verdict headline.
 *   - 'all-clear'  — every scanner that ran reported NO_FINDINGS and nothing
 *                    failed; a deterministic APPROVE verdict is posted and the
 *                    judge model is not called.
 *   - 'incomplete' — no scanner produced findings AND at least one scanner
 *                    failed (or nothing ran at all); a clean result cannot be
 *                    claimed, so a deterministic INCOMPLETE verdict is posted
 *                    and the action fails (fail-closed; re-run to retry).
 *
 * Previously the zero-findings-plus-failure case reached the judge with a
 * "review could not be completed" prompt and the action stayed green.
 */

import type { ScannerResult } from './scanner.js';

export type ScannerPoolClass = 'findings' | 'all-clear' | 'incomplete';

export interface ScannerPoolClassification {
  kind: ScannerPoolClass;
  /** Scanners that genuinely ran (status OK or SKIPPED). */
  ran: number;
  /** Scanners with usable findings (OK with non-empty, non-NO_FINDINGS output). */
  usable: ScannerResult[];
  /** Scanners with status FAILED. */
  failed: ScannerResult[];
  /** True when the action must exit non-zero for this classification. */
  failAction: boolean;
}

type VerdictLanguage = 'tr' | 'en';

/**
 * A scanner result is usable for judge aggregation only when it succeeded
 * and produced actual findings (not empty, not the NO_FINDINGS sentinel).
 */
export function hasUsableOutput(result: ScannerResult): boolean {
  const trimmed = result.output.trim();
  return result.success && trimmed.length > 0 && trimmed !== 'NO_FINDINGS';
}

/**
 * Classify the scanner pool (regular + rescue + judge-scan results).
 * Pure: no I/O, no model call.
 */
export function classifyScannerPool(results: ScannerResult[]): ScannerPoolClassification {
  const usable = results.filter(hasUsableOutput);
  const failed = results.filter((r) => r.status === 'FAILED');
  const ran = results.filter((r) => r.status === 'OK' || r.status === 'SKIPPED').length;

  if (usable.length > 0) {
    return { kind: 'findings', ran, usable, failed, failAction: false };
  }

  // Nothing usable: an all-clear needs every scanner to have actually run.
  if (failed.length === 0 && ran > 0) {
    return { kind: 'all-clear', ran, usable, failed, failAction: false };
  }

  return { kind: 'incomplete', ran, usable, failed, failAction: true };
}

/** Deterministic verdict texts exist in Turkish and English; others fall back to English. */
function resolveLanguage(language: string): VerdictLanguage {
  const lang = language.toLowerCase();
  return lang === 'tr' || lang === 'turkish' ? 'tr' : 'en';
}

function formatModelList(results: ScannerResult[]): string {
  return results.map((r) => `\`${r.model}\``).join(', ');
}

/**
 * Deterministic APPROVE verdict for an all-clear pool. Mirrors the judge's
 * four-section structure as far as it can be produced without a judge pass.
 */
export function buildAllClearVerdict(
  classification: ScannerPoolClassification,
  language: string
): string {
  const n = classification.ran;

  if (resolveLanguage(language) === 'tr') {
    return [
      '## 1. Hüküm',
      '',
      `**APPROVE** — koşan ${n} tarayıcının tamamı bu diff için \`NO_FINDINGS\` bildirdi. Birleştirilecek bulgu olmadığından yargıç modeli çağrılmadı.`,
      '',
      '## 2. Bulgular',
      '',
      'Yok.',
      '',
      '_Etkilenen akışlar ve manuel doğrulama listesi bir yargıç geçişi gerektirir; tümü-temiz koşuda üretilmez._',
    ].join('\n');
  }

  const scanners = n === 1 ? 'scanner' : 'scanners';
  return [
    '## 1. Verdict',
    '',
    `**APPROVE** — all ${n} ${scanners} that ran reported \`NO_FINDINGS\` on this diff. There are no findings to aggregate, so the judge model was not called.`,
    '',
    '## 2. Findings',
    '',
    'None.',
    '',
    '_Impacted Flows and the Manual Verification Checklist require a judge pass and are not generated for an all-clear run._',
  ].join('\n');
}

/**
 * Deterministic INCOMPLETE verdict: no findings, but part of the pool is
 * missing. Posted together with a non-zero exit so the check turns red.
 */
export function buildIncompleteVerdict(
  classification: ScannerPoolClassification,
  language: string
): string {
  const n = classification.failed.length;
  const list = formatModelList(classification.failed);

  if (resolveLanguage(language) === 'tr') {
    const failedClause =
      n > 0
        ? `ancak ${n} tarayıcı başarısız oldu: ${list}.`
        : 'ancak hiçbir tarayıcı çalışmadı.';
    return [
      '## 1. Hüküm',
      '',
      `**INCOMPLETE** — hiçbir tarayıcı bulgu bildirmedi, ${failedClause} Tarayıcı havuzunun bir kısmı eksikken temiz sonuç iddia edilemez; bu koşu başarısız olarak işaretlendi. Workflow'u yeniden çalıştırın; hata nedenleri Sources bölümünde listelenmiştir.`,
    ].join('\n');
  }

  const failedClause =
    n > 0
      ? `but ${n} ${n === 1 ? 'scanner' : 'scanners'} failed: ${list}.`
      : 'but no scanner ran at all.';
  return [
    '## 1. Verdict',
    '',
    `**INCOMPLETE** — no scanner reported a finding, ${failedClause} A clean result cannot be claimed while part of the scanner pool is missing, so this run is marked failed. Re-run the workflow; the failure reasons are listed under Sources.`,
  ].join('\n');
}

/**
 * Headline suffix for the 'findings' class when FAILED scanners are present:
 * the verdict itself is unchanged (the judge saw every usable output), but
 * the loss must be visible on the verdict line, not only in Sources.
 * Returns undefined when nothing failed.
 */
export function formatDegradedSuffix(
  classification: ScannerPoolClassification,
  language: string
): string | undefined {
  const n = classification.failed.length;
  if (n === 0) return undefined;

  const list = formatModelList(classification.failed);
  if (resolveLanguage(language) === 'tr') {
    return `⚠️ DEGRADED — ${n} tarayıcı başarısız: ${list}`;
  }
  return `⚠️ DEGRADED — ${n} ${n === 1 ? 'scanner' : 'scanners'} failed: ${list}`;
}

/** The judge is instructed to put one of these tokens on its verdict line. */
const VERDICT_TOKEN = /\b(?:REQUEST CHANGES|APPROVE(?: WITH NITS)?)\b/;

/**
 * Append the degraded suffix to the judge's verdict headline line — the first
 * line carrying a verdict token. When the judge output has no such line, the
 * suffix is prepended as its own line so it can never be lost.
 */
export function appendDegradedSuffix(judgeOutput: string, suffix: string): string {
  const lines = judgeOutput.split('\n');
  const index = lines.findIndex((line) => VERDICT_TOKEN.test(line));

  if (index === -1) {
    return `${suffix}\n\n${judgeOutput}`;
  }

  lines[index] = `${lines[index]!.trimEnd()} — ${suffix}`;
  return lines.join('\n');
}
