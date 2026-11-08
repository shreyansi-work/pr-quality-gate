import type { ReactNode } from 'react';
import type { Pull, PullDetail } from '../types';
import { ago, checksUrl, plural, short, tail, titleCase, ttl } from '../lib/format';
import { SevWord } from './Bits';
import { Icon } from './Icon';
import { checkInfo, type StageKey } from './Pipeline';

const PanelHead = ({ title, hint }: { title: string; hint?: string | null }) => (
  <div className="panel-h"><h2>{title}</h2>{hint && <span className="muted small">{hint}</span>}</div>
);

export function StagePanel({ pr, k, onRerun }: { pr: PullDetail; k: StageKey; onRerun: () => void }) {
  if (k === 'push') return <PushPanel pr={pr} />;
  if (k === 'checks') return <ChecksPanel pr={pr} />;
  if (k === 'ai') return <AiPanel pr={pr} onRerun={onRerun} />;
  return <GatePanel pr={pr} />;
}

function PushPanel({ pr }: { pr: PullDetail }) {
  const runs = pr.runs ?? [];
  return (
    <>
      <PanelHead title="Push" hint="The commit this page is about" />
      <dl className="facts-list">
        <div><dt>Commit</dt><dd className="mono">{pr.headSha}</dd></div>
        <div><dt>Branch</dt><dd className="mono">{pr.branch}</dd></div>
        <div><dt>Author</dt><dd>{pr.author}</dd></div>
        <div><dt>Repository</dt><dd>{pr.repo}</dd></div>
      </dl>
      <h3 className="sub-h">Reviews of this pull request</h3>
      {runs.length === 0 ? <div className="muted">No review has run yet.</div> : (
        <ul className="runs">
          {runs.map((r, i) => <li key={i}><span className="mono">{short(r.headSha)}</span><span>{titleCase(r.status)}</span><span className="muted">{ago(r.createdAt)}</span></li>)}
        </ul>
      )}
    </>
  );
}

function ChecksPanel({ pr }: { pr: Pull }) {
  const { list } = checkInfo(pr);
  return (
    <>
      <PanelHead title="Checks" hint="Facts from real tools, no AI" />
      {list.length === 0 ? (
        <div className="muted"><b>No CI checks reported for this commit. </b>If the repo has a GitHub Actions workflow (build, lint, tests), its results appear here after the next push.</div>
      ) : (
        <ul className="check-list">
          {list.map((c, i) => {
            const ok = c.conclusion === 'success' || c.conclusion === 'neutral' || c.conclusion === 'skipped';
            const bad = !!c.conclusion && !ok;
            return (
              <li key={i}>
                <a className={`check ${ok ? 'ok' : bad ? 'no' : 'wait'}`} href={checksUrl(pr)} target="_blank" rel="noopener noreferrer">
                  <Icon name={ok ? 'check' : bad ? 'cross' : 'spin'} className={ok || bad ? '' : 'spin'} />
                  <span>{c.name}</span>
                  <em>{ok ? (c.conclusion === 'success' ? 'passed' : c.conclusion) : bad ? 'failed' : 'running'}</em>
                </a>
              </li>
            );
          })}
        </ul>
      )}
      <p className="note">These results are shown for your information. The gate depends on your triage of the findings, not on CI.</p>
    </>
  );
}

