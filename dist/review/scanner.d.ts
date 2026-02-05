/**
 * Scanner Module - Parallel Multi-LLM Code Review
 * MVP v0.1 - Configurable models, parallel execution
 */
import type { OpenRouterConfig } from '../openrouter/client.js';
export interface ScannerResult {
    model: string;
    output: string;
    tokensUsed: number;
    durationMs: number;
    success: boolean;
    error?: string | undefined;
}
export interface ScannerConfig {
    openrouter: OpenRouterConfig;
    models: string[];
    maxTokens: number;
    language: string;
}
/**
 * Run all scanners in parallel
 * IMPORTANT: Scanners never see each other's output
 */
export declare function runScanners(config: ScannerConfig, diff: string): Promise<ScannerResult[]>;
//# sourceMappingURL=scanner.d.ts.map