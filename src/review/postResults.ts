/**
 * Post review results to GitHub based on review mode and findings
 */

import type { GitHubConfig, FileDiff, TruncationInfo } from '../github/diff.js';
import { postOrUpdateComment, postInlineReview } from '../github/comments.js';
import type { ScannerResult } from './scanner.js';
import type { InlineFinding, ReviewMode } from './judge.js';
import { logger } from '../utils/logger.js';

export interface PostResultsInput {
  reviewMode: ReviewMode;
  commentMarker: string;
}

export interface PostResultsJudge {
  output: string;
  findings?: InlineFinding[] | undefined;
}

export interface PostResultsDiff {
  files: FileDiff[];
  headSha: string;
  truncation: TruncationInfo;
}

export async function postResults(
  inputs: PostResultsInput,
  githubConfig: GitHubConfig,
  judgeResult: PostResultsJudge,
  diff: PostResultsDiff,
  scannerResults: ScannerResult[]
): Promise<void> {
  if (inputs.reviewMode === 'inline' && judgeResult.findings !== undefined) {
    if (judgeResult.findings.length > 0) {
      await postInlineReview(
        githubConfig,
        judgeResult.findings,
        diff.files,
        diff.headSha,
        scannerResults,
        diff.truncation,
        inputs.commentMarker
      );
    } else {
      await postOrUpdateComment(
        githubConfig,
        {
          judgeOutput: 'No issues found in this PR. LGTM! ✅',
          scannerResults,
          truncation: diff.truncation,
        },
        inputs.commentMarker
      );
    }
    return;
  }

  if (inputs.reviewMode === 'inline') {
    logger.warn('Inline mode: failed to parse findings, falling back to summary');
  }
  await postOrUpdateComment(
    githubConfig,
    {
      judgeOutput: judgeResult.output,
      scannerResults,
      truncation: diff.truncation,
    },
    inputs.commentMarker
  );
}
