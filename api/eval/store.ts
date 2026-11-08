import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderReport } from './report.js';
import type { EvalRun } from './types.js';

const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 40) || 'run';

/** The newest saved run other than `exceptId`, or undefined. Results live only in api/eval/results. */
export function loadPreviousRun(dir: string, exceptId?: string): EvalRun | undefined {
  if (!existsSync(dir)) return undefined;
  const names = readdirSync(dir).filter((n) => n.endsWith('.json')).sort();
  for (const name of names.reverse()) {
    try {
      const run = JSON.parse(readFileSync(join(dir, name), 'utf8')) as EvalRun;
      if (run.id !== exceptId && run.metrics && Array.isArray(run.bugs)) return run;
    } catch {
      /* a damaged file is skipped */
    }
  }
  return undefined;
}

/** Write the run as JSON (for the next comparison) and Markdown (for people). Returns the two paths. */
export function saveRun(dir: string, run: EvalRun, previous?: EvalRun): { json: string; markdown: string } {
  mkdirSync(dir, { recursive: true });
  const base = join(dir, `${run.id}-${safe(run.label)}`);
  writeFileSync(`${base}.json`, JSON.stringify(run, null, 2));
  writeFileSync(`${base}.md`, renderReport(run, previous));
  return { json: `${base}.json`, markdown: `${base}.md` };
}
