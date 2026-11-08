import { describe, expect, it } from 'vitest';
import type { DiffFile } from '../github/diff.types.js';
import { needsAsk, planRecheck, type RecheckContext, type RecheckFinding } from './recheck.js';
import { pickRun, readinessOf } from './readiness.js';
import { addedText, fingerprint, sameCode } from '../review/fingerprint.js';
import { MAX_FINDINGS_PER_FILE, parseProposed } from '../review/parse-findings.js';
import { filterFiles } from '../github/diff-filter.js';

const finding = (o: Partial<RecheckFinding> = {}): RecheckFinding => ({
  source: 'AI',
  status: 'ACCEPTED',
  ticketState: 'OPEN',
  fingerprint: 'fp1',
  file: 'a.ts',
  functionName: 'login',
  quote: 'const x = user.name',
  ...o,
});
const file = (patch?: string): DiffFile => ({ filename: 'a.ts', status: 'modified', additions: 1, deletions: 0, patch });
const ctx = (o: Partial<RecheckContext> = {}): RecheckContext => ({
  seen: new Set(),
  changed: new Map([['a.ts', file('@@\n+const  y = 1')]]),
  reviewed: new Set(['a.ts']),
  ...o,
});
const only = (f: DiffFile) => new Map([[f.filename, f]]);

describe('planRecheck: open tickets', () => {
  it('leaves a ticket alone when the review found it again', () => {
    expect(planRecheck(finding(), ctx({ seen: new Set(['fp1']) }))).toBeNull();
  });
  it('leaves it alone when the flagged line is still in the diff (AI just missed it)', () => {
    expect(planRecheck(finding(), ctx({ changed: only(file('@@\n+const   x = user.name')) }))).toBeNull();
  });
  it('does not mistake `await foo()` for the old `foo()` line (the fix for a missing await)', () => {
    const c = ctx({ changed: only(file('@@\n+await this.audit.log(user.id);')) });
    const f = finding({ quote: 'this.audit.log(user.id);', functionName: null });
    // the line changed: the AI is asked, it does not close by itself
    expect(needsAsk(f, c)).toBe(true);
    expect(planRecheck(f, { ...c, answers: new Map([['fp1', 'gone' as const]]) })?.ticketState).toBe('FIXED_AUTO');
  });
  it('does NOT close a ticket just because its line was edited (no function name, B2)', () => {
    const secret = finding({ quote: "const secret = 'dev-secret-123';", functionName: null });
    const c = ctx({ changed: only(file("@@\n+const secret = 'dev-secret-456';")) });
    expect(planRecheck(secret, c)?.ticketState).toBe('NEEDS_LOOK');
    expect(planRecheck(secret, { ...c, answers: new Map([['fp1', 'present' as const]]) })).toBeNull();
  });
  it('a comment added to the flagged line does not close it when the AI says it is still there', () => {
    const f = finding({ quote: 'const total = a / b;', functionName: null });
    const c = ctx({ changed: only(file('@@\n+const total = a / b; // TODO')), answers: new Map([['fp1', 'present' as const]]) });
    expect(planRecheck(f, c)).toBeNull();
  });
  it('a function with a similar name does not count as edited (whole word, B4)', () => {
    const f = finding({ functionName: 'login', quote: 'const x = a.b();' });
    const c = ctx({ changed: only(file('@@\n+const y = 1;\n // loginPage styles')), answers: new Map() });
    expect(planRecheck(f, c)?.closeReason).not.toContain('login() was edited');
  });
  it('closes it when the file left the PR', () => {
    expect(planRecheck(finding(), ctx({ changed: new Map() }))?.ticketState).toBe('FIXED_AUTO');
  });
  const reworded = { changed: only(file('@@\n+function login() {}')) };
  it('says "needs a look" when the line changed and nobody could confirm', () => {
    expect(planRecheck(finding(), ctx(reworded))?.ticketState).toBe('NEEDS_LOOK');
    expect(planRecheck(finding(), ctx({ ...reworded, answers: new Map() }))?.ticketState).toBe('NEEDS_LOOK');
  });
  it('asks the AI only in that case', () => {
    expect(needsAsk(finding(), ctx(reworded))).toBe(true);
    expect(needsAsk(finding({ functionName: null }), ctx(reworded))).toBe(true);
    expect(needsAsk(finding({ ticketState: 'OPEN', file: 'gone.ts' }), ctx(reworded))).toBe(false); // file left the PR: no question needed
    expect(needsAsk(finding({ ticketState: 'FIXED_AUTO' }), ctx(reworded))).toBe(false);
  });
  it('follows the AI answer: gone closes the ticket, present keeps it open', () => {
    const gone = new Map([['fp1', 'gone' as const]]);
    const present = new Map([['fp1', 'present' as const]]);
    expect(planRecheck(finding(), ctx({ ...reworded, answers: gone }))?.ticketState).toBe('FIXED_AUTO');
    expect(planRecheck(finding(), ctx({ ...reworded, answers: present }))).toBeNull();
  });
  it('says "needs a look" when the file was not reviewed this time', () => {
    expect(planRecheck(finding(), ctx({ reviewed: new Set() }))?.ticketState).toBe('NEEDS_LOOK');
  });
  it('says "needs a look" when GitHub gives no diff', () => {
    expect(planRecheck(finding(), ctx({ changed: only(file(undefined)) }))?.ticketState).toBe('NEEDS_LOOK');
  });
  it('re-checks held tickets too', () => {
    expect(planRecheck(finding({ status: 'HELD', functionName: null }), ctx({ answers: new Map([['fp1', 'gone' as const]]) }))?.ticketState).toBe('FIXED_AUTO');
  });
  it('moves "needs a look" back to open when the problem is found again', () => {
    expect(planRecheck(finding({ ticketState: 'NEEDS_LOOK' }), ctx({ seen: new Set(['fp1']) }))?.ticketState).toBe('OPEN');
  });
});

