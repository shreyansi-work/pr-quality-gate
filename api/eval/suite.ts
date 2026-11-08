import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { locateBug } from './match.js';
import { CATEGORIES, type LocatedBug, type Split, type Suite } from './types.js';

export const EVAL_DIR = dirname(fileURLToPath(import.meta.url));

export interface LoadedSuite {
  suite: Suite;
  /** file path (as the review sees it) -> code */
  contents: Map<string, string>;
  bugs: LocatedBug[];
  cleanPaths: string[];
}

/** Problems that would make a measurement meaningless. Empty when the suite is sound. */
export function checkSuite(suite: Suite, contents: Map<string, string>): string[] {
  const problems: string[] = [];
  const paths = new Set<string>();
  for (const f of suite.files) {
    if (paths.has(f.path)) problems.push(`File ${f.path} is listed twice`);
    paths.add(f.path);
    if (!contents.has(f.path)) problems.push(`File ${f.path}: no code at ${f.source}`);
    if (f.split !== 'tune' && f.split !== 'holdout') problems.push(`File ${f.path}: split must be tune or holdout`);
  }
  const ids = new Set<string>();
  const clean = new Set(suite.files.filter((f) => f.clean).map((f) => f.path));
  for (const b of suite.bugs) {
    if (ids.has(b.id)) problems.push(`Bug id ${b.id} is used twice`);
    ids.add(b.id);
    if (!(CATEGORIES as readonly string[]).includes(b.category)) problems.push(`Bug ${b.id}: unknown category ${b.category}`);
    if (!paths.has(b.path)) problems.push(`Bug ${b.id}: file ${b.path} is not in the suite`);
    if (clean.has(b.path)) problems.push(`Bug ${b.id}: file ${b.path} is marked clean`);
    if (!b.explanation.trim()) problems.push(`Bug ${b.id}: no explanation`);
    const code = contents.get(b.path);
    if (code !== undefined) {
      const times = code.split(b.anchor).length - 1;
      if (times !== 1) problems.push(`Bug ${b.id}: the anchor appears ${times} times in ${b.path} (it must appear exactly once)`);
    }
  }
  for (const f of suite.files) {
    if (!f.clean && !suite.bugs.some((b) => b.path === f.path)) problems.push(`File ${f.path} is not clean but has no planted bug`);
  }
  return problems;
}

export function loadSuite(dir = EVAL_DIR): LoadedSuite {
  const suite = JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8')) as Suite;
  const contents = new Map<string, string>();
  for (const f of suite.files) {
    try {
      contents.set(f.path, readFileSync(join(dir, f.source), 'utf8'));
    } catch {
      /* reported by checkSuite */
    }
  }
  const problems = checkSuite(suite, contents);
  if (problems.length > 0) throw new Error(`The evaluation suite is not valid:\n- ${problems.join('\n- ')}`);
  const bugs: LocatedBug[] = suite.bugs.map((b) => {
    const at = locateBug(contents.get(b.path) as string, b);
    return { ...b, startLine: at.start, endLine: at.end };
  });
  return { suite, contents, bugs, cleanPaths: suite.files.filter((f) => f.clean).map((f) => f.path) };
}

/** Only the files of one split (and their bugs). 'all' returns the suite unchanged. */
export function selectSplit(loaded: LoadedSuite, split: Split | 'all'): LoadedSuite {
  if (split === 'all') return loaded;
  const files = loaded.suite.files.filter((f) => f.split === split);
  const paths = new Set(files.map((f) => f.path));
  return {
    suite: { ...loaded.suite, files, bugs: loaded.suite.bugs.filter((b) => paths.has(b.path)) },
    contents: loaded.contents,
    bugs: loaded.bugs.filter((b) => paths.has(b.path)),
    cleanPaths: loaded.cleanPaths.filter((p) => paths.has(p)),
  };
}
