/**
 * Prompts Module - Centralized prompt management
 * Spec-compliant prompts for scanner and judge
 */
import type { ScannerResult } from './scanner.js';
/**
 * Build scanner system prompt (spec-compliant)
 */
export declare function buildScannerSystemPrompt(language: string): string;
/**
 * Build scanner user prompt
 */
export declare function buildScannerUserPrompt(diff: string): string;
/**
 * Build judge system prompt (spec-compliant)
 */
export declare function buildJudgeSystemPrompt(language: string): string;
/**
 * Build judge user prompt from scanner results
 */
export declare function buildJudgeUserPrompt(scannerResults: ScannerResult[]): string;
//# sourceMappingURL=prompts.d.ts.map