describe('planRecheck: rules, closed and rejected', () => {
  it('closes the "no tests" rule when it stops firing, keeps it while it fires', () => {
    expect(planRecheck(finding({ source: 'RULE' }), ctx())?.ticketState).toBe('FIXED_AUTO');
    expect(planRecheck(finding({ source: 'RULE' }), ctx({ seen: new Set(['fp1']) }))).toBeNull();
  });
  it('reopens a fixed ticket when the problem comes back', () => {
    expect(planRecheck(finding({ ticketState: 'FIXED_MANUAL' }), ctx({ seen: new Set(['fp1']) }))?.ticketState).toBe('OPEN');
    expect(planRecheck(finding({ ticketState: 'FIXED_AUTO' }), ctx())).toBeNull();
  });
  it('never touches tickets you created by hand', () => {
    expect(planRecheck(finding({ source: 'MANUAL', file: '', quote: '' }), ctx())).toBeNull();
  });
  it('reopens a ticket that was closed with its pull request when the problem is found again', () => {
    expect(planRecheck(finding({ ticketState: 'CLOSED_PR' }), ctx({ seen: new Set(['fp1']) }))?.ticketState).toBe('OPEN');
    expect(planRecheck(finding({ ticketState: 'CLOSED_PR' }), ctx())).toBeNull();
  });
  it('never touches rejected findings', () => {
    expect(planRecheck(finding({ status: 'REJECTED', ticketState: null }), ctx())).toBeNull();
  });
});

describe('planRecheck: findings nobody triaged yet', () => {
  it('hides a NEW finding whose line disappeared', () => {
    expect(planRecheck(finding({ status: 'NEW', ticketState: null, functionName: null }), ctx({ answers: new Map([['fp1', 'gone' as const]]) }))?.status).toBe('GONE');
  });
  it('hides a NEW finding when its line was changed and the new review did not report it again', () => {
    const f = finding({ status: 'NEW', ticketState: null, functionName: null });
    const patch = planRecheck(f, ctx({ answers: new Map() })); // AI gave no answer
    expect(patch?.status).toBe('GONE');
  });
  it('keeps a NEW finding when its line is still there, the AI says it is present, or the file was not reviewed', () => {
    const f = finding({ status: 'NEW', ticketState: null, functionName: null });
    expect(planRecheck(f, ctx({ changed: only(file('@@\n+const x = user.name')) }))).toBeNull();
    expect(planRecheck(f, ctx({ answers: new Map([['fp1', 'present' as const]]) }))).toBeNull();
    expect(planRecheck(f, ctx({ reviewed: new Set(), answers: new Map() }))).toBeNull();
  });
  it('an accepted ticket the AI could not confirm still goes to "Needs a look", not hidden', () => {
    expect(planRecheck(finding(), ctx({ answers: new Map() }))?.ticketState).toBe('NEEDS_LOOK');
  });
  it('brings a hidden finding back if it returns', () => {
    expect(planRecheck(finding({ status: 'GONE', ticketState: null }), ctx({ seen: new Set(['fp1']) }))?.status).toBe('NEW');
  });
});

describe('pickRun', () => {
  it('uses the run of the current commit, even when a newer run for another commit exists (B7)', () => {
    const runs = [{ headSha: 'B', status: 'DONE' }, { headSha: 'A', status: 'DONE' }];
    expect(pickRun('A', runs)?.headSha).toBe('A');
    expect(readinessOf('A', pickRun('A', runs), []).state).toBe('READY');
    expect(pickRun('C', runs)?.headSha).toBe('B'); // nothing for this commit yet: fall back to the newest
  });
});

