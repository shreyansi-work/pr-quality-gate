// One place for talking to the Nest API. Every successful write calls invalidate(),
// so every screen that shows data reloads by itself.

const listeners = new Set<() => void>();
export const onInvalidate = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const invalidate = () => listeners.forEach((fn) => fn());

export const getToken = () => { try { return localStorage.getItem('apiToken') ?? ''; } catch { return ''; } };
export const setToken = (t: string) => { try { localStorage.setItem('apiToken', t); } catch { /* storage blocked */ } };

export async function api<T = unknown>(path: string, body?: unknown, method?: 'GET' | 'POST' | 'PATCH' | 'DELETE', retried = false): Promise<T> {
  const res = await fetch(path, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { 'x-api-token': getToken(), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401 && !retried) {
    // The server has API_TOKEN set. Ask once, remember it, and try again.
    const t = window.prompt('This server needs an API token (the API_TOKEN value from the server .env):', getToken());
    if (t !== null && t.trim()) { setToken(t.trim()); return api<T>(path, body, method, true); }
  }
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = ((await res.json()) as { message?: string }).message ?? msg; } catch { /* not JSON */ }
    throw new Error(res.status === 401 ? 'Unauthorized: the API token is missing or wrong. Reload the page to enter it again.' : msg);
  }
  return res.json() as Promise<T>;
}

/** A write: runs the call, then tells every screen to reload. */
export async function write<T = unknown>(path: string, body?: unknown, method?: 'POST' | 'PATCH' | 'DELETE'): Promise<T> {
  const out = await api<T>(path, body ?? {}, method);
  invalidate();
  return out;
}
