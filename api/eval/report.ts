import { headline } from './gate.js';
import type { BugResult, EvalRun, Metrics } from './types.js';

const pct = (v: number | null): string => (v === null ? 'n/a' : `${v}%`);

const delta = (now: number | null, before: number | null, unit = ''): string => {
  if (now === null || before === null) return 'n/a';
  const d = Math.round((now - before) * 10) / 10;
  return `${d > 0 ? '+' : ''}${d}${unit}`;
};

export interface Comparison {
  previousId: string;
  warnings: string[];
  detectionRate: string;
  detected: string;
  falsePositives: string;
  duplicates: string;
  falsePositiveShare: string;
  newlyDetected: string[];
  newlyMissed: string[];
}

/** What changed since the previous run, and whether the two runs can fairly be compared. */
export function compareRuns(now: EvalRun, before: EvalRun): Comparison {
  const warnings: string[] = [];
  if (now.suiteVersion !== before.suiteVersion) warnings.push(`The suite changed (version ${before.suiteVersion} -> ${now.suiteVersion}); the numbers are not directly comparable.`);
  if (now.metrics.planted !== before.metrics.planted) warnings.push(`The number of planted bugs changed (${before.metrics.planted} -> ${now.metrics.planted}).`);
  if (now.model !== before.model) warnings.push(`The model changed (${before.model} -> ${now.model}); a difference may come from the model, not from your change.`);
  const changed = Object.keys({ ...now.settings, ...before.settings }).filter((k) => now.settings[k] !== before.settings[k]);
  if (changed.length > 0) warnings.push(`Settings that differ: ${changed.map((k) => `${k} (${before.settings[k] ?? 'unset'} -> ${now.settings[k] ?? 'unset'})`).join(', ')}.`);

  const was = new Map(before.bugs.map((b) => [b.id, b.detected]));
  return {
    previousId: before.id,
    warnings,
    detectionRate: delta(headline(now).detectionRate, headline(before).detectionRate, ' points'),
    detected: delta(now.metrics.detected, before.metrics.detected),
    falsePositives: delta(now.metrics.falsePositives, before.metrics.falsePositives),
    duplicates: delta(now.metrics.duplicates, before.metrics.duplicates),
    falsePositiveShare: delta(headline(now).falsePositiveShare, headline(before).falsePositiveShare, ' points'),
    newlyDetected: now.bugs.filter((b) => b.detected && was.get(b.id) === false).map((b) => b.id),
    newlyMissed: now.bugs.filter((b) => !b.detected && was.get(b.id) === true).map((b) => b.id),
  };
}

const CAUSE_TEXT: Record<string, string> = {
  file_skipped: 'file skipped by the filter',
  code_not_sent: 'code not sent to the model',
  dropped_no_evidence: 'dropped by the evidence check',
  dropped_by_verify: 'dropped by the second check',
  cut_by_cap: 'cut by the findings limit',
  wrong_issue_same_place: 'model reported something else here',
  not_proposed: 'model did not see it',
  review_aborted: 'review failed or did not run',
};

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

function summaryRows(m: Metrics): string[] {
  return [
    `| Planted bugs | ${m.planted} |`,
    `| Correctly detected | ${m.detected} |`,
    `| Missed | ${m.missed} |`,
    `| **Detection rate** | **${pct(m.detectionRate)}** (${m.detected} / ${m.planted}) |`,
    `| Findings reported | ${m.findingsTotal} |`,
    `| False positives | ${m.falsePositives} |`,
    `| False positives, share of all findings | ${pct(m.falsePositiveShare)} (${m.falsePositives} / ${m.findingsTotal}) |`,
    `| Clean files flagged | ${m.cleanFilesFlagged} / ${m.cleanFiles} = ${pct(m.cleanFileFlagRate)} |`,
    `| Duplicate findings | ${m.duplicates} |`,
    `| Detected with the expected category | ${m.detectedWithExactCategory} / ${m.detected} |`,
  ];
}

