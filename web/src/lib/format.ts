import type { Finding, Pull, Severity } from '../types';

export const base = (p: string) => p.split('/').pop() ?? p;
export const short = (sha?: string | null) => (sha ?? '').slice(0, 7);
export const words = (s: string) => s.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
export const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
export const tail = (p: string) => p.split('/').slice(-2).join('/');
export const key = (f: { id: number }) => `PRG-${f.id}`;
export const plural = (n: number, one: string, many?: string) => `${n} ${n === 1 ? one : (many ?? `${one}s`)}`;

// Findings saved before titles existed only have a long message. Cut it at the end of the first
// clause ("..., so ...", "..., leading to ...") and, if still long, at a word boundary.
export function firstSentence(text?: string | null): string {
  const t = (text ?? '').replace(/`/g, '').trim();
  const cut = t.search(/(?:[.!?;]|,\s+(?:so|which|leading|causing|because|and)\b)(?:\s|$)/);
  const s = (cut > 0 ? t.slice(0, cut) : t).replace(/[.,;:\s]+$/, '');
  if (s.length <= 70) return s;
  const space = s.lastIndexOf(' ', 68);
  return `${s.slice(0, space > 30 ? space : 68)}…`;
}

export const ttl = (f: Finding) => f.title || firstSentence(f.message) || words(f.category);
export const descOf = (f: Finding) => f.description ?? f.message;

export function ago(iso: string | number): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
export function age(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 3600) return '<1 h';
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} d`;
}
export function stamp(iso: string): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (Date.now() - d.getTime() > 6 * 864e5) return `${d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })} ${time}`;
  return `${d.toLocaleDateString('en-GB', { weekday: 'short' })} ${time}`;
}

type PrLink = Pick<Pull, 'repo' | 'number'>;
export const ghUrl = (pr: PrLink, tailPath = '') => `https://github.com/${pr.repo.split('/').map(encodeURIComponent).join('/')}/pull/${pr.number}${tailPath}`;
export const checksUrl = (pr: PrLink) => ghUrl(pr, '/checks');

export const SEV: Record<Severity, { n: number; word: string; cls: string }> = {
  HIGH: { n: 3, word: 'High', cls: 'sev-high' },
  MEDIUM: { n: 2, word: 'Medium', cls: 'sev-medium' },
  LOW: { n: 1, word: 'Low', cls: 'sev-low' },
};
export const SEV_RANK: Record<Severity, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
export const sevOf = (s: Severity) => SEV[s] ?? SEV.LOW;

/** Wording of a finding that is fixed: the same for every way it got fixed. */
export function doneLabel(t: Pick<Finding, 'ticketState'>): string {
  if (t.ticketState === 'FIXED_MANUAL') return 'Marked fixed by you';
  if (t.ticketState === 'CLOSED_PR') return 'Pull request closed';
  return 'Fixed by a later push';
}

/** [label, chip class] of one finding. */
export function findingStatus(f: Finding): [string, string] {
  if (f.status === 'NEW') return ['To decide', 'todo'];
  if (f.status === 'REJECTED') return ['Rejected', 'rej'];
  if (f.status === 'GONE' || f.column === 'FIXED') return ['Fixed', 'fix'];
  if (f.column === 'NEEDS_LOOK') return ['Needs a look', 'look'];
  if (f.column === 'HELD') return ['Held', 'held'];
  return ['Accepted', 'acc'];
}
export const isFixed = (f: Finding) => f.status === 'GONE' || f.column === 'FIXED';
export const statusNote = (f: Finding) => (isFixed(f) ? doneLabel(f) : '');

export function sourceLabel(f: Pick<Finding, 'source'>): string {
  if (f.source === 'MANUAL') return 'Created by you';
  if (f.source === 'RULE') return 'Rule check, no AI';
  return 'AI review';
}
export const sourceShort = (s: string) => (s === 'MANUAL' ? 'Manual' : s === 'RULE' ? 'Rule' : 'AI');

export function badgeOf(pr: Pull): { cls: string; label: string } {
  if (pr.prState && pr.prState !== 'open') return { cls: 'rej', label: titleCase(pr.prState) };
  switch (pr.readiness) {
    case 'READY': return { cls: 'fix', label: 'Ready to merge' };
    case 'NOT_READY': return { cls: 'acc', label: 'Gate closed' };
    case 'NEEDS_TRIAGE': return { cls: 'look', label: 'Needs your decision' };
    case 'FAILED': return { cls: 'acc', label: 'Review failed' };
    default: return { cls: 'rev', label: !pr.run || pr.run.status === 'QUEUED' ? 'Queued' : 'Reviewing' };
  }
}
