/**
 * Judge Module - Aggregation and Merge Logic
 * MVP v0.1 - Merge scanner outputs into ONE final review
 */
import { callOpenRouter } from '../openrouter/client.js';
import { buildJudgeSystemPrompt, buildJudgeUserPrompt } from './prompts.js';
import { logger } from '../utils/logger.js';
/**
 * Run the judge to merge scanner outputs
 */
export async function runJudge(config, scannerResults) {
    const start = performance.now();
    const successfulScanners = scannerResults.filter((r) => r.success);
    logger.info('Starting judge aggregation', {
        judgeModel: config.model,
        scannersToMerge: successfulScanners.length,
        language: config.language,
    });
    if (successfulScanners.length === 0) {
        logger.error('No successful scanner results to judge');
        return {
            output: 'Review could not be completed - all scanners failed.',
            tokensUsed: 0,
            durationMs: Math.round(performance.now() - start),
            success: false,
            error: 'No successful scanner results',
        };
    }
    try {
        const messages = [
            { role: 'system', content: buildJudgeSystemPrompt(config.language) },
            { role: 'user', content: buildJudgeUserPrompt(scannerResults) },
        ];
        const { content, tokensUsed } = await callOpenRouter(config.openrouter, config.model, messages, config.maxTokens, 0.2 // Lower temperature for more consistent merging
        );
        const durationMs = Math.round(performance.now() - start);
        logger.info('Judge finished', {
            tokensUsed,
            durationMs,
            outputLength: content.length,
        });
        return {
            output: content,
            tokensUsed,
            durationMs,
            success: true,
        };
    }
    catch (error) {
        const durationMs = Math.round(performance.now() - start);
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error('Judge failed', { error: errorMessage, durationMs });
        return {
            output: `Review aggregation failed: ${errorMessage}`,
            tokensUsed: 0,
            durationMs,
            success: false,
            error: errorMessage,
        };
    }
}
//# sourceMappingURL=judge.js.map