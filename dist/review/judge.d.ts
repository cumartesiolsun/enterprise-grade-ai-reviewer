/**
 * Judge Module - Aggregation and Merge Logic
 * Supports summary (free-form) and inline (structured JSON) review modes
 */
import type { OpenRouterConfig } from '../openrouter/client.js';
import type { ScannerResult } from './scanner.js';
export type ReviewMode = 'summary' | 'inline';
export interface InlineFinding {
    file: string;
    line: number;
    severity: 'critical' | 'warning' | 'info';
    title: string;
    body: string;
    sources?: string[] | undefined;
}
export interface JudgeConfig {
    openrouter: OpenRouterConfig;
    model: string;
    maxTokens: number;
    language: string;
    reviewMode: ReviewMode;
}
export interface JudgeResult {
    output: string;
    tokensUsed: number;
    durationMs: number;
    success: boolean;
    error?: string | undefined;
    findings?: InlineFinding[] | undefined;
}
/**
 * Run the judge to merge scanner outputs
 */
export declare function runJudge(config: JudgeConfig, scannerResults: ScannerResult[], diff: string): Promise<JudgeResult>;
//# sourceMappingURL=judge.d.ts.map