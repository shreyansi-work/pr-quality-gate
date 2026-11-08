import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Decision, Finding, PullDetail } from '../types';
import { write } from '../lib/api';
import { useApi } from '../lib/useApi';
import { ago, ghUrl, isFixed, key, plural, SEV_RANK, short, sourceShort, statusNote, tail, ttl, sevOf } from '../lib/format';
import { openTicket } from '../lib/drawer';
import { Bars, Chip, ErrorBox, Skeleton, SourceTag } from '../components/Bits';
import { Icon, type IconName } from '../components/Icon';
import { IconButton, Pick, SearchBox, Tabs } from '../components/Controls';
import { reasonDialog, toast } from '../components/Feedback';
import { Rail, stagesOf, type StageKey } from '../components/Pipeline';
import { StagePanel } from '../components/StagePanels';
import { DetailModal } from '../components/DetailModal';

const PAGE_SIZE = 25;
type TabKey = 'all' | 'todo' | 'accepted' | 'look' | 'held' | 'fixed' | 'rejected';
type SortKey = 'sev' | 'new' | 'file';
interface Filters { q: string; sev: string; src: string; file: string; status: TabKey; sort: SortKey; page: number }

const tabKey = (f: Finding): Exclude<TabKey, 'all'> =>
  f.status === 'NEW' ? 'todo' : f.status === 'REJECTED' ? 'rejected' : isFixed(f) ? 'fixed' : f.column === 'NEEDS_LOOK' ? 'look' : f.column === 'HELD' ? 'held' : 'accepted';

export function PullView({ id, f }: { id: number; f: number | null }) {
  const { data: pr, error, reload } = useApi<PullDetail>(`/api/pulls/${id}`, (d) => (d?.readiness === 'REVIEWING' ? 5000 : 0));
  if (error && !pr) return <ErrorBox error={error} retry={reload} />;
  if (!pr) return <Skeleton kind="pr" />;
  // key = the filters start fresh for each pull request, but survive reloads
  return <PullBody key={pr.id} pr={pr} f={f} />;
}

function nextStep(pr: PullDetail): { cls?: string; text: ReactNode; action?: 'triage' | 'accepted' | 'rerun' } {
  const c = pr.counts;
  if (pr.prState && pr.prState !== 'open') return { text: <><b>This pull request is {pr.prState}.</b> The gate no longer applies.</> };
  if (pr.readiness === 'READY') return { cls: 'ready', text: <><b>The gate is open.</b> <span>Nothing accepted is open and nothing is waiting for your decision. You still merge in GitHub.</span></> };
  if (pr.readiness === 'FAILED') return { cls: 'bad', text: <><b>The review failed.</b> <span>{pr.run?.error ?? 'Unknown error.'}</span></>, action: 'rerun' };
  if (pr.readiness === 'REVIEWING') return { text: <><b>Review in progress.</b> <span>This page refreshes by itself.</span></> };
  if (pr.readiness === 'NEEDS_TRIAGE') {
    const open = c.acceptedOpen ? ` ${plural(c.acceptedOpen, 'accepted ticket')} still open, so the gate stays closed.` : ' The gate opens when you have decided on all of them.';
    return { text: <><b>{plural(c.toTriage, 'finding')} {c.toTriage === 1 ? 'is' : 'are'} waiting for your decision.</b><span>{open}</span></>, action: 'triage' };
  }
  const bits = [`${plural(c.acceptedOpen, 'accepted ticket')} still open`];
  if (c.needsLook) bits.push(`${c.needsLook} need a look`);
  return { cls: 'bad', text: <><b>The gate is closed.</b> <span>{bits.join(', ')}. Fix them, or move them to Held if they should not block.</span></>, action: 'accepted' };
}

const VERBS: Record<Decision, string> = {
  ACCEPT: 'Accepted. A ticket was created.', HOLD: 'Put on hold. A ticket was created.',
  REJECT: 'Rejected. The reason is kept.', UNREJECT: 'Moved back to triage',
};

