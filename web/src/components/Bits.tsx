import type { ReactNode } from 'react';
import type { Finding, Pull, Severity } from '../types';
import { badgeOf, findingStatus, sevOf, sourceShort } from '../lib/format';

export function Bars({ sev, big = false }: { sev: Severity; big?: boolean }) {
  const s = sevOf(sev);
  return (
    <span className={`bars ${s.cls}${big ? ' lg' : ''}`} title={`${s.word} severity`}>
      {[1, 2, 3].map((i) => <i key={i} className={i <= s.n ? 'on' : ''} style={{ height: big ? 6 + i * 4 : 4 + i * 3 }} />)}
    </span>
  );
}

export function SevWord({ sev }: { sev: Severity }) {
  const s = sevOf(sev);
  return <span className={`sev ${s.cls}`}><Bars sev={sev} /><span>{s.word}</span></span>;
}

export function Chip({ f }: { f: Finding }) {
  const [label, cls] = findingStatus(f);
  return <span className={`chip ${cls}`}>{label}</span>;
}

export function GateBadge({ pr }: { pr: Pull }) {
  const b = badgeOf(pr);
  return <span className={`chip ${b.cls}`}>{b.label}</span>;
}

export const SourceTag = ({ source }: { source: string }) => <span className="src">{sourceShort(source)}</span>;

/** Text with `inline code` between backticks. Rendered as text nodes, never as HTML. */
export function Rich({ text }: { text?: string | null }) {
  return <>{(text ?? '').split('`').map((part, i) => (i % 2 === 1 ? <code key={i} className="ic-code">{part}</code> : part))}</>;
}

export function ErrorBox({ error, retry, children }: { error?: unknown; retry?: () => void; children?: ReactNode }) {
  const text = error instanceof Error ? error.message : error ? String(error) : null;
  return (
    <div className="err" role="alert">
      {text ?? children}{retry && <> <button type="button" className="link-btn" onClick={retry}>Try again</button></>}
    </div>
  );
}

const Sk = ({ w, h }: { w: string; h: number }) => <div className="skel" style={{ height: h, width: w }} />;
export function Skeleton({ kind }: { kind: 'pulls' | 'pr' | 'tickets' }) {
  if (kind === 'tickets') return <><Sk w="220px" h={36} /><Sk w="100%" h={36} /><div className="board">{[0, 1, 2, 3].map((i) => <Sk key={i} w="100%" h={220} />)}</div></>;
  if (kind === 'pr') return <><Sk w="160px" h={18} /><Sk w="60%" h={40} /><Sk w="100%" h={150} /><Sk w="100%" h={64} /><Sk w="100%" h={320} /></>;
  return <><Sk w="240px" h={36} /><Sk w="100%" h={36} /><Sk w="100%" h={380} /></>;
}
