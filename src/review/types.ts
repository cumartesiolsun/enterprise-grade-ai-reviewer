/**
 * Review Module Types
 */

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export type FindingCategory =
  | 'bug'
  | 'security'
  | 'logic'
  | 'performance'
  | 'edge-case'
  | 'maintainability'
  | 'style'
  | 'best-practice';

export interface Finding {
  /** Unique identifier for the finding */
  id: string;
  /** Severity level */
  severity: Severity;
  /** Category of the issue */
  category: FindingCategory;
  /** File path where the issue was found */
  file?: string;
  /** Line number (if applicable) */
  line?: number;
  /** Description of the issue */
  description: string;
  /** Suggested fix (if any) */
  suggestion?: string;
}

export interface ScannerResult {
  /** Model identifier that produced this result */
  model: string;
  /** List of findings from this scanner */
  findings: Finding[];
  /** Raw response text from the model */
  rawResponse: string;
  /** Token usage for this scan */
  tokensUsed: number;
  /** Time taken in milliseconds */
  durationMs: number;
  /** Whether the scan completed successfully */
  success: boolean;
  /** Error message if scan failed */
  error?: string;
}

export interface FinalReview {
  /** Merged and deduplicated findings */
  findings: Finding[];
  /** Summary of the review */
  summary: string;
  /** Overall assessment */
  verdict: 'approve' | 'request-changes' | 'comment';
  /** Total number of findings by severity */
  stats: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    info: number;
  };
  /** Models that contributed to this review */
  contributingModels: string[];
  /** Judge model used */
  judgeModel: string;
  /** Total cost estimate (USD) */
  estimatedCost: number;
}

export interface ReviewConfig {
  /** Models to use for scanning */
  scannerModels: string[];
  /** Model to use for judging/aggregation */
  judgeModel: string;
  /** Maximum tokens per scanner response */
  maxScannerTokens: number;
  /** Maximum tokens for judge response */
  maxJudgeTokens: number;
  /** Temperature for scanner models */
  scannerTemperature: number;
  /** Temperature for judge model */
  judgeTemperature: number;
}

export interface PRSize {
  /** Number of files changed */
  filesChanged: number;
  /** Total lines added */
  additions: number;
  /** Total lines deleted */
  deletions: number;
  /** Categorization */
  category: 'small' | 'medium' | 'large';
}