function PullBody({ pr, f: openId }: { pr: PullDetail; f: number | null }) {
  const [flt, setFlt] = useState<Filters>({ q: '', sev: '', src: '', file: '', status: pr.counts.toTriage > 0 ? 'todo' : 'all', sort: 'sev', page: 1 });
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [stage, setStage] = useState<StageKey | null>(null);
  const [problem, setProblem] = useState<unknown>(null);
  const tableRef = useRef<HTMLElement>(null);
  const set = (patch: Partial<Filters>) => setFlt((p) => ({ ...p, page: 1, ...patch }));

  const all = pr.findings;
  const byId = useMemo(() => new Map(all.map((x) => [x.id, x])), [all]);
  const tabCounts = useMemo(() => {
    const c: Record<string, number> = { all: all.length };
    for (const x of all) c[tabKey(x)] = (c[tabKey(x)] ?? 0) + 1;
    return c;
  }, [all]);

  const visible = useMemo(() => {
    const q = flt.q.trim().toLowerCase();
    const idx = new Map(all.map((x, i) => [x.id, i]));
    const list = all.filter((x) =>
      (flt.status === 'all' || tabKey(x) === flt.status) && (!flt.sev || x.severity === flt.sev) && (!flt.src || x.source === flt.src) && (!flt.file || x.file === flt.file) &&
      (!q || `${ttl(x)} ${x.file} ${x.functionName ?? ''} ${key(x)} ${x.message ?? ''}`.toLowerCase().includes(q)));
    const fixedRank = (x: Finding) => (tabKey(x) === 'fixed' ? 1 : 0);
    if (flt.sort === 'new') list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    else if (flt.sort === 'file') list.sort((a, b) => (a.file || '~').localeCompare(b.file || '~') || idx.get(a.id)! - idx.get(b.id)!);
    else list.sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || fixedRank(a) - fixedRank(b) || idx.get(a.id)! - idx.get(b.id)!);
    return list;
  }, [all, flt.q, flt.sev, flt.src, flt.file, flt.status, flt.sort]);

  const pages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const page = Math.min(flt.page, pages);
  const from = (page - 1) * PAGE_SIZE;
  const slice = visible.slice(from, from + PAGE_SIZE);
  const sliceNew = slice.filter((x) => x.status === 'NEW');
  const pickedNew = [...picked].filter((x) => byId.get(x)?.status === 'NEW');
  const hashBase = `#/pr/${pr.id}`;

  // ----- actions -----
  const rerun = async () => {
    try { await write(`/api/pulls/${pr.id}/rerun`, {}); toast('Review queued'); } catch (err) { setProblem(err); }
  };
  const decide = async (x: Finding, decision: Decision, reason?: string) => {
    try {
      await write(`/api/findings/${x.id}/triage`, reason !== undefined ? { decision, reason } : { decision });
      toast(VERBS[decision]);
      setPicked((s) => { const n = new Set(s); n.delete(x.id); return n; });
    } catch (err) { setProblem(err); }
  };
  const reject = async (x: Finding) => {
    const reason = await reasonDialog('Reject this finding?', ttl(x));
    if (reason != null) await decide(x, 'REJECT', reason);
  };
  const bulk = async (decision: Decision) => {
    const ids = pickedNew;
    if (!ids.length) return;
    let reason: string | undefined;
    if (decision === 'REJECT') {
      const r = await reasonDialog(`Reject ${plural(ids.length, 'finding')}?`, 'The same reason is saved for each one.');
      if (r == null) return;
      reason = r;
    }
    let done = 0;
    try {
      for (const fid of ids) { await write(`/api/findings/${fid}/triage`, reason !== undefined ? { decision, reason } : { decision }); done++; }
      toast(`${plural(done, 'finding')} ${decision === 'ACCEPT' ? 'accepted' : decision === 'HOLD' ? 'put on hold' : 'rejected'}`);
    } catch (err) { setProblem(new Error(`${done} of ${ids.length} done. ${(err as Error).message}`)); }
    setPicked(new Set());
  };

  const showTable = (patch: Partial<Filters>) => { set(patch); tableRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
  const step = nextStep(pr);
  const stages = stagesOf(pr);
  const onStage = (k: StageKey) => {
    if (k === 'triage') { setStage(null); showTable({ status: pr.counts.toTriage > 0 ? 'todo' : 'all' }); return; }
    setStage((cur) => (cur === k ? null : k));
  };

  // ----- the open finding (details modal) -----
  const current = openId != null ? byId.get(openId) ?? null : null;
  let modal: ReactNode = null;
  if (current) {
    const ids = visible.map((x) => x.id);
    const at = ids.indexOf(current.id);
    const prevId = at > 0 ? ids[at - 1] : null;
    const nextId = at >= 0 && at < ids.length - 1 ? ids[at + 1] : at < 0 && ids.length ? ids[0] : null;
    // after a decision, move on to the next finding that still waits for you
    const afterDecision = () => {
      const order = at >= 0 ? [...ids.slice(at + 1), ...ids.slice(0, at)] : ids;
      return order.find((x) => x !== current.id && byId.get(x)?.status === 'NEW') ?? null;
    };
    modal = <DetailModal f={current} pr={pr} hashBase={hashBase} nav={{ prevId, nextId, at, total: ids.length, afterDecision }} />;
  }
  // the page behind the modal is only locked while a modal is open (DetailModal handles it)
  useEffect(() => { if (!current) document.body.style.overflow = ''; }, [current]);

  const files = [...new Set(all.map((x) => x.file).filter(Boolean))].sort();
  const srcs = [...new Set(all.map((x) => x.source))];
  const sevList = (k: string) => all.filter((x) => x.severity === k && x.status !== 'REJECTED');
  const tickets = all.filter((x) => x.column).length;
  const canRerun = pr.prState === 'open' && pr.readiness !== 'REVIEWING';
  const tabItems: [TabKey, string, number][] = [['all', 'All', tabCounts.all], ['todo', 'To decide', tabCounts.todo ?? 0], ['accepted', 'Accepted', tabCounts.accepted ?? 0]];
  if (tabCounts.look) tabItems.push(['look', 'Needs a look', tabCounts.look]);
  tabItems.push(['held', 'Held', tabCounts.held ?? 0], ['fixed', 'Fixed', tabCounts.fixed ?? 0], ['rejected', 'Rejected', tabCounts.rejected ?? 0]);

  const Tile = ({ k, label }: { k: 'HIGH' | 'MEDIUM' | 'LOW'; label: string }) => {
    const list = sevList(k);
    const todo = list.filter((x) => x.status === 'NEW').length;
    const on = flt.sev === k;
    return (
      <button type="button" className={`tile${on ? ' on' : ''}`} aria-pressed={on} onClick={() => set({ sev: on ? '' : k })}>
        <Bars sev={k} big />
        <span><div className="num">{list.length}</div><div className="lab">{label}{todo ? ` · ${todo} to decide` : ''}</div></span>
      </button>
    );
  };

  const rows: ReactNode[] = [];
  let lastSev: string | null = null;
  for (const x of slice) {
    if (flt.sort === 'sev' && x.severity !== lastSev) {
      lastSev = x.severity;
      const g = visible.filter((y) => y.severity === x.severity);
      rows.push(
        <div key={`g-${x.severity}`} className="gh">
          <span className={`sev ${sevOf(x.severity).cls}`}><Bars sev={x.severity} />{sevOf(x.severity).word} severity</span>
          <small>{plural(g.length, 'finding')} · {g.filter((y) => y.status === 'NEW').length} to decide</small>
        </div>,
      );
    }
    rows.push(<Row key={x.id} x={x} selected={x.id === openId} checked={picked.has(x.id)} hashBase={hashBase}
      onCheck={(on) => setPicked((s) => { const n = new Set(s); if (on) n.add(x.id); else n.delete(x.id); return n; })}
      onDecide={(d) => void decide(x, d)} onReject={() => void reject(x)} />);
  }

  return (
    <>
      <div>
        <div className="crumb"><a href="#/">Pull requests</a> / {pr.repo} / #{pr.number}</div>
        <div className="rep-top">
          <div>
            <h1>{pr.title}</h1>
            <div className="rep-meta">
              <span>by {pr.author}</span><span className="src mono">{pr.branch}</span><span className="src mono">{short(pr.headSha)}</span>
              {pr.run?.finishedAt && pr.readiness !== 'REVIEWING' && <span>reviewed {ago(pr.run.finishedAt)}</span>}
            </div>
          </div>
          <div className="rep-actions">
            {canRerun && <button type="button" className="btn" onClick={() => void rerun()}><Icon name="refresh" />Run review again</button>}
            <a className="ibtn" style={{ height: 36, width: 36 }} href={ghUrl(pr)} target="_blank" rel="noopener noreferrer" aria-label="Open the pull request on GitHub" title="Open on GitHub"><Icon name="out" /></a>
          </div>
        </div>
      </div>

      {problem != null && <ErrorBox error={problem} />}

      <section className="card pipe" aria-label="Pipeline">
        <Rail stages={stages} active={stage} onPick={onStage} />
        <div className={`nextstep ${step.cls ?? ''}`}>
          <div className="t">{step.text}</div>
          {step.action === 'triage' && <button type="button" className="btn primary" onClick={() => onStage('triage')}>Start triage</button>}
          {step.action === 'accepted' && <button type="button" className="btn primary" onClick={() => showTable({ status: 'accepted' })}>Show accepted tickets</button>}
          {step.action === 'rerun' && <button type="button" className="btn primary" onClick={() => void rerun()}><Icon name="refresh" />Run the review again</button>}
        </div>
        {stage && <div className="stage-panel"><StagePanel pr={pr} k={stage} onRerun={() => void rerun()} /></div>}
      </section>

      <div className="toolbar" style={{ justifyContent: 'space-between' }}>
        <div className="tabs" role="navigation" aria-label="Pull request sections">
          <a className="tab on" href={hashBase} aria-current="page">Findings<b className="muted">{all.length}</b></a>
          <a className="tab" href={`#/tickets?pr=${pr.id}`}>Tickets for this PR<b className="muted">{tickets}</b></a>
        </div>
        <span className="muted small">Click a row to see all details</span>
      </div>

      <div className="tiles" role="group" aria-label="Filter by severity">
        <Tile k="HIGH" label="High severity" />
        <Tile k="MEDIUM" label="Medium" />
        <Tile k="LOW" label="Low" />
        <button type="button" className={`tile${flt.status === 'fixed' ? ' on' : ''}`} aria-pressed={flt.status === 'fixed'} onClick={() => set({ status: flt.status === 'fixed' ? 'all' : 'fixed' })}>
          <span className="okic"><Icon name="circleok" /></span>
          <span><div className="num">{tabCounts.fixed ?? 0}</div><div className="lab">Fixed in later pushes</div></span>
        </button>
      </div>

      <section className="card ft" id="findings" ref={tableRef} aria-label="Findings">
        <div className="ft-bar">
          <div className="toolbar">
            <SearchBox placeholder="Search by title, file or function" value={flt.q} label="Search findings" onChange={(v) => set({ q: v })} />
            <Pick label="Severity" pad={74} options={[['', 'All'], ['HIGH', 'High'], ['MEDIUM', 'Medium'], ['LOW', 'Low']]} value={flt.sev} onChange={(v) => set({ sev: v })} />
            {srcs.length > 1 && <Pick label="Source" pad={64} options={[['', 'All'], ...srcs.map((s): [string, string] => [s, sourceShort(s)])]} value={flt.src} onChange={(v) => set({ src: v })} />}
            {files.length > 1 && <Pick label="File" pad={48} options={[['', 'All files'], ...files.map((x): [string, string] => [x, tail(x)])]} value={flt.file} onChange={(v) => set({ file: v })} />}
            <Pick label="Sort" pad={50} options={[['sev', 'Severity'], ['new', 'Newest'], ['file', 'File']]} value={flt.sort} onChange={(v) => set({ sort: v as SortKey })} />
          </div>
          <Tabs items={tabItems} active={flt.status} onPick={(k) => set({ status: k })} label="Filter by status" />
        </div>

        {pickedNew.length > 0 && (
          <div className="bulk">
            <b>{pickedNew.length} selected</b><span className="grow" />
            <button type="button" className="btn" onClick={() => void bulk('ACCEPT')}><Icon name="check" />Accept</button>
            <button type="button" className="btn" onClick={() => void bulk('HOLD')}><Icon name="hold" />Hold</button>
            <button type="button" className="btn" onClick={() => void bulk('REJECT')}><Icon name="cross" />Reject</button>
            <button type="button" className="btn quiet" onClick={() => setPicked(new Set())}>Clear</button>
          </div>
        )}

        <div role="table" aria-label="Findings table">
          <div className="frow th" role="row">
            <span role="columnheader">
              <input type="checkbox" aria-label="Select all findings waiting for a decision" checked={sliceNew.length > 0 && sliceNew.every((x) => picked.has(x.id))}
                onChange={(e) => setPicked((s) => { const n = new Set(s); sliceNew.forEach((x) => (e.target.checked ? n.add(x.id) : n.delete(x.id))); return n; })} />
            </span>
            <span role="columnheader">Severity</span><span role="columnheader">Finding</span>
            <span role="columnheader" className="c-src">Source</span><span role="columnheader">Status</span><span role="columnheader" className="c-age">Found</span>
            <span role="columnheader" style={{ textAlign: 'right' }}>Decide</span>
          </div>
          <div role="rowgroup">
            {rows}
            {visible.length === 0 && (
              <div className="empty">
                {all.length === 0
                  ? (pr.readiness === 'REVIEWING' ? 'Findings appear here when the review finishes.' : 'No findings. Nothing to decide.')
                  : <><b>No finding matches these filters</b><button type="button" className="btn" onClick={() => set({ q: '', sev: '', src: '', file: '', status: 'all' })}>Clear filters</button></>}
              </div>
            )}
          </div>
        </div>

        <div className="ft-foot">
          <span>{visible.length === 0 ? 'No findings' : `Showing ${from + 1}–${from + slice.length} of ${plural(visible.length, 'finding')}`}</span>
          {pages > 1 && (
            <span className="pg">
              <IconButton icon="left" label="Previous page" disabled={page <= 1} onClick={() => setFlt((p) => ({ ...p, page: page - 1 }))} />
              <span style={{ padding: '0 6px' }}>Page {page} of {pages}</span>
              <IconButton icon="right" label="Next page" disabled={page >= pages} onClick={() => setFlt((p) => ({ ...p, page: page + 1 }))} />
            </span>
          )}
        </div>
      </section>

      {modal}
    </>
  );
}

