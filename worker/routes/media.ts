/**
 * Image upload and serving (COG-008, the slice meetings needs).
 *
 * Students paste photos straight into their notes, so this path carries files
 * taken by minors on their own phones. Two consequences shape everything here:
 *
 *   - Every upload is stripped of metadata before it is stored. Phone JPEGs
 *     carry GPS, media is served to the whole team, and the nightly backup
 *     copies it into R2 — so an unstripped upload publishes a child's home
 *     location to the roster and to every future restore of that dump.
 *   - The format is decided by the file's own magic bytes, never the header the
 *     client sent. `/media/*` is same-origin, so an SVG accepted as an image
 *     would be stored XSS against every teammate's session.
 *
 * The read route deliberately does NOT live under `/api`, because the no-store
 * middleware in index.ts would make every image a fresh round trip forever.
 */
import { Hono } from 'hono';
import { nowSeconds, uuid } from '../lib/crypto';
import {
  ALLOWED_TYPES,
  dimensions,
  EXTENSIONS,
  sniff,
  stripMetadata,
} from '../lib/images';
import { optionalString, readJson } from '../lib/http';
import {
  auth as authOf,
  denyRole,
  requireMember,
  sameOriginOnly,
  type AppEnv,
} from '../lib/tenancy';

const media = new Hono<AppEnv>();

/**
 * Per file. The client downscales to 2000px before uploading, so anything this
 * large is a client that failed to and a bill we would rather not pay.
 */
const MAX_BYTES = 10 * 1024 * 1024;
/** Per team per season. Roughly a thousand photos, which is a generous season. */
const MAX_TEAM_BYTES = 2 * 1024 * 1024 * 1024;

// ------------------------------------------------------------------- upload

media.post('/', sameOriginOnly, requireMember, denyRole('viewer'), async (c) => {
  const { teamId, member } = authOf(c);

  const season = await c.env.DB.prepare(
    'SELECT id FROM seasons WHERE team_id = ? AND is_current = 1',
  )
    .bind(teamId)
    .first<{ id: string }>();
  if (!season) return c.json({ error: 'no_current_season' }, 409);

  // Checked twice on purpose: Content-Length lets an oversized upload be
  // refused before its bytes are read, and the second check catches a chunked
  // request that simply lied about its length.
  const declared = Number(c.req.header('Content-Length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_BYTES) {
    return c.json({ error: 'file_too_large', max_bytes: MAX_BYTES }, 413);
  }

  const buffer = await c.req.arrayBuffer();
  const raw = new Uint8Array(buffer);
  if (raw.byteLength === 0) return c.json({ error: 'empty_body' }, 400);
  if (raw.byteLength > MAX_BYTES) {
    return c.json({ error: 'file_too_large', max_bytes: MAX_BYTES }, 413);
  }

  const sniffed = sniff(raw);
  if (!sniffed || !ALLOWED_TYPES.includes(sniffed)) {
    // One code for "not an image" and "an image we do not accept". The client
    // maps it to copy naming the formats; the server does not owe a prober a
    // breakdown of what it recognised.
    return c.json(
      { error: 'unsupported_media_type', allowed: ALLOWED_TYPES },
      415,
    );
  }

  const usage = await c.env.DB.prepare(
    'SELECT COALESCE(SUM(bytes), 0) AS used FROM media WHERE team_id = ? AND season_id = ?',
  )
    .bind(teamId, season.id)
    .first<{ used: number }>();
  if ((usage?.used ?? 0) + raw.byteLength > MAX_TEAM_BYTES) {
    return c.json({ error: 'quota_exceeded', max_bytes: MAX_TEAM_BYTES }, 507);
  }

  const cleaned = stripMetadata(raw, sniffed);
  const size = dimensions(cleaned, sniffed);

  const id = uuid();
  // Both path segments are uuids rather than labels: a key must derive only
  // from immutable identifiers, and `seasons.label` is user-editable text.
  const key = `teams/${teamId}/${season.id}/${id}.${EXTENSIONS[sniffed]}`;
  const now = nowSeconds();

  await c.env.MEDIA.put(key, cleaned, {
    httpMetadata: { contentType: sniffed },
  });

  try {
    await c.env.DB.prepare(
      `INSERT INTO media
         (id, team_id, season_id, r2_key, kind, bytes, width, height, caption,
          tags, uploaded_by, created_at)
       VALUES (?, ?, ?, ?, 'photo', ?, ?, ?, NULL, '[]', ?, ?)`,
    )
      .bind(
        id,
        teamId,
        season.id,
        key,
        cleaned.byteLength,
        size?.width ?? null,
        size?.height ?? null,
        member.id,
        now,
      )
      .run();
  } catch (err) {
    // Do not leave an orphan object paying rent in R2 for a row that does not
    // exist. The reverse order — row first — would leave a media id that 404s.
    await c.env.MEDIA.delete(key).catch(() => undefined);
    throw err;
  }

  return c.json(
    {
      id,
      url: `/media/${id}`,
      content_type: sniffed,
      bytes: cleaned.byteLength,
      width: size?.width ?? null,
      height: size?.height ?? null,
    },
    201,
  );
});

// --------------------------------------------------------------------- list

media.get('/', requireMember, async (c) => {
  const { teamId } = authOf(c);
  const { results } = await c.env.DB.prepare(
    `SELECT id, season_id, kind, bytes, width, height, caption, uploaded_by, created_at
       FROM media WHERE team_id = ? ORDER BY created_at DESC LIMIT 200`,
  )
    .bind(teamId)
    .all();
  return c.json({ media: results });
});

media.patch('/:id', sameOriginOnly, requireMember, denyRole('viewer'), async (c) => {
  const body = await readJson(c);
  if (!body) return c.json({ error: 'invalid_body' }, 400);
  const { teamId } = authOf(c);

  const result = await c.env.DB.prepare(
    'UPDATE media SET caption = ? WHERE id = ? AND team_id = ?',
  )
    .bind(optionalString(body.caption, 500), c.req.param('id'), teamId)
    .run();
  if (result.meta.changes === 0) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true });
});

