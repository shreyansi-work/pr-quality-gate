import { useCallback, useEffect, useRef, useState } from 'react';
import { api, onInvalidate } from './api';

export interface ApiState<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  reload: () => void;
}

/**
 * GET a path. Keeps the old data on screen while it reloads (no flashing).
 * Reloads after any write (invalidate) and, if pollMs returns a number, on a timer.
 */
export function useApi<T>(path: string, pollMs?: (data: T | null) => number): ApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const poll = useRef(pollMs);
  poll.current = pollMs;
  const dataRef = useRef<T | null>(null);

  const load = useCallback(async () => {
    const my = ++seq.current;
    try {
      const out = await api<T>(path);
      if (my !== seq.current) return;
      dataRef.current = out;
      setData(out);
      setError(null);
    } catch (e) {
      if (my === seq.current) setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, [path]);

  // a new path starts clean
  useEffect(() => { dataRef.current = null; setData(null); setError(null); setLoading(true); }, [path]);
  useEffect(() => { void load(); return onInvalidate(() => { void load(); }); }, [load]);

  // auto refresh, paused while someone is typing
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const tick = () => {
      const ms = poll.current?.(dataRef.current) ?? 0;
      if (ms > 0) {
        t = setTimeout(() => {
          const el = document.activeElement?.tagName;
          if (el !== 'INPUT' && el !== 'TEXTAREA') void load();
          tick();
        }, ms);
      } else {
        t = setTimeout(tick, 2000); // check again, the answer may change
      }
    };
    tick();
    return () => clearTimeout(t);
  }, [load]);

  return { data, error, loading, reload: () => { void load(); } };
}