export function renderReport(run: EvalRun, previous?: EvalRun): string {
  const m = run.metrics;
  const out: string[] = [];
  out.push(`# Bug detection evaluation: ${run.label}`);
  out.push('');
  out.push(`Run ${run.id} · model ${run.model} (${run.provider}) · ${run.durationSeconds}s · suite version ${run.suiteVersion}`);
  out.push(`Settings: ${Object.entries(run.settings).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  const failed = run.files.filter((f) => f.error);
  if (failed.length > 0) {
    out.push('');
    out.push(`> **${failed.length} file(s) failed to review** (${failed.map((f) => f.path).join(', ')}). Their bugs are counted as missed. Fix the cause and run again before trusting these numbers.`);
  }
  out.push('', '## Summary', '', '| Metric | Value |', '|---|---|', ...summaryRows(m));

  if (run.repeat) {
    const rp = run.repeat;
    const everyRun = run.bugs.filter((b) => rp.hits[b.id] === rp.runs).length;
    const never = run.bugs.filter((b) => (rp.hits[b.id] ?? 0) === 0).map((b) => b.id);
    const some = run.bugs.filter((b) => (rp.hits[b.id] ?? 0) > 0 && rp.hits[b.id] < rp.runs).map((b) => `${b.id} (${rp.hits[b.id]}/${rp.runs})`);
    out.push('', `## Repeated runs (${rp.runs})`, '');
    out.push(`- Detection rate per run: ${rp.detectionRates.map(pct).join(', ')}. **Mean ${pct(rp.meanDetectionRate)}** (lowest ${pct(rp.minDetectionRate)}, highest ${pct(rp.maxDetectionRate)}).`);
    out.push(`- False positives per run: ${rp.falsePositives.join(', ')} (mean ${rp.meanFalsePositives}, mean share ${pct(rp.meanFalsePositiveShare)}).`);
    out.push(`- Found in every run: ${everyRun}. Found in some runs only: ${some.join(', ') || 'none'}. Never found: ${never.join(', ') || 'none'}.`);
    out.push('', '_The tables below are from the median run. Compare runs with the mean above._');
  }
  out.push('', '## Results by category', '', '| Category | Planted | Detected | Missed | Detection rate | False positives | Duplicates |', '|---|---|---|---|---|---|---|');
  for (const [name, c] of Object.entries(m.byCategory)) {
    if (c.planted === 0 && c.falsePositives === 0 && c.duplicates === 0) continue;
    out.push(`| ${name} | ${c.planted} | ${c.detected} | ${c.missed} | ${pct(c.detectionRate)} | ${c.falsePositives} | ${c.duplicates} |`);
  }
  out.push('', '_False positives are filed under the category the model gave (`other` when it could not be placed)._');

  const missed = run.bugs.filter((b) => !b.detected);
  out.push('', `## Missed bugs (${missed.length})`, '');
  if (missed.length === 0) out.push('None.');
  else {
    out.push('| Bug | Category | Where | Likely cause | Detail |', '|---|---|---|---|---|');
    for (const b of missed) out.push(`| ${b.id} | ${b.category} | ${b.path}:${b.startLine} | ${CAUSE_TEXT[b.cause ?? ''] ?? b.cause ?? '?'} | ${cell(b.causeDetail ?? '')} |`);
    const counts = new Map<string, number>();
    for (const b of missed) counts.set(b.cause ?? '?', (counts.get(b.cause ?? '?') ?? 0) + 1);
    out.push('', `Causes: ${[...counts].map(([k, v]) => `${CAUSE_TEXT[k] ?? k} ${v}`).join(', ')}.`);
  }

  out.push('', `## False positives (${run.falsePositives.length})`, '');
  if (run.falsePositives.length === 0) out.push('None.');
  else {
    out.push('Check each one: a finding on a buggy file may be a real bug nobody planted.', '', '| File | Line | Category | Why it counts as wrong | Message |', '|---|---|---|---|---|');
    for (const f of run.falsePositives) out.push(`| ${f.file} | ${f.startLine ?? '?'} | ${f.category} | ${f.reason.replace(/_/g, ' ')} | ${cell((f.title ? `${f.title}: ` : '') + f.message).slice(0, 160)} |`);
  }

  const dups = run.bugs.filter((b) => b.duplicates > 0);
  out.push('', `## Duplicate findings (${m.duplicates})`, '');
  if (dups.length === 0) out.push('None.');
  else for (const b of dups) out.push(`- ${b.id}: ${b.duplicates} extra finding(s) on the same bug`);

  out.push('', '## Detected bugs: check the match', '', '| Bug | Matched finding | Category given | Exact category |', '|---|---|---|---|');
  for (const b of run.bugs.filter((x) => x.detected)) {
    out.push(`| ${b.id} | ${cell((b.matchedFinding?.title ?? b.matchedFinding?.message ?? '').slice(0, 110))} | ${b.matchedFinding?.category ?? ''} | ${b.categoryExact ? 'yes' : 'no'} |`);
  }
  out.push('', '_A match is decided by file, line and category, not by meaning. Read this list once to confirm the findings really describe the planted bug._');

  out.push('', '## Files', '', '| File | Clean | Proposed | Kept | Note |', '|---|---|---|---|---|');
  for (const f of run.files) out.push(`| ${f.path} | ${f.clean ? 'yes' : 'no'} | ${f.proposed} | ${f.findings} | ${cell(f.error ? `failed: ${f.error}` : f.skippedReason ? `skipped: ${f.skippedReason}` : '')} |`);

  out.push('', '## Comparison with the previous run', '');
  if (!previous) out.push('No earlier run was found, so this one is the baseline.');
  else {
    const c = compareRuns(run, previous);
    out.push(`Previous run: ${c.previousId}`, '');
    for (const w of c.warnings) out.push(`- Warning: ${w}`);
    out.push('', '| Metric | Change |', '|---|---|', `| Detection rate | ${c.detectionRate} |`, `| Detected bugs | ${c.detected} |`, `| False positives | ${c.falsePositives} |`, `| False positive share | ${c.falsePositiveShare} |`, `| Duplicates | ${c.duplicates} |`);
    out.push('', `Newly detected: ${c.newlyDetected.join(', ') || 'none'}`, `Newly missed: ${c.newlyMissed.join(', ') || 'none'}`);
    out.push('', '_One run on a model with a little randomness is a rough measure. Treat a change of one or two bugs as noise until it repeats._');
  }
  return out.join('\n') + '\n';
}

export type { BugResult };
