import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeActionOutputs, writeStepSummary } from './actionOutputs.js';

let tempDir: string;
let outputFile: string;
let summaryFile: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'action-outputs-test-'));
  outputFile = join(tempDir, 'github_output');
  summaryFile = join(tempDir, 'step_summary');
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('writeActionOutputs', () => {
  it('appends key=value lines to the file at GITHUB_OUTPUT', () => {
    writeActionOutputs(
      { 'total-tokens': '1234', 'findings-count': '3' },
      { GITHUB_OUTPUT: outputFile }
    );

    expect(readFileSync(outputFile, 'utf8')).toBe(
      'total-tokens=1234\nfindings-count=3\n'
    );
  });

  it('appends to existing file content instead of overwriting', () => {
    writeFileSync(outputFile, 'existing=x\n', 'utf8');

    writeActionOutputs({ 'scanners-failed': '0' }, { GITHUB_OUTPUT: outputFile });

    expect(readFileSync(outputFile, 'utf8')).toBe('existing=x\nscanners-failed=0\n');
  });

  it('appends across multiple calls', () => {
    writeActionOutputs({ a: '1' }, { GITHUB_OUTPUT: outputFile });
    writeActionOutputs({ b: '2' }, { GITHUB_OUTPUT: outputFile });

    expect(readFileSync(outputFile, 'utf8')).toBe('a=1\nb=2\n');
  });

  it('is a no-op when GITHUB_OUTPUT is not set', () => {
    expect(() => writeActionOutputs({ a: '1' }, {})).not.toThrow();
    expect(existsSync(outputFile)).toBe(false);
  });

  it('does not touch the file when there are no outputs', () => {
    writeActionOutputs({}, { GITHUB_OUTPUT: outputFile });
    expect(existsSync(outputFile)).toBe(false);
  });

  it('flattens LF and CRLF newlines in values to keep the format line-based', () => {
    writeActionOutputs(
      { msg: 'line1\nline2\r\nline3' },
      { GITHUB_OUTPUT: outputFile }
    );

    expect(readFileSync(outputFile, 'utf8')).toBe('msg=line1 line2 line3\n');
  });

  it('prevents value newlines from injecting extra output lines', () => {
    writeActionOutputs(
      { safe: 'value\ninjected-key=evil' },
      { GITHUB_OUTPUT: outputFile }
    );

    const content = readFileSync(outputFile, 'utf8');
    expect(content).toBe('safe=value injected-key=evil\n');
    expect(content).not.toContain('\ninjected-key=evil');
  });
});

describe('writeStepSummary', () => {
  it('appends markdown to the file at GITHUB_STEP_SUMMARY with a trailing newline', () => {
    writeStepSummary('## Review Summary', { GITHUB_STEP_SUMMARY: summaryFile });

    expect(readFileSync(summaryFile, 'utf8')).toBe('## Review Summary\n');
  });

  it('does not double a trailing newline that is already present', () => {
    writeStepSummary('done\n', { GITHUB_STEP_SUMMARY: summaryFile });

    expect(readFileSync(summaryFile, 'utf8')).toBe('done\n');
  });

  it('appends across multiple calls', () => {
    writeFileSync(summaryFile, '# Existing\n', 'utf8');

    writeStepSummary('first', { GITHUB_STEP_SUMMARY: summaryFile });
    writeStepSummary('second', { GITHUB_STEP_SUMMARY: summaryFile });

    expect(readFileSync(summaryFile, 'utf8')).toBe('# Existing\nfirst\nsecond\n');
  });

  it('preserves multi-line markdown content', () => {
    writeStepSummary('## Title\n\n- item 1\n- item 2', {
      GITHUB_STEP_SUMMARY: summaryFile,
    });

    expect(readFileSync(summaryFile, 'utf8')).toBe('## Title\n\n- item 1\n- item 2\n');
  });

  it('is a no-op when GITHUB_STEP_SUMMARY is not set', () => {
    expect(() => writeStepSummary('## Title', {})).not.toThrow();
    expect(existsSync(summaryFile)).toBe(false);
  });
});
