/**
 * Meetings and recurring series (COG-036, phase 1).
 *
 * Every statement that names a meeting carries `AND team_id = ?` in its WHERE
 * clause rather than fetching first and checking afterwards. That is not style:
 * it makes a cross-tenant read *unexpressible* in a handler instead of merely
 * guarded, and it means a foreign id answers 404 rather than 403. A 403 would
 * confirm the row exists on somebody else's team, which is a slower leak of the
 * same information.
 */
import { Hono } from 'hono';
import { nowSeconds, uuid } from '../lib/crypto';
import { boundedInt, optionalString, readJson } from '../lib/http';
import { isMeetingKind, isMeetingStatus } from '../lib/meetings';
import { localDateInZone, toSlot } from '../lib/tz';
import {
  auth as authOf,
  requireMember,
  requireRole,
  sameOriginOnly,
  type AppEnv,
} from '../lib/tenancy';

const meetings = new Hono<AppEnv>();

/** Long enough for a competition day, short enough to catch a units mistake. */
const MAX_DURATION_MINUTES = 14 * 60;
const MIN_DURATION_MINUTES = 15;
/** A season's worth of meetings, listed at once, is the largest honest page. */
const MAX_LIST_LIMIT = 400;

interface SeasonRow {
  id: string;
  starts_at: number;
  ends_at: number;
}

interface TeamRow {
  timezone: string;
}

/** The projection every meeting response shares, optionally table-qualified. */
function meetingColumns(prefix = ''): string {
  const p = prefix ? `${prefix}.` : '';
  return [
    'id',
    'team_id',
    'season_id',
    'title',
    'starts_at',
    'ends_at',
    'location',
    'kind',
    'status',
    'series_id',
    'series_slot',
    'detached_at',
    'started_at',
    'ended_at',
    'cancel_reason',
    'created_by',
    'created_at',
    'updated_at',
  ]
    .map((column) => `${p}${column}`)
    .join(', ');
}

const MEETING_COLUMNS = meetingColumns();

async function currentSeasonRow(
  db: D1Database,
  teamId: string,
): Promise<SeasonRow | null> {
  return await db
    .prepare(
      `SELECT id, starts_at, ends_at FROM seasons
        WHERE team_id = ? AND is_current = 1`,
    )
    .bind(teamId)
    .first<SeasonRow>();
}

async function teamTimezone(db: D1Database, teamId: string): Promise<string> {
  const row = await db
    .prepare('SELECT timezone FROM teams WHERE id = ?')
    .bind(teamId)
    .first<TeamRow>();
  return row?.timezone ?? 'America/New_York';
}

// ------------------------------------------------------------------ listing

/**
 * The season's meetings.
 *
 * `attendance_count` comes from a LEFT JOIN rather than a second round trip:
 * the index screen shows it on every row, and N+1 over a season of meetings is
 * exactly the kind of query that looks fine on a laptop and costs real money on
 * D1's per-row billing.
 */
meetings.get('/', requireMember, async (c) => {
  const { teamId } = authOf(c);
  const season = await currentSeasonRow(c.env.DB, teamId);
  if (!season) return c.json({ error: 'no_current_season' }, 409);

  const url = new URL(c.req.url);
  const from = Number(url.searchParams.get('from') ?? season.starts_at);
  const to = Number(url.searchParams.get('to') ?? season.ends_at);
  const limit = Math.min(
    Number(url.searchParams.get('limit') ?? MAX_LIST_LIMIT) || MAX_LIST_LIMIT,
    MAX_LIST_LIMIT,
  );
  const status = url.searchParams.get('status');

  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    return c.json({ error: 'invalid_range' }, 400);
  }
  if (status !== null && !isMeetingStatus(status)) {
    return c.json({ error: 'invalid_status' }, 400);
  }

  const { results } = await c.env.DB.prepare(
    `SELECT ${meetingColumns('m')},
            COUNT(a.id) AS attendance_count,
            (SELECT COUNT(*) FROM meeting_note_blocks b
              WHERE b.team_id = m.team_id AND b.meeting_id = m.id
                AND b.deleted_at IS NULL) AS block_count,
            (SELECT COUNT(*) FROM portfolio_candidates pc
              WHERE pc.team_id = m.team_id
                AND ((pc.source_type = 'meeting' AND pc.source_id = m.id)
                  OR (pc.source_type = 'meeting_block' AND pc.source_id IN
                      (SELECT b2.id FROM meeting_note_blocks b2
                        WHERE b2.team_id = m.team_id AND b2.meeting_id = m.id
                          AND b2.deleted_at IS NULL)))) AS flagged_count
       FROM meetings m
       LEFT JOIN meeting_attendance a
         ON a.team_id = m.team_id AND a.meeting_id = m.id
            AND a.state IN ('present', 'late')
      WHERE m.team_id = ? AND m.season_id = ?
        AND m.starts_at >= ? AND m.starts_at <= ?
        AND (? IS NULL OR m.status = ?)
      GROUP BY m.id
      ORDER BY m.starts_at ASC
      LIMIT ?`,
  )
    .bind(teamId, season.id, from, to, status, status, limit)
    .all();

  return c.json({ meetings: results });
});

