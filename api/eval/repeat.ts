import type { EvalRun, RepeatSummary } from './types.js';

const mean = (values: number[]): number => values.reduce((a, b) => a + b, 0) / values.length;
const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * Combine several runs of the same suite. A model gives slightly different answers each time, so one run is a rough
 * measure. The result is the median run (by detection rate, then fewest false positives) with a `repeat` summary:
 * mean / min / max and, for every bug, in how many runs it was found.
 */
export function aggregateRuns(runs: EvalRun[]): EvalRun {
  if (runs.length === 0) throw new Error('Nothing to combine');
  const ordered = [...runs].sort(
    (a, b) => (a.metrics.detectionRate ?? -1) - (b.metrics.detectionRate ?? -1) || b.metrics.falsePositives - a.metrics.falsePositives,
  );
  const median = ordered[Math.floor((ordered.length - 1) / 2)];

  const rates = runs.map((r) => r.metrics.detectionRate);
  const known = rates.filter((r): r is number => r !== null);
  const shares = runs.map((r) => r.metrics.falsePositiveShare).filter((r): r is number => r !== null);
  const hits: Record<string, number> = {};
  for (const run of runs) for (const b of run.bugs) hits[b.id] = (hits[b.id] ?? 0) + (b.detected ? 1 : 0);

  const repeat: RepeatSummary = {
    runs: runs.length,
    detectionRates: rates,
    falsePositives: runs.map((r) => r.metrics.falsePositives),
    meanDetectionRate: known.length ? round1(mean(known)) : null,
    minDetectionRate: known.length ? Math.min(...known) : null,
    maxDetectionRate: known.length ? Math.max(...known) : null,
    meanFalsePositives: round1(mean(runs.map((r) => r.metrics.falsePositives))),
    meanFalsePositiveShare: shares.length ? round1(mean(shares)) : null,
    hits,
  };
  return { ...median, id: runs[0].id, durationSeconds: runs.reduce((sum, r) => sum + r.durationSeconds, 0), repeat };
}
