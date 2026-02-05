"use strict";
/**
 * Scanner Module - Parallel Multi-LLM Code Review
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.runScanners = runScanners;
exports.runScannersWithAutoConfig = runScannersWithAutoConfig;
const client_js_1 = require("../openrouter/client.js");
const prompts_js_1 = require("./prompts.js");
const concurrency_js_1 = require("../utils/concurrency.js");
const logger_js_1 = require("../utils/logger.js");
/**
 * Run a single scanner
 */
async function runSingleScanner(model, diff, config, language = 'en') {
    const start = performance.now();
    try {
        const prompt = (0, prompts_js_1.buildScannerPrompt)(diff, language);
        const { content, tokensUsed } = await (0, client_js_1.callOpenRouter)(model, prompt, {
            systemPrompt: prompts_js_1.SCANNER_SYSTEM_PROMPT,
            maxTokens: config.maxScannerTokens,
            temperature: config.scannerTemperature,
        });
        return {
            model,
            findings: [], // Will be parsed by judge
            rawResponse: content,
            tokensUsed,
            durationMs: Math.round(performance.now() - start),
            success: true,
        };
    }
    catch (error) {
        logger_js_1.logger.error(`Scanner failed: ${model}`, { error: String(error) });
        return {
            model,
            findings: [],
            rawResponse: '',
            tokensUsed: 0,
            durationMs: Math.round(performance.now() - start),
            success: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}
/**
 * Run all scanners in parallel
 * IMPORTANT: Scanners never see each other's output
 */
async function runScanners(diff, config, language = 'en') {
    const truncatedDiff = (0, prompts_js_1.truncateDiff)(diff);
    logger_js_1.logger.info('Starting parallel scanners', {
        models: config.scannerModels,
        diffLength: diff.length,
        truncatedLength: truncatedDiff.length,
        language,
    });
    const results = await (0, concurrency_js_1.allSettled)(config.scannerModels, (model) => runSingleScanner(model, truncatedDiff, config, language));
    // Extract results
    const scannerResults = results
        .filter((r) => r.success && r.result)
        .map((r) => r.result);
    // Log summary
    const successful = scannerResults.filter((r) => r.success).length;
    const failed = scannerResults.filter((r) => !r.success).length;
    const totalTokens = scannerResults.reduce((sum, r) => sum + r.tokensUsed, 0);
    const totalDuration = Math.max(...scannerResults.map((r) => r.durationMs));
    logger_js_1.logger.info('Scanners completed', {
        successful,
        failed,
        totalTokens,
        totalDurationMs: totalDuration,
    });
    return scannerResults;
}
/**
 * Run scanners with automatic model selection based on PR size
 */
async function runScannersWithAutoConfig(diff, models, options = {}, language = 'en') {
    const config = {
        scannerModels: models,
        judgeModel: 'claude-sonnet-judge',
        maxScannerTokens: options.maxScannerTokens ?? 1000,
        maxJudgeTokens: options.maxJudgeTokens ?? 2000,
        scannerTemperature: options.scannerTemperature ?? 0.3,
        judgeTemperature: options.judgeTemperature ?? 0.2,
    };
    return runScanners(diff, config, language);
}
//# sourceMappingURL=scanner.js.map