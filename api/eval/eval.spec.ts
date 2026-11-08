import { describe, expect, it } from 'vitest';
import { LlmProvider } from '../src/llm/llm.provider.js';
import { REVIEW_SYSTEM, VERIFY_SYSTEM } from '../src/review/prompts.js';
import { ReviewService } from '../src/review/review.service.js';
import { explainMiss } from './causes.js';
import { categoryFits, categoryGroup, closestLine, locateBug, locateLines, matchFindings } from './match.js';
import { computeMetrics, percent } from './metrics.js';
import { compareRuns, renderReport } from './report.js';
import { runSuite } from './runner.js';
import { aggregateRuns } from './repeat.js';
import { checkGate, DEFAULT_LIMITS } from './gate.js';
import { checkSuite, loadSuite, selectSplit } from './suite.js';
import type { EvalFinding, EvalRun, FileRun, LocatedBug } from './types.js';

const bug = (id: string, path: string, category: LocatedBug['category'], startLine: number, endLine = startLine): LocatedBug => ({
  id, path, category, anchor: 'x', span: endLine - startLine, explanation: 'e', startLine, endLine,
});
const finding = (file: string, category: string, startLine: number | null, endLine = startLine): EvalFinding => ({
  file, category, severity: 'HIGH', quote: 'q', message: 'm', startLine, endLine,
});

describe('locating code', () => {
  const code = ['a = 1;', '  const x = await   foo(1);', 'return x;'].join('\n');
  it('finds a line ignoring whitespace', () => {
    expect(locateLines(code, 'const x = await foo(1);')).toEqual({ start: 2, end: 2 });
  });
  it('finds a part of a line and counts the lines of a multi-line quote', () => {
    expect(locateLines(code, 'await foo(1)')).toEqual({ start: 2, end: 2 });
    expect(locateLines(code, 'const x = await foo(1);\nreturn x;')).toEqual({ start: 2, end: 3 });
  });
  it('returns null when the code is not there', () => {
    expect(locateLines(code, 'nothing like it')).toBeNull();
  });
  it('locates a planted bug by its anchor and span, and throws for a missing anchor', () => {
    expect(locateBug(code, { id: 'B', anchor: 'return x;', span: 0 })).toEqual({ start: 3, end: 3 });
    expect(() => locateBug(code, { id: 'B', anchor: 'missing', span: 0 })).toThrow();
  });
  it('closestLine finds a line the model changed a little, and nothing for an unrelated quote', () => {
    const c = "x\nthis.mailer.send(order.userId, 'Your order was archived');\ny";
    expect(closestLine(c, "this.mailer.send(order.userId, 'Your order was archived!')")).toBe(2);
    expect(closestLine(c, 'completely different words here')).toBeNull();
  });
});

describe('categories', () => {
  it('maps the model categories onto the suite groups', () => {
    expect(categoryGroup('Security_Vulnerability')).toBe('security');
    expect(categoryGroup('transaction_error')).toBe('database_transaction');
    expect(categoryGroup('other')).toBeNull();
  });
  it('accepts the same group, a related group and an unplaceable one, but not an unrelated one', () => {
    expect(categoryFits('async_await', 'async_await')).toEqual({ fits: true, exact: true });
    expect(categoryFits('error_handling', 'async_await')).toEqual({ fits: true, exact: false });
    expect(categoryFits('other', 'async_await')).toEqual({ fits: true, exact: false });
    expect(categoryFits('performance', 'logic_error')).toEqual({ fits: true, exact: false });
    expect(categoryFits('security', 'logic_error').fits).toBe(false);
  });
});

