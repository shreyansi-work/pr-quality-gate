import type { DiffFile } from '../github/diff.types.js';
import { normalize } from '../review/fingerprint.js';

/** What we know about the new push, collected by the worker after the review finished. */
export interface RecheckContext {
  /** Fingerprints the review (AI + rules) produced again on this push. */
  seen: Set<string>;
  /** Every file changed in the PR as of this push, by file name. */
  changed: Map<string, DiffFile>;
  /** Files the AI actually read this time (the others were skipped by the file filter). */
  reviewed: Set<string>;
  /**
   * Answers from asking the AI "is this problem still in the new code?", by fingerprint.
   * Only asked when the flagged line changed but the function around it is still in the diff.
   */
  answers?: Map<string, 'present' | 'gone'>;
}

export interface RecheckFinding {
  source: string;
  status: string; // NEW | ACCEPTED | HELD | REJECTED | GONE
  ticketState: string | null; // OPEN | NEEDS_LOOK | FIXED_AUTO | FIXED_MANUAL | null
  fingerprint: string;
  file: string;
  functionName: string | null;
  quote: string;
}

/** The fields to change on the finding. `null` from planRecheck means: leave it alone. */
export interface RecheckPatch {
  status?: 'NEW' | 'GONE';
  ticketState?: 'OPEN' | 'NEEDS_LOOK' | 'FIXED_AUTO';
  closedAt?: Date | null;
  closeReason?: string | null;
}

/**
 * Is this exact line still in the diff? Compared line by line, not as a substring:
 * `foo(x);` must NOT match `await foo(x);` (that is the fix for a missing await).
 */
export function lineStillThere(patch: string, quote: string): boolean {
  const q = normalize(quote);
  if (/\n/.test(quote.trim())) return normalize(patch).includes(q); // multi-line quote: fall back to substring
  return patch.split('\n').some((line) => {
    const body = line.startsWith('+') || line.startsWith(' ') ? line.slice(1) : line;
    return normalize(body) === q;
  });
}

type Verdict = { verdict: 'STILL_THERE' | 'FIXED' | 'UNSURE' | 'ASK'; reason: string };

/** Is the problem still in the code? Deterministic on purpose: no AI call, so no surprises. */
export function judge(f: RecheckFinding, ctx: RecheckContext): Verdict {
  if (ctx.seen.has(f.fingerprint)) {
    return { verdict: 'STILL_THERE', reason: 'Found again in the latest push' };
  }
  if (f.source === 'RULE') {
    return { verdict: 'FIXED', reason: 'The rule no longer fires (a test was added, or the source change is gone)' };
  }
  const file = ctx.changed.get(f.file);
  if (!file) {
    return { verdict: 'FIXED', reason: 'The file is no longer part of this PR' };
  }
  if (!file.patch) {
    return { verdict: 'UNSURE', reason: 'GitHub shows no diff for this file now, so it could not be checked' };
  }
  if (lineStillThere(file.patch, f.quote)) {
    return { verdict: 'STILL_THERE', reason: 'The flagged line is still in the code (the AI did not repeat it this time)' };
  }
  if (!ctx.reviewed.has(f.file)) {
    return { verdict: 'UNSURE', reason: 'The line changed, but this file was not reviewed this time (skipped by the file filter)' };
  }
  // The flagged line changed. Fixed, or only reworded (a renamed variable, a new comment)?
  // Only a re-read of the new code can tell, so ask the AI. This used to be skipped when the
  // finding had no function name, and then ANY edit of the line closed the ticket.
  const answer = ctx.answers?.get(f.fingerprint);
  if (answer === 'gone') return { verdict: 'FIXED', reason: 'The AI re-read the new code and the problem is gone' };
  if (answer === 'present') return { verdict: 'STILL_THERE', reason: 'The AI re-read the new code and the problem is still there' };
  const edited = f.functionName && hasWord(file.patch, f.functionName) ? ` and ${f.functionName}() was edited` : '';
  return {
    verdict: ctx.answers ? 'UNSURE' : 'ASK',
    reason: `The flagged line changed${edited}, and the AI could not confirm it is fixed. Please check it`,
  };
}

/** Whole-word search, so `login` does not match `loginPage`. */
function hasWord(text: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_$])${escaped}($|[^A-Za-z0-9_$])`).test(text);
}

const isClosed = (f: RecheckFinding) =>
  f.ticketState === 'FIXED_AUTO' || f.ticketState === 'FIXED_MANUAL' || f.ticketState === 'CLOSED_PR';

/** Does this finding need the AI to look at the new code before we can decide? */
export function needsAsk(f: RecheckFinding, ctx: RecheckContext): boolean {
  if (f.status === 'REJECTED' || f.status === 'GONE' || f.source === 'MANUAL' || isClosed(f)) return false;
  return judge(f, { ...ctx, answers: undefined }).verdict === 'ASK';
}

/** Decide what to do with one finding after a new push. */
export function planRecheck(f: RecheckFinding, ctx: RecheckContext, now = new Date()): RecheckPatch | null {
  if (f.status === 'REJECTED') return null; // you said it is not a problem: stay quiet
  if (f.source === 'MANUAL') return null; // a ticket you wrote yourself: only you close it

  const seen = ctx.seen.has(f.fingerprint);

  // Came back after being hidden.
  if (f.status === 'GONE') {
    return seen ? { status: 'NEW', closedAt: null, closeReason: null } : null;
  }

  // A closed ticket whose problem is back (a regression): reopen it.
  if (isClosed(f)) {
    return seen
      ? { ticketState: 'OPEN', closedAt: null, closeReason: 'Found again after the ticket was closed' }
      : null;
  }

  const judged = judge(f, ctx);
  const reason = judged.reason;
  const verdict = judged.verdict === 'ASK' ? 'UNSURE' : judged.verdict; // nobody answered: unsure

  // An open ticket.
  if (f.ticketState === 'OPEN' || f.ticketState === 'NEEDS_LOOK') {
    if (verdict === 'STILL_THERE') {
      return f.ticketState === 'NEEDS_LOOK' ? { ticketState: 'OPEN', closeReason: null } : null;
    }
    if (verdict === 'FIXED') return { ticketState: 'FIXED_AUTO', closedAt: now, closeReason: reason };
    return f.ticketState === 'OPEN' ? { ticketState: 'NEEDS_LOOK', closeReason: reason } : { closeReason: reason };
  }

  // Not triaged yet (status NEW): if it disappeared, hide it so you do not triage a ghost.
  if (f.status === 'NEW' && verdict === 'FIXED') {
    return { status: 'GONE', closedAt: now, closeReason: reason };
  }
  // Untriaged and the AI could not confirm the fix. The flagged line is no longer in the code and
  // the new review (which read the new code) did not report it again, so that is enough to hide it.
  // Nothing was accepted yet, so nobody is relying on it. (An accepted ticket stays "Needs a look".)
  if (f.status === 'NEW' && verdict === 'UNSURE') {
    const file = ctx.changed.get(f.file);
    if (file?.patch && ctx.reviewed.has(f.file) && !lineStillThere(file.patch, f.quote)) {
      return {
        status: 'GONE',
        closedAt: now,
        closeReason: 'The flagged line was changed and the new review did not report the problem again',
      };
    }
  }
  return null;
}
