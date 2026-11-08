import { useState } from 'react';
import type { Column, Pull, Ticket } from '../types';
import { useApi } from '../lib/useApi';
import { age, doneLabel, key, plural, SEV_RANK, sourceShort, ttl } from '../lib/format';
import { openCreate, openTicket } from '../lib/drawer';
import { replaceHash } from '../lib/route';
import { Bars, Chip, ErrorBox, SevWord, Skeleton, SourceTag } from '../components/Bits';
import { Icon } from '../components/Icon';
import { Pick, SearchBox, Tabs } from '../components/Controls';

const COLUMNS: [Column, string, string, string][] = [
  ['ACCEPTED', 'Accepted', 'Blocks merge until fixed', 'var(--high)'],
  ['HELD', 'Held', 'Real, but does not block', 'var(--hold)'],
  ['NEEDS_LOOK', 'Needs a look', 'A push may have fixed it', 'var(--med-bar)'],
  ['FIXED', 'Done', 'Fixed, closed or never decided', 'var(--ok)'],
];

// filters live outside the component so they survive opening a ticket
const saved = { q: '', pr: '', sev: '', src: '', view: 'board' as 'board' | 'list' };

const openIt = (t: Ticket) => { if (t.status === 'GONE') location.hash = `#/pr/${t.pull.id}?f=${t.id}`; else openTicket(t.id); };

function Card({ t }: { t: Ticket }) {
  const done = t.column === 'FIXED';
  return (
    <button type="button" className="tk" onClick={() => openIt(t)}>
      <span className="top"><Bars sev={t.severity} /><span className="key">{key(t)}</span><span className="grow" /><SourceTag source={t.source} /></span>
      <span className="tt">{ttl(t)}</span>
      <span className="where">{t.source === 'MANUAL' ? `Manual ticket · #${t.pull.number}` : `#${t.pull.number} · ${t.file}`}</span>
      <span className="foot">
        {done ? <span className="pill">{doneLabel(t)}</span> : <SevWord sev={t.severity} />}
        <span>{done ? age(t.closedAt ?? t.updatedAt) : age(t.createdAt)}</span>
      </span>
    </button>
  );
}

function TRow({ t }: { t: Ticket }) {
  return (
    <button type="button" className="trow" onClick={() => openIt(t)}>
      <span className="c-sev"><SevWord sev={t.severity} /></span>
      <span className="tt"><span className="ttl">{ttl(t)}</span><span className="path">{key(t)} · {t.source === 'MANUAL' ? 'Manual ticket' : t.file} · #{t.pull.number}</span></span>
      <span className="c-src"><SourceTag source={t.source} /></span>
      <span className="c-status"><Chip f={t} />{t.column === 'FIXED' && <span className="sub"> {doneLabel(t)}</span>}</span>
      <span className="sub">{t.column === 'FIXED' ? `${doneLabel(t)} · ${age(t.closedAt ?? t.updatedAt)}` : age(t.createdAt)}</span>
    </button>
  );
}

export function TicketsView({ prParam }: { prParam: string | null }) {
  const tickets = useApi<Ticket[]>('/api/tickets', () => 10000);
  const pulls = useApi<Pull[]>('/api/pulls');
  const [, bump] = useState(0);
  const set = (patch: Partial<typeof saved>) => { Object.assign(saved, patch); bump((n) => n + 1); };

  // a link like #/tickets?pr=5 sets the pull request filter once
  const [seen, setSeen] = useState<string | null>(null);
  if (prParam != null && prParam !== seen) { saved.pr = prParam; setSeen(prParam); }

  if ((tickets.error && !tickets.data) || (pulls.error && !pulls.data)) return <ErrorBox error={tickets.error ?? pulls.error} retry={() => { tickets.reload(); pulls.reload(); }} />;
  if (!tickets.data || !pulls.data) return <Skeleton kind="tickets" />;

  const all = tickets.data;
  const q = saved.q.trim().toLowerCase();
  const list = all.filter((t) =>
    (!saved.pr || String(t.pull.id) === saved.pr) && (!saved.sev || t.severity === saved.sev) && (!saved.src || t.source === saved.src) &&
    (!q || `${ttl(t)} ${t.file ?? ''} ${key(t)} ${t.pull.title}`.toLowerCase().includes(q)));
  const sel = pulls.data.find((p) => String(p.id) === saved.pr);
  const srcs = [...new Set(all.map((t) => t.source))];
  const setPr = (v: string) => { saved.pr = v; setSeen(v || null); replaceHash(v ? `#/tickets?pr=${v}` : '#/tickets'); bump((n) => n + 1); };

  const order: Record<Column, number> = { ACCEPTED: 0, NEEDS_LOOK: 1, HELD: 2, FIXED: 3 };
  const rows = [...list].sort((a, b) => order[a.column ?? 'FIXED'] - order[b.column ?? 'FIXED'] || SEV_RANK[a.severity] - SEV_RANK[b.severity]);

  return (
    <>
      {sel && <a className="backlink" href={`#/pr/${sel.id}`}><Icon name="back" />Back to pull request #{sel.number}, {sel.title}</a>}
      <div className="board-head">
        <div><h1>Ticket board</h1><p className="lede">Cards move by themselves when you decide on a finding or when a push fixes it.</p></div>
        <button type="button" className="btn primary" onClick={() => openCreate(saved.pr, pulls.data!)}><Icon name="plus" />New ticket</button>
      </div>
      <div className="toolbar">
        <SearchBox placeholder="Search tickets" value={saved.q} label="Search tickets" onChange={(v) => set({ q: v })} />
        <Pick label="Pull request" pad={130} options={[['', 'All'], ...pulls.data.map((p): [string, string] => [String(p.id), `#${p.number} ${p.title}`.slice(0, 48)])]} value={saved.pr} onChange={setPr} />
        {srcs.length > 1 && <Pick label="Source" pad={64} options={[['', 'All'], ...srcs.map((s): [string, string] => [s, sourceShort(s)])]} value={saved.src} onChange={(v) => set({ src: v })} />}
        <Tabs items={[['', 'All'], ['HIGH', 'High'], ['MEDIUM', 'Medium'], ['LOW', 'Low']]} active={saved.sev} onPick={(k) => set({ sev: k })} label="Filter by severity" />
        <span className="grow" />
        <span className="muted small">{plural(list.length, 'ticket')}</span>
        <div className="seg" role="group" aria-label="View">
          <button type="button" className={saved.view === 'board' ? 'on' : ''} aria-pressed={saved.view === 'board'} onClick={() => set({ view: 'board' })}><Icon name="board" /><span className="lbl">Board</span></button>
          <button type="button" className={saved.view === 'list' ? 'on' : ''} aria-pressed={saved.view === 'list'} onClick={() => set({ view: 'list' })}><Icon name="list" /><span className="lbl">List</span></button>
        </div>
      </div>
      {saved.view === 'list' ? (
        rows.length === 0 ? <div className="card empty">No ticket matches these filters.</div>
          : <section className="card tl" aria-label="Tickets">{rows.map((t) => <TRow key={t.id} t={t} />)}</section>
      ) : (
        <div className="board">
          {COLUMNS.map(([k, name, note, color]) => {
            const col = list.filter((t) => t.column === k);
            return (
              <div key={k} className="col">
                <div className="col-h" title={note} style={{ ['--c' as string]: color }}><i className="dot" /><h3>{name}</h3><span className="n">{col.length}</span></div>
                {col.length ? col.map((t) => <Card key={t.id} t={t} />) : <div className="none">Nothing here</div>}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
