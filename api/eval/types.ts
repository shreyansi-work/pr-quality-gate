/** The bug groups the suite is measured in. The model's own category names are mapped onto these (see match.ts). */
export const CATEGORIES = [
  'async_await',
  'resource_leak',
  'logic_error',
  'race_condition',
  'data_loss',
  'security',
  'input_validation',
  'database_transaction',
  'exception_handling',
  'api_contract',
] as const;
export type Category = (typeof CATEGORIES)[number];

/** One file of the suite. The code lives in a .txt file so it is never compiled, linted or run. */
export interface SuiteFile {
  /** The name the review sees, for example src/orders/order.service.ts. */
  path: string;
  /** Where the code is, relative to api/eval. */
  source: string;
  /** A file without planted bugs. Every finding on it is a false positive. */
  clean: boolean;
  /**
   * tune: the files you may study while improving the prompt.
   * holdout: files nobody tunes against. Run them at milestones to see whether an improvement is real.
   */
  split: Split;
}

export type Split = 'tune' | 'holdout';

/** The answer key for one planted bug. Kept in expected.json, never sent to the model. */
export interface PlantedBug {
  id: string;
  path: string;
  category: Category;
  /** Text that appears exactly once in the file, on the first line of the bug. Line numbers would break on every edit. */
  anchor: string;
  /** How many lines after the anchor line still belong to the bug. */
  span: number;
  explanation: string;
}

export interface Suite {
  version: number;
  files: SuiteFile[];
  bugs: PlantedBug[];
}

export interface LocatedBug extends PlantedBug {
  startLine: number;
  endLine: number;
}

/** A finding the review kept, with the lines of the file it points at. */
export interface EvalFinding {
  file: string;
  category: string;
  severity: string;
  title?: string;
  quote: string;
  message: string;
  /** null when the quote could not be found in the file. */
  startLine: number | null;
  endLine: number | null;
}

export type FindingVerdict =
  | { kind: 'detected'; bugId: string; categoryExact: boolean }
  | { kind: 'duplicate'; bugId: string }
  | { kind: 'false_positive'; reason: 'clean_file' | 'no_bug_here' | 'wrong_issue_same_place' | 'quote_not_found' };

export interface MatchOutcome {
  verdicts: { finding: EvalFinding; verdict: FindingVerdict }[];
  /** bug id -> the finding that counted as its detection */
  detectedBy: Map<string, EvalFinding>;
}

export type MissCause =
  | 'file_skipped'
  | 'code_not_sent'
  | 'dropped_no_evidence'
  | 'dropped_by_verify'
  | 'cut_by_cap'
  | 'wrong_issue_same_place'
  | 'not_proposed'
  | 'review_aborted';

/** What happened to one file during the run. */
export interface FileRun {
  path: string;
  clean: boolean;
  skippedReason?: string;
  /** Patches that were sent to the model (a big file is sent in pieces). */
  pieces: string[];
  proposed: { category: string; quote: string; message: string; startLine: number | null }[];
  dropped: { quote: string; reason: 'no_evidence' | 'verify'; startLine: number | null }[];
  cappedCount: number;
  error?: string;
}

export interface BugResult {
  id: string;
  category: Category;
  path: string;
  startLine: number;
  endLine: number;
  explanation: string;
  detected: boolean;
  categoryExact?: boolean;
  duplicates: number;
  matchedFinding?: { title?: string; category: string; message: string; startLine: number | null };
  cause?: MissCause;
  causeDetail?: string;
}

export interface CategoryMetrics {
  planted: number;
  detected: number;
  missed: number;
  /** percent, or null when nothing was planted in this category */
  detectionRate: number | null;
  duplicates: number;
  falsePositives: number;
}

export interface Metrics {
  planted: number;
  detected: number;
  missed: number;
  detectionRate: number | null;
  findingsTotal: number;
  falsePositives: number;
  duplicates: number;
  /** false positives / all findings. null when the review reported nothing. */
  falsePositiveShare: number | null;
  cleanFiles: number;
  cleanFilesFlagged: number;
  /** clean files with at least one finding / clean files. null when the suite has no clean files. */
  cleanFileFlagRate: number | null;
  detectedWithExactCategory: number;
  byCategory: Record<string, CategoryMetrics>;
}

/** Present when the suite was run several times. The tables of the run are those of the median run. */
export interface RepeatSummary {
  runs: number;
  detectionRates: (number | null)[];
  falsePositives: number[];
  meanDetectionRate: number | null;
  minDetectionRate: number | null;
  maxDetectionRate: number | null;
  meanFalsePositives: number;
  meanFalsePositiveShare: number | null;
  /** bug id -> in how many runs it was detected */
  hits: Record<string, number>;
}

export interface EvalRun {
  id: string;
  label: string;
  startedAt: string;
  durationSeconds: number;
  model: string;
  provider: string;
  suiteVersion: number;
  settings: Record<string, string>;
  metrics: Metrics;
  bugs: BugResult[];
  falsePositives: { file: string; category: string; title?: string; startLine: number | null; reason: string; message: string }[];
  files: { path: string; clean: boolean; skippedReason?: string; findings: number; proposed: number; error?: string }[];
  repeat?: RepeatSummary;
}
