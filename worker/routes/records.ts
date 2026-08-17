/**
 * Attendance and action items — the two records a meeting leaves behind.
 *
 * Attendance is the Sustain award's "documented progress tracking" and it is
 * also, plainly, a log of where named minors were on named evenings. The
 * migration says what that trade is and why it is accepted; the shape here is
 * the other half of it. Coaches record for the team, and a student may only
 * ever record themselves — `POST /attendance/self` structurally cannot name
 * somebody else, which is the tenancy rule applied to identity.
 *
 * Action items are separate from `tasks` because a task needs a board, and
 * choosing a board mid-sentence while somebody is still talking is exactly the
 * friction that stops anything being written down. Promotion is a later,
 * deliberate act.
 */
import { Hono } from 'hono';
import { nowSeconds, uuid } from '../lib/crypto';
import { boundedInt, optionalString, readJson } from '../lib/http';
import { isActionStatus, isAttendanceState } from '../lib/meetings';
import {
  auth as authOf,
  denyRole,
  requireMember,
  requireRole,
  sameOriginOnly,
  type AppEnv,
} from '../lib/tenancy';

const records = new Hono<AppEnv>();

const ACTION_COLUMNS = `id, meeting_id, block_id, text, assignee_member_id, due_at,
        status, task_id, created_by, created_at, updated_at`;

// --------------------------------------------------------------- attendance

records.get('/meetings/:id/attendance', requireMember, async (c) => {
  const { teamId } = authOf(c);
  const { results } = await c.env.DB.prepare(
    `SELECT a.id AS id, a.member_id AS member_id, a.state AS state,
            a.arrived_late AS arrived_late, a.left_early AS left_early,
            a.minutes AS minutes, a.note AS note, a.recorded_by AS recorded_by,
            a.recorded_at AS recorded_at, m.display_name AS display_name
       FROM meeting_attendance a
       JOIN members m ON m.id = a.member_id AND m.team_id = a.team_id
      WHERE a.team_id = ? AND a.meeting_id = ?`,
  )
    .bind(teamId, c.req.param('id'))
    .all();
  return c.json({ attendance: results });
});

/**
 * Record the roll in one upsert batch.
 *
 * Members not named in the body are left alone, so two coaches marking
 * different halves of the room do not erase each other. Every member_id is
 * checked against the caller's own team first — the cross-tenant write a naive
 * upsert would happily accept.
 */
records.put(
  '/meetings/:id/attendance',
  sameOriginOnly,
  requireMember,
  requireRole('coach', 'mentor'),
  async (c) => {
    const body = await readJson(c);
    if (!body || !Array.isArray(body.entries)) {
      return c.json({ error: 'invalid_body' }, 400);
    }
    const entries = body.entries as Record<string, unknown>[];

    const { teamId, member } = authOf(c);
    const meetingId = c.req.param('id');
    const meeting = await c.env.DB.prepare(
      'SELECT id FROM meetings WHERE id = ? AND team_id = ?',
    )
      .bind(meetingId, teamId)
      .first();
    if (!meeting) return c.json({ error: 'not_found' }, 404);

    const { results: roster } = await c.env.DB.prepare(
      "SELECT id FROM members WHERE team_id = ? AND status = 'active'",
    )
      .bind(teamId)
      .all<{ id: string }>();
    const known = new Set(roster.map((r) => r.id));

    const now = nowSeconds();
    const statements: D1PreparedStatement[] = [];

    for (const entry of entries) {
      const memberId = optionalString(entry.member_id, 64);
      if (!memberId || !known.has(memberId)) {
        return c.json({ error: 'unknown_member' }, 400);
      }
      // An explicit null clears the entry rather than recording an absence.
      if (entry.state === null) {
        statements.push(
          c.env.DB.prepare(
            'DELETE FROM meeting_attendance WHERE team_id = ? AND meeting_id = ? AND member_id = ?',
          ).bind(teamId, meetingId, memberId),
        );
        continue;
      }
      if (!isAttendanceState(entry.state)) {
        return c.json({ error: 'invalid_state' }, 400);
      }
      statements.push(
        c.env.DB.prepare(
          `INSERT INTO meeting_attendance
             (id, team_id, meeting_id, member_id, state, arrived_late, left_early,
              minutes, note, recorded_by, recorded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (team_id, meeting_id, member_id) DO UPDATE SET
             state = excluded.state, arrived_late = excluded.arrived_late,
             left_early = excluded.left_early, minutes = excluded.minutes,
             note = excluded.note, recorded_by = excluded.recorded_by,
             recorded_at = excluded.recorded_at`,
        ).bind(
          uuid(),
          teamId,
          meetingId,
          memberId,
          entry.state,
          entry.arrived_late ? 1 : 0,
          entry.left_early ? 1 : 0,
          boundedInt(entry.minutes, 0, 1440),
          optionalString(entry.note, 500),
          member.id,
          now,
        ),
      );
    }

    if (statements.length > 0) await c.env.DB.batch(statements);

    const { results } = await c.env.DB.prepare(
      `SELECT id, member_id, state, arrived_late, left_early, minutes, note,
              recorded_by, recorded_at
         FROM meeting_attendance WHERE team_id = ? AND meeting_id = ?`,
    )
      .bind(teamId, meetingId)
      .all();
    return c.json({ attendance: results });
  },
);

