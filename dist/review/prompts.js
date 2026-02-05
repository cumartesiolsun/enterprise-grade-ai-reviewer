"use strict";
/**
 * Prompt Templates for Code Review
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.JUDGE_SYSTEM_PROMPT = exports.SCANNER_SYSTEM_PROMPT = void 0;
exports.getSectionHeaders = getSectionHeaders;
exports.buildScannerPrompt = buildScannerPrompt;
exports.buildJudgePrompt = buildJudgePrompt;
exports.truncateDiff = truncateDiff;
exports.estimateTokens = estimateTokens;
/** Language display names for prompts */
const LANGUAGE_NAMES = {
    en: 'English',
    tr: 'Turkish',
    ja: 'Japanese',
    de: 'German',
    fr: 'French',
    es: 'Spanish',
    pt: 'Portuguese',
    zh: 'Chinese',
    ko: 'Korean',
};
/** Section headers by language */
const SECTION_HEADERS = {
    en: {
        summary: 'Summary',
        critical: 'Critical Findings',
        high: 'Important Findings',
        low: 'Low Priority',
        verdict: 'Verdict',
    },
    tr: {
        summary: 'Özet',
        critical: 'Kritik Bulgular',
        high: 'Önemli Bulgular',
        low: 'Düşük Öncelikli',
        verdict: 'Sonuç',
    },
    ja: {
        summary: '概要',
        critical: '重大な問題',
        high: '重要な問題',
        low: '低優先度',
        verdict: '判定',
    },
    de: {
        summary: 'Zusammenfassung',
        critical: 'Kritische Befunde',
        high: 'Wichtige Befunde',
        low: 'Niedrige Priorität',
        verdict: 'Urteil',
    },
    fr: {
        summary: 'Résumé',
        critical: 'Problèmes Critiques',
        high: 'Problèmes Importants',
        low: 'Priorité Basse',
        verdict: 'Verdict',
    },
    es: {
        summary: 'Resumen',
        critical: 'Hallazgos Críticos',
        high: 'Hallazgos Importantes',
        low: 'Prioridad Baja',
        verdict: 'Veredicto',
    },
    pt: {
        summary: 'Resumo',
        critical: 'Problemas Críticos',
        high: 'Problemas Importantes',
        low: 'Baixa Prioridade',
        verdict: 'Veredito',
    },
    zh: {
        summary: '摘要',
        critical: '严重问题',
        high: '重要问题',
        low: '低优先级',
        verdict: '结论',
    },
    ko: {
        summary: '요약',
        critical: '심각한 문제',
        high: '중요한 문제',
        low: '낮은 우선순위',
        verdict: '판정',
    },
};
/**
 * Get section headers for a language
 */
function getSectionHeaders(language = 'en') {
    return SECTION_HEADERS[language] ?? SECTION_HEADERS.en;
}
/**
 * Scanner prompt template - identical for all models
 * Models must never see each other's output
 */
function buildScannerPrompt(diff, language = 'en') {
    const langName = LANGUAGE_NAMES[language] ?? 'English';
    return `You are a senior software engineer performing a code review.

Review the following Git diff.
Focus on:
- Bugs
- Security issues
- Incorrect logic
- Performance problems
- Missing edge cases

Rules:
- Be concise
- Bullet points only
- Do NOT repeat the diff
- Do NOT invent issues
- Respond in ${langName}

Diff:
${diff}`;
}
/**
 * Judge prompt template - aggregates multiple reviews
 * Judge must NOT add new findings, only merge/dedupe/rank
 */
function buildJudgePrompt(reviews, language = 'en') {
    const langName = LANGUAGE_NAMES[language] ?? 'English';
    const headers = getSectionHeaders(language);
    const formattedReviews = reviews
        .filter((r) => r.success)
        .map((r, i) => `--- Review ${i + 1} (Model: ${r.model}) ---
${r.rawResponse}
`)
        .join('\n');
    return `You are a code review judge.

Below are multiple independent code review outputs for the SAME code.

Tasks:
1. Remove duplicates
2. Resolve contradictions
3. Discard incorrect or weak findings
4. Prioritize critical issues
5. Produce ONE final review

Rules:
- Do NOT add new findings
- Use only provided inputs
- Output must be concise and actionable
- Respond in ${langName}

Format your response as:

## ${headers.summary}
[1-2 sentence overview]

## ${headers.critical}
- [Critical severity findings only]

## ${headers.high}
- [High priority findings]

## ${headers.low}
- [Minor improvement suggestions if any]

## ${headers.verdict}
[APPROVE / REQUEST_CHANGES / COMMENT with brief justification]

Reviews:
${formattedReviews}`;
}
/**
 * System prompt for scanner models
 */
exports.SCANNER_SYSTEM_PROMPT = `You are an expert code reviewer with deep knowledge of software engineering best practices, security vulnerabilities, and performance optimization. Your reviews are concise, actionable, and focused on real issues.`;
/**
 * System prompt for judge model
 */
exports.JUDGE_SYSTEM_PROMPT = `You are a senior engineering lead responsible for consolidating code review feedback. You excel at identifying duplicate issues, resolving contradictory opinions, and prioritizing findings based on their impact. You never introduce new issues - you only organize and prioritize existing feedback.`;
/**
 * Truncate diff if too large
 */
function truncateDiff(diff, maxChars = 50000) {
    if (diff.length <= maxChars) {
        return diff;
    }
    const truncated = diff.slice(0, maxChars);
    const lastNewline = truncated.lastIndexOf('\n');
    return (truncated.slice(0, lastNewline) +
        `\n\n... [Diff truncated: ${diff.length - maxChars} characters omitted] ...`);
}
/**
 * Estimate token count (rough approximation)
 * ~4 characters per token for English, ~2-3 for code
 */
function estimateTokens(text) {
    // Use a conservative estimate of 3 chars per token for mixed content
    return Math.ceil(text.length / 3);
}
//# sourceMappingURL=prompts.js.map