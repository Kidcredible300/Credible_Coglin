import { Hono } from 'hono';
import { auth } from './routes/auth';
import { invites } from './routes/invites';
import { team } from './routes/team';
import type { AppEnv } from './lib/tenancy';

const app = new Hono<AppEnv>();

// Health check. Touches D1 on purpose — a 200 here means the binding resolved,
// not just that the Worker booted. Phase 0 verification depends on that.
app.get('/api/health', async (c) => {
  const started = Date.now();
  let db: 'ok' | 'error' = 'ok';
  let dbError: string | undefined;

  try {
    await c.env.DB.prepare('SELECT 1').first();
  } catch (err) {
    db = 'error';
    dbError = err instanceof Error ? err.message : String(err);
  }

  return c.json(
    {
      status: db === 'ok' ? 'ok' : 'degraded',
      environment: c.env.ENVIRONMENT ?? 'local',
      db,
      dbError,
      ms: Date.now() - started,
    },
    db === 'ok' ? 200 : 503,
  );
});

app.route('/api/auth', auth);
app.route('/api/invites', invites);
app.route('/api', team);

app.all('/api/*', (c) => c.json({ error: 'not_found' }, 404));

export default app;