describe('readinessOf', () => {
  const run = (status: string, headSha = 'h') => ({ headSha, status });
  it('is REVIEWING until the run for the newest commit is done', () => {
    expect(readinessOf('h', null, []).state).toBe('REVIEWING');
    expect(readinessOf('h', run('DONE', 'older'), []).state).toBe('REVIEWING');
    expect(readinessOf('h', run('RUNNING'), []).state).toBe('REVIEWING');
  });
  it('is FAILED when the run failed', () => {
    expect(readinessOf('h', run('FAILED'), []).state).toBe('FAILED');
  });
  it('is READY with no accepted tickets open and nothing to triage', () => {
    const findings = [
      { status: 'HELD', ticketState: 'OPEN' },
      { status: 'REJECTED', ticketState: null },
      { status: 'ACCEPTED', ticketState: 'FIXED_AUTO' },
      { status: 'ACCEPTED', ticketState: 'CLOSED_PR' },
      { status: 'GONE', ticketState: null },
    ];
    expect(readinessOf('h', run('DONE'), findings).state).toBe('READY');
  });
  it('is NEEDS_TRIAGE while a NEW finding waits', () => {
    expect(readinessOf('h', run('DONE'), [{ status: 'NEW', ticketState: null }]).state).toBe('NEEDS_TRIAGE');
  });
  it('is NOT_READY while an accepted ticket is open or needs a look', () => {
    expect(readinessOf('h', run('DONE'), [{ status: 'ACCEPTED', ticketState: 'OPEN' }, { status: 'NEW', ticketState: null }]).state).toBe('NOT_READY');
    expect(readinessOf('h', run('DONE'), [{ status: 'ACCEPTED', ticketState: 'NEEDS_LOOK' }]).state).toBe('NOT_READY');
  });
});

describe('finding identity (B3)', () => {
  it('does not change when the model words the category or function differently', () => {
    const a = fingerprint('async_await', 'LoginPage.tsx', 'onSubmit', 'const { data } = authApi.login(values)');
    const b = fingerprint('missing_await', 'LoginPage.tsx', undefined, 'const  { data } =  authApi.login(values)');
    expect(a).toBe(b);
  });
  it('differs for another file or other code', () => {
    expect(fingerprint('x', 'a.ts', undefined, 'foo(1)')).not.toBe(fingerprint('x', 'b.ts', undefined, 'foo(1)'));
    expect(fingerprint('x', 'a.ts', undefined, 'foo(1)')).not.toBe(fingerprint('x', 'a.ts', undefined, 'foo(2)'));
  });
  it('treats a longer or shorter quote of the same code as the same code', () => {
    expect(sameCode('const { data } = authApi.login(values)', 'authApi.login(values)')).toBe(true);
    expect(sameCode('foo()', 'foo()')).toBe(true);
    expect(sameCode('authApi.login(values)', 'authApi.register(values)')).toBe(false);
    expect(sameCode('a', 'abc')).toBe(false); // too short to compare
  });
});

describe('added lines only (B14)', () => {
  it('addedText has only the "+" lines', () => {
    const t = addedText('@@ -1,3 +1,3 @@\n unchanged();\n-removed();\n+added(1);');
    expect(t).toContain('added(1);');
    expect(t).not.toContain('unchanged');
    expect(t).not.toContain('removed');
  });
});

describe('parseProposed (B15, B20, B21)', () => {
  const item = (i: number, extra: object = {}) => ({ category: 'c' + i, quote: 'line number ' + i, message: 'm' + i, ...extra });
  it('keeps up to the per-file limit', () => {
    const out = parseProposed(JSON.stringify({ findings: Array.from({ length: MAX_FINDINGS_PER_FILE + 5 }, (_, i) => item(i)) }));
    expect(out).toHaveLength(MAX_FINDINGS_PER_FILE);
  });
  it('drops an invalid confidence and keeps a valid one in lower case', () => {
    const [a, b] = parseProposed(JSON.stringify({ findings: [item(1, { confidence: 'banana' }), item(2, { confidence: 'HIGH' })] }));
    expect(a.confidence).toBeUndefined();
    expect(b.confidence).toBe('high');
  });
  it('keeps a leading "+" of the quote (the review step decides)', () => {
    expect(parseProposed(JSON.stringify({ findings: [item(1, { quote: '+counter++;' })] }))[0].quote).toBe('+counter++;');
  });
});

describe('filterFiles (B16, B17, B18)', () => {
  const mk = (name: string, len = 20): DiffFile => ({ filename: name, status: 'modified', additions: 1, deletions: 0, patch: '@@\n+' + 'x'.repeat(len) });
  it('reads a src/build folder, Vue, YAML, shell and Prisma files', () => {
    const { reviewable } = filterFiles([mk('src/build/utils.ts'), mk('src/App.vue'), mk('.github/workflows/ci.yml'), mk('deploy.sh'), mk('prisma/schema.prisma')]);
    expect(reviewable).toHaveLength(5);
  });
  it('still skips real build output and generated code', () => {
    const { reviewable, skipped } = filterFiles([mk('build/out.js'), mk('src/generated/x.ts'), mk('dist/a.js')]);
    expect(reviewable).toHaveLength(0);
    expect(skipped).toHaveLength(3);
  });
  it('spends the token budget on login/auth code before docs and tests', () => {
    const { reviewable, skipped } = filterFiles([mk('a-helper.ts', 11900), mk('b-helper.ts', 11900), mk('c-helper.ts', 11900), mk('z-auth-login.ts', 11000)]);
    expect(reviewable.map((f) => f.filename)).toContain('z-auth-login.ts');
    expect(skipped.some((s) => s.file === 'c-helper.ts')).toBe(true);
  });
});
