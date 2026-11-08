export type Readiness = 'READY' | 'NOT_READY' | 'NEEDS_TRIAGE' | 'REVIEWING' | 'FAILED';

export interface ReadinessCounts {
  toTriage: number; // NEW findings waiting for you
  acceptedOpen: number; // accepted tickets that block the merge (open or "needs a look")
  held: number;
  needsLook: number;
  fixed: number;
  rejected: number;
}

interface RunLike {
  headSha: string;
  status: string;
}
interface FindingLike {
  status: string;
  ticketState: string | null;
}

/**
 * The run for the commit the pull request is on now. Runs are looked up by commit, not by creation
 * time: after a reset to an older commit the newest row belongs to the other commit, and the pull
 * request would stay on "Reviewing" for ever. With no run for this commit yet, the newest run is returned.
 */
export function pickRun<T extends RunLike>(headSha: string, runsNewestFirst: T[]): T | null {
  return runsNewestFirst.find((r) => r.headSha === headSha) ?? runsNewestFirst[0] ?? null;
}

export function countFindings(findings: FindingLike[]): ReadinessCounts {
  const c: ReadinessCounts = { toTriage: 0, acceptedOpen: 0, held: 0, needsLook: 0, fixed: 0, rejected: 0 };
  for (const f of findings) {
    if (f.status === 'NEW') c.toTriage++;
    else if (f.status === 'REJECTED') c.rejected++;
    else if (f.status === 'GONE') c.fixed++; // fixed before it was triaged
    else if (f.status === 'ACCEPTED' || f.status === 'HELD') {
      if (f.ticketState === 'FIXED_AUTO' || f.ticketState === 'FIXED_MANUAL' || f.ticketState === 'CLOSED_PR') c.fixed++;
      else {
        if (f.ticketState === 'NEEDS_LOOK') c.needsLook++;
        if (f.status === 'ACCEPTED') c.acceptedOpen++;
        else c.held++;
      }
    }
  }
  return c;
}

/**
 * Readiness is computed from the data every time, never stored,
 * so it cannot drift out of sync with the tickets.
 * `run` must be the newest run; if it is for an older commit we are still waiting for the new one.
 */
export function readinessOf(headSha: string, run: RunLike | null, findings: FindingLike[]) {
  const counts = countFindings(findings);
  let state: Readiness;
  if (!run || run.headSha !== headSha || run.status === 'QUEUED' || run.status === 'RUNNING' || run.status === 'SKIPPED') {
    state = 'REVIEWING';
  } else if (run.status === 'FAILED') {
    state = 'FAILED';
  } else if (counts.acceptedOpen > 0) {
    state = 'NOT_READY';
  } else if (counts.toTriage > 0) {
    state = 'NEEDS_TRIAGE';
  } else {
    state = 'READY';
  }
  return { state, counts };
}
