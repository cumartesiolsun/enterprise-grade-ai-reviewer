/**
 * Judge Module - Aggregation and Merge Logic
 * Supports summary (free-form) and inline (structured JSON) review modes
 */
import { callOpenRouter } from '../openrouter/client.js';
import { buildJudgeSystemPrompt, buildJudgeUserPrompt, buildJudgeSystemPromptInline, buildJudgeUserPromptInline, } from './prompts.js';
import { logger } from '../utils/logger.js';
/**
 * Attempt to parse the judge's JSON output into InlineFinding[].
 * Returns undefined if parsing fails (caller falls back to summary).
 */
function parseInlineFindings(content) {
    try {
        let jsonStr = content.trim();
        // Strip markdown code fences if present
        const fenceRegex = /^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/;
        const fenceMatch = fenceRegex.exec(jsonStr);
        if (fenceMatch?.[1]) {
            jsonStr = fenceMatch[1];
        }
        const parsed = JSON.parse(jsonStr);
        if (!Array.isArray(parsed)) {
            logger.warn('Judge inline output is not an array, falling back to summary');
            return undefined;
        }
        const findings = [];
        for (const item of parsed) {
            if (typeof item === 'object' &&
                item !== null &&
                'file' in item &&
                'line' in item &&
                'severity' in item &&
                'title' in item &&
                'body' in item) {
                const rec = item;
                const severity = rec['severity'];
                if (typeof rec['file'] === 'string' &&
                    typeof rec['line'] === 'number' &&
                    typeof rec['title'] === 'string' &&
                    typeof rec['body'] === 'string' &&
                    (severity === 'critical' || severity === 'warning' || severity === 'info')) {
                    findings.push({
                        file: rec['file'],
                        line: rec['line'],
                        severity,
                        title: rec['title'],
                        body: rec['body'],
                    });
                }
                else {
                    logger.warn('Skipping finding with invalid fields', { item });
                }
            }
            else {
                logger.warn('Skipping malformed finding item');
            }
        }
        return findings;
    }
    catch (error) {
        logger.warn('Failed to parse judge inline output as JSON', {
            error: error instanceof Error ? error.message : String(error),
        });
        return undefined;
    }
}
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
        reviewMode: config.reviewMode,
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
        // Select prompts based on review mode
        const systemPrompt = config.reviewMode === 'inline'
            ? buildJudgeSystemPromptInline(config.language)
            : buildJudgeSystemPrompt(config.language);
        const userPrompt = config.reviewMode === 'inline'
            ? buildJudgeUserPromptInline(scannerResults)
            : buildJudgeUserPrompt(scannerResults);
        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ];
        const { content, tokensUsed } = await callOpenRouter(config.openrouter, config.model, messages, config.maxTokens, 0.2);
        const durationMs = Math.round(performance.now() - start);
        logger.info('Judge finished', {
            tokensUsed,
            durationMs,
            outputLength: content.length,
        });
        // Parse findings for inline mode
        let findings;
        if (config.reviewMode === 'inline') {
            findings = parseInlineFindings(content);
            logger.info('Inline findings parsed', {
                findingsCount: findings?.length ?? 0,
                parsedSuccessfully: findings !== undefined,
            });
        }
        return {
            output: content,
            tokensUsed,
            durationMs,
            success: true,
            findings,
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