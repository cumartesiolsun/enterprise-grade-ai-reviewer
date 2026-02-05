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
export const MODEL_REGISTRY: Record<string, ModelInfo> = {
  // Scanner Models
  'gpt-5.2-codex': {
    id: 'openai/gpt-4o',  // Using GPT-4o as closest available
    name: 'GPT-5.2 Codex',
    provider: 'openai',
    role: 'scanner',
    focus: ['bug', 'logic', 'patch'],
    inputCostPer1M: 2.5,
    outputCostPer1M: 10,
    contextWindow: 128000,
    available: true,
  },
  'claude-sonnet': {
    id: 'anthropic/claude-3.5-sonnet',
    name: 'Claude 3.5 Sonnet',
    provider: 'anthropic',
    role: 'both',
    focus: ['maintainability', 'security'],
    inputCostPer1M: 3,
    outputCostPer1M: 15,
    contextWindow: 200000,
    available: true,
  },
  'gemini-2.5-pro': {
    id: 'google/gemini-2.0-flash-001',  // Using Gemini 2.0 Flash as available option
    name: 'Gemini 2.5 Pro',
    provider: 'google',
    role: 'scanner',
    focus: ['style', 'best-practice'],
    inputCostPer1M: 0.075,
    outputCostPer1M: 0.3,
    contextWindow: 1000000,
    available: true,
  },
  'kimi-k2.5': {
    id: 'moonshotai/kimi-k2',
    name: 'Kimi K2.5',
    provider: 'moonshot',
    role: 'scanner',
    focus: ['performance'],
    inputCostPer1M: 0.5,
    outputCostPer1M: 2,
    contextWindow: 131072,
    available: true,
  },

  // Judge Models (priority order)
  'claude-sonnet-judge': {
    id: 'anthropic/claude-3.5-sonnet',
    name: 'Claude Sonnet (Judge)',
    provider: 'anthropic',
    role: 'judge',
    focus: ['aggregation', 'deduplication', 'prioritization'],
    inputCostPer1M: 3,
    outputCostPer1M: 15,
    contextWindow: 200000,
    available: true,
  },
  'gpt-4.1': {
    id: 'openai/gpt-4-turbo',
    name: 'GPT-4.1',
    provider: 'openai',
    role: 'judge',
    focus: ['aggregation', 'deduplication'],
    inputCostPer1M: 10,
    outputCostPer1M: 30,
    contextWindow: 128000,
    available: true,
  },
};

/** Default scanner models */
export const DEFAULT_SCANNERS = ['gpt-5.2-codex', 'claude-sonnet', 'gemini-2.5-pro'];

/** Judge model priority (first available is used) */
export const JUDGE_PRIORITY = ['claude-sonnet-judge', 'gpt-4.1', 'gpt-5.2-codex'];

/**
 * Get model info by key
 */
export function getModel(key: string): ModelInfo | undefined {
  return MODEL_REGISTRY[key];
}

/**
 * Get OpenRouter model ID from our key
 */
export function getModelId(key: string): string {
  const model = MODEL_REGISTRY[key];
  if (!model) {
    throw new Error(`Unknown model: ${key}`);
  }
  return model.id;
}

/**
 * Get all available scanner models
 */
export function getAvailableScanners(): string[] {
  return Object.entries(MODEL_REGISTRY)
    .filter(([, info]) => (info.role === 'scanner' || info.role === 'both') && info.available)
    .map(([key]) => key);
}

/**
 * Get the best available judge model
 */
export function getBestJudgeModel(): string {
  for (const key of JUDGE_PRIORITY) {
    const model = MODEL_REGISTRY[key];
    if (model?.available && (model.role === 'judge' || model.role === 'both')) {
      return key;
    }
  }
  throw new Error('No judge model available');
}

/** Size info interface for model selection (compatible with NormalizedDiff.size) */
export interface SizeInfo {
  filesChanged: number;
  category: 'small' | 'medium' | 'large';
}

/**
 * Select models based on PR size (cost optimization)
 */
export function selectModelsForPRSize(size: SizeInfo): { scanners: string[]; judge: string } {
  switch (size.category) {
    case 'small':
      // Small PRs: single scanner for cost efficiency
      return {
        scanners: ['gpt-5.2-codex'],
        judge: 'claude-sonnet-judge',
      };

    case 'medium':
      // Medium PRs: two scanners
      return {
        scanners: ['gpt-5.2-codex', 'claude-sonnet'],
        judge: 'claude-sonnet-judge',
      };

    case 'large':
      // Large PRs: full multi-model review
      return {
        scanners: DEFAULT_SCANNERS,
        judge: getBestJudgeModel(),
      };
  }
}

/**
 * Calculate PR size category
 */
export function calculatePRSize(filesChanged: number, additions: number, deletions: number): PRSize {
  const totalChanges = additions + deletions;

  let category: PRSize['category'];
  if (filesChanged <= 3 && totalChanges <= 100) {
    category = 'small';
  } else if (filesChanged <= 10 && totalChanges <= 500) {
    category = 'medium';
  } else {
    category = 'large';
  }

  return {
    filesChanged,
    additions,
    deletions,
    category,
  };
}

/**
 * Estimate cost for a review
 */
export function estimateCost(
  diffTokens: number,
  scannerModels: string[],
  judgeModel: string,
  expectedOutputTokens: number = 500
): number {
  let totalCost = 0;

  // Scanner costs
  for (const modelKey of scannerModels) {
    const model = MODEL_REGISTRY[modelKey];
    if (model) {
      const inputCost = (diffTokens / 1_000_000) * model.inputCostPer1M;
      const outputCost = (expectedOutputTokens / 1_000_000) * model.outputCostPer1M;
      totalCost += inputCost + outputCost;
    }
  }

  // Judge cost (input = all scanner outputs + original diff context)
  const judgeModelInfo = MODEL_REGISTRY[judgeModel];
  if (judgeModelInfo) {
    const judgeInputTokens = expectedOutputTokens * scannerModels.length + diffTokens * 0.2; // Smaller context for judge
    const inputCost = (judgeInputTokens / 1_000_000) * judgeModelInfo.inputCostPer1M;
    const outputCost = (expectedOutputTokens * 1.5 / 1_000_000) * judgeModelInfo.outputCostPer1M; // Judge output slightly longer
    totalCost += inputCost + outputCost;
  }

  return totalCost;
}

/**
 * Create review config with defaults
 */
export function createReviewConfig(overrides: Partial<ReviewConfig> = {}): ReviewConfig {
  return {
    scannerModels: DEFAULT_SCANNERS,
    judgeModel: getBestJudgeModel(),
    maxScannerTokens: 1000,
    maxJudgeTokens: 2000,
    scannerTemperature: 0.3,
    judgeTemperature: 0.2,
    ...overrides,
  };
}
