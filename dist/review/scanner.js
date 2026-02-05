/**
 * Scanner Module - Parallel Multi-LLM Code Review
 * MVP v0.1 - Configurable models, parallel execution
 */
import { callOpenRouter } from '../openrouter/client.js';
import { buildScannerSystemPrompt, buildScannerUserPrompt } from './prompts.js';
import { logger } from '../utils/logger.js';
/**
 * Run a single scanner
 */
async function runSingleScanner(config, model, diff) {
    const start = performance.now();
    try {
        const messages = [
            { role: 'system', content: buildScannerSystemPrompt(config.language) },
            { role: 'user', content: buildScannerUserPrompt(diff) },
        ];
        const { content, tokensUsed } = await callOpenRouter(config.openrouter, model, messages, config.maxTokens, 0.3);
        const durationMs = Math.round(performance.now() - start);
        logger.info(`Scanner finished: ${model}`, {
            tokensUsed,
            durationMs,
            outputLength: content.length,
        });
        // Determine status: OK if has content, SKIPPED if empty/LGTM
        const isEmptyOrLgtm = content.trim().length === 0 ||
            content.toLowerCase().includes('lgtm') ||
            content.toLowerCase().includes('looks good');
        const status = isEmptyOrLgtm ? 'SKIPPED' : 'OK';
        return {
            model,
            output: content,
            tokensUsed,
            durationMs,
            success: true,
            status,
        };
    }
    catch (error) {
        const durationMs = Math.round(performance.now() - start);
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`Scanner failed: ${model}`, { error: errorMessage, durationMs });
        return {
            model,
            output: '',
            tokensUsed: 0,
            durationMs,
            success: false,
            status: 'FAILED',
            error: errorMessage,
        };
    }
}
/**
 * Run all scanners in parallel
 * IMPORTANT: Scanners never see each other's output
 */
export async function runScanners(config, diff) {
    logger.info('Starting parallel scanners', {
        models: config.models,
        diffLength: diff.length,
        language: config.language,
    });
    // Run all scanners in parallel
    const results = await Promise.all(config.models.map((model) => runSingleScanner(config, model, diff)));
    // Log summary
    const successful = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;
    const totalTokens = results.reduce((sum, r) => sum + r.tokensUsed, 0);
    const maxDuration = Math.max(...results.map((r) => r.durationMs));
    logger.info('All scanners completed', {
        successful,
        failed,
        totalTokens,
        maxDurationMs: maxDuration,
    });
    return results;
}
//# sourceMappingURL=scanner.js.map