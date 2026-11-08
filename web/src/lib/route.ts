import { useSyncExternalStore } from 'react';

// Hash routing, same links as before: #/  #/pr/5?f=48  #/tickets?pr=5
export type Route =
  | { name: 'pulls' }
  | { name: 'pr'; id: number; f: number | null }
  | { name: 'tickets'; pr: string | null };

const EVENT = 'app:route';

function read(): string { return location.hash; }

export function parseRoute(hash: string): Route {
  const [path, query = ''] = hash.replace(/^#/, '').split('?');
  const params = new URLSearchParams(query);
  const m = /^\/pr\/(\d+)$/.exec(path);
  if (m) return { name: 'pr', id: Number(m[1]), f: params.get('f') ? Number(params.get('f')) : null };
  if (path === '/tickets') return { name: 'tickets', pr: params.get('pr') };
  return { name: 'pulls' };
}

function subscribe(cb: () => void) {
  window.addEventListener('hashchange', cb);
  window.addEventListener(EVENT, cb);
  return () => { window.removeEventListener('hashchange', cb); window.removeEventListener(EVENT, cb); };
}

/** The current route. Re-renders when the hash changes. */
export function useHash(): string { return useSyncExternalStore(subscribe, read); }

/** Change the address without adding a history entry (used for the open finding and filters). */
export function replaceHash(hash: string) {
  history.replaceState(null, '', hash);
  window.dispatchEvent(new Event(EVENT));
}
