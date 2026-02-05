/**
 * Prompt Templates for Code Review
 */
import type { ScannerResult } from './types.js';
/** Supported output languages */
export type OutputLanguage = 'en' | 'tr' | 'ja' | 'de' | 'fr' | 'es' | 'pt' | 'zh' | 'ko';
/**
 * Get section headers for a language
 */
export declare function getSectionHeaders(language?: OutputLanguage): {
    summary: string;
    critical: string;
    high: string;
    low: string;
    verdict: string;
};
/**
 * Scanner prompt template - identical for all models
 * Models must never see each other's output
 */
export declare function buildScannerPrompt(diff: string, language?: OutputLanguage): string;
/**
 * Judge prompt template - aggregates multiple reviews
 * Judge must NOT add new findings, only merge/dedupe/rank
 */
export declare function buildJudgePrompt(reviews: ScannerResult[], language?: OutputLanguage): string;
/**
 * System prompt for scanner models
 */
export declare const SCANNER_SYSTEM_PROMPT = "You are an expert code reviewer with deep knowledge of software engineering best practices, security vulnerabilities, and performance optimization. Your reviews are concise, actionable, and focused on real issues.";
/**
 * System prompt for judge model
 */
export declare const JUDGE_SYSTEM_PROMPT = "You are a senior engineering lead responsible for consolidating code review feedback. You excel at identifying duplicate issues, resolving contradictory opinions, and prioritizing findings based on their impact. You never introduce new issues - you only organize and prioritize existing feedback.";
/**
 * Truncate diff if too large
 */
export declare function truncateDiff(diff: string, maxChars?: number): string;
/**
 * Estimate token count (rough approximation)
 * ~4 characters per token for English, ~2-3 for code
 */
export declare function estimateTokens(text: string): number;
//# sourceMappingURL=prompts.d.ts.map