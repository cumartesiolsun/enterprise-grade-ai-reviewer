/**
 * Judge Module - Aggregation and Merge Logic
 * MVP v0.1 - Merge scanner outputs into ONE final review
 */
import type { OpenRouterConfig } from '../openrouter/client.js';
import type { ScannerResult } from './scanner.js';
export interface JudgeConfig {
    openrouter: OpenRouterConfig;
    model: string;
    maxTokens: number;
    language: string;
}
export interface JudgeResult {
    output: string;
    tokensUsed: number;
    durationMs: number;
    success: boolean;
    error?: string | undefined;
}
/**
 * Run the judge to merge scanner outputs
 */
export declare function runJudge(config: JudgeConfig, scannerResults: ScannerResult[]): Promise<JudgeResult>;
//# sourceMappingURL=judge.d.ts.map