import { useEffect, useState } from 'react';
import { PageHeader } from '@/components/PageHeader';

type Health = {
  status: string;
  environment: string;
  db: string;
  dbError?: string;
  ms: number;
};

/**
 * The Phase 0 infrastructure check, kept out of the navigation. The CI smoke
 * test hits /api/health directly; this is for eyeballing a deploy.
 */
export default function Debug() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json() as Promise<Health>)
      .then(setHealth)
      .catch((e: unknown) => setError(String(e)));
  }, []);

  return (
    <>
      <PageHeader eyebrow="Infrastructure" title="Debug" />
      <div className="px-4 py-6 md:px-8">
        <div className="bg-card border-border max-w-md rounded-lg border p-4">
          {error && <p className="text-destructive text-sm">{error}</p>}
          {!health && !error && (
            <p className="text-muted-foreground text-sm">Checking…</p>
          )}
          {health && (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
              <dt className="text-muted-foreground">Status</dt>
              <dd
                className={
                  health.status === 'ok' ? 'text-readiness-ready' : 'text-destructive'
                }
              >
                {health.status}
              </dd>
              <dt className="text-muted-foreground">Environment</dt>
              <dd className="font-mono">{health.environment}</dd>
              <dt className="text-muted-foreground">D1</dt>
              <dd className="font-mono">{health.db}</dd>
              {health.dbError && (
                <>
                  <dt className="text-muted-foreground">D1 error</dt>
                  <dd className="text-destructive">{health.dbError}</dd>
                </>
              )}
              <dt className="text-muted-foreground">Latency</dt>
              <dd className="tabular font-mono">{health.ms} ms</dd>
            </dl>
          )}
        </div>
      </div>
    </>
  );
}
