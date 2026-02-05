"use strict";
/**
 * Model Registry and Routing Configuration
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.JUDGE_PRIORITY = exports.DEFAULT_SCANNERS = exports.MODEL_REGISTRY = void 0;
exports.getModel = getModel;
exports.getModelId = getModelId;
exports.getAvailableScanners = getAvailableScanners;
exports.getBestJudgeModel = getBestJudgeModel;
exports.selectModelsForPRSize = selectModelsForPRSize;
exports.calculatePRSize = calculatePRSize;
exports.estimateCost = estimateCost;
exports.createReviewConfig = createReviewConfig;
/**
 * Model registry with OpenRouter identifiers
 * Prices are estimates and should be verified with OpenRouter
 */
exports.MODEL_REGISTRY = {
    // Scanner Models
    'gpt-5.2-codex': {
        id: 'openai/gpt-4o', // Using GPT-4o as closest available
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
        id: 'google/gemini-2.0-flash-001', // Using Gemini 2.0 Flash as available option
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
exports.DEFAULT_SCANNERS = ['gpt-5.2-codex', 'claude-sonnet', 'gemini-2.5-pro'];
/** Judge model priority (first available is used) */
exports.JUDGE_PRIORITY = ['claude-sonnet-judge', 'gpt-4.1', 'gpt-5.2-codex'];
/**
 * Get model info by key
 */
function getModel(key) {
    return exports.MODEL_REGISTRY[key];
}
/**
 * Get OpenRouter model ID from our key
 */
function getModelId(key) {
    const model = exports.MODEL_REGISTRY[key];
    if (!model) {
        throw new Error(`Unknown model: ${key}`);
    }
    return model.id;
}
/**
 * Get all available scanner models
 */
function getAvailableScanners() {
    return Object.entries(exports.MODEL_REGISTRY)
        .filter(([, info]) => (info.role === 'scanner' || info.role === 'both') && info.available)
        .map(([key]) => key);
}
/**
 * Get the best available judge model
 */
function getBestJudgeModel() {
    for (const key of exports.JUDGE_PRIORITY) {
        const model = exports.MODEL_REGISTRY[key];
        if (model?.available && (model.role === 'judge' || model.role === 'both')) {
            return key;
        }
    }
    throw new Error('No judge model available');
}
/**
 * Select models based on PR size (cost optimization)
 */
function selectModelsForPRSize(size) {
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
                scanners: exports.DEFAULT_SCANNERS,
                judge: getBestJudgeModel(),
            };
    }
}
/**
 * Calculate PR size category
 */
function calculatePRSize(filesChanged, additions, deletions) {
    const totalChanges = additions + deletions;
    let category;
    if (filesChanged <= 3 && totalChanges <= 100) {
        category = 'small';
    }
    else if (filesChanged <= 10 && totalChanges <= 500) {
        category = 'medium';
    }
    else {
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
function estimateCost(diffTokens, scannerModels, judgeModel, expectedOutputTokens = 500) {
    let totalCost = 0;
    // Scanner costs
    for (const modelKey of scannerModels) {
        const model = exports.MODEL_REGISTRY[modelKey];
        if (model) {
            const inputCost = (diffTokens / 1_000_000) * model.inputCostPer1M;
            const outputCost = (expectedOutputTokens / 1_000_000) * model.outputCostPer1M;
            totalCost += inputCost + outputCost;
        }
    }
    // Judge cost (input = all scanner outputs + original diff context)
    const judgeModelInfo = exports.MODEL_REGISTRY[judgeModel];
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
function createReviewConfig(overrides = {}) {
    return {
        scannerModels: exports.DEFAULT_SCANNERS,
        judgeModel: getBestJudgeModel(),
        maxScannerTokens: 1000,
        maxJudgeTokens: 2000,
        scannerTemperature: 0.3,
        judgeTemperature: 0.2,
        ...overrides,
    };
}
//# sourceMappingURL=models.js.map