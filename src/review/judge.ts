/**
 * Judge Module - Aggregation and Deduplication Logic
 */

import type { ScannerResult, FinalReview, ReviewConfig, Severity, Finding } from './types.js';
import { callOpenRouter } from '../openrouter/client.js';
import type { OutputLanguage } from './prompts.js';
import { buildJudgePrompt, JUDGE_SYSTEM_PROMPT, estimateTokens, getSectionHeaders } from './prompts.js';
import { logger } from '../utils/logger.js';
import { estimateCost } from '../config/models.js';

/**
 * Parse severity from multi-language text
 */
function parseSeverity(text: string): Severity {
  const lower = text.toLowerCase();
  // English
  if (lower.includes('critical')) return 'critical';
  if (lower.includes('high') || lower.includes('important')) return 'high';
  if (lower.includes('medium')) return 'medium';
  if (lower.includes('low')) return 'low';
  // Turkish
  if (lower.includes('kritik')) return 'critical';
  if (lower.includes('yüksek') || lower.includes('önemli')) return 'high';
  if (lower.includes('orta')) return 'medium';
  if (lower.includes('düşük')) return 'low';
  // Japanese
  if (lower.includes('重大') || lower.includes('クリティカル')) return 'critical';
  if (lower.includes('重要')) return 'high';
  // German
  if (lower.includes('kritisch')) return 'critical';
  if (lower.includes('wichtig') || lower.includes('hoch')) return 'high';
  if (lower.includes('mittel')) return 'medium';
  if (lower.includes('niedrig')) return 'low';
  // French
  if (lower.includes('critique')) return 'critical';
  if (lower.includes('important') || lower.includes('élevé')) return 'high';
  if (lower.includes('moyen')) return 'medium';
  if (lower.includes('faible') || lower.includes('basse')) return 'low';
  // Spanish
  if (lower.includes('crítico')) return 'critical';
  if (lower.includes('alto') || lower.includes('importante')) return 'high';
  if (lower.includes('medio')) return 'medium';
  if (lower.includes('bajo')) return 'low';
  // Portuguese
  if (lower.includes('crítico')) return 'critical';
  if (lower.includes('alto') || lower.includes('importante')) return 'high';
  if (lower.includes('médio')) return 'medium';
  if (lower.includes('baixo')) return 'low';
  // Chinese
  if (lower.includes('严重') || lower.includes('关键')) return 'critical';
  if (lower.includes('重要') || lower.includes('高')) return 'high';
  if (lower.includes('中等') || lower.includes('中')) return 'medium';
  if (lower.includes('低')) return 'low';
  // Korean
  if (lower.includes('심각') || lower.includes('크리티컬')) return 'critical';
  if (lower.includes('중요') || lower.includes('높은')) return 'high';
  if (lower.includes('중간') || lower.includes('보통')) return 'medium';
  if (lower.includes('낮은')) return 'low';

  return 'info';
}

/**
 * Parse verdict from multi-language text
 */
function parseVerdict(text: string): FinalReview['verdict'] {
  const lower = text.toLowerCase();
  // English
  if (lower.includes('approve')) return 'approve';
  if (lower.includes('request_changes') || lower.includes('request changes') || lower.includes('changes requested')) return 'request-changes';
  // Turkish
  if (lower.includes('onay')) return 'approve';
  if (lower.includes('değişiklik')) return 'request-changes';
  // Japanese
  if (lower.includes('承認')) return 'approve';
  if (lower.includes('変更要求') || lower.includes('変更')) return 'request-changes';
  // German
  if (lower.includes('genehmigt')) return 'approve';
  if (lower.includes('änderungen')) return 'request-changes';
  // French
  if (lower.includes('approuvé')) return 'approve';
  if (lower.includes('modifications')) return 'request-changes';
  // Spanish
  if (lower.includes('aprobado')) return 'approve';
  if (lower.includes('cambios')) return 'request-changes';
  // Portuguese
  if (lower.includes('aprovado')) return 'approve';
  if (lower.includes('alterações')) return 'request-changes';
  // Chinese
  if (lower.includes('批准') || lower.includes('已批准')) return 'approve';
  if (lower.includes('更改') || lower.includes('需要')) return 'request-changes';
  // Korean
  if (lower.includes('승인')) return 'approve';
  if (lower.includes('변경')) return 'request-changes';

  return 'comment';
}

