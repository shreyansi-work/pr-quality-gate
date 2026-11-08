import { filterFiles } from '../src/github/diff-filter.js';
import type { DiffFile } from '../src/github/diff.types.js';
import { patchFromContent } from '../src/review/context.js';
import type { ReviewService, ReviewTrace } from '../src/review/review.service.js';
import { explainMiss } from './causes.js';
import { categoryGroup, closestLine, locateLines, matchFindings } from './match.js';
import { computeMetrics } from './metrics.js';
import type { LoadedSuite } from './suite.js';
import type { BugResult, EvalFinding, EvalRun, FileRun } from './types.js';

export interface RunOptions {
  label: string;
  provider: string;
  settings: Record<string, string>;
  /** Same limits the real worker uses, so a file the product would skip is skipped here too. */
  maxFileChars: number;
  maxTotalChars: number;
  /** Called after each file, for progress output. */
  onFile?: (path: string, index: number, total: number) => void;
  now?: () => Date;
}

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');

/**
 * Review every file of the suite the way the product does (filter, then ReviewService.reviewFiles), one file at a
 * time so what happened to each file is recorded on its own. Every file is a NEW file: the whole file is the diff.
 * Rule findings (such as "no tests") are ignored, because they say nothing about bug detection.
 * The answer key is only used after all reviews are finished.
 */
export async function runSuite(review: ReviewService, loaded: LoadedSuite, modelName: string, opts: RunOptions): Promise<EvalRun> {
  const now = opts.now ?? (() => new Date());
  const startedAt = now();
  const findings: EvalFinding[] = [];
  const fileRuns = new Map<string, FileRun>();

  let index = 0;
  for (const f of loaded.suite.files) {
    index++;
    const content = loaded.contents.get(f.path) as string;
    const lineCount = content.replace(/\n$/, '').split('\n').length;
    const diffFile: DiffFile = { filename: f.path, status: 'added', additions: lineCount, deletions: 0, patch: patchFromContent(content) };
    const run: FileRun = { path: f.path, clean: f.clean, pieces: [], proposed: [], dropped: [], cappedCount: 0 };
    fileRuns.set(f.path, run);

    const { reviewable, skipped } = filterFiles([diffFile], opts.maxFileChars, opts.maxTotalChars);
    if (reviewable.length === 0) {
      run.skippedReason = skipped[0]?.reason ?? 'skipped by the file filter';
    } else {
      const line = (quote: string) => locateLines(content, quote)?.start ?? closestLine(content, quote);
      const trace = (e: ReviewTrace) => {
        if (e.type === 'piece') run.pieces.push(e.patch);
        else if (e.type === 'proposed') run.proposed.push({ category: e.category, quote: e.quote, message: e.message, startLine: line(e.quote) });
        else if (e.type === 'dropped') run.dropped.push({ quote: e.quote, reason: e.reason, startLine: line(e.quote) });
        else run.cappedCount += e.count;
      };
      try {
        const result = await review.reviewFiles(reviewable, [diffFile], undefined, new Map(), trace);
        for (const k of result.findings) {
          if (k.source !== 'AI') continue;
          const at = locateLines(content, k.quote);
          findings.push({
            file: f.path,
            category: k.category,
            severity: k.severity,
            title: k.title,
            quote: k.quote,
            message: k.message,
            startLine: at?.start ?? null,
            endLine: at?.end ?? null,
          });
        }
      } catch (err) {
        run.error = (err as Error).message;
      }
    }
    opts.onFile?.(f.path, index, loaded.suite.files.length);
  }

  const reviewed = [...fileRuns.values()].filter((r) => !r.skippedReason);
  if (reviewed.length > 0 && reviewed.every((r) => r.error)) {
    throw new Error(`Every file failed to review, so there is nothing to measure. First error: ${reviewed[0].error}`);
  }

  // From here on the answer key is used.
  const outcome = matchFindings(loaded.bugs, findings, new Set(loaded.cleanPaths));
  const metrics = computeMetrics(loaded.bugs, outcome, loaded.cleanPaths, categoryGroup);

  const dupCount = new Map<string, number>();
  for (const { verdict } of outcome.verdicts) if (verdict.kind === 'duplicate') dupCount.set(verdict.bugId, (dupCount.get(verdict.bugId) ?? 0) + 1);
  const verdictOf = new Map(outcome.verdicts.map((v) => [v.finding, v.verdict]));

  const bugs: BugResult[] = loaded.bugs.map((b) => {
    const hit = outcome.detectedBy.get(b.id);
    const result: BugResult = {
      id: b.id,
      category: b.category,
      path: b.path,
      startLine: b.startLine,
      endLine: b.endLine,
      explanation: b.explanation,
      detected: Boolean(hit),
      duplicates: dupCount.get(b.id) ?? 0,
    };
    if (hit) {
      const v = verdictOf.get(hit);
      result.categoryExact = v?.kind === 'detected' ? v.categoryExact : undefined;
      result.matchedFinding = { title: hit.title, category: hit.category, message: hit.message, startLine: hit.startLine };
    } else {
      const code = (loaded.contents.get(b.path) as string).split('\n')[b.startLine - 1] ?? '';
      const why = explainMiss(b, code, fileRuns.get(b.path));
      result.cause = why.cause;
      result.causeDetail = why.detail;
    }
    return result;
  });

  const falsePositives = outcome.verdicts
    .filter((v) => v.verdict.kind === 'false_positive')
    .map((v) => ({
      file: v.finding.file,
      category: v.finding.category,
      title: v.finding.title,
      startLine: v.finding.startLine,
      reason: v.verdict.kind === 'false_positive' ? v.verdict.reason : '',
      message: v.finding.message,
    }));

  const perFile = new Map<string, number>();
  for (const k of findings) perFile.set(k.file, (perFile.get(k.file) ?? 0) + 1);

  const finished = now();
  return {
    id: stamp(startedAt),
    label: opts.label,
    startedAt: startedAt.toISOString(),
    durationSeconds: Math.round((finished.getTime() - startedAt.getTime()) / 1000),
    model: modelName,
    provider: opts.provider,
    suiteVersion: loaded.suite.version,
    settings: opts.settings,
    metrics,
    bugs,
    falsePositives,
    files: [...fileRuns.values()].map((r) => ({
      path: r.path,
      clean: r.clean,
      skippedReason: r.skippedReason,
      findings: perFile.get(r.path) ?? 0,
      proposed: r.proposed.length,
      error: r.error,
    })),
  };
}
