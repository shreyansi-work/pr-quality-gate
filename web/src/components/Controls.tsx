import type { ReactNode } from 'react';
import { Icon } from './Icon';

export function SearchBox({ placeholder, value, label, onChange }: { placeholder: string; value: string; label: string; onChange: (v: string) => void }) {
  return (
    <label className="search">
      <Icon name="search" /><span className="sr">{label}</span>
      <input type="search" placeholder={placeholder} value={value} aria-label={label} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

/** A select with its name inside the box ("Severity  All"). pad = space for the name, in px. */
export function Pick({ label, pad, options, value, onChange }: { label: string; pad: number; options: [string, string][]; value: string; onChange: (v: string) => void }) {
  return (
    <span className="selw">
      <span>{label}</span>
      <select aria-label={label} style={{ ['--pad' as string]: `${pad}px` }} value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
      </select>
    </span>
  );
}

export function Tabs<K extends string>({ items, active, onPick, label }: { items: [K, string, number?][]; active: K; onPick: (k: K) => void; label: string }) {
  return (
    <div className="tabs" role="group" aria-label={label}>
      {items.map(([k, name, n]) => (
        <button key={k} type="button" className={`tab${k === active ? ' on' : ''}`} aria-pressed={k === active} onClick={() => onPick(k)}>
          {name}{n != null && <b className="muted">{n}</b>}
        </button>
      ))}
    </div>
  );
}

export function IconButton({ icon, label, className = '', onClick, disabled, children }: { icon: Parameters<typeof Icon>[0]['name']; label: string; className?: string; onClick?: () => void; disabled?: boolean; children?: ReactNode }) {
  return <button type="button" className={`ibtn ${className}`.trim()} aria-label={label} title={label} onClick={onClick} disabled={disabled}><Icon name={icon} />{children}</button>;
}
