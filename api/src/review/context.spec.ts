import { describe, expect, it } from 'vitest';
import { needsContext, patchForRecheck, pickChunk, splitPatch, trimContext } from './context.js';
import { addedText } from './fingerprint.js';
import { buildReviewUser, buildVerifyUser } from './prompts.js';

const added = (n: number, prefix = 'const a') => Array.from({ length: n }, (_, i) => `+${prefix}${i} = ${i};`).join('\n');

describe('splitPatch', () => {
  it('leaves a small diff alone', () => {
    expect(splitPatch('@@ -1 +1 @@\n+x', 1000)).toEqual(['@@ -1 +1 @@\n+x']);
  });
  it('cuts a big brand new file (one hunk) between lines and loses no added line', () => {
    const patch = `@@ -0,0 +1,300 @@\n${added(300)}`;
    const pieces = splitPatch(patch, 1500);
    expect(pieces.length > 1).toBe(true);
    for (const p of pieces) expect(p.length <= 1600).toBe(true);
    // every added line of the original appears in exactly the pieces together
    expect(addedText(pieces.join('\n'))).toBe(addedText(patch));
  });
  it('cuts at hunk borders and packs small hunks together', () => {
    const hunk = (i: number) => `@@ -${i},2 +${i},3 @@\n+line ${i}\n context`;
    const patch = [1, 20, 40, 60].map(hunk).join('\n');
    const pieces = splitPatch(patch, 70);
    expect(pieces.length > 1).toBe(true);
    expect(pieces.every((p) => p.startsWith('@@'))).toBe(true);
    expect(addedText(pieces.join('\n'))).toBe(addedText(patch));
  });
  it('cuts one enormous line (minified code) so no piece is far over the limit', () => {
    const patch = `@@ -0,0 +1 @@\n+${'x'.repeat(5000)}`;
    const pieces = splitPatch(patch, 1000);
    expect(pieces.length >= 5).toBe(true);
    expect(pieces.every((p) => p.length <= 1100)).toBe(true);
  });
  it('limit 0 means no cutting', () => {
    expect(splitPatch(`@@\n${added(500)}`, 0)).toHaveLength(1);
  });
});

describe('pickChunk', () => {
  it('returns the piece that holds the quote', () => {
    const patch = `@@ -0,0 +1,300 @@\n${added(300)}`;
    const piece = pickChunk(patch, 'const a250 = 250;', 1500);
    expect(piece).toContain('const a250 = 250;');
    expect(piece.length <= 1600).toBe(true);
  });
  it('picks the piece that shares most names with an edited quote (the re-check case)', () => {
    const lines = Array.from({ length: 300 }, (_, i) => `+const a${i} = ${i};`);
    lines[250] = '+passwordResetExpires: new Date(Date.now() + ttlMinutes * 60 * 1000),';
    const patch = `@@ -0,0 +1,300 @@\n${lines.join('\n')}`;
    const piece = pickChunk(patch, 'passwordResetExpires: new Date(Date.now() + ttlMinutes * 60),', 1500);
    expect(piece).toContain('ttlMinutes * 60 * 1000');
  });
  it('falls back to the first piece when the quote is not found', () => {
    const patch = `@@ -0,0 +1,300 @@\n${added(300)}`;
    expect(pickChunk(patch, 'nothing like this', 1500)).toContain('const a0 = 0;');
  });
});