/**
 * Check yourself in.
 *
 * Ignores any member_id in the body and uses the session's own membership. A
 * student marking a friend present is the exact failure mode that would make
 * the whole attendance record worthless as a Sustain artifact.
 */
records.post(
  '/meetings/:id/attendance/self',
  sameOriginOnly,
  requireMember,
  denyRole('viewer'),
  async (c) => {
    const body = (await readJson(c)) ?? {};
    // A student checking in is always present. `arrived_late` is the honest way
    // to say "I got here at 6:20" without pretending lateness is a different
    // kind of attendance.
    const arrivedLate = body.arrived_late ? 1 : 0;

    const { teamId, member } = authOf(c);
    const meetingId = c.req.param('id');
    const meeting = await c.env.DB.prepare(
      'SELECT id FROM meetings WHERE id = ? AND team_id = ?',
    )
      .bind(meetingId, teamId)
      .first();
    if (!meeting) return c.json({ error: 'not_found' }, 404);

    await c.env.DB.prepare(
      `INSERT INTO meeting_attendance
         (id, team_id, meeting_id, member_id, state, arrived_late, recorded_by, recorded_at)
       VALUES (?, ?, ?, ?, 'present', ?, ?, ?)
       ON CONFLICT (team_id, meeting_id, member_id) DO UPDATE SET
         state = 'present', arrived_late = excluded.arrived_late,
         recorded_by = excluded.recorded_by, recorded_at = excluded.recorded_at`,
    )
      .bind(uuid(), teamId, meetingId, member.id, arrivedLate, member.id, nowSeconds())
      .run();

    return c.json({
      ok: true,
      member_id: member.id,
      state: 'present',
      arrived_late: arrivedLate === 1,
    });
  },
);

/** The Sustain rollup: who is still turning up in February. Index-covered. */
records.get('/attendance/summary', requireMember, async (c) => {
  const { teamId } = authOf(c);

  const held = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM meetings
      WHERE team_id = ? AND status = 'held'`,
  )
    .bind(teamId)
    .first<{ n: number }>();

  const { results } = await c.env.DB.prepare(
    `SELECT m.id AS member_id, m.display_name AS display_name,
            SUM(CASE WHEN a.state = 'present' THEN 1 ELSE 0 END) AS present,
            SUM(CASE WHEN a.state = 'excused' THEN 1 ELSE 0 END) AS excused,
            SUM(CASE WHEN a.state = 'absent' THEN 1 ELSE 0 END) AS absent,
            SUM(COALESCE(a.arrived_late, 0)) AS arrived_late,
            SUM(COALESCE(a.left_early, 0)) AS left_early,
            SUM(COALESCE(a.minutes, 0)) AS minutes
       FROM members m
       LEFT JOIN meeting_attendance a
         ON a.member_id = m.id AND a.team_id = m.team_id
      WHERE m.team_id = ? AND m.status = 'active'
      GROUP BY m.id
      ORDER BY m.created_at ASC`,
  )
    .bind(teamId)
    .all();

  return c.json({ meetings_held: held?.n ?? 0, members: results });
});

// ------------------------------------------------------------- action items

records.get('/action-items', requireMember, async (c) => {
  const { teamId } = authOf(c);
  const url = new URL(c.req.url);
  const status = url.searchParams.get('status');
  if (status !== null && !isActionStatus(status)) {
    return c.json({ error: 'invalid_status' }, 400);
  }
  const { results } = await c.env.DB.prepare(
    `SELECT ${ACTION_COLUMNS} FROM meeting_action_items
      WHERE team_id = ? AND (? IS NULL OR status = ?)
      ORDER BY created_at DESC LIMIT 300`,
  )
    .bind(teamId, status, status)
    .all();
  return c.json({ action_items: results });
});

records.post(
  '/meetings/:id/action-items',
  sameOriginOnly,
  requireMember,
  denyRole('viewer'),
  async (c) => {
    const body = await readJson(c);
    if (!body) return c.json({ error: 'invalid_body' }, 400);

    const { teamId, member } = authOf(c);
    const meetingId = c.req.param('id');
    const meeting = await c.env.DB.prepare(
      'SELECT id FROM meetings WHERE id = ? AND team_id = ?',
    )
      .bind(meetingId, teamId)
      .first();
    if (!meeting) return c.json({ error: 'not_found' }, 404);

    const text = optionalString(body.text, 500);
    if (!text) return c.json({ error: 'missing_text' }, 400);

    const id = uuid();
    const now = nowSeconds();
    await c.env.DB.prepare(
      `INSERT INTO meeting_action_items
         (id, team_id, meeting_id, block_id, text, assignee_member_id, due_at,
          status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
    )
      .bind(
        id,
        teamId,
        meetingId,
        optionalString(body.block_id, 64),
        text,
        optionalString(body.assignee_member_id, 64),
        boundedInt(body.due_at, 0, 4_102_444_800),
        member.id,
        now,
        now,
      )
      .run();

    const row = await c.env.DB.prepare(
      `SELECT ${ACTION_COLUMNS} FROM meeting_action_items WHERE id = ? AND team_id = ?`,
    )
      .bind(id, teamId)
      .first();
    return c.json({ action_item: row }, 201);
  },
);