// ------------------------------------------------------------------- create

meetings.post(
  '/',
  sameOriginOnly,
  requireMember,
  requireRole('coach', 'mentor'),
  async (c) => {
    const body = await readJson(c);
    if (!body) return c.json({ error: 'invalid_body' }, 400);

    const { teamId, member } = authOf(c);
    const season = await currentSeasonRow(c.env.DB, teamId);
    if (!season) return c.json({ error: 'no_current_season' }, 409);

    const startsAt = boundedInt(body.starts_at, 0, 4_102_444_800);
    if (startsAt === null) return c.json({ error: 'invalid_starts_at' }, 400);

    const kind = body.kind === undefined ? 'build' : body.kind;
    if (!isMeetingKind(kind)) return c.json({ error: 'invalid_kind' }, 400);

    const duration =
      body.duration_minutes === undefined
        ? 120
        : boundedInt(body.duration_minutes, MIN_DURATION_MINUTES, MAX_DURATION_MINUTES);
    if (duration === null) return c.json({ error: 'invalid_duration' }, 400);

    const title = optionalString(body.title, 200) ?? 'Team meeting';
    const location = optionalString(body.location, 200);

    const timezone = await teamTimezone(c.env.DB, teamId);
    const id = uuid();
    const now = nowSeconds();

    await c.env.DB.prepare(
      `INSERT INTO meetings
         (id, team_id, season_id, title, starts_at, ends_at, location, kind,
          status, series_slot, created_by, created_at, updated_at, agenda, notes, attendees)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?, ?, ?, NULL, NULL, '[]')`,
    )
      .bind(
        id,
        teamId,
        season.id,
        title,
        startsAt,
        startsAt + duration * 60,
        location,
        kind,
        // A one-off still gets a slot so it reads consistently on the client.
        // It cannot collide: series_id is NULL and SQLite treats NULLs in a
        // unique index as distinct.
        toSlot(localDateInZone(startsAt, timezone)),
        member.id,
        now,
        now,
      )
      .run();

    const row = await c.env.DB.prepare(
      `SELECT ${MEETING_COLUMNS} FROM meetings WHERE id = ? AND team_id = ?`,
    )
      .bind(id, teamId)
      .first();

    return c.json({ meeting: row }, 201);
  },
);

// --------------------------------------------------------------------- read

