import { describe, it, expect } from 'vitest';
import type { ScannerResult } from './scanner.js';
import {
  buildScannerSystemPrompt,
  buildScannerUserPrompt,
  buildJudgeSystemPrompt,
  buildJudgeUserPrompt,
  buildJudgeSystemPromptInline,
  buildJudgeUserPromptInline,
} from './prompts.js';

function makeScannerResult(overrides: Partial<ScannerResult> = {}): ScannerResult {
  return {
    model: 'test-model',
    output: 'Some finding',
    tokensUsed: 100,
    durationMs: 500,
    success: true,
    status: 'OK',
    ...overrides,
  };
}

describe('buildScannerSystemPrompt', () => {
  it('contains "Respond in Turkish" for language "tr"', () => {
    const result = buildScannerSystemPrompt('tr');
    expect(result).toContain('Respond in Turkish.');
  });

  it('contains "Respond in English" for language "en"', () => {
    const result = buildScannerSystemPrompt('en');
    expect(result).toContain('Respond in English.');
  });

  it('contains "Respond in Turkish" for language "turkish" (case insensitive)', () => {
    const result = buildScannerSystemPrompt('turkish');
    expect(result).toContain('Respond in Turkish.');
  });

  it('contains "Respond in de" for unsupported language code "de"', () => {
    const result = buildScannerSystemPrompt('de');
    expect(result).toContain('Respond in de.');
  });
});

describe('buildScannerUserPrompt', () => {
  it('wraps the diff in a markdown code fence', () => {
    const diff = '--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new';
    const result = buildScannerUserPrompt(diff);
    expect(result).toContain('```diff');
    expect(result).toContain(diff);
    expect(result).toContain('```');
  });
});

describe('buildJudgeSystemPrompt', () => {
  it('contains language instruction and aggregator role for "en"', () => {
    const result = buildJudgeSystemPrompt('en');
    expect(result).toContain('Respond in English.');
    expect(result).toContain('aggregator');
  });
});

describe('buildJudgeUserPrompt', () => {
  it('includes model names and outputs for successful results', () => {
    const results: ScannerResult[] = [
      makeScannerResult({ model: 'model-a', output: 'Finding A' }),
      makeScannerResult({ model: 'model-b', output: 'Finding B' }),
    ];
    const result = buildJudgeUserPrompt(results, 'mock diff');
    expect(result).toContain('model-a');
    expect(result).toContain('Finding A');
    expect(result).toContain('model-b');
    expect(result).toContain('Finding B');
  });

  it('returns a fallback message when no results are successful', () => {
    const results: ScannerResult[] = [
      makeScannerResult({ success: false, status: 'FAILED', output: '' }),
    ];
    const result = buildJudgeUserPrompt(results, 'mock diff');
    expect(result).toContain('No scanner results available');
  });

  it('filters out failed results and only includes successful ones', () => {
    const results: ScannerResult[] = [
      makeScannerResult({ model: 'good-model', output: 'Valid finding', success: true }),
      makeScannerResult({ model: 'bad-model', output: 'Error output', success: false, status: 'FAILED' }),
    ];
    const result = buildJudgeUserPrompt(results, 'mock diff');
    expect(result).toContain('good-model');
    expect(result).toContain('Valid finding');
    expect(result).not.toContain('bad-model');
    expect(result).not.toContain('Error output');
  });
});

describe('buildJudgeSystemPromptInline', () => {
  it('contains JSON structure instructions and Turkish language for "tr"', () => {
    const result = buildJudgeSystemPromptInline('tr');
    expect(result).toContain('Respond in Turkish.');
    expect(result).toContain('JSON');
    expect(result).toContain('"file"');
    expect(result).toContain('"line"');
    expect(result).toContain('"severity"');
    expect(result).toContain('"title"');
    expect(result).toContain('"body"');
  });
});

describe('buildJudgeUserPromptInline', () => {
  it('mentions JSON array and includes model outputs for successful results', () => {
    const results: ScannerResult[] = [
      makeScannerResult({ model: 'inline-model', output: 'Inline finding' }),
    ];
    const result = buildJudgeUserPromptInline(results, 'mock diff');
    expect(result).toContain('JSON array');
    expect(result).toContain('inline-model');
    expect(result).toContain('Inline finding');
  });

  it('returns an empty array message when no results are successful', () => {
    const results: ScannerResult[] = [
      makeScannerResult({ success: false, status: 'FAILED', output: '' }),
    ];
    const result = buildJudgeUserPromptInline(results, 'mock diff');
    expect(result).toContain('empty JSON array');
    expect(result).toContain('[]');
  });
});