describe('matching findings to planted bugs', () => {
  const bugs = [bug('A', 'f.ts', 'async_await', 10), bug('B', 'f.ts', 'logic_error', 20, 22), bug('C', 'g.ts', 'security', 5)];
  const clean = new Set(['clean.ts']);

  it('detects a bug when the finding is in the right place with a fitting category', () => {
    const r = matchFindings(bugs, [finding('f.ts', 'async_await', 10)], clean);
    expect(r.detectedBy.has('A')).toBe(true);
    expect(r.verdicts[0].verdict).toEqual({ kind: 'detected', bugId: 'A', categoryExact: true });
  });
  it('allows a small distance but not a large one', () => {
    expect(matchFindings(bugs, [finding('f.ts', 'async_await', 12)], clean).detectedBy.has('A')).toBe(true);
    expect(matchFindings(bugs, [finding('f.ts', 'async_await', 14)], clean).detectedBy.has('A')).toBe(false);
  });
  it('counts a second finding on the same bug as a duplicate, not a second detection', () => {
    const r = matchFindings(bugs, [finding('f.ts', 'async_await', 10), finding('f.ts', 'async_await', 11)], clean);
    expect(r.detectedBy.size).toBe(1);
    expect(r.verdicts[1].verdict).toEqual({ kind: 'duplicate', bugId: 'A' });
  });
  it('does not count a finding about something else at the same place', () => {
    const r = matchFindings(bugs, [finding('f.ts', 'security', 20)], clean);
    expect(r.detectedBy.size).toBe(0);
    expect(r.verdicts[0].verdict).toEqual({ kind: 'false_positive', reason: 'wrong_issue_same_place' });
  });
  it('does not match across files', () => {
    const r = matchFindings(bugs, [finding('other.ts', 'security', 5)], clean);
    expect(r.verdicts[0].verdict).toEqual({ kind: 'false_positive', reason: 'no_bug_here' });
  });
  it('treats findings on clean files and unlocated findings as false positives', () => {
    const r = matchFindings(bugs, [finding('clean.ts', 'logic_error', 3), finding('f.ts', 'logic_error', null)], clean);
    expect(r.verdicts[0].verdict).toEqual({ kind: 'false_positive', reason: 'clean_file' });
    expect(r.verdicts[1].verdict).toEqual({ kind: 'false_positive', reason: 'quote_not_found' });
  });
  it('prefers the nearest bug', () => {
    const two = [bug('N1', 'f.ts', 'logic_error', 10), bug('N2', 'f.ts', 'logic_error', 14)];
    const r = matchFindings(two, [finding('f.ts', 'logic_error', 13)], clean);
    expect(r.detectedBy.has('N2')).toBe(true);
  });
});

describe('metrics', () => {
  const bugs = [bug('A', 'f.ts', 'async_await', 10), bug('B', 'f.ts', 'logic_error', 20), bug('C', 'g.ts', 'security', 5), bug('D', 'g.ts', 'security', 30)];
  const found = [
    finding('f.ts', 'async_await', 10), // detects A
    finding('f.ts', 'async_await', 10), // duplicate of A
    finding('g.ts', 'other', 5), // detects C (not exact)
    finding('g.ts', 'logic_error', 99), // false positive on a buggy file
    finding('clean.ts', 'null_handling', 2), // false positive on a clean file
  ];
  const outcome = matchFindings(bugs, found, new Set(['clean.ts', 'clean2.ts']));
  const m = computeMetrics(bugs, outcome, ['clean.ts', 'clean2.ts'], categoryGroup);

  it('counts detections, misses and the detection rate', () => {
    expect([m.planted, m.detected, m.missed, m.detectionRate]).toEqual([4, 2, 2, 50]);
  });
  it('counts false positives, duplicates and the two false-positive rates with their denominators', () => {
    expect([m.findingsTotal, m.falsePositives, m.duplicates]).toEqual([5, 2, 1]);
    expect(m.falsePositiveShare).toBe(40);
    expect([m.cleanFiles, m.cleanFilesFlagged, m.cleanFileFlagRate]).toEqual([2, 1, 50]);
  });
  it('counts how many detections had the expected category', () => {
    expect(m.detectedWithExactCategory).toBe(1);
  });
  it('splits the numbers by category', () => {
    expect(m.byCategory.async_await).toEqual({ planted: 1, detected: 1, missed: 0, detectionRate: 100, duplicates: 1, falsePositives: 0 });
    expect(m.byCategory.security.detectionRate).toBe(50);
    expect(m.byCategory.logic_error.falsePositives).toBe(2);
  });
  it('gives null instead of dividing by zero', () => {
    expect(percent(0, 0)).toBeNull();
    const none = computeMetrics([], matchFindings([], [], new Set()), [], categoryGroup);
    expect([none.detectionRate, none.falsePositiveShare, none.cleanFileFlagRate]).toEqual([null, null, null]);
  });
});

