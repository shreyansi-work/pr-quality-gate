import { useMemo, useState } from 'react';
import type { Pull, Readiness } from '../types';
import { useApi } from '../lib/useApi';
import { firstSentence } from '../lib/format';
import { ErrorBox, GateBadge, Skeleton } from '../components/Bits';
import { Icon } from '../components/Icon';
import { Pick, SearchBox, Tabs } from '../components/Controls';
import { MiniRail } from '../components/Pipeline';
import { ago } from '../lib/format';
import { SEV } from '../lib/format';

const STATUS_OPTIONS: [string, string][] = [['', 'All'], ['READY', 'Gate open'], ['NOT_READY', 'Gate closed'], ['NEEDS_TRIAGE', 'Waiting for you'], ['REVIEWING', 'Being reviewed'], ['FAILED', 'Review failed']];
const GROUPS: [Readiness, string, string][] = [
  ['NEEDS_TRIAGE', 'Waiting for you', 'Decide on the findings so the gate can open'],
  ['NOT_READY', 'Gate closed', 'An accepted ticket is still open'],
  ['REVIEWING', 'Reviewing', 'The AI is reading the latest push'],
  ['FAILED', 'Review failed', 'Run the review again from the pull request'],
  ['READY', 'Ready to merge', 'Nothing open, nothing waiting'],
];
const isOpen = (p: Pull) => !p.prState || p.prState === 'open';
type Tab = 'open' | 'merged' | 'closed';
const tabOf = (p: Pull): Tab => (isOpen(p) ? 'open' : p.prState === 'merged' ? 'merged' : 'closed');

// filters live outside the component so they survive going to a PR and back
const saved = { q: '', st: '', repo: '', tab: 'open' as Tab };

function FindingsCell({ p }: { p: Pull }) {
  if (!isOpen(p)) return <span className="sub">No longer open</span>;
  if (p.readiness === 'REVIEWING') return <span className="sub">Review in progress</span>;
  if (p.readiness === 'FAILED') return <span className="sub" style={{ color: 'var(--high)' }}>{p.run?.error ? firstSentence(p.run.error) : 'Review failed'}</span>;
  const c = p.counts;
  const total = c.toTriage + c.acceptedOpen + c.held + c.fixed;
  if (total === 0) return <span className="sub">No findings</span>;
  const left = [c.toTriage ? `${c.toTriage} to decide` : '', c.acceptedOpen ? `${c.acceptedOpen} accepted open` : ''].filter(Boolean).join(' · ') || (c.held ? `${c.held} held` : 'All decided');
  const cols = [['HIGH', 'var(--high)'], ['MEDIUM', 'var(--med-bar)'], ['LOW', 'var(--low)']] as const;
  return (
    <>
      {p.sev && (
        <div className="cnts">
          {cols.map(([k, col]) => <span key={k} className="cnt" title={`${SEV[k].word} severity`} style={{ ['--c' as string]: col }}><i />{p.sev![k] ?? 0}</span>)}
        </div>
      )}
      <div className="sub">{left}</div>
    </>
  );
}

function Row({ p }: { p: Pull }) {
  return (
    <a className="prow" href={`#/pr/${p.id}`}>
      <div className="cell c-pr">
        <div className="ttl">{p.title}</div>
        <div className="sub"><span className="mono">{p.repo}</span> · #{p.number} · <span className="mono">{p.branch}</span> · by {p.author}</div>
      </div>
      <div className="cell c-pipe"><MiniRail pr={p} /></div>
      <div className="cell c-find"><FindingsCell p={p} /></div>
      <div className="cell c-gate"><GateBadge pr={p} /></div>
      <div className="cell upd sub">{ago(p.updatedAt)}</div>
      <span className="chev"><Icon name="right" /></span>
    </a>
  );
}

export function PullsView() {
  const { data: pulls, error, reload } = useApi<Pull[]>('/api/pulls', () => 8000);
  const [, bump] = useState(0);
  const set = (patch: Partial<typeof saved>) => { Object.assign(saved, patch); bump((n) => n + 1); };

  const open = useMemo(() => (pulls ?? []).filter(isOpen), [pulls]);
  if (error && !pulls) return <ErrorBox error={error} retry={reload} />;
  if (!pulls) return <Skeleton kind="pulls" />;

  const n = (k: Readiness) => open.filter((p) => p.readiness === k).length;
  const repos = [...new Set(pulls.map((p) => p.repo))].sort();
  const q = saved.q.trim().toLowerCase();
  const shown = pulls.filter((p) =>
    tabOf(p) === saved.tab && (!saved.st || p.readiness === saved.st) && (!saved.repo || p.repo === saved.repo) &&
    (!q || `#${p.number} ${p.title} ${p.branch} ${p.author} ${p.repo}`.toLowerCase().includes(q)));
  const tabItems: [Tab, string, number][] = [['open', 'Open', open.length], ['merged', 'Merged', pulls.filter((p) => tabOf(p) === 'merged').length], ['closed', 'Closed', pulls.filter((p) => tabOf(p) === 'closed').length]];

  return (
    <>
      <div>
        <h1>Pull requests</h1>
        <p className="lede">{open.length === 0 ? 'Nothing open right now.' : `${n('NEEDS_TRIAGE')} waiting for your decision, ${n('NOT_READY')} with the gate closed, ${n('READY')} ready to merge.`}</p>
      </div>
      <div className="toolbar">
        <SearchBox placeholder="Search by title, branch or author" value={saved.q} label="Search pull requests" onChange={(v) => set({ q: v })} />
        <Pick label="Repository" pad={100} options={[['', 'All'], ...repos.map((r): [string, string] => [r, r])]} value={saved.repo} onChange={(v) => set({ repo: v })} />
        <Pick label="Gate" pad={56} options={STATUS_OPTIONS} value={saved.st} onChange={(v) => set({ st: v })} />
        <span className="grow" />
        <Tabs items={tabItems} active={saved.tab} onPick={(k) => set({ tab: k })} label="Pull request state" />
      </div>
      {pulls.length === 0 ? (
        <div className="card empty">
          <b>No pull requests yet</b>
          <p>Push to a pull request in a repo where the GitHub App is installed, for example <code>git push origin my-branch</code></p>
          <p className="small">To see a demo first, run <code>curl -X POST localhost:3000/dev/seed</code></p>
        </div>
      ) : shown.length === 0 ? (
        <div className="card empty">No pull request matches these filters.</div>
      ) : (
        <section className="card pt" aria-label="Pull requests">
          <div className="prow th" role="row"><span>Pull request</span><span>Pipeline</span><span>Findings</span><span>Gate</span><span className="upd">Updated</span><span /></div>
          {saved.tab === 'open'
            ? GROUPS.map(([k, name, note]) => {
                const rows = shown.filter((p) => p.readiness === k);
                if (!rows.length) return null;
                return (
                  <div key={k} role="rowgroup">
                    <div className="grp">{name}<span className="n">{rows.length}</span><small>{note}</small></div>
                    {rows.map((p) => <Row key={p.id} p={p} />)}
                  </div>
                );
              })
            : shown.map((p) => <Row key={p.id} p={p} />)}
        </section>
      )}
    </>
  );
}