function Row({ x, selected, checked, hashBase, onCheck, onDecide, onReject }: {
  x: Finding; selected: boolean; checked: boolean; hashBase: string;
  onCheck: (on: boolean) => void; onDecide: (d: Decision) => void; onReject: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const go = async (d: Decision) => { setBusy(true); try { await onDecide(d); } finally { setBusy(false); } };
  const Act = ({ icon, cls, label, onClick }: { icon: IconName; cls: string; label: string; onClick: () => void }) =>
    <button type="button" className={`ibtn ${cls}`.trim()} aria-label={label} title={label} disabled={busy} onClick={onClick}><Icon name={icon} /></button>;
  const note = statusNote(x);
  return (
    <div className={`frow${selected ? ' sel' : ''}`} role="row"
      onClick={(e) => { if (!(e.target as HTMLElement).closest('button, a, input, label')) replaceHashOpen(hashBase, x.id); }}>
      <span className="c-chk" role="cell">
        {x.status === 'NEW' && <input type="checkbox" checked={checked} aria-label={`Select: ${ttl(x)}`} onChange={(e) => onCheck(e.target.checked)} />}
      </span>
      <span className={`c-sev sev ${sevOf(x.severity).cls}`} role="cell"><Bars sev={x.severity} />{sevOf(x.severity).word}</span>
      <span className="tt" role="cell">
        <a className="ttl" style={{ display: 'block', color: 'inherit', textDecoration: 'none' }} href={`${hashBase}?f=${x.id}`}>{ttl(x)}</a>
        <div className="path" title={x.file || undefined}>{x.file ? `${x.file}${x.functionName ? ` · ${x.functionName}()` : ''}` : 'Manual ticket'}</div>
      </span>
      <span className="c-src" role="cell"><SourceTag source={x.source} /></span>
      <span className="c-status" role="cell"><Chip f={x} />{note && <div className="note-s">{note}</div>}</span>
      <span className="c-age sub" role="cell">{ago(x.createdAt)}</span>
      <span className="acts c-acts" role="cell">
        {x.status === 'NEW' ? (
          <>
            <Act icon="check" cls="ok" label="Accept: real problem, blocks merge" onClick={() => void go('ACCEPT')} />
            <Act icon="hold" cls="hd" label="Hold: real, not blocking" onClick={() => void go('HOLD')} />
            <Act icon="cross" cls="no" label="Reject: not a problem" onClick={onReject} />
          </>
        ) : x.status === 'REJECTED' ? (
          <Act icon="undo" cls="" label="Un-reject: move back to triage" onClick={() => void go('UNREJECT')} />
        ) : isFixed(x) ? (
          <span className="sub">No action needed</span>
        ) : (
          <button type="button" className="btn sm" onClick={() => openTicket(x.id)}>Ticket {key(x)}</button>
        )}
      </span>
    </div>
  );
}

const replaceHashOpen = (base: string, id: number) => { location.hash = `${base}?f=${id}`; };
