import type { DiffFile, SkippedFile } from './diff.types.js';

const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.java', '.go',
  '.rb', '.php', '.cs', '.rs', '.kt', '.swift', '.sql',
  // Also read: UI frameworks, shell scripts, CI/config files and database schemas can hold real bugs.
  '.vue', '.svelte', '.sh', '.bash', '.yml', '.yaml', '.prisma', '.graphql', '.gql',
  '.c', '.cc', '.cpp', '.h', '.hpp', '.dart', '.scala', '.lua', '.tf',
]);
// Files with no extension that still hold logic.
const CODE_BASENAMES = new Set(['Dockerfile', 'Makefile']);

/** Could the AI review this file name at all? (Used to decide whether to fetch a file GitHub gave no diff for.) */
export function isCodeFile(filename: string): boolean {
  const base = filename.split('/').pop() ?? filename;
  const dot = base.lastIndexOf('.');
  const ext = dot >= 0 ? base.slice(dot).toLowerCase() : '';
  return (CODE_EXTENSIONS.has(ext) || CODE_BASENAMES.has(base)) && !LOCKFILES.has(base)
    && !/(^|\/)(generated|__generated__|dist|node_modules)\//.test(filename) && !filename.startsWith('build/')
    && !/\.generated\./.test(base) && !/\.min\.(js|css)$/.test(base);
}

const LOCKFILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml']);

export interface FilterResult {
  reviewable: DiffFile[];
  skipped: SkippedFile[];
}

/**
 * Decide which changed files the AI should read. Every skipped file is listed
 * with a reason, so the report never hides what was not reviewed.
 */
/**
 * Files that matter most are read first, so when the token budget runs out it is the docs and
 * helpers that are left out, not the login code. (GitHub lists files alphabetically.)
 */
const RISKY = /(auth|login|signin|signup|password|token|secret|crypto|payment|billing|session|security|permission|guard|middleware|jwt|oauth|webhook)/i;
const TESTISH = /(\.spec\.|\.test\.)|(^|\/)(test|tests|__tests__|docs?)\//;
export function riskOf(filename: string): number {
  return (RISKY.test(filename) ? 2 : 0) + (TESTISH.test(filename) ? -2 : 0);
}

export function filterFiles(
  files: DiffFile[],
  maxFileChars = 12_000,
  maxTotalChars = 40_000,
): FilterResult {
  const reviewable: DiffFile[] = [];
  const skipped: SkippedFile[] = [];
  let total = 0;

  const skip = (file: string, reason: string, coveredBy: string) =>
    skipped.push({ file, reason, coveredBy });

  const ordered = files.map((f, i) => ({ f, i })).sort((a, b) => riskOf(b.f.filename) - riskOf(a.f.filename) || a.i - b.i).map((x) => x.f);

  for (const f of ordered) {
    const base = f.filename.split('/').pop() ?? f.filename;
    const dot = base.lastIndexOf('.');
    const ext = dot >= 0 ? base.slice(dot).toLowerCase() : '';

    if (LOCKFILES.has(base)) {
      skip(f.filename, 'Lockfile written by a package manager, no logic', 'the dependency audit');
    } else if (/(^|\/)(generated|__generated__|dist|node_modules)\//.test(f.filename) || f.filename.startsWith('build/') || /\.generated\./.test(base)) {
      skip(f.filename, 'Generated file, a fix here would be overwritten', 'the source that generates it');
    } else if (/\.min\.(js|css)$/.test(base)) {
      skip(f.filename, 'Minified code', 'nothing, review the original source');
    } else if (!f.patch) {
      skip(f.filename, 'No diff available (binary file, or too large for GitHub to show)', 'nothing, review by hand');
    } else if (!CODE_EXTENSIONS.has(ext) && !CODE_BASENAMES.has(base)) {
      skip(f.filename, 'Not a source code file', 'nothing, it is not code');
    } else if (f.patch.length > maxFileChars) {
      skip(f.filename, 'Too big for the token budget', 'nothing, review by hand');
    } else if (total + f.patch.length > maxTotalChars) {
      skip(f.filename, 'Over the total token budget for this PR', 'nothing, review by hand');
    } else {
      total += f.patch.length;
      reviewable.push(f);
    }
  }
  return { reviewable, skipped };
}

/** Turn the output of `git diff` into the same shape GitHub gives us. */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  const chunks = text.split(/^diff --git /m).filter((c) => c.trim().length > 0);
  for (const chunk of chunks) {
    const firstLine = chunk.split('\n', 1)[0] ?? '';
    const match = / b\/(.+)$/.exec(firstLine);
    if (!match) continue;
    const at = chunk.indexOf('\n@@');
    const patch = at >= 0 ? chunk.slice(at + 1) : undefined;
    const lines = patch?.split('\n') ?? [];
    files.push({
      filename: match[1],
      status: 'modified',
      additions: lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length,
      deletions: lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length,
      patch,
    });
  }
  return files;
}
