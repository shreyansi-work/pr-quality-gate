import type { EvalRun } from './types.js';

export interface GateLimits {
  /** Fail when the detection rate falls by more than this many percentage points. */
  maxDetectionDrop: number;
  /** Fail when the false positive share rises by more than this many percentage points. */
  maxFalsePositiveRise: number;
}

export const DEFAULT_LIMITS: GateLimits = { maxDetectionDrop: 3, maxFalsePositiveRise: 5 };

export interface GateResult {
  passed: boolean;
  failures: string[];
  notes: string[];
}

/** The two numbers the gate compares. With repeated runs these are the means, otherwise the single run. */
export function headline(run: EvalRun): { detectionRate: number | null; falsePositiveShare: number | null } {
  return run.repeat
    ? { detectionRate: run.repeat.meanDetectionRate, falsePositiveShare: run.repeat.meanFalsePositiveShare }
    : { detectionRate: run.metrics.detectionRate, falsePositiveShare: run.metrics.falsePositiveShare };
}

/**
 * Compare a new run with the accepted baseline.
 * Fails when detection drops or false positives rise beyond the limits, or when the two runs cannot be compared
 * fairly (a different suite or split), or when some files could not be reviewed at all.
 * Anything else that differs (model, settings, a weaker category) is reported as a note.
 */
export function checkGate(current: EvalRun, baseline: EvalRun, limits: GateLimits = DEFAULT_LIMITS): GateResult {
  const failures: string[] = [];
  const notes: string[] = [];

  if (current.suiteVersion !== baseline.suiteVersion) {
    failures.push(`The suite changed (version ${baseline.suiteVersion} -> ${current.suiteVersion}). Run the new suite and accept it as the new baseline.`);
  }
  if (current.settings.split !== baseline.settings.split) {
    failures.push(`The runs use different splits (${baseline.settings.split ?? 'all'} vs ${current.settings.split ?? 'all'}).`);
  }
  const broken = current.files.filter((f) => f.error);
  if (broken.length > 0) failures.push(`${broken.length} file(s) could not be reviewed: ${broken.map((f) => f.path).join(', ')}.`);

  if (failures.length === 0) {
    const now = headline(current);
    const before = headline(baseline);
    if (now.detectionRate !== null && before.detectionRate !== null) {
      const drop = Math.round((before.detectionRate - now.detectionRate) * 10) / 10;
      if (drop > limits.maxDetectionDrop) {
        failures.push(`Detection rate fell from ${before.detectionRate}% to ${now.detectionRate}% (${drop} points, limit ${limits.maxDetectionDrop}).`);
      }
    }
    const nowFp = now.falsePositiveShare ?? 0;
    const beforeFp = before.falsePositiveShare ?? 0;
    const rise = Math.round((nowFp - beforeFp) * 10) / 10;
    if (rise > limits.maxFalsePositiveRise) {
      failures.push(`False positive share rose from ${beforeFp}% to ${nowFp}% (${rise} points, limit ${limits.maxFalsePositiveRise}).`);
    }

    for (const [name, now1] of Object.entries(current.metrics.byCategory)) {
      const was = baseline.metrics.byCategory[name];
      if (!was || was.planted < 5 || now1.detectionRate === null || was.detectionRate === null) continue;
      if (was.detectionRate - now1.detectionRate >= 20) notes.push(`${name} fell from ${was.detectionRate}% to ${now1.detectionRate}%.`);
    }
  }

  if (current.model !== baseline.model) notes.push(`The model differs (${baseline.model} -> ${current.model}).`);
  if (current.settings.promptVersion !== baseline.settings.promptVersion) notes.push('The prompt differs from the baseline (expected when you changed it).');
  const runs = current.repeat?.runs ?? 1;
  if (runs < 3) notes.push(`Only ${runs} run(s) were averaged; use EVAL_RUNS=3 for a steadier result.`);

  return { passed: failures.length === 0, failures, notes };
}
