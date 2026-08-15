import { useEffect, useState } from 'react';

type State<T> =
  | { status: 'loading'; data: null; error: null }
  | { status: 'ready'; data: T; error: null }
  | { status: 'error'; data: null; error: Error };

/**
 * Minimal data-fetching hook for the mock layer.
 *
 * Not a cache and not a query library — Phase 1 will decide whether this app
 * needs one once there are real requests, real invalidation and real polling
 * (plan §8). Introducing TanStack Query now would be choosing an answer before
 * the question exists.
 */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []): State<T> {
  const [state, setState] = useState<State<T>>({
    status: 'loading',
    data: null,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading', data: null, error: null });
    fn()
      .then((data) => {
        if (!cancelled) setState({ status: 'ready', data, error: null });
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setState({
            status: 'error',
            data: null,
            error: e instanceof Error ? e : new Error(String(e)),
          });
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return state;
}
