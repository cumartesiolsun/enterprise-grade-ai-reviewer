/**
 * Scanner Module - Parallel Multi-LLM Code Review
 * v0.5 - Truthful SKIPPED semantics, role coverage tracking with automatic
 * rescue scanners, and an isolated judge-scan helper
 */

import type { OpenRouterConfig, ChatMessage } from '../openrouter/client.js';
import { callOpenRouter } from '../openrouter/client.js';
import type { ScannerRole } from './prompts.js';
import { buildScannerSystemPrompt, buildScannerUserPrompt } from './prompts.js';
import { logger } from '../utils/logger.js';

export type ScannerStatus = 'OK' | 'SKIPPED' | 'FAILED';

/** Where a ScannerResult came from. Absent means a regular main-pass scanner. */
export type ScannerOrigin = 'scanner' | 'rescue' | 'judge-scan';

/** How a role ended up covered (or not) after the main pass + rescue phase. */
export type CoverageStatus = 'covered' | 'rescued' | 'uncovered';

export interface RoleCoverage {
  role: ScannerRole;
  status: CoverageStatus;
}

export interface ScannerRunOutcome {
  results: ScannerResult[];
  coverage: RoleCoverage[];
}

export interface ScannerResult {
  model: string;
  role: ScannerRole;
  output: string;
  tokensUsed: number;
  durationMs: number;
  success: boolean;
  status: ScannerStatus;
  error?: string | undefined;
  /** Absent means a regular scanner from the main parallel pass. */
  origin?: ScannerOrigin | undefined;
}

export interface ScannerConfig {
  openrouter: OpenRouterConfig;
  models: string[];
  maxTokens: number;
  language: string;
  /**
   * Scanner roles, index-aligned with `models`. Resolution/validation is the
   * config layer's responsibility — the scanner only consumes the array. When
   * absent (or shorter than `models`), missing entries default to 'general'.
   */
  roles?: ScannerRole[];
  /** PR title/body context forwarded to the scanner user prompt. Default ''. */
  prContext?: string;
  /**
   * Fallback models for rescuing roles left uncovered by the main pass, tried
   * in order. Entries already in `models` (or consumed by an earlier rescue in
   * the same run) are skipped.
   */
  rescueModels?: string[];
}

/** Internal options for a single scanner call (rescue / judge-scan variants). */
interface SingleScannerOptions {
  /** Origin stamped on the result; omit for a regular main-pass scanner. */
  origin?: ScannerOrigin;
  /** Model name reported on the result. Defaults to the called model. */
  reportedModel?: string;
}

/** A result counts toward role coverage when the scanner genuinely ran. */
function isCovering(result: ScannerResult): boolean {
  return result.status === 'OK' || result.status === 'SKIPPED';
}

/**
 * Run a single scanner
 */
async function runSingleScanner(
  config: ScannerConfig,
  model: string,
  role: ScannerRole,
  diff: string,
  options?: SingleScannerOptions
): Promise<ScannerResult> {
  const start = performance.now();
  const reportedModel = options?.reportedModel ?? model;
  const originProps = options?.origin !== undefined ? { origin: options.origin } : {};

  logger.info(`Scanner started: ${reportedModel}`, { role, ...originProps });

  try {
    const messages: ChatMessage[] = [
      { role: 'system', content: buildScannerSystemPrompt(config.language, role) },
      { role: 'user', content: buildScannerUserPrompt(diff, config.prContext ?? '') },
    ];

    const { content, tokensUsed, finishReason } = await callOpenRouter(
      config.openrouter,
      model,
      messages,
      config.maxTokens,
      0.3
    );

    const durationMs = Math.round(performance.now() - start);
    const trimmed = content.trim();

    // v0.5 truthful SKIPPED semantics: SKIPPED only when the scanner
    // affirmatively reported nothing — the exact NO_FINDINGS sentinel, or an
    // empty completion that genuinely finished (finish_reason 'stop'). The
    // client already throws on empty-but-truncated responses, but classify
    // defensively: an empty completion with any other finish reason is not a
    // clean "nothing to report", so treat it as FAILED rather than a skip.
    if (trimmed.length === 0 && finishReason !== 'stop') {
      const errorMessage =
        `Scanner returned empty content with finish_reason '${finishReason ?? 'unknown'}' ` +
        `(expected 'stop' for an intentional empty response)`;

      logger.error(`Scanner failed: ${reportedModel}`, {
        role,
        error: errorMessage,
        durationMs,
        ...originProps,
      });

      return {
        model: reportedModel,
        role,
        output: '',
        tokensUsed,
        durationMs,
        success: false,
        status: 'FAILED',
        error: errorMessage,
        ...originProps,
      };
    }

    const status: ScannerStatus =
      trimmed === 'NO_FINDINGS' || trimmed.length === 0 ? 'SKIPPED' : 'OK';

    logger.info(`Scanner finished: ${reportedModel}`, {
      role,
      status,
      tokensUsed,
      durationMs,
      outputLength: content.length,
      ...originProps,
    });

    return {
      model: reportedModel,
      role,
      output: content,
      tokensUsed,
      durationMs,
      success: true,
      status,
      ...originProps,
    };
  } catch (error) {
    const durationMs = Math.round(performance.now() - start);
    // Client retries are exhausted by the time an error reaches us, so the
    // message is the final diagnostic for this scanner.
    const errorMessage = error instanceof Error ? error.message : String(error);

    logger.error(`Scanner failed: ${reportedModel}`, {
      role,
      error: errorMessage,
      durationMs,
      ...originProps,
    });

    return {
      model: reportedModel,
      role,
      output: '',
      tokensUsed: 0,
      durationMs,
      success: false,
      status: 'FAILED',
      error: errorMessage,
      ...originProps,
    };
  }
}

