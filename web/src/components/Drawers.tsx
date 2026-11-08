import { useEffect, useRef, useState } from 'react';
import type { Column, FindingFull, PullBrief, Severity } from '../types';
import { api, write } from '../lib/api';
import { bindDrawer, closeDrawer, type DrawerReq } from '../lib/drawer';
import { ago, descOf, key, sourceLabel, stamp, titleCase, ttl } from '../lib/format';
import { Chip, ErrorBox } from './Bits';
import { Icon } from './Icon';
import { confirmDialog, toast } from './Feedback';

const COLUMN_LABEL: Record<Column, string> = { ACCEPTED: 'Accepted (blocks merge)', HELD: 'Held', NEEDS_LOOK: 'Needs a look', FIXED: 'Done' };
const SEVERITIES: Severity[] = ['HIGH', 'MEDIUM', 'LOW'];

export function DrawerHost() {
  const [req, setReq] = useState<DrawerReq | null>(null);
  useEffect(() => {
    bindDrawer(setReq);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.getElementById('dialog-root')) setReq(null); };
    // opening another page closes the drawer
    const onHash = () => setReq(null);
    window.addEventListener('keydown', onKey);
    window.addEventListener('hashchange', onHash);
    return () => { bindDrawer(() => {}); window.removeEventListener('keydown', onKey); window.removeEventListener('hashchange', onHash); };
  }, []);
  if (!req) return null;
  return (
    <div id="drawer-root">
      <div className="overlay" onClick={closeDrawer} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={req.kind === 'create' ? 'New ticket' : 'Ticket'}>
        {req.kind === 'ticket' ? <TicketDrawer id={req.id} /> : <CreateDrawer defaultPr={req.defaultPr} pulls={req.pulls} />}
      </aside>
    </div>
  );
}

const CloseBtn = () => <button type="button" className="ibtn x" onClick={closeDrawer} aria-label="Close" title="Close (Esc)"><Icon name="cross" /></button>;

function TicketDrawer({ id }: { id: number }) {
  const [t, setT] = useState<FindingFull | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  useEffect(() => { api<FindingFull>(`/api/findings/${id}`).then(setT).catch(setLoadError); }, [id]);
  if (loadError) return <div><div className="d-bar"><CloseBtn /></div><ErrorBox error={loadError} /></div>;
  if (!t) return <div><div className="d-bar"><CloseBtn /></div><div className="muted">Loading…</div></div>;
  return <TicketForm t={t} />;
}

