import { Link, useParams } from 'react-router';

export default function Board() {
  const { slug } = useParams();

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="text-2xl font-bold">Board: {slug}</h1>
      <p className="mt-2 text-slate-500">
        Placeholder. Real boards land in Phase 2 (COG-011).
      </p>
      <p className="mt-6 text-sm">
        If you reached this by reloading the URL directly, SPA fallback routing
        is configured correctly.
      </p>
      <Link className="mt-4 inline-block text-blue-600 underline" to="/">
        ← Back
      </Link>
    </main>
  );
}
