export type Severity = 'HIGH' | 'MEDIUM' | 'LOW';
export type Source = 'AI' | 'RULE' | 'MANUAL';
export type FindingStatus = 'NEW' | 'ACCEPTED' | 'HELD' | 'REJECTED' | 'GONE';
export type Column = 'ACCEPTED' | 'HELD' | 'NEEDS_LOOK' | 'FIXED';
export type Readiness = 'READY' | 'NOT_READY' | 'NEEDS_TRIAGE' | 'REVIEWING' | 'FAILED';
export type Decision = 'ACCEPT' | 'HOLD' | 'REJECT' | 'UNREJECT';

export interface Counts {
  toTriage: number;
  acceptedOpen: number;
  held: number;
  needsLook: number;
  fixed: number;
  rejected: number;
}

export interface CiCheck { name: string; conclusion: string | null }
export interface SkippedFile { file: string; reason: string; coveredBy: string }

export interface Run {
  id?: number;
  status: string;
  headSha: string;
  error: string | null;
  model?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  createdAt?: string;
  ciSummary?: CiCheck[] | null;
  skippedFiles?: SkippedFile[] | null;
  changedFiles?: unknown[] | null;
}

export interface PullBrief { id: number; number: number; title: string; repo: string }

export interface Pull extends PullBrief {
  author: string;
  branch: string;
  headSha: string;
  prState?: string;
  updatedAt: string;
  readiness: Readiness;
  counts: Counts;
  sev?: Record<Severity, number>;
  run: Run | null;
}

export interface Finding {
  id: number;
  fingerprint: string;
  source: Source;
  category: string;
  severity: Severity;
  file: string;
  functionName: string | null;
  quote: string | null;
  message: string;
  title?: string | null;
  description?: string | null;
  suggestedFix?: string | null;
  confidence?: string | null;
  status: FindingStatus;
  ticketState?: string | null;
  column: Column | null;
  closeReason?: string | null;
  rejectReason?: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt?: string | null;
}

export interface PullDetail extends Pull {
  runs?: { headSha: string; status: string; createdAt: string }[];
  findings: Finding[];
}

export interface Ticket extends Finding { pull: PullBrief }

export interface FindingEvent { id: number; type: string; message: string; actor: string; createdAt: string }
export interface FindingFull extends Ticket { events?: FindingEvent[] }