records.patch(
  '/meetings/:id/action-items/:aid',
  sameOriginOnly,
  requireMember,
  denyRole('viewer'),
  async (c) => {
    const body = await readJson(c);
    if (!body) return c.json({ error: 'invalid_body' }, 400);
    const { teamId } = authOf(c);

    const sets: string[] = [];
    const values: unknown[] = [];
    if (body.text !== undefined) {
      const text = optionalString(body.text, 500);
      if (!text) return c.json({ error: 'missing_text' }, 400);
      sets.push('text = ?');
      values.push(text);
    }
    if (body.status !== undefined) {
      if (!isActionStatus(body.status)) return c.json({ error: 'invalid_status' }, 400);
      sets.push('status = ?');
      values.push(body.status);
    }
    if (body.assignee_member_id !== undefined) {
      sets.push('assignee_member_id = ?');
      values.push(optionalString(body.assignee_member_id, 64));
    }
    if (body.due_at !== undefined) {
      sets.push('due_at = ?');
      values.push(body.due_at === null ? null : boundedInt(body.due_at, 0, 4_102_444_800));
    }
    if (sets.length === 0) return c.json({ error: 'nothing_to_update' }, 400);

    sets.push('updated_at = ?');
    values.push(nowSeconds());

    const result = await c.env.DB.prepare(
      `UPDATE meeting_action_items SET ${sets.join(', ')}
        WHERE id = ? AND team_id = ? AND meeting_id = ?`,
    )
      .bind(...values, c.req.param('aid'), teamId, c.req.param('id'))
      .run();
    if (result.meta.changes === 0) return c.json({ error: 'not_found' }, 404);

    const row = await c.env.DB.prepare(
      `SELECT ${ACTION_COLUMNS} FROM meeting_action_items WHERE id = ? AND team_id = ?`,
    )
      .bind(c.req.param('aid'), teamId)
      .first();
    return c.json({ action_item: row });
  },
);

records.delete(
  '/meetings/:id/action-items/:aid',
  sameOriginOnly,
  requireMember,
  denyRole('viewer'),
  async (c) => {
    const { teamId } = authOf(c);
    const result = await c.env.DB.prepare(
      'DELETE FROM meeting_action_items WHERE id = ? AND team_id = ? AND meeting_id = ?',
    )
      .bind(c.req.param('aid'), teamId, c.req.param('id'))
      .run();
    if (result.meta.changes === 0) return c.json({ error: 'not_found' }, 404);
    return c.json({ ok: true });
  },
);

/**
 * Turn an action item into a board task.
 *
 * Picks a board rather than demanding one, and creates "Action items" if the
 * team has none — removing the "which board?" question is the entire point of
 * keeping capture and planning separate in the first place.
 *
 * `decision_log` is seeded from the nearest preceding decision block, which is
 * free Think-award material and the reason `decision` exists as a block kind at
 * all: the reasoning was typed at the moment it happened, and this is where it
 * gets carried forward instead of reconstructed in March.
 */
