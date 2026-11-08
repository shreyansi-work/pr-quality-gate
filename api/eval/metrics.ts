import { CATEGORIES, type Category, type CategoryMetrics, type LocatedBug, type MatchOutcome, type Metrics } from './types.js';

/** percent with one decimal, or null when there is nothing to divide by */
export const percent = (part: number, whole: number): number | null =>
  whole === 0 ? null : Math.round((part / whole) * 1000) / 10;

const empty = (): CategoryMetrics => ({ planted: 0, detected: 0, missed: 0, detectionRate: null, duplicates: 0, falsePositives: 0 });

/**
 * Detection rate = detected / planted x 100.
 * False positives are findings that are not a planted bug (on a clean file, or on a buggy file but not at a planted bug).
 * Two false-positive numbers are given because they answer different questions:
 *  - falsePositiveShare: of everything the review reported, how much was wrong. Denominator: all findings.
 *  - cleanFileFlagRate: how often a file without bugs got flagged. Denominator: clean files. Null without clean files.
 * A finding on a buggy file that matches no planted bug is counted as a false positive, but it may be a real bug
 * nobody planted. The report lists them so a person can check.
 */
export function computeMetrics(
  bugs: LocatedBug[],
  outcome: MatchOutcome,
  cleanPaths: string[],
  groupOf: (modelCategory: string) => Category | null,
): Metrics {
  const byCategory: Record<string, CategoryMetrics> = {};
  for (const c of CATEGORIES) byCategory[c] = empty();
  byCategory.other = empty();

  for (const b of bugs) {
    byCategory[b.category].planted++;
    if (outcome.detectedBy.has(b.id)) byCategory[b.category].detected++;
  }

  let falsePositives = 0;
  let duplicates = 0;
  let exact = 0;
  const flagged = new Set<string>();
  const categoryOfBug = new Map(bugs.map((b) => [b.id, b.category]));

  for (const { finding, verdict } of outcome.verdicts) {
    if (verdict.kind === 'detected' && verdict.categoryExact) exact++;
    if (verdict.kind === 'duplicate') {
      duplicates++;
      byCategory[categoryOfBug.get(verdict.bugId) as Category].duplicates++;
    }
    if (verdict.kind === 'false_positive') {
      falsePositives++;
      byCategory[groupOf(finding.category) ?? 'other'].falsePositives++;
    }
    if (cleanPaths.includes(finding.file)) flagged.add(finding.file);
  }

  for (const m of Object.values(byCategory)) {
    m.missed = m.planted - m.detected;
    m.detectionRate = percent(m.detected, m.planted);
  }

  const detected = outcome.detectedBy.size;
  const total = outcome.verdicts.length;
  return {
    planted: bugs.length,
    detected,
    missed: bugs.length - detected,
    detectionRate: percent(detected, bugs.length),
    findingsTotal: total,
    falsePositives,
    duplicates,
    falsePositiveShare: percent(falsePositives, total),
    cleanFiles: cleanPaths.length,
    cleanFilesFlagged: flagged.size,
    cleanFileFlagRate: percent(flagged.size, cleanPaths.length),
    detectedWithExactCategory: exact,
    byCategory,
  };
}
