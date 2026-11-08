import { normalize } from '../src/review/fingerprint.js';
import type {
  Category,
  EvalFinding,
  FindingVerdict,
  LocatedBug,
  MatchOutcome,
} from './types.js';

/** The model names its own categories. Each one is mapped to the group a planted bug is filed under. */
const GROUP: Record<string, Category> = {
  async_await: 'async_await',
  resource_leak: 'resource_leak',
  logic_error: 'logic_error',
  type_error: 'logic_error',
  infinite_loop: 'logic_error',
  null_handling: 'logic_error',
  race_condition: 'race_condition',
  data_loss: 'data_loss',
  security: 'security',
  security_vulnerability: 'security',
  authorization_error: 'security',
  hardcoded_secret: 'security',
  input_validation: 'input_validation',
  missing_validation: 'input_validation',
  database_error: 'database_transaction',
  transaction_error: 'database_transaction',
  exception_handling: 'exception_handling',
  error_handling: 'exception_handling',
  duplicate_operation: 'race_condition',
  api_contract: 'api_contract',
  integration_error: 'api_contract',
  config_error: 'api_contract',
};

/** Groups that describe the same underlying problem from another angle. A finding in a related group can still be right. */
const RELATED: Record<Category, Category[]> = {
  async_await: ['exception_handling'],
  resource_leak: ['exception_handling'],
  logic_error: [],
  race_condition: ['database_transaction', 'data_loss'],
  data_loss: ['database_transaction', 'input_validation'],
  security: ['input_validation'],
  input_validation: ['security', 'logic_error'],
  database_transaction: ['data_loss', 'race_condition', 'exception_handling'],
  exception_handling: ['async_await', 'resource_leak'],
  api_contract: ['logic_error', 'input_validation', 'exception_handling'],
};

/** null when the model's category is not one we can place (for example "other" or "performance"). */
export function categoryGroup(modelCategory: string): Category | null {
  return GROUP[modelCategory.trim().toLowerCase().replace(/[\s-]+/g, '_')] ?? null;
}

/**
 * Is a finding of this model category an acceptable report of a bug of this group?
 * Same group or a related group is accepted. A category we cannot place ("other") is accepted too, because the
 * place and the message decide then. It is counted as not exact, so the report shows how often that happened.
 */
export function categoryFits(modelCategory: string, bug: Category): { fits: boolean; exact: boolean } {
  const group = categoryGroup(modelCategory);
  if (group === null) return { fits: true, exact: false };
  if (group === bug) return { fits: true, exact: true };
  return { fits: RELATED[bug].includes(group), exact: false };
}

/**
 * The lines (1-based) of the file that hold a snippet, or null. Whitespace is ignored.
 * Only the first line of the snippet is searched; the rest only decides how many lines it covers.
 */
export function locateLines(content: string, snippet: string): { start: number; end: number } | null {
  const wanted = snippet.split('\n').map(normalize).filter((l) => l.length > 0);
  if (wanted.length === 0) return null;
  const lines = content.split('\n').map(normalize);
  // the whole first line, then (for a quote that is only part of a line) any line that contains it
  const first = wanted[0];
  let index = lines.findIndex((l) => l === first);
  if (index < 0) index = lines.findIndex((l) => l.includes(first));
  if (index < 0) return null;
  return { start: index + 1, end: index + wanted.length };
}

/**
 * For a quote that is not in the file as written (the model changed a character or two): the line that shares
 * most of its words with it, or null when no line is similar enough. Used only to say where a dropped proposal was
 * pointing, never to decide a detection.
 */
export function closestLine(content: string, snippet: string): number | null {
  const words = (t: string) => new Set(t.split(/[^A-Za-z0-9_]+/).filter((w) => w.length > 1));
  const first = snippet.split('\n').find((l) => l.trim().length > 0) ?? '';
  const want = words(first);
  if (want.size < 2) return null;
  let best = 0;
  let bestLine: number | null = null;
  content.split('\n').forEach((line, i) => {
    const have = words(line);
    let shared = 0;
    for (const w of want) if (have.has(w)) shared++;
    const score = shared / (want.size + have.size - shared || 1);
    if (score > best) {
      best = score;
      bestLine = i + 1;
    }
  });
  return best >= 0.5 ? bestLine : null;
}

/** Where a planted bug is, found by its anchor. Throws when the anchor is missing so a broken answer key is noticed. */
export function locateBug(content: string, bug: { id: string; anchor: string; span: number }): { start: number; end: number } {
  const at = locateLines(content, bug.anchor);
  if (!at) throw new Error(`Bug ${bug.id}: the anchor "${bug.anchor}" is not in the file`);
  return { start: at.start, end: at.start + bug.span };
}

const gap = (aStart: number, aEnd: number, bStart: number, bEnd: number): number =>
  aEnd < bStart ? bStart - aEnd : bEnd < aStart ? aStart - bEnd : 0;

/** How many lines away from a bug a finding may point and still count as pointing at it. */
export const LINE_TOLERANCE = 2;

/**
 * Decide, for every finding, whether it found a planted bug, repeated one, or is a false positive.
 * A finding is a detection only when it is in the right file, points at the bug's lines (within LINE_TOLERANCE)
 * and its category fits. The nearest bug wins. A second finding on a bug that is already found is a duplicate.
 * Findings are handled in the order given, so the first finding on a bug is the detection.
 */
export function matchFindings(
  bugs: LocatedBug[],
  findings: EvalFinding[],
  cleanPaths: Set<string>,
  tolerance = LINE_TOLERANCE,
): MatchOutcome {
  const detectedBy = new Map<string, EvalFinding>();
  const verdicts: MatchOutcome['verdicts'] = [];

  for (const finding of findings) {
    let verdict: FindingVerdict;
    if (finding.startLine === null || finding.endLine === null) {
      verdict = { kind: 'false_positive', reason: 'quote_not_found' };
    } else if (cleanPaths.has(finding.file)) {
      verdict = { kind: 'false_positive', reason: 'clean_file' };
    } else {
      const near = bugs
        .filter((b) => b.path === finding.file)
        .map((b) => ({ b, d: gap(finding.startLine as number, finding.endLine as number, b.startLine, b.endLine) }))
        .filter((x) => x.d <= tolerance)
        .sort((x, y) => x.d - y.d);
      if (near.length === 0) {
        verdict = { kind: 'false_positive', reason: 'no_bug_here' };
      } else {
        // the closest bug whose category fits; when the nearest bug is about something else, try the next one
        const fitting = near.find((x) => categoryFits(finding.category, x.b.category).fits);
        if (!fitting) {
          verdict = { kind: 'false_positive', reason: 'wrong_issue_same_place' };
        } else if (detectedBy.has(fitting.b.id)) {
          verdict = { kind: 'duplicate', bugId: fitting.b.id };
        } else {
          detectedBy.set(fitting.b.id, finding);
          verdict = { kind: 'detected', bugId: fitting.b.id, categoryExact: categoryFits(finding.category, fitting.b.category).exact };
        }
      }
    }
    verdicts.push({ finding, verdict });
  }
  return { verdicts, detectedBy };
}
