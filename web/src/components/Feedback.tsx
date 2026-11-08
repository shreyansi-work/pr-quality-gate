import { useEffect, useRef, useState } from 'react';

// ---- toast: bottom centre, 3 seconds. Call toast('text') from anywhere. ----
let pushToast: (t: string) => void = () => {};
export const toast = (text: string) => pushToast(text);

export function ToastHost() {
  const [text, setText] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    pushToast = (t) => { setText(t); clearTimeout(timer.current); timer.current = setTimeout(() => setText(null), 3000); };
    return () => { pushToast = () => {}; clearTimeout(timer.current); };
  }, []);
  return text ? <div className="toast" role="status">{text}</div> : null;
}

// ---- dialogs: confirmDialog() and reasonDialog() return promises, like window.confirm. ----
type Req =
  | { kind: 'confirm'; title: string; text: string; ok: string; resolve: (v: boolean) => void }
  | { kind: 'reason'; title: string; text: string; resolve: (v: string | null) => void };
let openDialog: (r: Req) => void = () => {};

export const confirmDialog = (title: string, text: string, ok: string) =>
  new Promise<boolean>((resolve) => openDialog({ kind: 'confirm', title, text, ok, resolve }));
/** Ask for the reason of a reject. Resolves the text, or null when cancelled. */
export const reasonDialog = (title: string, text: string) =>
  new Promise<string | null>((resolve) => openDialog({ kind: 'reason', title, text, resolve }));

export function DialogHost() {
  const [req, setReq] = useState<Req | null>(null);
  useEffect(() => { openDialog = setReq; return () => { openDialog = () => {}; }; }, []);
  if (!req) return null;
  return <DialogBody key={req.title + req.text} req={req} close={() => setReq(null)} />;
}

function DialogBody({ req, close }: { req: Req; close: () => void }) {
  const [reason, setReason] = useState('');
  const [warn, setWarn] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const cancelBtn = useRef<HTMLButtonElement>(null);

  const finish = (v: boolean | string | null) => {
    if (req.kind === 'confirm') req.resolve(v === true); else req.resolve(typeof v === 'string' ? v : null);
    close();
  };
  const cancel = () => finish(req.kind === 'confirm' ? false : null);

  useEffect(() => {
    (req.kind === 'reason' ? field.current : cancelBtn.current)?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); cancel(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const go = () => {
    if (!reason.trim()) { setWarn(true); field.current?.focus(); return; }
    finish(reason.trim());
  };

  return (
    <div id="dialog-root">
      <div className="overlay" style={{ zIndex: 59 }} onClick={cancel} />
      <div className="dialog" role="alertdialog" aria-label={req.title}>
        <h3>{req.title}</h3>
        <p>{req.text}</p>
        {req.kind === 'reason' && (
          <>
            <textarea ref={field} rows={3} maxLength={500} placeholder="Why is this not a problem?" aria-label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} />
            {warn && <div className="err">Write a short reason to reject.</div>}
          </>
        )}
        <div className="btn-row">
          <button type="button" className="btn" ref={cancelBtn} onClick={cancel}>Cancel</button>
          {req.kind === 'confirm'
            ? <button type="button" className="btn danger" onClick={() => finish(true)}>{req.ok}</button>
            : <button type="button" className="btn danger" onClick={go}>Reject</button>}
        </div>
      </div>
    </div>
  );
}