/**
 * Parse findings from judge response
 * This is a simplified parser - in production you might use structured output
 */
function parseFindings(judgeResponse: string, language: OutputLanguage = 'en'): Finding[] {
  const findings: Finding[] = [];
  const lines = judgeResponse.split('\n');
  const headers = getSectionHeaders(language);

  let currentSeverity: Severity = 'info';
  let findingIndex = 0;

  for (const line of lines) {
    // Detect section headers (multi-language support)
    if (line.includes(headers.critical) || line.includes('Critical') || line.includes('Kritik') || line.includes('重大')) {
      currentSeverity = 'critical';
      continue;
    }
    if (line.includes(headers.high) || line.includes('Important') || line.includes('High') || line.includes('Önemli') || line.includes('重要')) {
      currentSeverity = 'high';
      continue;
    }
    if (line.includes('Medium') || line.includes('Orta') || line.includes('中等')) {
      currentSeverity = 'medium';
      continue;
    }
    if (line.includes(headers.low) || line.includes('Low') || line.includes('Düşük') || line.includes('低')) {
      currentSeverity = 'low';
      continue;
    }

    // Parse bullet points as findings
    const bulletMatch = line.match(/^[-*•]\s*(.+)/);
    if (bulletMatch?.[1]) {
      const description = bulletMatch[1].trim();
      if (description.length > 10) {
        // Filter out very short items
        findings.push({
          id: `finding-${findingIndex++}`,
          severity: currentSeverity,
          category: 'bug', // Default category
          description,
        });
      }
    }
  }

  return findings;
}

/**
 * Extract summary from judge response
 */
function extractSummary(judgeResponse: string, language: OutputLanguage = 'en'): string {
  const headers = getSectionHeaders(language);

  // Look for Summary section in any supported language
  const summaryPatterns = [
    new RegExp(`##\\s*${headers.summary}\\s*\\n([\\s\\S]*?)(?=\\n##|$)`, 'i'),
    /##\s*Summary\s*\n([\s\S]*?)(?=\n##|$)/i,
    /##\s*Özet\s*\n([\s\S]*?)(?=\n##|$)/i,
    /##\s*概要\s*\n([\s\S]*?)(?=\n##|$)/i,
    /##\s*Zusammenfassung\s*\n([\s\S]*?)(?=\n##|$)/i,
    /##\s*Résumé\s*\n([\s\S]*?)(?=\n##|$)/i,
    /##\s*Resumen\s*\n([\s\S]*?)(?=\n##|$)/i,
    /##\s*Resumo\s*\n([\s\S]*?)(?=\n##|$)/i,
    /##\s*摘要\s*\n([\s\S]*?)(?=\n##|$)/i,
    /##\s*요약\s*\n([\s\S]*?)(?=\n##|$)/i,
  ];

  for (const pattern of summaryPatterns) {
    const match = judgeResponse.match(pattern);
    if (match?.[1]) {
      return match[1].trim();
    }
  }

  // Fallback: first non-empty paragraph
  const paragraphs = judgeResponse.split('\n\n').filter((p) => p.trim());
  return paragraphs[0]?.slice(0, 500) ?? 'Review completed.';
}

/**
 * Extract verdict from judge response
 */
