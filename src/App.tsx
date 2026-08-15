import { useEffect, useState } from 'react';
import { Link } from 'react-router';

type Health = {
  status: string;
  environment: string;
  db: string;
  dbError?: string;
  ms: number;
};

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json() as Promise<Health>)
      .then(setHealth)
      .catch((e) => setError(String(e)));
  }, []);

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="text-4xl font-bold tracking-tight">Coglin</h1>
      <p className="mt-2 text-slate-500">
        Season operations for <em>FIRST</em>® Tech Challenge teams.
      </p>

      <section className="mt-10 rounded-lg border border-slate-200 p-5 dark:border-slate-800">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Infrastructure check
        </h2>
        {error && <p className="mt-3 text-red-600">Request failed: {error}</p>}
        {!health && !error && (
          <p className="mt-3 text-slate-500">Checking…</p>
        )}
        {health && (
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
            <dt className="text-slate-500">Status</dt>
            <dd
              className={
                health.status === 'ok' ? 'text-green-600' : 'text-red-600'
              }
            >
              {health.status}
            </dd>
            <dt className="text-slate-500">Environment</dt>
            <dd>{health.environment}</dd>
            <dt className="text-slate-500">D1</dt>
            <dd>{health.db}</dd>
            {health.dbError && (
              <>
                <dt className="text-slate-500">D1 error</dt>
                <dd className="text-red-600">{health.dbError}</dd>
              </>
            )}
            <dt className="text-slate-500">Latency</dt>
            <dd>{health.ms} ms</dd>
          </dl>
        )}
      </section>

      <p className="mt-6 text-sm text-slate-500">
        SPA routing check:{' '}
        <Link className="text-blue-600 underline" to="/board/build">
          /board/build
        </Link>{' '}
        — reload that URL directly; it must render, not 404.
      </p>
    </main>
  );
}