function AiPanel({ pr, onRerun }: { pr: PullDetail; onRerun: () => void }) {
  const run = pr.run;
  const skipped = Array.isArray(run?.skippedFiles) ? run!.skippedFiles! : [];
  const changed = Array.isArray(run?.changedFiles) ? run!.changedFiles! : [];
  const secs = run?.startedAt && run?.finishedAt ? Math.max(1, Math.round((new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 1000)) : null;
  return (
    <>
      <PanelHead title="AI review" hint={run?.model ? `Model: ${run.model}` : null} />
      {pr.readiness === 'REVIEWING' && <div className="muted">The review is running. This page refreshes by itself.</div>}
      {pr.readiness === 'FAILED' && <div className="err">The review failed: {run?.error ?? 'unknown error'}</div>}
      {pr.prState === 'open' && pr.readiness !== 'REVIEWING' && (
        <div className="btn-row" style={{ margin: '0 0 16px' }}>
          <button type="button" className={pr.readiness === 'FAILED' ? 'btn primary' : 'btn'} onClick={onRerun}><Icon name="refresh" />Run the review again</button>
        </div>
      )}
      {run && (
        <dl className="facts-list">
          <div><dt>Files changed</dt><dd>{changed.length}</dd></div>
          <div><dt>Not reviewed by the AI</dt><dd>{skipped.length}</dd></div>
          {secs != null && <div><dt>Review time</dt><dd>{secs} s</dd></div>}
          <div><dt>Findings</dt><dd>{pr.findings.length}</dd></div>
        </dl>
      )}
      <h3 className="sub-h">Files the AI did not read</h3>
      {skipped.length === 0 ? <div className="muted">Every changed code file was reviewed.</div> : (
        <ul className="runs">
          {skipped.map((s, i) => <li key={i}><span className="mono">{s.file}</span><span className="muted">{s.reason}. Covered by: {s.coveredBy}.</span></li>)}
        </ul>
      )}
      <p className="note">Other reasons a file is skipped: too big for the token budget, binary file, minified code.</p>
    </>
  );
}

function GatePanel({ pr }: { pr: PullDetail }) {
  const c = pr.counts;
  const blockers = pr.findings.filter((f) => f.status === 'ACCEPTED' && f.column !== 'FIXED');
  const held = pr.findings.filter((f) => f.status === 'HELD' && f.column !== 'FIXED');
  const ended = !!pr.prState && pr.prState !== 'open';
  const head: [string, string] = ended ? [`This pull request is ${pr.prState}`, 'The gate no longer applies.']
    : pr.readiness === 'READY' ? ['The gate is open', 'Nothing accepted is open and nothing is waiting for your decision. You still merge in GitHub.']
    : pr.readiness === 'NOT_READY' ? ['The gate is closed', 'Fix the accepted tickets below, or move them to Held if they should not block.']
    : pr.readiness === 'NEEDS_TRIAGE' ? ['The gate is waiting for you', 'Decide on every finding. Accepted ones will block the gate until they are fixed.']
    : pr.readiness === 'FAILED' ? ['The review failed', pr.run?.error ?? 'Unknown error.']
    : ['Not decided yet', 'The latest commit is still being reviewed.'];
  const status = { READY: 'passed', NOT_READY: 'failed', NEEDS_TRIAGE: 'pending', REVIEWING: 'pending', FAILED: 'error' }[pr.readiness];
  const list = (items: typeof blockers): ReactNode => (
    <ul className="runs rows">
      {items.map((f) => (
        <li key={f.id}>
          <a href={`#/pr/${pr.id}?f=${f.id}`}>{ttl(f)}</a>
          <SevWord sev={f.severity} />
          <span className="muted small mono">{f.file ? tail(f.file) : 'Manual ticket'}</span>
        </li>
      ))}
    </ul>
  );
  return (
    <>
      <p className="gate-line"><b>{head[0]}</b><span className="muted">{head[1]}</span></p>
      {blockers.length > 0 && <><h3 className="sub-h">Accepted and still open ({blockers.length})</h3>{list(blockers)}</>}
      {c.toTriage > 0 && <div className="gate-todo"><span>{plural(c.toTriage, 'finding')} waiting for your decision</span></div>}
      {held.length > 0 && <><h3 className="sub-h">Held, not blocking ({held.length})</h3>{list(held)}</>}
      {!ended && status && <p className="note">On GitHub, the PR Quality Gate status shows as {status}. CI checks do not change the gate.</p>}
    </>
  );
}
