/**
 * Team, season and roster reads (COG-010, first slice).
 *
 * Every query here filters on `teamId` taken from `authOf(c)` — the session's
 * membership row — and none of them accept a team identifier from the request.
 * That is the whole tenancy rule in practice; see `worker/lib/tenancy.ts`.
 */
import { Hono } from 'hono';
import { auth as authOf, requireMember, type AppEnv } from '../lib/tenancy';

const team = new Hono<AppEnv>();

team.get('/team', requireMember, async (c) => {
  const { teamId } = authOf(c);
  const row = await c.env.DB.prepare(
    'SELECT id, team_number, name, region, created_at FROM teams WHERE id = ?',
  )
    .bind(teamId)
    .first();
  if (!row) return c.json({ error: 'not_found' }, 404);
  return c.json(row);
});

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