export { media };

// ------------------------------------------------------------------ serving

/**
 * Mounted at `/media`, outside `/api`, so images can actually be cached.
 *
 * Every request still costs a session read, a membership read and a media read
 * before a byte streams — three D1 rows — so a meeting with ten photos would be
 * thirty rows on every single open without the cache header below.
 */
const mediaFiles = new Hono<AppEnv>();

mediaFiles.get('/:id', requireMember, async (c) => {
  const { teamId } = authOf(c);

  // D1 first, always. R2 is never consulted with a key the tenancy check has
  // not already approved.
  const row = await c.env.DB.prepare(
    'SELECT r2_key, kind FROM media WHERE id = ? AND team_id = ?',
  )
    .bind(c.req.param('id'), teamId)
    .first<{ r2_key: string }>();
  // 404 rather than 403: a 403 would confirm the object exists on another team.
  if (!row) return c.json({ error: 'not_found' }, 404);

  const object = await c.env.MEDIA.get(row.r2_key, {
    onlyIf: c.req.raw.headers,
  });
  if (!object) {
    // The row exists and the object does not, which means a delete went half
    // way. Worth being loud about rather than silently 404ing.
    console.error('media object missing for key', row.r2_key);
    return c.json({ error: 'not_found' }, 404);
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('ETag', object.httpEtag);
  // `private`, never `public`: a per-tenant object in a shared cache is a
  // tenancy leak by HTTP semantics rather than by SQL. `immutable` is safe
  // because media is write-once — no route mutates the bytes at a given id.
  headers.set('Cache-Control', 'private, max-age=31536000, immutable');
  headers.set('Vary', 'Cookie');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Content-Disposition', 'inline');

  if (!('body' in object) || object.body === null) {
    // onlyIf matched, so the client's copy is current.
    return new Response(null, { status: 304, headers });
  }

  return new Response(object.body, { headers });
});

/**
 * Terminal 404 for anything else under /media.
 *
 * Without this a miss falls through to the assets handler, whose
 * `not_found_handling: single-page-application` hands back index.html with a
 * 200 — so a broken `<img>` would receive the entire app as HTML and no error
 * would ever surface.
 */
mediaFiles.all('/*', (c) => c.json({ error: 'not_found' }, 404));

export { mediaFiles };
