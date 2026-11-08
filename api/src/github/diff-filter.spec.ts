import { describe, expect, it } from 'vitest';
import { filterFiles, isCodeFile } from './diff-filter.js';
import type { DiffFile } from './diff.types.js';

const file = (filename: string, patch: string | undefined, status = 'modified'): DiffFile => ({ filename, status, additions: 1, deletions: 0, patch });
const body = (n: number) => `@@ -0,0 +1,${n} @@\n${Array.from({ length: n }, (_, i) => `+const v${i} = ${i};`).join('\n')}`;

describe('which files the AI reads', () => {
  it('reads normal code, Dockerfile and Terraform', () => {
    expect(isCodeFile('src/app.ts')).toBe(true);
    expect(isCodeFile('docker/Dockerfile')).toBe(true);
    expect(isCodeFile('infra/main.tf')).toBe(true);
  });
  it('does not read lock files, generated code or minified files', () => {
    expect(isCodeFile('package-lock.json')).toBe(false);
    expect(isCodeFile('src/generated/client.ts')).toBe(false);
    expect(isCodeFile('public/app.min.js')).toBe(false);
    expect(isCodeFile('logo.png')).toBe(false);
  });
});

describe('filterFiles', () => {
  it('reviews a new file', () => {
    const r = filterFiles([file('src/new.ts', body(20), 'added')]);
    expect(r.reviewable).toHaveLength(1);
    expect(r.skipped).toHaveLength(0);
  });
  it('reviews a Dockerfile', () => {
    expect(filterFiles([file('Dockerfile', body(5), 'added')]).reviewable).toHaveLength(1);
  });
  it('a file over the old 12,000 limit is skipped by default but kept with a higher limit', () => {
    const big = file('src/big.ts', body(900), 'added'); // about 20,000 characters
    expect(filterFiles([big]).reviewable).toHaveLength(0);
    expect(filterFiles([big], 36_000, 80_000).reviewable).toHaveLength(1);
  });
  it('still skips a file with no diff at all (binary)', () => {
    const r = filterFiles([file('src/x.ts', undefined)]);
    expect(r.reviewable).toHaveLength(0);
    expect(r.skipped).toHaveLength(1);
  });
  it('puts risky files first when the budget is small', () => {
    const r = filterFiles([file('src/aaa.ts', body(200)), file('src/auth/login.ts', body(200))], 36_000, 5_000);
    expect(r.reviewable[0].filename).toBe('src/auth/login.ts');
  });
});
