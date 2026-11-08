import { Fragment } from 'react';
import type { CiCheck, Pull } from '../types';
import { ago, base, plural, short, titleCase } from '../lib/format';
import { Icon } from './Icon';

// The pipeline: Push > Checks > AI review > Your triage > Gate

export type StageState = 'done' | 'current' | 'fail' | 'wait' | 'skip' | 'open' | 'closed';
export type StageKey = 'push' | 'checks' | 'ai' | 'triage' | 'gate';
export interface Stage { key: StageKey; label: string; state: StageState; sub: string; meta?: string; busy?: boolean }

export function checkInfo(pr: Pull) {
  const list: CiCheck[] = Array.isArray(pr.run?.ciSummary) ? pr.run!.ciSummary! : [];
  const bad = list.filter((k) => k.conclusion && !['success', 'neutral', 'skipped'].includes(k.conclusion));
  const wait = list.filter((k) => !k.conclusion);
  return { list, bad, wait };
}

export function stagesOf(pr: Pull): Stage[] {
  const c = pr.counts;
  const total = c.toTriage + c.acceptedOpen + c.held + c.fixed + c.rejected;
  const { list, bad, wait } = checkInfo(pr);
  const ended = !!pr.prState && pr.prState !== 'open';
  const reviewing = pr.readiness === 'REVIEWING';
  const failed = pr.readiness === 'FAILED';

  const checks: Pick<Stage, 'state' | 'sub'> =
    reviewing && list.length === 0 ? { state: 'wait', sub: 'Waiting' }
    : list.length === 0 ? { state: 'skip', sub: 'None reported' }
    : bad.length ? { state: 'fail', sub: `${bad.length} failed` }
    : wait.length ? { state: 'current', sub: 'Running' }
    : { state: 'done', sub: `${list.length} passed` };
  const ai: Omit<Stage, 'key' | 'label'> = reviewing
    ? { state: 'current', sub: !pr.run || pr.run.status === 'QUEUED' ? 'Queued' : 'Reviewing', busy: true }
    : failed ? { state: 'fail', sub: 'Failed' }
    : { state: 'done', sub: plural(total, 'finding'), meta: pr.run?.model ? base(pr.run.model) : '' };
  const decided = total - c.toTriage;
  const triage: Pick<Stage, 'state' | 'sub' | 'meta'> =
    reviewing || failed ? { state: 'wait', sub: 'Waiting' }
    : c.toTriage > 0 ? { state: 'current', sub: `${c.toTriage} to decide`, meta: `${decided} of ${total} done` }
    : { state: 'done', sub: total === 0 ? 'Nothing to decide' : 'All decided' };
  let gate: Pick<Stage, 'state' | 'sub' | 'meta'>;
  if (ended) gate = { state: 'wait', sub: titleCase(pr.prState!) };
  else if (pr.readiness === 'READY') gate = { state: 'open', sub: 'Open' };
  else if (pr.readiness === 'NOT_READY') gate = { state: 'closed', sub: 'Closed', meta: `${plural(c.acceptedOpen, 'ticket')} open` };
  else if (failed) gate = { state: 'fail', sub: 'Review failed' };
  else gate = { state: 'wait', sub: reviewing ? 'Waiting' : 'Not yet' };

  return [
    { key: 'push', label: 'Push', state: 'done', sub: ago(pr.run?.startedAt ?? pr.updatedAt ?? Date.now()), meta: short(pr.headSha) },
    { key: 'checks', label: 'Checks', ...checks },
    { key: 'ai', label: 'AI review', ...ai },
    { key: 'triage', label: 'Your triage', ...triage },
    { key: 'gate', label: 'Gate', ...gate },
  ];
}

const DONE_LIKE: StageState[] = ['done', 'skip', 'open'];

function Node({ s }: { s: Stage }) {
  return (
    <span className={`node ${s.state}`}>
      {s.key === 'gate' ? <Icon name={s.state === 'open' ? 'unlock' : s.state === 'fail' ? 'cross' : 'lock'} />
        : s.state === 'done' ? <Icon name="check" />
        : s.state === 'fail' ? <Icon name="cross" />
        : s.state === 'current' ? (s.busy ? <Icon name="spin" className="spin" /> : <Icon name="clock" />)
        : s.state === 'skip' ? <Icon name="dash" /> : null}
    </span>
  );
}

export function Rail({ stages, active, onPick }: { stages: Stage[]; active: StageKey | null; onPick: (k: StageKey) => void }) {
  return (
    <ol className="rail" aria-label="Pipeline">
      {stages.map((s, i) => {
        const prevDone = i > 0 && DONE_LIKE.includes(stages[i - 1].state);
        const thisDone = DONE_LIKE.includes(s.state);
        return (
          <li key={s.key} className={prevDone ? 'from-done' : ''}>
            <button type="button" className={`stage${s.key === active ? ' on' : ''}`} aria-pressed={s.key === active} aria-label={`${s.label}: ${s.sub}`} onClick={() => onPick(s.key)}>
              <span className="trk">
                <span className={`ln ${i === 0 ? 'gap' : prevDone ? 'done' : ''}`} />
                <Node s={s} />
                <span className={`ln ${i === stages.length - 1 ? 'gap' : thisDone ? 'done' : ''}`} />
              </span>
              <span className="st-t">{s.label}</span>
              <span className="st-s">{s.sub}</span>
              <span className="st-m">{s.meta ?? ''}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

export function MiniRail({ pr }: { pr: Pull }) {
  const st = stagesOf(pr);
  const summary = st.map((s) => `${s.label}: ${s.sub}`).join(', ');
  return (
    <span className="mini" role="img" aria-label={`Pipeline. ${summary}`} title={summary}>
      {st.map((s, i) => (
        <Fragment key={s.key}>
          {i > 0 && <b className={`ml ${DONE_LIKE.includes(st[i - 1].state) ? 'done' : st[i - 1].state === 'fail' ? 'fail' : ''}`} />}
          <i className={`md ${s.state}`} />
        </Fragment>
      ))}
    </span>
  );
}