describe('why a bug was missed', () => {
  const b = bug('A', 'f.ts', 'logic_error', 10);
  const base = (): FileRun => ({ path: 'f.ts', clean: false, pieces: ['@@\n+const total = a > b;'], proposed: [], dropped: [], cappedCount: 0 });
  const line = 'const total = a > b;';

  it('file skipped', () => {
    expect(explainMiss(b, line, { ...base(), skippedReason: 'too big' }).cause).toBe('file_skipped');
  });
  it('code not sent', () => {
    expect(explainMiss(b, line, { ...base(), pieces: ['@@\n+other code'] }).cause).toBe('code_not_sent');
  });
  it('dropped by the evidence check and by the second check', () => {
    expect(explainMiss(b, line, { ...base(), dropped: [{ quote: 'x', reason: 'no_evidence', startLine: 10 }] }).cause).toBe('dropped_no_evidence');
    expect(explainMiss(b, line, { ...base(), dropped: [{ quote: 'x', reason: 'verify', startLine: 11 }] }).cause).toBe('dropped_by_verify');
  });
  it('a drop far away from the bug is not blamed', () => {
    expect(explainMiss(b, line, { ...base(), dropped: [{ quote: 'x', reason: 'verify', startLine: 90 }] }).cause).toBe('not_proposed');
  });
  it('wrong issue at the same place, cap and not proposed', () => {
    expect(explainMiss(b, line, { ...base(), proposed: [{ category: 'security', quote: 'x', message: 'm', startLine: 10 }] }).cause).toBe('wrong_issue_same_place');
    expect(explainMiss(b, line, { ...base(), cappedCount: 3 }).cause).toBe('cut_by_cap');
    expect(explainMiss(b, line, base()).cause).toBe('not_proposed');
  });
  it('review failed or missing', () => {
    expect(explainMiss(b, line, { ...base(), error: 'boom' }).cause).toBe('review_aborted');
    expect(explainMiss(b, line, undefined).cause).toBe('review_aborted');
  });
});

describe('the suite', () => {
  const loaded = loadSuite();
  it('is sound: unique ids, anchors that appear exactly once, clean files without bugs', () => {
    expect(checkSuite(loaded.suite, loaded.contents)).toEqual([]);
  });
  it('has the planted bugs and clean files the evaluation needs', () => {
    expect(loaded.bugs).toHaveLength(100);
    expect(loaded.cleanPaths).toHaveLength(20);
    const perGroup = new Map<string, number>();
    for (const x of loaded.bugs) perGroup.set(x.category, (perGroup.get(x.category) ?? 0) + 1);
    expect(perGroup.size).toBe(10);
    expect([...perGroup.values()].every((n) => n === 10)).toBe(true);
  });
  it('splits into a tuning set and a held-out set that both cover every category', () => {
    const tune = selectSplit(loaded, 'tune');
    const holdout = selectSplit(loaded, 'holdout');
    expect(tune.bugs.length + holdout.bugs.length).toBe(100);
    expect(tune.cleanPaths.length + holdout.cleanPaths.length).toBe(20);
    expect(new Set(holdout.bugs.map((x) => x.category)).size).toBe(10);
    expect(new Set(tune.bugs.map((x) => x.category)).size).toBe(10);
    expect(holdout.cleanPaths.length > 0).toBe(true);
    const overlap = tune.suite.files.filter((f) => holdout.suite.files.some((h) => h.path === f.path));
    expect(overlap).toHaveLength(0);
    expect(selectSplit(loaded, 'all').bugs).toHaveLength(100);
  });
  it('does not leak the answers into the code the model sees', () => {
    for (const code of loaded.contents.values()) {
      expect(/\bbug\b|planted|BUG|TODO|FIXME/i.test(code)).toBe(false);
    }
  });
  it('detects a broken answer key', () => {
    const broken = { ...loaded.suite, bugs: [{ ...loaded.suite.bugs[0], anchor: 'this text is not in the file' }] };
    expect(checkSuite(broken, loaded.contents).length > 0).toBe(true);
  });
});

/** A scripted model: answers per file, so the whole pipeline can be tested without a real AI. */
class FakeLlm extends LlmProvider {
  readonly modelName = 'fake-model';
  constructor(private readonly script: Record<string, object[]>, private readonly failFor: string[] = []) {
    super();
  }
  async completeJson(system: string, user: string): Promise<string> {
    if (system === VERIFY_SYSTEM) return JSON.stringify({ real: !user.includes('REJECT-ME') });
    if (system !== REVIEW_SYSTEM) return '{}';
    const file = /^File: (\S+)/.exec(user)?.[1] ?? '';
    if (this.failFor.includes(file)) throw new Error('model unavailable');
    return JSON.stringify({ findings: this.script[file] ?? [] });
  }
}
const f = (quote: string, category: string, extra: object = {}) => ({ category, severity: 'high', quote, message: `problem with ${quote}`, ...extra });
const review = (llm: LlmProvider) => new ReviewService(llm, null as never, { get: () => undefined } as never);
const options = { label: 'test', provider: 'fake', settings: { promptVersion: 'x' }, maxFileChars: 100_000, maxTotalChars: 100_000 };