describe('patchForRecheck', () => {
  const patch = [
    '@@ -118,8 +118,8 @@ async validateCredentials',
    '     if (!user) {',
    '-    const passwordMatches = bcrypt.compare(',
    '+    const passwordMatches = await bcrypt.compare(',
    '       dto.password,',
    '@@ -210,4 +210,4 @@ requestPasswordReset',
    '-    const brace = {',
    '+    const brace = {',
  ].join('\n');

  it('drops the removed line so the old quote is not shown as current code', () => {
    const view = patchForRecheck(patch, 'const passwordMatches = bcrypt.compare(', 12_000);
    expect(view).toContain('await bcrypt.compare(');
    expect(view).not.toContain('-    const passwordMatches = bcrypt.compare(');
    expect(view).not.toContain('const passwordMatches = bcrypt.compare(');
  });

  it('keeps the hunk that held the old quote when the diff is split', () => {
    const view = patchForRecheck(patch, 'const passwordMatches = bcrypt.compare(', 220);
    expect(view).toContain('await bcrypt.compare(');
    expect(view).not.toContain('const brace');
  });

  it('does not show another function that still uses the same name', () => {
    const filler = Array.from({ length: 30 }, (_, i) => ` other${i}();`).join('\n');
    const wide = [
      '@@ -35,6 +35,6 @@ async register',
      '   async register(dto: RegisterDto) {',
      '-    const email = dto.email.trim();',
      '+    const email = dto.email.toLowerCase().trim();',
      '     const existing = await this.usersService.findByEmail(email);',
      filler,
      '@@ -120,4 +120,4 @@ async validateCredentials',
      '     const user = await this.usersService.findByEmail(dto.email);',
    ].join('\n');
    const view = patchForRecheck(wide, 'const email = dto.email.trim();', 12_000);
    expect(view).toContain('toLowerCase().trim()');
    expect(view).toContain('async register');
    expect(view).not.toContain('findByEmail(dto.email)');
    expect(view).not.toContain('const email = dto.email.trim()');
  });
});

describe('trimContext', () => {
  it('returns the file when it fits', () => {
    expect(trimContext('a\nb', 100)).toBe('a\nb');
  });
  it('cuts at a line border and says how much is missing', () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
    const out = trimContext(text, 200);
    expect(out).toContain('more lines not shown');
    expect(out.length < 260).toBe(true);
    expect(out.startsWith('line 0')).toBe(true);
  });
  it('is empty when switched off or empty', () => {
    expect(trimContext('abc', 0)).toBe('');
    expect(trimContext('   \n', 100)).toBe('');
  });
});

describe('needsContext', () => {
  it('skips new files, whose diff already is the whole file', () => {
    expect(needsContext('added')).toBe(false);
    expect(needsContext('removed')).toBe(false);
    expect(needsContext('modified')).toBe(true);
    expect(needsContext('renamed')).toBe(true);
  });
});

describe('prompts', () => {
  it('adds the full file only when there is context', () => {
    expect(buildReviewUser('a.ts', '+x')).toBe('File: a.ts\n\nDiff:\n+x');
    const withCtx = buildReviewUser('a.ts', '+x', 'full text');
    expect(withCtx).toContain('Full file after this change');
    expect(withCtx).toContain('full text');
    expect(withCtx).toContain('Diff (report problems only');
  });
  it('the verify prompt works with and without context', () => {
    expect(buildVerifyUser('a.ts', '+x', 'x', 'bad')).toContain('Claimed problem line: x');
    expect(buildVerifyUser('a.ts', '+x', 'x', 'bad', 'ctx')).toContain('ctx');
  });
});

import { patchFromContent } from './context.js';
import { REVIEW_SYSTEM, VERIFY_SYSTEM } from './prompts.js';

describe('patchFromContent', () => {
  it('turns a whole file into an all-added diff', () => {
    expect(patchFromContent('a\nb\n')).toBe('@@ -0,0 +1,2 @@\n+a\n+b');
    expect(addedText(patchFromContent('const x = 1;\nreturn x;'))).toBe('const x = 1; return x;');
  });
});

describe('review prompt', () => {
  it('no longer limits the review to a short list of categories', () => {
    expect(REVIEW_SYSTEM.includes('Check ONLY')).toBe(false);
    for (const c of ['resource_leak', 'race_condition', 'logic_error', 'infinite_loop', 'data_loss', 'security_vulnerability', 'authorization_error', 'database_error', 'input_validation', 'transaction_error', 'exception_handling', 'duplicate_operation', 'integration_error', 'other']) expect(REVIEW_SYSTEM).toContain(c);
  });
  it('tells the model to review every line of a new file', () => {
    expect(REVIEW_SYSTEM).toContain('brand new file');
  });
  it('the verify step only drops a finding it can rule out', () => {
    expect(VERIFY_SYSTEM).toContain('cannot rule it out');
  });
});