records.post(
  '/meetings/:id/action-items/:aid/promote',
  sameOriginOnly,
  requireMember,
  denyRole('viewer'),
  async (c) => {
    const body = (await readJson(c)) ?? {};
    const { teamId } = authOf(c);
    const meetingId = c.req.param('id');

    const item = await c.env.DB.prepare(
      `SELECT id, text, assignee_member_id, due_at, task_id, block_id
         FROM meeting_action_items
        WHERE id = ? AND team_id = ? AND meeting_id = ?`,
    )
      .bind(c.req.param('aid'), teamId, meetingId)
      .first<{
        id: string;
        text: string;
        assignee_member_id: string | null;
        due_at: number | null;
        task_id: string | null;
        block_id: string | null;
      }>();
    if (!item) return c.json({ error: 'not_found' }, 404);
    if (item.task_id) return c.json({ error: 'already_promoted', task_id: item.task_id }, 409);

    const season = await c.env.DB.prepare(
      'SELECT id FROM seasons WHERE team_id = ? AND is_current = 1',
    )
      .bind(teamId)
      .first<{ id: string }>();
    if (!season) return c.json({ error: 'no_current_season' }, 409);

    let boardId = optionalString(body.board_id, 64);
    if (boardId) {
      const board = await c.env.DB.prepare(
        'SELECT id FROM boards WHERE id = ? AND team_id = ?',
      )
        .bind(boardId, teamId)
        .first();
      if (!board) return c.json({ error: 'not_found' }, 404);
    } else {
      const fallback = await c.env.DB.prepare(
        'SELECT id FROM boards WHERE team_id = ? ORDER BY position ASC LIMIT 1',
      )
        .bind(teamId)
        .first<{ id: string }>();
      boardId = fallback?.id ?? null;
    }

    const now = nowSeconds();
    const statements: D1PreparedStatement[] = [];

    if (!boardId) {
      boardId = uuid();
      statements.push(
        c.env.DB.prepare(
          'INSERT INTO boards (id, team_id, season_id, name, sub_team, position) VALUES (?, ?, ?, ?, NULL, 0)',
        ).bind(boardId, teamId, season.id, 'Action items'),
      );
    }

    // The reasoning nearest above the action item, if somebody wrote one down.
    let decisionLog: string | null = null;
    if (item.block_id) {
      const decision = await c.env.DB.prepare(
        `SELECT text FROM meeting_note_blocks
          WHERE team_id = ? AND meeting_id = ? AND kind = 'decision'
            AND deleted_at IS NULL
            AND position < (SELECT position FROM meeting_note_blocks WHERE id = ?)
          ORDER BY position DESC LIMIT 1`,
      )
        .bind(teamId, meetingId, item.block_id)
        .first<{ text: string }>();
      decisionLog = decision?.text ?? null;
    }

    const meeting = await c.env.DB.prepare(
      'SELECT title, starts_at FROM meetings WHERE id = ? AND team_id = ?',
    )
      .bind(meetingId, teamId)
      .first<{ title: string; starts_at: number }>();

    const max = await c.env.DB.prepare(
      'SELECT COALESCE(MAX(position), 0) AS max FROM tasks WHERE team_id = ? AND board_id = ?',
    )
      .bind(teamId, boardId)
      .first<{ max: number }>();

    const taskId = uuid();
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO tasks
           (id, team_id, board_id, title, body, assignee_member_id, status, due_at,
            position, decision_log, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'todo', ?, ?, ?, ?, ?)`,
      ).bind(
        taskId,
        teamId,
        boardId,
        item.text.slice(0, 200),
        `From ${meeting?.title ?? 'a meeting'}`,
        item.assignee_member_id,
        item.due_at,
        (max?.max ?? 0) + 1024,
        decisionLog,
        now,
        now,
      ),
      // The guard makes a double promote a 409 rather than two tasks.
      c.env.DB.prepare(
        `UPDATE meeting_action_items SET task_id = ?, updated_at = ?
          WHERE id = ? AND team_id = ? AND task_id IS NULL`,
      ).bind(taskId, now, item.id, teamId),
    );

    await c.env.DB.batch(statements);

    const [task, action] = await c.env.DB.batch([
      c.env.DB.prepare(
        `SELECT id, board_id, title, body, assignee_member_id, status, due_at, decision_log
           FROM tasks WHERE id = ? AND team_id = ?`,
      ).bind(taskId, teamId),
      c.env.DB.prepare(
        `SELECT ${ACTION_COLUMNS} FROM meeting_action_items WHERE id = ? AND team_id = ?`,
      ).bind(item.id, teamId),
    ]);

    return c.json({ task: task.results[0], action_item: action.results[0] }, 201);
  },
);

export { records };