meetings.get('/:id', requireMember, async (c) => {
  const { teamId } = authOf(c);
  const id = c.req.param('id');

  const meeting = await c.env.DB.prepare(
    `SELECT ${MEETING_COLUMNS} FROM meetings WHERE id = ? AND team_id = ?`,
  )
    .bind(id, teamId)
    .first();
  if (!meeting) return c.json({ error: 'not_found' }, 404);

  // One batch rather than six awaits. The meeting screen needs all of this to
  // render anything at all, and the candidates array is what lets the editor
  // draw its flag marks without a second request.
  const [agenda, blocks, attendance, actionItems, candidates] = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT id, meeting_id, position, title, detail, owner_member_id,
              minutes_planned, sub_team, done, created_by, created_at, updated_at
         FROM meeting_agenda_items
        WHERE team_id = ? AND meeting_id = ?
        ORDER BY position ASC`,
    ).bind(teamId, id),
    c.env.DB.prepare(
      `SELECT id, meeting_id, position, kind, text, media_id, source_agenda_item_id,
              created_by_member_id, updated_by_member_id, created_at, updated_at
         FROM meeting_note_blocks
        WHERE team_id = ? AND meeting_id = ? AND deleted_at IS NULL
        ORDER BY position ASC`,
    ).bind(teamId, id),
    c.env.DB.prepare(
      // arrived_late and left_early belong here, not only in the attendance
      // route's own projection: the meeting screen seeds its roll from THIS
      // response, so omitting them silently drops both marks on every reload
      // while the save and the season rollup keep looking correct.
      `SELECT id, meeting_id, member_id, state, arrived_late, left_early,
              minutes, note, recorded_by, recorded_at
         FROM meeting_attendance
        WHERE team_id = ? AND meeting_id = ?`,
    ).bind(teamId, id),
    c.env.DB.prepare(
      `SELECT id, meeting_id, block_id, text, assignee_member_id, due_at, status,
              task_id, created_by, created_at, updated_at
         FROM meeting_action_items
        WHERE team_id = ? AND meeting_id = ?
        ORDER BY created_at ASC`,
    ).bind(teamId, id),
    c.env.DB.prepare(
      `SELECT id, source_type, source_id, suggested_award, why, state,
              placed_page_id, flagged_by, created_at
         FROM portfolio_candidates
        WHERE team_id = ?
          AND ((source_type = 'meeting' AND source_id = ?)
            OR (source_type = 'meeting_block' AND source_id IN
                (SELECT id FROM meeting_note_blocks
                  WHERE team_id = ? AND meeting_id = ?)))`,
    ).bind(teamId, id, teamId, id),
  ]);

  const present = (attendance.results as { member_id: string; state: string }[])
    .filter((a) => a.state === 'present' || a.state === 'late')
    .map((a) => a.member_id);

  return c.json({
    meeting,
    agenda: agenda.results,
    blocks: blocks.results,
    attendance: attendance.results,
    action_items: actionItems.results,
    candidates: candidates.results,
    // Derived, so the `Meeting.attendees` shape declared in src/types.ts keeps
    // working now that the legacy JSON column is no longer written.
    attendees: present,
  });
});

// ------------------------------------------------------------------- update

meetings.patch(
  '/:id',
  sameOriginOnly,
  requireMember,
  requireRole('coach', 'mentor'),
  async (c) => {
    const body = await readJson(c);
    if (!body) return c.json({ error: 'invalid_body' }, 400);

    const { teamId } = authOf(c);
    const id = c.req.param('id');

    const existing = await c.env.DB.prepare(
      `SELECT series_id, starts_at, ends_at FROM meetings WHERE id = ? AND team_id = ?`,
    )
      .bind(id, teamId)
      .first<{ series_id: string | null; starts_at: number; ends_at: number | null }>();
    if (!existing) return c.json({ error: 'not_found' }, 404);

    const sets: string[] = [];
    const values: unknown[] = [];
    let touchesSchedule = false;

    if (body.title !== undefined) {
      const title = optionalString(body.title, 200);
      if (!title) return c.json({ error: 'invalid_title' }, 400);
      sets.push('title = ?');
      values.push(title);
      touchesSchedule = true;
    }
    if (body.starts_at !== undefined) {
      const startsAt = boundedInt(body.starts_at, 0, 4_102_444_800);
      if (startsAt === null) return c.json({ error: 'invalid_starts_at' }, 400);
      sets.push('starts_at = ?');
      values.push(startsAt);
      touchesSchedule = true;
    }
    if (body.ends_at !== undefined) {
      const endsAt = boundedInt(body.ends_at, 0, 4_102_444_800);
      if (endsAt === null) return c.json({ error: 'invalid_ends_at' }, 400);
      sets.push('ends_at = ?');
      values.push(endsAt);
      touchesSchedule = true;
    }
    if (body.location !== undefined) {
      sets.push('location = ?');
      values.push(optionalString(body.location, 200));
      touchesSchedule = true;
    }
    if (body.kind !== undefined) {
      if (!isMeetingKind(body.kind)) return c.json({ error: 'invalid_kind' }, 400);
      sets.push('kind = ?');
      values.push(body.kind);
      touchesSchedule = true;
    }
    if (body.status !== undefined) {
      if (!isMeetingStatus(body.status)) return c.json({ error: 'invalid_status' }, 400);
      sets.push('status = ?');
      values.push(body.status);
    }

    if (sets.length === 0) return c.json({ error: 'nothing_to_update' }, 400);

    // Editing one occurrence of a series detaches it. From here on a series
    // edit leaves it alone: somebody decided something specific about this
    // evening, and a rule should not quietly overwrite that.
    if (existing.series_id !== null && touchesSchedule) {
      sets.push('detached_at = ?');
      values.push(nowSeconds());
    }

    sets.push('updated_at = ?');
    values.push(nowSeconds());

    await c.env.DB.prepare(
      `UPDATE meetings SET ${sets.join(', ')} WHERE id = ? AND team_id = ?`,
    )
      .bind(...values, id, teamId)
      .run();

    const row = await c.env.DB.prepare(
      `SELECT ${MEETING_COLUMNS} FROM meetings WHERE id = ? AND team_id = ?`,
    )
      .bind(id, teamId)
      .first();
    return c.json({ meeting: row });
  },
);

/**
 * Cancel, which is not delete.
 *
 * "We called off Nov 11 for the snowstorm" is part of the season record and
 * feeds the Sustain narrative, so the row survives with a reason attached. It
 * also detaches, so re-expanding the series will not resurrect it.
 */
meetings.post(
  '/:id/cancel',
  sameOriginOnly,
  requireMember,
  requireRole('coach', 'mentor'),
  async (c) => {
    const body = (await readJson(c)) ?? {};
    const { teamId } = authOf(c);
    const id = c.req.param('id');
    const now = nowSeconds();

    const result = await c.env.DB.prepare(
      `UPDATE meetings
          SET status = 'cancelled', cancel_reason = ?, detached_at = ?, updated_at = ?
        WHERE id = ? AND team_id = ?`,
    )
      .bind(optionalString(body.reason, 300), now, now, id, teamId)
      .run();

    if (result.meta.changes === 0) return c.json({ error: 'not_found' }, 404);

    const row = await c.env.DB.prepare(
      `SELECT ${MEETING_COLUMNS} FROM meetings WHERE id = ? AND team_id = ?`,
    )
      .bind(id, teamId)
      .first();
    return c.json({ meeting: row });
  },
);

/**
 * Delete, which refuses to throw away a season.
 *
 * A meeting with notes, attendance or action items on it is a record somebody
 * made, so deleting it takes an explicit `?force=1`. Without the guard the
 * destructive path and the tidy-up path are the same button.
 */
meetings.delete(
  '/:id',
  sameOriginOnly,
  requireMember,
  requireRole('coach'),
  async (c) => {
    const { teamId } = authOf(c);
    const id = c.req.param('id');
    const force = new URL(c.req.url).searchParams.get('force') === '1';

    const meeting = await c.env.DB.prepare(
      'SELECT id FROM meetings WHERE id = ? AND team_id = ?',
    )
      .bind(id, teamId)
      .first();
    if (!meeting) return c.json({ error: 'not_found' }, 404);

    if (!force) {
      const content = await c.env.DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM meeting_note_blocks
             WHERE team_id = ?1 AND meeting_id = ?2 AND deleted_at IS NULL) AS blocks,
           (SELECT COUNT(*) FROM meeting_attendance
             WHERE team_id = ?1 AND meeting_id = ?2) AS attendance,
           (SELECT COUNT(*) FROM meeting_action_items
             WHERE team_id = ?1 AND meeting_id = ?2) AS action_items`,
      )
        .bind(teamId, id)
        .first<{ blocks: number; attendance: number; action_items: number }>();

      const total =
        (content?.blocks ?? 0) + (content?.attendance ?? 0) + (content?.action_items ?? 0);
      if (total > 0) {
        return c.json(
          {
            error: 'meeting_has_content',
            blocks: content?.blocks ?? 0,
            attendance: content?.attendance ?? 0,
            action_items: content?.action_items ?? 0,
          },
          409,
        );
      }
    }

    // Candidates are polymorphic and cannot cascade, so they are cleared here
    // explicitly — both the flag on the meeting itself and any flag on one of
    // its blocks. Missing this is how the inbox fills with rows pointing at
    // nothing.
    await c.env.DB.batch([
      c.env.DB.prepare(
        `DELETE FROM portfolio_candidates
          WHERE team_id = ?1
            AND ((source_type = 'meeting' AND source_id = ?2)
              OR (source_type = 'meeting_block' AND source_id IN
                  (SELECT id FROM meeting_note_blocks
                    WHERE team_id = ?1 AND meeting_id = ?2)))`,
      ).bind(teamId, id),
      c.env.DB.prepare('DELETE FROM meetings WHERE id = ? AND team_id = ?').bind(id, teamId),
    ]);

    return c.json({ ok: true });
  },
);

export { meetings };
