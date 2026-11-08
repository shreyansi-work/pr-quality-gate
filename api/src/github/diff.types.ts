export interface DiffFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

export interface SkippedFile {
  file: string;
  reason: string;
  coveredBy: string;
}

export interface CheckRunSummary {
  name: string;
  status: string;
  conclusion: string | null;
}
