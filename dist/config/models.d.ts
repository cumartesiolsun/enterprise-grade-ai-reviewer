/**
 * Model Registry and Routing Configuration
 */
import type { ReviewConfig, PRSize } from '../review/types.js';
export interface ModelInfo {
    /** OpenRouter model identifier */
    id: string;
    /** Display name */
    name: string;
    /** Provider (openai, anthropic, google, etc) */
    provider: string;
    /** Role in the review process */
    role: 'scanner' | 'judge' | 'both';
    /** Focus areas for this model */
    focus: string[];
    /** Cost per 1M input tokens (USD) */
    inputCostPer1M: number;
    /** Cost per 1M output tokens (USD) */
    outputCostPer1M: number;
    /** Context window size */
    contextWindow: number;
    /** Whether model is available */
    available: boolean;
}
/**
 * Model registry with OpenRouter identifiers
 * Prices are estimates and should be verified with OpenRouter
 */
export declare const MODEL_REGISTRY: Record<string, ModelInfo>;
/** Default scanner models */
export declare const DEFAULT_SCANNERS: string[];
/** Judge model priority (first available is used) */
export declare const JUDGE_PRIORITY: string[];
/**
 * Get model info by key
 */
export declare function getModel(key: string): ModelInfo | undefined;
/**
 * Get OpenRouter model ID from our key
 */
export declare function getModelId(key: string): string;
/**
 * Get all available scanner models
 */
export declare function getAvailableScanners(): string[];
/**
 * Get the best available judge model
 */
export declare function getBestJudgeModel(): string;
/** Size info interface for model selection (compatible with NormalizedDiff.size) */
export interface SizeInfo {
    filesChanged: number;
    category: 'small' | 'medium' | 'large';
}
/**
 * Select models based on PR size (cost optimization)
 */
export declare function selectModelsForPRSize(size: SizeInfo): {
    scanners: string[];
    judge: string;
};
/**
 * Calculate PR size category
 */
export declare function calculatePRSize(filesChanged: number, additions: number, deletions: number): PRSize;
/**
 * Estimate cost for a review
 */
export declare function estimateCost(diffTokens: number, scannerModels: string[], judgeModel: string, expectedOutputTokens?: number): number;
/**
 * Create review config with defaults
 */
export declare function createReviewConfig(overrides?: Partial<ReviewConfig>): ReviewConfig;
//# sourceMappingURL=models.d.ts.map