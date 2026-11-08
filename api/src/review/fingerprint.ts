import { createHash } from 'node:crypto';

/** Collapse all whitespace so formatting changes do not change identity. */
export const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim();

/**
 * A finding's identity: file + normalized quoted code.
 * NOT the line number (lines move on every push), and NOT the category or function name:
 * the model words those differently from run to run, and that used to create duplicates
 * of a problem you had already decided on. The parameters stay so callers do not change.
 */
export function fingerprint(
  _category: string,
  file: string,
  _functionName: string | undefined,
  quote: string,
): string {
  return createHash('sha256')
    .update([file, normalize(quote)].join('|'))
    .digest('hex')
    .slice(0, 16);
}

/** Do two quotes from the same file point at the same code? One may be a part of the other. */
export function sameCode(a: string, b: string): boolean {
  const x = normalize(a);
  const y = normalize(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 12 && long.includes(short);
}

/**
 * The code as it is after the change: every line of the diff that was not removed
 * (added lines and unchanged lines), whitespace collapsed.
 */
export function currentCode(patch: string): string {
  return normalize(
    patch
      .split('\n')
      .filter((l) => !l.startsWith('-') && !l.startsWith('@@') && !l.startsWith('\\'))
      .map((l) => (l.startsWith('+') || l.startsWith(' ') ? l.slice(1) : l))
      .join('\n'),
  );
}

/**
 * Is the code an old finding pointed at still in the new diff? With no diff to look at (unknown) the answer
 * is "yes", which keeps the old behaviour. When the line was edited the answer is "no": a new finding that only
 * looks similar to it is then a different problem, not the old one coming back.
 */
export function quoteStillInCode(patch: string | undefined, quote: string): boolean {
  if (!patch || !patch.trim()) return true;
  const q = normalize(quote);
  return q === '' || currentCode(patch).includes(q);
}

/** The text of the added lines ("+" lines) of a diff, whitespace collapsed. */
export function addedText(patch: string): string {
  return normalize(
    patch
      .split('\n')
      .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
      .map((l) => l.slice(1))
      .join('\n'),
  );
}
