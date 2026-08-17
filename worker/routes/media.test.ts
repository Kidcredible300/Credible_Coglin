import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { call, callJson, inviteAndAccept, signUpCoach, stubResend } from './_helpers';

beforeAll(() => {
  stubResend();
});

// ------------------------------------------------------------------ fixtures

function join(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const ascii = (text: string) => new Uint8Array([...text].map((c) => c.charCodeAt(0)));
const be32 = (n: number) =>
  new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  return join(be32(data.length), ascii(type), data, be32(0));
}

/** A structurally valid PNG. Enough for sniffing, dimensions and stripping. */
function png(width: number, height: number, extra: Uint8Array[] = []): Uint8Array {
  return join(
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', join(be32(width), be32(height), new Uint8Array([8, 6, 0, 0, 0]))),
    ...extra,
    pngChunk('IDAT', new Uint8Array([0x78, 0x9c, 0x00])),
    pngChunk('IEND', new Uint8Array(0)),
  );
}

async function upload(
  cookie: string,
  bytes: Uint8Array,
  contentType = 'image/png',
): Promise<Response> {
  return call('/api/media', {
    method: 'POST',
    cookie,
    headers: { 'Content-Type': contentType },
    body: bytes as unknown as BodyInit,
  });
}

describe('upload', () => {
  it('stores an image and reports its real dimensions', async () => {
    const cookie = await signUpCoach(7100);
    const response = await upload(cookie, png(1200, 800));
    expect(response.status).toBe(201);

    const body = (await response.json()) as {
      id: string;
      url: string;
      width: number;
      height: number;
    };
    expect(body.width).toBe(1200);
    expect(body.height).toBe(800);
    expect(body.url).toBe(`/media/${body.id}`);

    const row = await env.DB.prepare('SELECT r2_key, bytes FROM media WHERE id = ?')
      .bind(body.id)
      .first<{ r2_key: string; bytes: number }>();
    // Key derives only from immutable ids, never from a user-editable label.
    expect(row?.r2_key).toMatch(/^teams\/[0-9a-f-]+\/[0-9a-f-]+\/[0-9a-f-]+\.png$/);
    expect(await env.MEDIA.get(row!.r2_key)).not.toBeNull();
  });

  it('strips metadata before anything is stored', async () => {
    // The reason this whole path is careful: students paste phone photos, and
    // phone photos carry GPS.
    const cookie = await signUpCoach(7101);
    const withGps = png(64, 64, [
      pngChunk('eXIf', ascii('GPSLatitude 42.3601 GPSLongitude -71.0589')),
      pngChunk('tEXt', ascii('Author\0A Student')),
    ]);
    const response = await upload(cookie, withGps);
    expect(response.status).toBe(201);
    const { id } = (await response.json()) as { id: string };

    const row = await env.DB.prepare('SELECT r2_key FROM media WHERE id = ?')
      .bind(id)
      .first<{ r2_key: string }>();
    const stored = await env.MEDIA.get(row!.r2_key);
    const text = await stored!.text();

    expect(text).not.toContain('GPSLatitude');
    expect(text).not.toContain('42.3601');
    expect(text).not.toContain('A Student');
  });

  it('rejects an SVG even when the header claims it is a PNG', async () => {
    // /media/* is same-origin, so a stored SVG is XSS against every teammate.
    const cookie = await signUpCoach(7102);
    const svg = ascii('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const response = await upload(cookie, svg, 'image/png');
    expect(response.status).toBe(415);
    expect(((await response.json()) as { error: string }).error).toBe(
      'unsupported_media_type',
    );

    // Scoped to this team: storage is isolated per test FILE, not per test, so
    // a global count would be measuring the fixtures of every test above.
    const count = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM media
        WHERE team_id = (SELECT id FROM teams WHERE team_number = 7102)`,
    ).first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it('rejects an empty body and an oversized file', async () => {
    const cookie = await signUpCoach(7103);
    expect((await upload(cookie, new Uint8Array(0))).status).toBe(400);

    const huge = join(png(4, 4), new Uint8Array(11 * 1024 * 1024));
    expect((await upload(cookie, huge)).status).toBe(413);
  });

  it('refuses uploads from a viewer', async () => {
    const coach = await signUpCoach(7104);
    const viewer = await inviteAndAccept(coach, { role: 'viewer', handle: 'guest' });
    expect((await upload(viewer.cookie, png(8, 8))).status).toBe(403);
  });
});

describe('serving', () => {
  it('returns the exact bytes with an immutable private cache', async () => {
    const cookie = await signUpCoach(7200);
    const { id } = (await (await upload(cookie, png(32, 32))).json()) as { id: string };

    const response = await call(`/media/${id}`, { cookie });
    expect(response.status).toBe(200);

    const cacheControl = response.headers.get('Cache-Control') ?? '';
    // The regression test for someone moving this route under /api, where the
    // no-store middleware would make every photo a fresh round trip forever.
    expect(cacheControl).not.toContain('no-store');
    expect(cacheControl).toContain('immutable');
    // `private`, never `public`: a per-tenant object in a shared cache is a
    // tenancy leak by HTTP semantics rather than by SQL.
    expect(cacheControl).toContain('private');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Vary')).toBe('Cookie');

    const served = new Uint8Array(await response.arrayBuffer());
    expect(served.length).toBeGreaterThan(0);
  });

  it('404s a missing id as JSON, not as the app shell', async () => {
    // Without the terminal /media/* handler this falls through to
    // not_found_handling: single-page-application, and a broken <img> receives
    // the whole app as HTML with a 200.
    const cookie = await signUpCoach(7201);
    const response = await call(`/media/${crypto.randomUUID()}`, { cookie });
    expect(response.status).toBe(404);
    expect(response.headers.get('Content-Type')).toContain('application/json');
    expect(await response.text()).not.toContain('<!doctype html');
  });

  it('requires a session', async () => {
    const cookie = await signUpCoach(7202);
    const { id } = (await (await upload(cookie, png(8, 8))).json()) as { id: string };
    expect((await call(`/media/${id}`)).status).toBe(401);
  });
});

describe('tenancy isolation', () => {
  it('never serves or lists one team\'s photos to another', async () => {
    const alpha = await signUpCoach(7300);
    const beta = await signUpCoach(7301);

    const betaMedia = (await (await upload(beta, png(100, 100))).json()) as {
      id: string;
    };

    // 404 rather than 403: a 403 confirms the object exists somewhere.
    const read = await call(`/media/${betaMedia.id}`, { cookie: alpha });
    expect(read.status).toBe(404);

    const list = await callJson<{ media: unknown[] }>('/api/media', { cookie: alpha });
    expect(list.body.media).toHaveLength(0);

    // Captioning another team's photo.
    expect(
      (
        await call(`/api/media/${betaMedia.id}`, {
          method: 'PATCH',
          cookie: alpha,
          body: JSON.stringify({ caption: 'ALPHA WAS HERE' }),
        })
      ).status,
    ).toBe(404);

    const row = await env.DB.prepare('SELECT caption FROM media WHERE id = ?')
      .bind(betaMedia.id)
      .first<{ caption: string | null }>();
    expect(row?.caption).toBeNull();
  });

  it('will not let a flag point at another team\'s photo', async () => {
    const alpha = await signUpCoach(7302);
    const beta = await signUpCoach(7303);
    const betaMedia = (await (await upload(beta, png(20, 20))).json()) as { id: string };

    const response = await callJson<{ error: string }>('/api/portfolio/candidates', {
      method: 'POST',
      cookie: alpha,
      body: JSON.stringify({ source_type: 'media', source_id: betaMedia.id }),
    });
    expect(response.status).toBe(404);
    expect(response.body.error).toBe('source_not_found');
  });
});
