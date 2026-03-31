/**
 * Post review results to GitHub based on review mode and findings
 */
import { postOrUpdateComment, postInlineReview } from '../github/comments.js';
import { logger } from '../utils/logger.js';
export async function postResults(inputs, githubConfig, judgeResult, diff, scannerResults) {
    if (inputs.reviewMode === 'inline' && judgeResult.findings !== undefined) {
        if (judgeResult.findings.length > 0) {
            await postInlineReview(githubConfig, judgeResult.findings, diff.files, diff.headSha, scannerResults, diff.truncation, inputs.commentMarker);
        }
        else {
            await postOrUpdateComment(githubConfig, {
                judgeOutput: 'No issues found in this PR. LGTM! ✅',
                scannerResults,
                truncation: diff.truncation,
            }, inputs.commentMarker);
        }
        return;
    }
    if (inputs.reviewMode === 'inline') {
        logger.warn('Inline mode: failed to parse findings, falling back to summary');
    }
    await postOrUpdateComment(githubConfig, {
        judgeOutput: judgeResult.output,
        scannerResults,
        truncation: diff.truncation,
    }, inputs.commentMarker);
}
//# sourceMappingURL=postResults.js.map