/**
 * Rescue phase (v0.5): every distinct role assigned this run must end up with
 * at least one scanner that genuinely ran (OK or SKIPPED). For each uncovered
 * role, one rescue scanner is attempted. Model selection order:
 *   (a) the first `rescueModels` entry not already used this run (not in the
 *       main model list, not taken by a previous rescue in this run);
 *   (b) otherwise the fastest model that succeeded this run in any role — it
 *       may be reused across multiple rescued roles;
 *   (c) if neither exists, the role stays uncovered and no call is made.
 *
 * Appends rescue results to `results` (they flow to the judge like any other
 * scanner result) and returns the per-role coverage report.
 */
async function rescueUncoveredRoles(
  config: ScannerConfig,
  diff: string,
  assignedRoles: ScannerRole[],
  results: ScannerResult[]
): Promise<RoleCoverage[]> {
  const uncoveredRoles = assignedRoles.filter(
    (role) => !results.some((r) => r.role === role && isCovering(r))
  );

  const mainModels = new Set(config.models);
  const takenRescueModels = new Set<string>();

  let fastestSuccessful: ScannerResult | undefined;
  for (const r of results) {
    if (r.success && (fastestSuccessful === undefined || r.durationMs < fastestSuccessful.durationMs)) {
      fastestSuccessful = r;
    }
  }

  // Select models sequentially (rescue-model consumption is order-dependent),
  // then run all rescue calls in parallel.
  const plans: { role: ScannerRole; model: string }[] = [];
  for (const role of uncoveredRoles) {
    const rescueModel = (config.rescueModels ?? []).find(
      (m) => !mainModels.has(m) && !takenRescueModels.has(m)
    );

    if (rescueModel !== undefined) {
      takenRescueModels.add(rescueModel);
      plans.push({ role, model: rescueModel });
      logger.info('Rescue scanner scheduled', { role, model: rescueModel, source: 'rescue-models' });
    } else if (fastestSuccessful !== undefined) {
      plans.push({ role, model: fastestSuccessful.model });
      logger.info('Rescue scanner scheduled', {
        role,
        model: fastestSuccessful.model,
        source: 'fastest-successful',
        durationMs: fastestSuccessful.durationMs,
      });
    } else {
      logger.warn('Role stays uncovered: no unused rescue model and no successful scanner', {
        role,
      });
    }
  }

  const rescueResults = await Promise.all(
    plans.map(({ role, model }) => runSingleScanner(config, model, role, diff, { origin: 'rescue' }))
  );
  results.push(...rescueResults);

  const coverage = assignedRoles.map((role): RoleCoverage => {
    if (!uncoveredRoles.includes(role)) {
      return { role, status: 'covered' };
    }
    const rescue = rescueResults.find((r) => r.role === role);
    if (rescue !== undefined && isCovering(rescue)) {
      return { role, status: 'rescued' };
    }
    if (rescue !== undefined) {
      logger.warn('Rescue scanner failed, role stays uncovered', {
        role,
        model: rescue.model,
        error: rescue.error,
      });
    }
    return { role, status: 'uncovered' };
  });

  logger.info('Role coverage', {
    coverage: coverage.map((c) => `${c.role}: ${c.status}`),
    rescuesAttempted: plans.length,
  });

  return coverage;
}

/**
 * Run all scanners in parallel, then rescue any uncovered roles
 * IMPORTANT: Scanners never see each other's output
 */
export async function runScanners(
  config: ScannerConfig,
  diff: string
): Promise<ScannerRunOutcome> {
  // Map each model to its role (index-aligned; missing entries → 'general')
  const assignments: { model: string; role: ScannerRole }[] = config.models.map(
    (model, index) => ({ model, role: config.roles?.[index] ?? 'general' })
  );

  logger.info('Starting parallel scanners', {
    assignments: assignments.map(({ model, role }) => `${model} -> ${role}`),
    diffLength: diff.length,
    language: config.language,
  });

  // Run all scanners in parallel
  const results = await Promise.all(
    assignments.map(({ model, role }) => runSingleScanner(config, model, role, diff))
  );

  // Log summary
  const successful = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;
  const totalTokens = results.reduce((sum, r) => sum + r.tokensUsed, 0);
  const maxDuration = results.length > 0 ? Math.max(...results.map((r) => r.durationMs)) : 0;

  logger.info('All scanners completed', {
    successful,
    failed,
    totalTokens,
    maxDurationMs: maxDuration,
  });

  // Distinct roles assigned this run, in first-appearance order
  const distinctRoles: ScannerRole[] = [];
  for (const { role } of assignments) {
    if (!distinctRoles.includes(role)) {
      distinctRoles.push(role);
    }
  }

  const coverage = await rescueUncoveredRoles(config, diff, distinctRoles, results);

  return { results, coverage };
}

/**
 * Run the judge model as an ISOLATED scanner-style pass over the diff.
 *
 * The aggregation judge must stay a pure verifier; a model cannot be an honest
 * referee of its own in-prompt findings, so the judge model's own scan is
 * isolated in its own call and treated like any other scanner source.
 *
 * Uses the scanner system prompt for `role` and the scanner token budget from
 * `config.maxTokens` — NOT the judge budget.
 */
export async function runJudgeScan(
  config: ScannerConfig,
  diff: string,
  model: string,
  role: ScannerRole
): Promise<ScannerResult> {
  return runSingleScanner(config, model, role, diff, {
    origin: 'judge-scan',
    reportedModel: `judge-scan:${model}`,
  });
}