function TicketForm({ t }: { t: FindingFull }) {
  const manual = t.source === 'MANUAL';
  const [title, setTitle] = useState(ttl(t));
  const [desc, setDesc] = useState(descOf(t) ?? '');
  const [sev, setSev] = useState<Severity>(t.severity);
  const [col, setCol] = useState<Column>(t.column ?? 'ACCEPTED');
  const [msg, setMsg] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => { first.current?.focus(); }, []);

  const options: Column[] = ['ACCEPTED', 'HELD', 'FIXED', ...(t.column === 'NEEDS_LOOK' ? (['NEEDS_LOOK'] as Column[]) : [])];
  const dirty = title !== ttl(t) || desc !== (descOf(t) ?? '') || sev !== t.severity || col !== (t.column ?? 'ACCEPTED');

  const run = async (fn: () => Promise<unknown>, okText: string) => {
    setBusy(true);
    try { await fn(); closeDrawer(); toast(okText); } catch (err) { setBusy(false); setMsg(err); }
  };
  const save = () => run(async () => {
    if (!title.trim()) throw new Error('The title cannot be empty.');
    await write(`/api/findings/${t.id}`, { title: title.trim(), description: desc, severity: sev }, 'PATCH');
    if (col !== t.column) {
      if (col === 'ACCEPTED') await write(`/api/findings/${t.id}/triage`, { decision: 'ACCEPT' });
      else if (col === 'HELD') await write(`/api/findings/${t.id}/triage`, { decision: 'HOLD' });
      else if (col === 'FIXED') await write(`/api/findings/${t.id}/fixed`, {});
    }
  }, 'Ticket saved');
  const del = async () => {
    const ok = await confirmDialog('Delete this ticket?',
      manual ? 'This ticket will be deleted for good.' : 'The review found this one, so it is marked as rejected ("Deleted by you") and will not come back on the next push.', 'Delete');
    if (ok) await run(() => write(`/api/findings/${t.id}`, undefined, 'DELETE'), 'Ticket deleted');
  };

  return (
    <div>
      <div className="d-bar"><Chip f={t} /><span className="small muted">{key(t)} · created {ago(t.createdAt)}</span><CloseBtn /></div>
      <div className="field"><span className="small">Title</span><input ref={first} type="text" className="t-in" maxLength={200} value={title} aria-label="Title" onChange={(e) => setTitle(e.target.value)} /></div>
      <div className="field"><span className="small">Description</span><textarea rows={5} maxLength={5000} placeholder="Describe the ticket…" aria-label="Description" value={desc} onChange={(e) => setDesc(e.target.value)} /></div>
      <div className="two field">
        <label className="f">Severity
          <select aria-label="Severity" value={sev} onChange={(e) => setSev(e.target.value as Severity)}>{SEVERITIES.map((v) => <option key={v} value={v}>{titleCase(v)}</option>)}</select>
        </label>
        <label className="f">State
          <select aria-label="State" value={col} onChange={(e) => setCol(e.target.value as Column)}>{options.map((v) => <option key={v} value={v}>{COLUMN_LABEL[v]}</option>)}</select>
        </label>
      </div>
      <div className="sect">
        <div className="small muted">Linked finding</div>
        <div className="big">{t.pull.repo} #{t.pull.number} {t.pull.title}</div>
        {!manual && (
          <>
            <div className="loc" style={{ marginTop: 4 }}><span className="mono">{t.file}</span>{t.functionName && <> · <span className="mono">{t.functionName}()</span></>} · {sourceLabel(t)}</div>
            {t.quote && <pre className="code">{t.quote}</pre>}
          </>
        )}
        {t.closeReason && <div className="small muted" style={{ marginTop: 8 }}>Note: {t.closeReason}</div>}
        <div style={{ marginTop: 10 }}><a className="btn" href={`#/pr/${t.pull.id}?f=${t.id}`} onClick={closeDrawer}><Icon name="out" />Open details on the pull request</a></div>
      </div>
      {msg != null && <ErrorBox error={msg} />}
      <div className="d-actions">
        <button type="button" className="btn primary" disabled={!dirty || busy} onClick={() => void save()}>Save changes</button>
        {t.column === 'FIXED'
          ? <button type="button" className="btn" disabled={busy} onClick={() => void run(() => write(`/api/findings/${t.id}/reopen`, {}), 'Ticket reopened')}>Reopen</button>
          : <button type="button" className="btn" disabled={busy} onClick={() => void run(() => write(`/api/findings/${t.id}/fixed`, {}), 'Marked as fixed')}>Mark fixed</button>}
        {t.column === 'NEEDS_LOOK' && <button type="button" className="btn" disabled={busy} onClick={() => void run(() => write(`/api/findings/${t.id}/reopen`, {}), 'Still a problem. Ticket reopened')}>Still a problem</button>}
        <span className="grow" />
        <button type="button" className="btn danger" disabled={busy} onClick={() => void del()}>Delete</button>
      </div>
      <div className="sect">
        <h3>Activity</h3>
        {(t.events ?? []).length === 0 ? <div className="small muted" style={{ marginTop: 8 }}>No history yet.</div> : (
          <ul className="log">
            {t.events!.map((e) => (
              <li key={e.id}><span className="when">{stamp(e.createdAt)}</span><span>{e.message} <span className="by">by {e.actor === 'system' ? 'system' : 'you'}</span></span></li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function CreateDrawer({ defaultPr, pulls }: { defaultPr: string; pulls: PullBrief[] }) {
  const [pr, setPr] = useState(defaultPr && pulls.some((p) => String(p.id) === defaultPr) ? defaultPr : String(pulls[0]?.id ?? ''));
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [sev, setSev] = useState<Severity>('MEDIUM');
  const [status, setStatus] = useState<'ACCEPTED' | 'HELD'>('ACCEPTED');
  const [msg, setMsg] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => { first.current?.focus(); }, []);

  const create = async () => {
    setBusy(true);
    try {
      await write('/api/tickets', { pullRequestId: Number(pr), title, description: desc, severity: sev, status });
      closeDrawer(); toast('Ticket created');
    } catch (err) { setBusy(false); setMsg(err); }
  };

  if (pulls.length === 0) {
    return <div><div className="d-bar"><h3>New ticket</h3><CloseBtn /></div><p className="muted">There is no pull request to attach a ticket to yet.</p></div>;
  }
  return (
    <div>
      <div className="d-bar"><h3>New ticket</h3><CloseBtn /></div>
      <div className="field"><span className="small">Pull request</span>
        <select aria-label="Pull request" value={pr} onChange={(e) => setPr(e.target.value)}>{pulls.map((p) => <option key={p.id} value={String(p.id)}>{`#${p.number} ${p.title}`.slice(0, 70)}</option>)}</select>
      </div>
      <div className="field"><span className="small">Title</span><input ref={first} type="text" className="t-in" maxLength={200} placeholder="Ticket title" aria-label="Title" value={title} onChange={(e) => setTitle(e.target.value)} /></div>
      <div className="field"><span className="small">Description</span><textarea rows={6} maxLength={5000} placeholder="Describe the ticket…" aria-label="Description" value={desc} onChange={(e) => setDesc(e.target.value)} /></div>
      <div className="two field">
        <label className="f">Severity
          <select aria-label="Severity" value={sev} onChange={(e) => setSev(e.target.value as Severity)}>{SEVERITIES.map((v) => <option key={v} value={v}>{titleCase(v)}</option>)}</select>
        </label>
        <label className="f">State
          <select aria-label="State" value={status} onChange={(e) => setStatus(e.target.value as 'ACCEPTED' | 'HELD')}><option value="ACCEPTED">Accepted (blocks merge)</option><option value="HELD">Held</option></select>
        </label>
      </div>
      <div className="note">A manual ticket is never closed automatically. An accepted one keeps the pull request "Not ready" until you mark it done.</div>
      {msg != null && <ErrorBox error={msg} />}
      <div className="d-actions">
        <button type="button" className="btn primary" disabled={busy} onClick={() => void create()}>Create</button>
        <button type="button" className="btn" onClick={closeDrawer}>Cancel</button>
      </div>
    </div>
  );
}
