import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Decision, FindingFull, Finding, PullDetail } from '../types';
import { write } from '../lib/api';
import { useApi } from '../lib/useApi';
import { ago, base as fileName, descOf, ghUrl, key, short, sourceLabel, titleCase, ttl } from '../lib/format';
import { openTicket } from '../lib/drawer';
import { Bars, Chip, ErrorBox, Rich } from './Bits';
import { Icon, type IconName } from './Icon';
import { IconButton } from './Controls';
import { toast } from './Feedback';
import { replaceHash } from '../lib/route';

export interface ModalNav { prevId: number | null; nextId: number | null; at: number; total: number; afterDecision: () => number | null }

const VERBS: Record<Decision, string> = {
  ACCEPT: 'Accepted. A ticket was created.', HOLD: 'Put on hold. A ticket was created.',
  REJECT: 'Rejected. The reason is kept.', UNREJECT: 'Moved back to triage',
};

export function DetailModal({ f, pr, hashBase, nav }: { f: Finding; pr: PullDetail; hashBase: string; nav: ModalNav }) {
  const close = () => replaceHash(hashBase);
  const go = (id: number | null) => { if (id != null) replaceHash(`${hashBase}?f=${id}`); };
  const { prevId, nextId } = nav;

  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const [warn, setWarn] = useState<ReactNode>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const reasonField = useRef<HTMLInputElement>(null);
  const { data: full } = useApi<FindingFull>(`/api/findings/${f.id}`);

  // each finding starts clean, and the page behind the modal does not scroll
  useEffect(() => { setReason(''); setWarn(null); setBusy(false); dialog.current?.focus(); }, [f.id]);
  useEffect(() => { document.body.style.overflow = 'hidden'; return () => { document.body.style.overflow = ''; }; }, []);

  // Escape closes, left and right arrows move between findings
  const latest = useRef({ close, prevId, nextId });
  latest.current = { close, prevId, nextId };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.getElementById('dialog-root')) return;
      if (e.key === 'Escape') { e.preventDefault(); latest.current.close(); return; }
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '');
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'ArrowLeft') go(latest.current.prevId);
      if (e.key === 'ArrowRight') go(latest.current.nextId);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** One API call. stay: remain on this finding, else move to the next one waiting for you. */
  const run = async (path: string, body: object, okText: string, opts: { stay?: boolean; needReason?: boolean } = {}) => {
    if (opts.needReason && !reason.trim()) {
      setWarn(<div className="err">Write a short reason to reject. It is kept, so the same finding stays rejected on later pushes.</div>);
      reasonField.current?.focus();
      return;
    }
    setBusy(true);
    try {
      const next = opts.stay ? null : nav.afterDecision();
      await write(`/api/findings/${f.id}/${path}`, body);
      toast(okText);
      if (next != null) go(next); else if (!opts.stay) close();
      setBusy(false);
    } catch (err) {
      setBusy(false);
      setWarn(<ErrorBox error={err} />);
    }
  };
  const decide = (decision: Decision, okText = VERBS[decision], opts?: { stay?: boolean; needReason?: boolean }) =>
    run('triage', decision === 'REJECT' ? { decision, reason } : { decision }, okText, opts);

  const Dec = ({ cls, icon, label, onClick }: { cls: string; icon: IconName; label: string; onClick: () => void }) =>
    <button type="button" className={`dec ${cls}`.trim()} disabled={busy} onClick={onClick}><Icon name={icon} />{label}</button>;
  const reasonRow = (
    <label className="f">Reason (needed only to reject)
      <input ref={reasonField} type="text" maxLength={500} placeholder="Why is this not a problem?" aria-label="Reason for rejecting" value={reason} onChange={(e) => setReason(e.target.value)} />
    </label>
  );

  let foot: ReactNode;
  if (f.status === 'NEW') {
    foot = (
      <>
        <div className="row">
          <b>Your decision</b>
          <Dec cls="ok" icon="check" label="Accept" onClick={() => decide('ACCEPT')} />
          <Dec cls="hd" icon="hold" label="Hold" onClick={() => decide('HOLD')} />
          <Dec cls="no" icon="cross" label="Reject" onClick={() => decide('REJECT', undefined, { needReason: true })} />
          <span className="grow" /><span className="muted small">Accept blocks merge. Hold does not.</span>
        </div>
        {reasonRow}{warn}
        <div className="muted small">After you decide, the next finding opens. Accepted and held findings become tickets on the <a href={`#/tickets?pr=${pr.id}`}>ticket board</a>.</div>
      </>
    );
  } else if (f.status === 'GONE') {
    foot = (
      <>
        <div className="row"><b>Fixed</b><Chip f={f} /></div>
        <div className="muted">{f.closeReason ?? 'The problem is no longer in the code. It was fixed before you made a decision.'}</div>
        <div className="muted small">Nothing to decide. If the problem comes back in a later push, it returns to triage.</div>
        <div className="m-links"><a className="btn" href={`#/tickets?pr=${pr.id}`}><Icon name="board" />See on the ticket board</a></div>
      </>
    );
  } else if (f.status === 'REJECTED') {
    foot = (
      <>
        <div className="row">
          <b>Rejected</b><Chip f={f} /><span className="grow" />
          <Dec cls="" icon="undo" label="Un-reject" onClick={() => decide('UNREJECT', VERBS.UNREJECT, { stay: true })} />
        </div>
        <div className="muted">{f.rejectReason ? `Reason: ${f.rejectReason}` : 'No reason was given.'}</div>{warn}
      </>
    );
  } else {
    const fixed = f.column === 'FIXED';
    foot = (
      <>
        <div className="row">
          <b>Ticket {key(f)}</b><Chip f={f} /><span className="grow" />
          {fixed ? <Dec cls="" icon="undo" label="Reopen" onClick={() => run('reopen', {}, 'Ticket reopened', { stay: true })} /> : (
            <>
              <Dec cls="ok" icon="check" label="Confirm fixed" onClick={() => run('fixed', {}, 'Marked as fixed', { stay: true })} />
              {f.status === 'HELD'
                ? <Dec cls="" icon="check" label="Move to Accepted" onClick={() => decide('ACCEPT', 'Moved to Accepted', { stay: true })} />
                : <Dec cls="hd" icon="hold" label="Put on hold" onClick={() => decide('HOLD', 'Put on hold', { stay: true })} />}
              {f.column === 'NEEDS_LOOK' && <Dec cls="" icon="undo" label="Still a problem" onClick={() => run('reopen', {}, 'Still a problem. Ticket reopened', { stay: true })} />}
              <Dec cls="no" icon="cross" label="Reject" onClick={() => decide('REJECT', undefined, { stay: true, needReason: true })} />
            </>
          )}
        </div>
        {f.closeReason && <div className="muted">{f.closeReason}</div>}
        {!fixed && reasonRow}{warn}
        <div className="m-links">
          {/* the ticket drawer replaces the modal, so only one panel is open at a time */}
          <button type="button" className="btn" onClick={() => { close(); openTicket(f.id); }}>Open ticket {key(f)}</button>
          <a className="btn" href={`#/tickets?pr=${pr.id}`}><Icon name="board" />See on the ticket board</a>
        </div>
      </>
    );
  }

  const events = [...(full?.events ?? [])].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  const sevCls = f.severity === 'HIGH' ? 'acc' : f.severity === 'MEDIUM' ? 'look' : 'rev';
  const stLabel = f.status === 'GONE' || f.column === 'FIXED' ? 'Fixed' : f.status === 'NEW' ? 'To decide' : f.status === 'REJECTED' ? 'Rejected' : f.column === 'HELD' ? 'Held' : f.column === 'NEEDS_LOOK' ? 'Needs a look' : 'Accepted';
  const copy = async () => { try { await navigator.clipboard.writeText(location.href); toast('Link copied'); } catch { toast('Copy the address from the browser bar'); } };

  return (
    <div>
      <div className="overlay" onClick={close} />
      <div className="modal-wrap" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
        <div className="modal" ref={dialog} role="dialog" aria-modal="true" aria-label={`Finding: ${ttl(f)}`} tabIndex={-1}>
          <div className="m-bar">
            <IconButton icon="left" label="Previous finding" disabled={prevId == null} onClick={() => go(prevId)} />
            <IconButton icon="right" label="Next finding" disabled={nextId == null} onClick={() => go(nextId)} />
            <span className="muted">{nav.at >= 0 ? `${nav.at + 1} of ${nav.total} in this list` : 'Not in the current list'}</span>
            <span className="grow" />
            <IconButton icon="link" label="Copy link to this finding" onClick={copy} />
            <a className="ibtn" href={ghUrl(pr, '/files')} target="_blank" rel="noopener noreferrer" aria-label="Open the changed files on GitHub" title="Open on GitHub"><Icon name="out" /></a>
            <IconButton icon="cross" label="Close (Esc)" onClick={close} />
          </div>
          <div className="m-body">
            <div>
              <div className="m-chips">
                <span className={`chip ${sevCls}`}><Bars sev={f.severity} />{titleCase(f.severity)} severity</span>
                <Chip f={f} />
                <span className="chip rej">{sourceLabel(f)}</span>
              </div>
              <h2>{ttl(f)}</h2>
              {f.file && <div className="loc">{f.file}{f.functionName && ` · ${f.functionName}()`}</div>}
            </div>
            {f.quote && (
              <div className="codebox">
                <div className="cap"><span>{f.file ? fileName(f.file) : 'Ticket'}</span><span>{stLabel}</span></div>
                <pre className="code">{f.quote}</pre>
              </div>
            )}
            <div><div className="lab">{f.source === 'MANUAL' ? 'Description' : 'What is wrong'}</div><div className="d-text"><Rich text={descOf(f)} /></div></div>
            {f.suggestedFix && <div><div className="lab">Suggested fix</div><div className="d-text"><Rich text={f.suggestedFix} /></div></div>}
            <div className="facts">
              {f.confidence && <div><div className="lab">Confidence</div>{titleCase(f.confidence)}</div>}
              {pr.run?.model && f.source === 'AI' && <div><div className="lab">Model</div><span className="mono">{fileName(pr.run.model)}</span></div>}
              <div><div className="lab">Found in</div><span className="mono">{short(pr.headSha)}</span></div>
              <div><div className="lab">Fingerprint</div><span className="mono">{f.fingerprint.slice(0, 4)}…{f.fingerprint.slice(-4)}</span></div>
            </div>
            <div>
              <div className="lab">History</div>
              <div className="hist">
                {events.length === 0
                  ? <div><i className="new" />Found by the {sourceLabel(f).toLowerCase()} · {ago(f.createdAt)}</div>
                  : events.map((e, i) => <div key={e.id ?? i}><i className={i === 0 ? 'new' : ''} />{e.message} · {ago(e.createdAt)}</div>)}
              </div>
            </div>
          </div>
          <div className="m-dec">{foot}</div>
        </div>
      </div>
    </div>
  );
}