function extractVerdict(judgeResponse: string, language: OutputLanguage = 'en'): FinalReview['verdict'] {
  const headers = getSectionHeaders(language);

  // Look for Verdict section in any supported language
  const verdictPatterns = [
    new RegExp(`##\\s*${headers.verdict}\\s*\\n([\\s\\S]*?)(?=\\n##|$)`, 'i'),
    /##\s*Verdict\s*\n([\s\S]*?)(?=\n##|$)/i,
    /##\s*Sonuç\s*\n([\s\S]*?)(?=\n##|$)/i,
    /##\s*判定\s*\n([\s\S]*?)(?=\n##|$)/i,
    /##\s*Urteil\s*\n([\s\S]*?)(?=\n##|$)/i,
    /##\s*Verdict\s*\n([\s\S]*?)(?=\n##|$)/i,  // French same as English
    /##\s*Veredicto\s*\n([\s\S]*?)(?=\n##|$)/i,
    /##\s*Veredito\s*\n([\s\S]*?)(?=\n##|$)/i,
    /##\s*结论\s*\n([\s\S]*?)(?=\n##|$)/i,
    /##\s*판정\s*\n([\s\S]*?)(?=\n##|$)/i,
  ];

  for (const pattern of verdictPatterns) {
    const match = judgeResponse.match(pattern);
    if (match?.[1]) {
      return parseVerdict(match[1]);
    }
  }

  // Fallback: scan entire response for verdict keywords
  return parseVerdict(judgeResponse);
}

/**
 * Count findings by severity
 */
function countBySeverity(findings: Finding[]): FinalReview['stats'] {
  return {
    critical: findings.filter((f) => f.severity === 'critical').length,
    high: findings.filter((f) => f.severity === 'high').length,
    medium: findings.filter((f) => f.severity === 'medium').length,
    low: findings.filter((f) => f.severity === 'low').length,
    info: findings.filter((f) => f.severity === 'info').length,
  };
}

/**
 * Judge and merge findings from multiple scanners
 * IMPORTANT: Judge does NOT add new findings, only aggregates
 */
export async function judgeReviews(
  reviews: ScannerResult[],
  config: ReviewConfig,
  language: OutputLanguage = 'en'
): Promise<FinalReview> {
  const successfulReviews = reviews.filter((r) => r.success);

  if (successfulReviews.length === 0) {
    throw new Error('No successful scanner results to judge');
  }

  logger.info('Starting judge aggregation', {
    judgeModel: config.judgeModel,
    reviewCount: successfulReviews.length,
    language,
  });

  const start = performance.now();
  const prompt = buildJudgePrompt(successfulReviews, language);

  const { content: judgeResponse, tokensUsed } = await callOpenRouter(
    config.judgeModel,
    prompt,
    {
      systemPrompt: JUDGE_SYSTEM_PROMPT,
      maxTokens: config.maxJudgeTokens,
      temperature: config.judgeTemperature,
    }
  );

  const durationMs = Math.round(performance.now() - start);

  // Parse the judge's response
  const contributingModels = successfulReviews.map((r) => r.model);
  const findings = parseFindings(judgeResponse, language);
  const summary = extractSummary(judgeResponse, language);
  const verdict = extractVerdict(judgeResponse, language);
  const stats = countBySeverity(findings);

  // Calculate total tokens used across all scanners + judge
  const totalScannerTokens = reviews.reduce((sum, r) => sum + r.tokensUsed, 0);
  const totalTokens = totalScannerTokens + tokensUsed;

  // Estimate cost
  const diffTokens = estimateTokens(prompt); // Rough estimate
  const cost = estimateCost(
    diffTokens,
    config.scannerModels,
    config.judgeModel,
    config.maxScannerTokens
  );

  logger.info('Judge completed', {
    findings: findings.length,
    verdict,
    tokensUsed,
    durationMs,
    estimatedCost: cost.toFixed(4),
  });

  // Auto-determine verdict based on findings if not clear
  let finalVerdict = verdict;
  if (stats.critical > 0) {
    finalVerdict = 'request-changes';
  } else if (stats.high > 2) {
    finalVerdict = 'request-changes';
  } else if (findings.length === 0) {
    finalVerdict = 'approve';
  }

  return {
    findings,
    summary,
    verdict: finalVerdict,
    stats,
    contributingModels,
    judgeModel: config.judgeModel,
    estimatedCost: cost,
  };
}

/**
 * Full review pipeline: scan + judge
 */
export async function runFullReview(
  diff: string,
  config: ReviewConfig,
  language: OutputLanguage = 'en'
): Promise<FinalReview> {
  // Import here to avoid circular dependency
  const { runScanners } = await import('./scanner.js');

  const scannerResults = await runScanners(diff, config, language);
  return judgeReviews(scannerResults, config, language);
}
