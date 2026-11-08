import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkGate, DEFAULT_LIMITS } from './gate.js';
import { EVAL_DIR } from './suite.js';
import type { EvalRun } from './types.js';

/**
 * Entry of `npm run eval:gate`. Compares the newest run in eval/results (or the file in EVAL_RESULT)
 * with eval/baseline.json and fails when the review got worse. It does not call the AI.
 *
 *   GATE_MAX_DETECTION_DROP    percentage points, default 3
 *   GATE_MAX_FP_RISE           percentage points, default 5
 */
const num = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return process.env[name] !== undefined && process.env[name] !== '' && Number.isFinite(n) ? n : fallback;
};

const newestResult = (dir: string): string | undefined => {
  if (!existsSync(dir)) return undefined;
  const names = readdirSync(dir).filter((n) => n.endsWith('.json')).sort();
  return names.length ? join(dir, names[names.length - 1]) : undefined;
};

describe('regression gate', () => {
  it('the newest run is not worse than the baseline', () => {
    const baselinePath = join(EVAL_DIR, 'baseline.json');
    if (!existsSync(baselinePath)) {
      throw new Error('There is no eval/baseline.json yet. Run `npm run eval`, check the report, then `npm run eval:baseline`.');
    }
    const resultPath = process.env.EVAL_RESULT ?? newestResult(join(EVAL_DIR, 'results'));
    if (!resultPath) throw new Error('There is no run in eval/results. Run `npm run eval` first.');

    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as EvalRun;
    const current = JSON.parse(readFileSync(resultPath, 'utf8')) as EvalRun;
    const result = checkGate(current, baseline, {
      maxDetectionDrop: num('GATE_MAX_DETECTION_DROP', DEFAULT_LIMITS.maxDetectionDrop),
      maxFalsePositiveRise: num('GATE_MAX_FP_RISE', DEFAULT_LIMITS.maxFalsePositiveRise),
    });

    console.log(`[gate] baseline ${baseline.id} (${baseline.label}) vs ${current.id} (${current.label})`);
    for (const n of result.notes) console.log(`[gate] note: ${n}`);
    for (const f of result.failures) console.log(`[gate] FAIL: ${f}`);
    if (result.passed) console.log('[gate] passed');
    expect(result.failures).toEqual([]);
  });
});
