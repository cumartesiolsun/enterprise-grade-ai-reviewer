/**
 * Scanner Module - Parallel Multi-LLM Code Review
 */
import type { ScannerResult, ReviewConfig } from './types.js';
import type { OutputLanguage } from './prompts.js';
/**
 * Run all scanners in parallel
 * IMPORTANT: Scanners never see each other's output
 */
export declare function runScanners(diff: string, config: ReviewConfig, language?: OutputLanguage): Promise<ScannerResult[]>;
/**
 * Run scanners with automatic model selection based on PR size
 */
export declare function runScannersWithAutoConfig(diff: string, models: string[], options?: Partial<ReviewConfig>, language?: OutputLanguage): Promise<ScannerResult[]>;
//# sourceMappingURL=scanner.d.ts.map