describe('a whole evaluation run with a scripted model', () => {
  const loaded = loadSuite();
  const script = {
    'src/orders/order.service.ts': [
      f('this.repo.save(order);', 'async_await'),
      f('this.repo.save(order);', 'async_await', { message: 'again, worded differently' }),
      f("this.mailer.send(order.userId, 'Your order was archived!')", 'async_await'), // not on an added line as written
    ],
    'src/billing/pricing.ts': [
      f('if (subtotal > FREE_SHIPPING_FROM) return 0;', 'logic_error'),
      f('for (let i = 0; i <= items.length; i++) {', 'security'), // wrong issue
      f('if (account.active || account.verified) {', 'logic_error', { message: 'REJECT-ME' }), // second check rejects it
    ],
    'src/files/files.controller.ts': [f("WHERE name LIKE '%${term}%'", 'other'), f('const UPLOAD_DIR', 'logic_error')],
    'src/billing/discount.ts': [f('return subtotal >= FREE_SHIPPING_FROM ? 0 : 4.99;', 'logic_error')],
  };

  it('measures detections, misses, false positives and duplicates, and explains the misses', async () => {
    const run = await runSuite(review(new FakeLlm(script, ['src/sync/sync.service.ts'])), loaded, 'fake-model', options);
    const m = run.metrics;
    expect(m.planted).toBe(100);
    expect(m.detected).toBe(3); // AW-1, LE-1, SEC-1
    expect(m.duplicates).toBe(1);
    expect(m.falsePositives).toBe(3); // wrong issue, unrelated line, finding on a clean file
    expect(m.cleanFilesFlagged).toBe(1);
    expect(m.cleanFiles).toBe(20);
    const byId = new Map(run.bugs.map((x) => [x.id, x]));
    expect(byId.get('AW-1')?.detected).toBe(true);
    expect(byId.get('AW-1')?.duplicates).toBe(1);
    expect(byId.get('SEC-1')?.categoryExact).toBe(false);
    expect(byId.get('AW-3')?.cause).toBe('dropped_no_evidence');
    expect(byId.get('AW-2')?.cause).toBe('not_proposed');
    expect(byId.get('LE-2')?.cause).toBe('wrong_issue_same_place');
    expect(byId.get('LE-3')?.cause).toBe('dropped_by_verify');
    expect(byId.get('EX-1')?.cause).toBe('review_aborted');
    expect(run.files.find((x) => x.path === 'src/sync/sync.service.ts')?.error).toBe('model unavailable');
  });

  it('skips a file the product would skip and says so', async () => {
    const run = await runSuite(review(new FakeLlm({})), loaded, 'fake-model', { ...options, maxFileChars: 300 });
    expect(run.bugs.every((x) => x.cause === 'file_skipped')).toBe(true);
    expect(run.metrics.detected).toBe(0);
  });

  it('stops instead of reporting a false 0% when the model never answers', async () => {
    const every = loaded.suite.files.map((x) => x.path);
    await expect(runSuite(review(new FakeLlm({}, every)), loaded, 'fake-model', options)).rejects.toThrow();
  });

  it('writes a report with every required part and compares with the previous run', async () => {
    const before = await runSuite(review(new FakeLlm({})), loaded, 'fake-model', { ...options, label: 'baseline' });
    const after = await runSuite(review(new FakeLlm(script)), loaded, 'fake-model', { ...options, label: 'after' });
    const c = compareRuns(after, before);
    expect(c.newlyDetected.sort()).toEqual(['AW-1', 'LE-1', 'SEC-1']);
    expect(c.newlyMissed).toEqual([]);
    const text = renderReport(after, before);
    for (const part of ['Planted bugs', 'Detection rate', 'False positives', 'Duplicate findings', 'Results by category', 'Missed bugs', 'Comparison with the previous run', 'Newly detected: AW-1, LE-1, SEC-1']) {
      expect(text).toContain(part);
    }
    expect(renderReport(before)).toContain('baseline');
    expect(renderReport(before)).toContain('No earlier run was found');
  });

  it('warns when two runs cannot be compared fairly', async () => {
    const a = await runSuite(review(new FakeLlm({})), loaded, 'model-a', { ...options, settings: { promptVersion: '1' } });
    const b = await runSuite(review(new FakeLlm({})), loaded, 'model-b', { ...options, settings: { promptVersion: '2' } });
    const w = compareRuns(b, a).warnings.join(' ');
    expect(w).toContain('model changed');
    expect(w).toContain('promptVersion');
  });
});

