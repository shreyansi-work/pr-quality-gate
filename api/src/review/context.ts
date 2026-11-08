import { normalize } from './fingerprint.js';

/**
 * Helpers that decide WHAT the model gets to read. No network, no database, so they are easy to test.
 */

/** A hunk header line, for example "@@ -10,6 +10,9 @@ function name". */
const HUNK = /^@@ /m;

/**
 * Cut a diff into pieces of at most maxChars, so a big file is reviewed in several calls
 * instead of being skipped. Pieces start at hunk borders when they can. A single hunk that is
 * bigger than maxChars (a brand new file is ONE hunk) is cut between lines.
 * Every piece keeps its "+" lines exactly as they were, so the quote check still works.
 */
export function splitPatch(patch: string, maxChars: number): string[] {
  if (maxChars <= 0 || patch.length <= maxChars) return [patch];

  // 1. hunks
  const hunks: string[] = [];
  const marks = [...patch.matchAll(new RegExp(HUNK.source, 'gm'))].map((m) => m.index ?? 0);
  if (marks.length === 0 || marks[0] !== 0) marks.unshift(0);
  marks.forEach((start, i) => {
    const piece = patch.slice(start, marks[i + 1] ?? patch.length);
    if (piece.trim()) hunks.push(piece);
  });

  // 2. a hunk that is still too big is cut between lines, and each part gets a small header
  const parts: string[] = [];
  for (const hunk of hunks) {
    if (hunk.length <= maxChars) { parts.push(hunk); continue; }
    const lines = hunk.split('\n');
    let cur: string[] = [];
    let len = 0;
    const flush = () => { if (cur.length) { parts.push(cur.join('\n')); cur = []; len = 0; } };
    for (const line of lines) {
      // a single huge line (minified code) is cut as well, so a piece never goes far over the limit
      const pieces = line.length > maxChars ? line.match(new RegExp(`.{1,${maxChars}}`, 'gs')) ?? [line] : [line];
      for (const p of pieces) {
        if (len + p.length + 1 > maxChars) flush();
        cur.push(p);
        len += p.length + 1;
      }
    }
    flush();
  }

  // 3. pack small neighbours together so we do not make a model call for every tiny hunk
  const out: string[] = [];
  let acc = '';
  for (const p of parts) {
    if (acc && acc.length + p.length + 1 > maxChars) { out.push(acc); acc = ''; }
    acc = acc ? `${acc}\n${p}` : p;
  }
  if (acc) out.push(acc);
  return out;
}

/**
 * Drop removed lines. The old quote usually sits on a "-" line next to the fix, and the
 * re-check model treats that deleted line as proof the problem is still there.
 * "---" is a file header, not a removed line.
 */
export function withoutRemovedLines(patch: string): string {
  return patch
    .split('\n')
    .filter((line) => !(line.startsWith('-') && !line.startsWith('---')))
    .join('\n');
}

/**
 * The few lines around the old quote. A short file still fits in one chunk, and that chunk
 * contains other functions. Those were making the model keep a fixed line open because
 * some other function still used the same name (dto.email in login, after register was fixed).
 * The hunk header is kept even when it sits above the window.
 */
export function windowAroundQuote(patch: string, quote: string, radius = 8): string {
  const lines = patch.split('\n');
  const q = normalize(quote);
  if (q.length < 6) return patch;
  let at = -1;
  let best = 0;
  lines.forEach((line, i) => {
    const raw = line.startsWith('+') || line.startsWith('-') || line.startsWith(' ') ? line.slice(1) : line;
    const body = normalize(raw);
    let score = body === q ? 4 : body.includes(q) ? 2 : 0;
    if (score === 0) return;
    if (line.startsWith('-') && !line.startsWith('---')) score += 1;
    if (score > best) { at = i; best = score; }
  });
  if (at < 0) return patch;
  const start = Math.max(0, at - radius);
  const end = Math.min(lines.length, at + radius + 1);
  const slice = lines.slice(start, end);
  let headerAt = -1;
  for (let i = at; i >= 0; i--) if (lines[i].startsWith('@@')) { headerAt = i; break; }
  if (headerAt >= 0 && headerAt < start) slice.unshift(lines[headerAt]);
  return slice.join('\n');
}

/**
 * What the re-check model is allowed to see: the lines around the old quote,
 * with removed lines taken out.
 */
export function patchForRecheck(patch: string, quote: string, maxChars: number): string {
  return withoutRemovedLines(windowAroundQuote(pickChunk(patch, quote, maxChars), quote));
}

/** The piece of a diff that holds the quote (used by the re-check, which must not send a huge diff). */
export function pickChunk(patch: string, quote: string, maxChars: number): string {
  const pieces = splitPatch(patch, maxChars);
  if (pieces.length === 1) return pieces[0];
  const q = normalize(quote);
  if (q.length >= 6) {
    const hit = pieces.find((p) => normalize(p).includes(q));
    if (hit) return hit;
  }
  // The quote is not in the new diff (the line was edited, which is what the re-check asks about).
  // Take the piece that shares most names with it, instead of always the first piece.
  const qWords = identifiers(quote);
  if (qWords.size > 0) {
    let best = pieces[0];
    let bestScore = 0;
    for (const p of pieces) {
      const pWords = identifiers(p);
      let score = 0;
      for (const w of qWords) if (pWords.has(w)) score++;
      if (score > bestScore) { best = p; bestScore = score; }
    }
    return best;
  }
  return pieces[0];
}

/** The names (words of 3+ characters) used in some code. */
function identifiers(text: string): Set<string> {
  return new Set(text.match(/[A-Za-z_$][\w$]{2,}/g) ?? []);
}

/**
 * The full file as context, cut at a line border when it is too long.
 * Returns '' when the context is switched off (maxChars <= 0) or there is nothing to show.
 */
export function trimContext(content: string, maxChars: number): string {
  if (maxChars <= 0 || !content.trim()) return '';
  if (content.length <= maxChars) return content;
  const cut = content.lastIndexOf('\n', maxChars);
  const kept = content.slice(0, cut > 0 ? cut : maxChars);
  const hidden = content.slice(kept.length).split('\n').length - 1;
  return `${kept}\n[... ${hidden} more lines not shown ...]`;
}

/** Added files already ARE their diff, so sending the file again would only cost tokens. */
export const needsContext = (status: string) => status !== 'added' && status !== 'removed';

/**
 * GitHub sends no diff for a very large change. For a NEW file the whole file is the change, so we
 * build the diff ourselves: every line is an added line. (For a modified file we cannot know which
 * lines changed, so the whole file is reviewed as if it were new. That is more than needed, never less.)
 */
export function patchFromContent(content: string): string {
  const text = content.endsWith('\n') ? content.slice(0, -1) : content;
  const lines = text.split('\n');
  return `@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}`;
}
