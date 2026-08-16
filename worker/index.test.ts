import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from './index';

describe('/api/health', () => {
  it('reports ok and reaches D1', async () => {
    const request = new Request('http://example.com/api/health');
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; db: string };
    expect(body.status).toBe('ok');
    expect(body.db).toBe('ok');
  });
});

/**
 * Regression guard. A cached `/api/auth/me` is uniquely nasty: the login POST
 * still succeeds and writes a real session row, so the server looks healthy
 * from every angle, while the user is bounced back to the login screen forever
 * by a stale "not signed in" answer. It cannot be reproduced with curl.
 */
describe('API cache headers', () => {
  it('marks every /api response no-store and varying on Cookie', async () => {
    for (const path of ['/api/health', '/api/auth/me', '/api/members']) {
      const ctx = createExecutionContext();
      const response = await worker.fetch(
        new Request(`http://example.com${path}`),
        env,
        ctx,
      );
      await waitOnExecutionContext(ctx);

      expect(response.headers.get('Cache-Control')).toContain('no-store');
      // Without Vary, a shared cache may hand one signed-in user's response to
      // somebody else — a tenancy leak via HTTP rather than SQL.
      expect(response.headers.get('Vary')).toContain('Cookie');
    }
  });
});

describe('unknown API routes', () => {
  it('404s rather than falling through to the SPA shell', async () => {
    const request = new Request('http://example.com/api/nope');
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(404);
  });
});