const fakeRun = (over: Partial<EvalRun> & { rate?: number | null; fpShare?: number | null; detected?: Record<string, boolean> } = {}): EvalRun => {
  const { rate = 60, fpShare = 10, detected = {}, ...rest } = over;
  return {
    id: '20260101-000000',
    label: 'x',
    startedAt: '2026-01-01T00:00:00.000Z',
    durationSeconds: 1,
    model: 'm',
    provider: 'p',
    suiteVersion: 2,
    settings: { split: 'all', promptVersion: 'a' },
    metrics: {
      planted: 10, detected: 6, missed: 4, detectionRate: rate, findingsTotal: 10, falsePositives: 1, duplicates: 0,
      falsePositiveShare: fpShare, cleanFiles: 2, cleanFilesFlagged: 0, cleanFileFlagRate: 0, detectedWithExactCategory: 6, byCategory: {},
    },
    bugs: Object.entries(detected).map(([id, d]) => ({ id, category: 'logic_error', path: 'f.ts', startLine: 1, endLine: 1, explanation: 'e', detected: d, duplicates: 0 })),
    falsePositives: [],
    files: [],
    ...rest,
  } as EvalRun;
};

describe('repeated runs', () => {
  const a = fakeRun({ rate: 50, detected: { 'A-1': true, 'A-2': false } });
  const b = fakeRun({ rate: 60, detected: { 'A-1': true, 'A-2': true } });
  const c = fakeRun({ rate: 70, detected: { 'A-1': true, 'A-2': false } });
  it('reports the mean, lowest and highest rate and how often each bug was found', () => {
    const r = aggregateRuns([c, a, b]);
    expect(r.repeat?.runs).toBe(3);
    expect(r.repeat?.meanDetectionRate).toBe(60);
    expect([r.repeat?.minDetectionRate, r.repeat?.maxDetectionRate]).toEqual([50, 70]);
    expect(r.repeat?.hits['A-1']).toBe(3);
    expect(r.repeat?.hits['A-2']).toBe(1);
  });
  it('uses the median run for the tables', () => {
    expect(aggregateRuns([c, a, b]).metrics.detectionRate).toBe(60);
  });
  it('shows the repeat section in the report', () => {
    const text = renderReport(aggregateRuns([c, a, b]));
    expect(text).toContain('Repeated runs (3)');
    expect(text).toContain('A-2 (1/3)');
  });
  it('refuses to combine nothing', () => {
    expect(() => aggregateRuns([])).toThrow();
  });
});

describe('regression gate', () => {
  const base = fakeRun({ rate: 60, fpShare: 10 });
  it('passes when nothing got worse', () => {
    expect(checkGate(fakeRun({ rate: 60, fpShare: 10 }), base).passed).toBe(true);
    expect(checkGate(fakeRun({ rate: 75, fpShare: 8 }), base).passed).toBe(true);
  });
  it('passes a drop inside the limit and fails one beyond it', () => {
    expect(checkGate(fakeRun({ rate: 57, fpShare: 10 }), base).passed).toBe(true);
    const r = checkGate(fakeRun({ rate: 56.9, fpShare: 10 }), base);
    expect(r.passed).toBe(false);
    expect(r.failures[0]).toContain('Detection rate fell');
  });
  it('fails when false positives rise too much', () => {
    expect(checkGate(fakeRun({ rate: 60, fpShare: 15 }), base).passed).toBe(true);
    expect(checkGate(fakeRun({ rate: 60, fpShare: 15.1 }), base).passed).toBe(false);
  });
  it('uses the limits it is given', () => {
    expect(checkGate(fakeRun({ rate: 55 }), base, { maxDetectionDrop: 10, maxFalsePositiveRise: 5 }).passed).toBe(true);
    expect(DEFAULT_LIMITS.maxDetectionDrop).toBe(3);
  });
  it('fails when the suite or the split differ, and when files could not be reviewed', () => {
    expect(checkGate(fakeRun({ suiteVersion: 3 }), base).passed).toBe(false);
    expect(checkGate(fakeRun({ settings: { split: 'tune', promptVersion: 'a' } }), base).passed).toBe(false);
    const broken = fakeRun({ files: [{ path: 'f.ts', clean: false, findings: 0, proposed: 0, error: 'boom' }] });
    expect(checkGate(broken, base).passed).toBe(false);
  });
  it('compares the mean when a run was repeated, and notes a changed prompt', () => {
    const repeated = aggregateRuns([fakeRun({ rate: 50, settings: { split: 'all', promptVersion: 'b' } }), fakeRun({ rate: 70, settings: { split: 'all', promptVersion: 'b' } })]);
    const r = checkGate(repeated, base);
    expect(r.passed).toBe(true);
    expect(r.notes.join(' ')).toContain('prompt differs');
  });
});
