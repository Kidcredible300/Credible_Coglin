/**
 * Team, season and roster reads (COG-010, first slice).
 *
 * Every query here filters on `teamId` taken from `authOf(c)` — the session's
 * membership row — and none of them accept a team identifier from the request.
 * That is the whole tenancy rule in practice; see `worker/lib/tenancy.ts`.
 */
import { Hono } from 'hono';
import { readJson, optionalString } from '../lib/http';
import { isValidTimeZone } from '../lib/tz';
import {
  auth as authOf,
  requireMember,
  requireRole,
  sameOriginOnly,
  type AppEnv,
} from '../lib/tenancy';

const team = new Hono<AppEnv>();

team.get('/team', requireMember, async (c) => {
  const { teamId } = authOf(c);
  const row = await c.env.DB.prepare(
    'SELECT id, team_number, name, region, timezone, created_at FROM teams WHERE id = ?',
  )
    .bind(teamId)
    .first();
  if (!row) return c.json({ error: 'not_found' }, 404);
  return c.json(row);
});

/**
 * Coach-only, and the timezone is why this route exists at all.
 *
 * A recurring meeting is stored as a wall-clock rule, so the team's zone is
 * what every occurrence is resolved against. Getting it wrong does not fail —
 * it materialises a whole season an hour off — so it is a coach's decision and
 * it is validated against the runtime's own tz database rather than a list we
 * would have to maintain.
 *
 * Changing it deliberately does NOT re-resolve series that already exist: each
 * series snapshots the zone it was created with, so a correction here applies
 * to what gets scheduled next rather than silently moving meetings already on
 * the calendar.
 */
team.patch(
  '/team',
  sameOriginOnly,
  requireMember,
  requireRole('coach'),
  async (c) => {
    const body = await readJson(c);
    if (!body) return c.json({ error: 'invalid_body' }, 400);

    const { teamId } = authOf(c);
    const sets: string[] = [];
    const values: unknown[] = [];

    if (body.name !== undefined) {
      const name = optionalString(body.name, 120);
      if (!name) return c.json({ error: 'invalid_name' }, 400);
      sets.push('name = ?');
      values.push(name);
    }
    if (body.region !== undefined) {
      sets.push('region = ?');
      values.push(optionalString(body.region, 120));
    }
    if (body.timezone !== undefined) {
      if (!isValidTimeZone(body.timezone)) {
        return c.json({ error: 'invalid_timezone' }, 400);
      }
      sets.push('timezone = ?');
      values.push(body.timezone);
    }

    if (sets.length === 0) return c.json({ error: 'nothing_to_update' }, 400);

    await c.env.DB.prepare(`UPDATE teams SET ${sets.join(', ')} WHERE id = ?`)
      .bind(...values, teamId)
      .run();

    const row = await c.env.DB.prepare(
      'SELECT id, team_number, name, region, timezone, created_at FROM teams WHERE id = ?',
    )
      .bind(teamId)
      .first();
    return c.json(row);
  },
);

team.get('/season/current', requireMember, async (c) => {
  const { teamId } = authOf(c);
  const row = await c.env.DB.prepare(
    `SELECT id, team_id, label, starts_at, ends_at, is_current
       FROM seasons WHERE team_id = ? AND is_current = 1`,
  )
    .bind(teamId)
    .first();
  if (!row) return c.json({ error: 'not_found' }, 404);
  return c.json(row);
});

/**
 * The roster. `sub_teams` is stored as a json string and parsed here so the
 * client receives the array shape `src/types.ts` declares — the mock fixtures
 * already return arrays, so parsing server-side is what lets the swap in
 * `src/lib/api.ts` happen without touching Roster.tsx.
 *
 * Note there is no password, no email and no user id in the projection. The
 * roster screen needs none of them, and a student's row should carry as little
 * as possible past the API boundary.
 */
team.get('/members', requireMember, async (c) => {
  const { teamId } = authOf(c);
  const { results } = await c.env.DB.prepare(
    `SELECT id, team_id, user_id, role, sub_teams, display_name, handle, status, created_at
       FROM members
      WHERE team_id = ? AND status = 'active'
      ORDER BY created_at ASC`,
  )
    .bind(teamId)
    .all<{ sub_teams: string; user_id: string }>();

  return c.json(
    results.map(({ user_id: _userId, ...m }) => ({
      ...m,
      sub_teams: JSON.parse(m.sub_teams) as string[],
    })),
  );
});

export { team };
