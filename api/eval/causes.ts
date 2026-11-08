import { addedText, normalize } from '../src/review/fingerprint.js';
import { categoryFits } from './match.js';
import { LINE_TOLERANCE } from './match.js';
import type { FileRun, LocatedBug, MissCause } from './types.js';

const near = (line: number | null, bug: LocatedBug) =>
  line !== null && line >= bug.startLine - LINE_TOLERANCE && line <= bug.endLine + LINE_TOLERANCE;

/**
 * Why a planted bug was not reported. Read from what the pipeline recorded, in the order the pipeline works:
 * filter -> sent to the model -> proposed -> evidence check -> second check -> cap.
 * `bugLine` is the text of the bug's first line.
 */
export function explainMiss(bug: LocatedBug, bugLine: string, run: FileRun | undefined): { cause: MissCause; detail: string } {
  if (!run) return { cause: 'review_aborted', detail: 'The file was not reviewed in this run.' };
  if (run.skippedReason) return { cause: 'file_skipped', detail: `The file filter skipped it: ${run.skippedReason}.` };
  if (run.error) return { cause: 'review_aborted', detail: `The review of this file failed: ${run.error}` };

  const wanted = normalize(bugLine);
  const sent = run.pieces.some((p) => addedText(p).includes(wanted));
  if (!sent) return { cause: 'code_not_sent', detail: 'The line of the bug was in none of the pieces sent to the model (cut by a size limit).' };

  const dropped = run.dropped.filter((d) => near(d.startLine, bug));
  const noEvidence = dropped.find((d) => d.reason === 'no_evidence');
  if (noEvidence) return { cause: 'dropped_no_evidence', detail: `The model proposed it, but the evidence check removed it (quote "${noEvidence.quote.slice(0, 60)}" is not on an added line).` };
  const verifyDrop = dropped.find((d) => d.reason === 'verify');
  if (verifyDrop) return { cause: 'dropped_by_verify', detail: `The model proposed it and the second check said it is not a real problem (quote "${verifyDrop.quote.slice(0, 60)}").` };

  const wrong = run.proposed.find((p) => near(p.startLine, bug) && !categoryFits(p.category, bug.category).fits);
  if (wrong) return { cause: 'wrong_issue_same_place', detail: `The model reported something else on these lines (${wrong.category}: ${wrong.message.slice(0, 80)}).` };

  if (run.cappedCount > 0) return { cause: 'cut_by_cap', detail: `${run.cappedCount} proposed finding(s) of this file were cut by the per-file limit; the bug may be among them.` };
  return { cause: 'not_proposed', detail: 'The code was sent and nothing was proposed for these lines: the model looked at it and did not see the problem.' };
}
