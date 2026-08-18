/**
 * A meeting's agenda, and the button that starts it (COG-036, phase 2).
 *
 * Agenda items are planning and happen before; notes are capture and happen
 * during. The notes half used to live here as `meeting_note_blocks` routes and is
 * now routes/docs.ts — see migrations/0006 for why documents replaced blocks. What
 * stays is the agenda, and `POST /:id/start`, which is the seam between them: it
 * flips the meeting to held and seeds one document from the agenda.
 *
 * This router mounts on /api/meetings BEFORE the meetings router, because it
 * claims deeper paths under a meeting while that one owns /:id itself.
 */
import { Hono } from 'hono';
import { nowSeconds, uuid } from '../lib/crypto';
import { boundedInt, optionalString, readJson } from '../lib/http';
import { POSITION_GAP } from '../lib/meetings';
import { parseContent } from '../lib/notes';
import {
  auth as authOf,
  denyRole,
  requireMember,
  sameOriginOnly,
  type AppEnv,
} from '../lib/tenancy';

const notes = new Hono<AppEnv>();

const MAX_AGENDA_ITEMS = 100;

/** Matches DOC_SUMMARY in routes/docs.ts: no `content`, for the same reason. */
const DOC_SUMMARY_COLUMNS = `id, parent_doc_id, meeting_id, position, title,
        created_by, updated_by, created_at, updated_at,
        LENGTH(content) AS content_bytes`;

const AGENDA_COLUMNS = `id, meeting_id, position, title, detail, owner_member_id,
        minutes_planned, sub_team, done, created_by, created_at, updated_at`;

/**
 * Confirm the meeting is this team's, and fail closed if not.
 *
 * Every handler below calls this first. It is the reason a block route cannot
 * be tricked into writing into another team's meeting by way of a guessed
 * meeting id — the child rows carry team_id too, but checking the parent is
 * what makes the 404 honest.
 */
async function ownedMeeting(
  db: D1Database,
  teamId: string,
  meetingId: string,
): Promise<{ id: string; started_at: number | null } | null> {
  return await db
    .prepare('SELECT id, started_at FROM meetings WHERE id = ? AND team_id = ?')
    .bind(meetingId, teamId)
    .first<{ id: string; started_at: number | null }>();
}

/** Position for a new row appended to the end of a list. */
async function nextPosition(
  db: D1Database,
  table: 'meeting_agenda_items',
  teamId: string,
  meetingId: string,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT MAX(position) AS max FROM ${table}
        WHERE team_id = ? AND meeting_id = ?`,
    )
    .bind(teamId, meetingId)
    .first<{ max: number | null }>();
  return (row?.max ?? 0) + POSITION_GAP;
}

async function currentSeasonRow(
  db: D1Database,
  teamId: string,
): Promise<{ id: string } | null> {
  return await db
    .prepare('SELECT id FROM seasons WHERE team_id = ? AND is_current = 1')
    .bind(teamId)
    .first<{ id: string }>();
}

/** The meeting's own title, which is what the seeded document is called. */
async function meetingTitle(
  db: D1Database,
  teamId: string,
  meetingId: string,
): Promise<string> {
  const row = await db
    .prepare('SELECT title FROM meetings WHERE id = ? AND team_id = ?')
    .bind(meetingId, teamId)
    .first<{ title: string }>();
  return row?.title ?? 'Meeting notes';
}

// ------------------------------------------------------------------- agenda

notes.get('/:id/agenda', requireMember, async (c) => {
  const { teamId } = authOf(c);
  const id = c.req.param('id');
  if (!(await ownedMeeting(c.env.DB, teamId, id))) {
    return c.json({ error: 'not_found' }, 404);
  }
  const { results } = await c.env.DB.prepare(
    `SELECT ${AGENDA_COLUMNS} FROM meeting_agenda_items
      WHERE team_id = ? AND meeting_id = ? ORDER BY position ASC`,
  )
    .bind(teamId, id)
    .all();
  return c.json({ agenda: results });
});

notes.post(
  '/:id/agenda',
  sameOriginOnly,
  requireMember,
  denyRole('viewer'),
  async (c) => {
    const body = await readJson(c);
    if (!body) return c.json({ error: 'invalid_body' }, 400);

    const { teamId, member } = authOf(c);
    const meetingId = c.req.param('id');
    if (!(await ownedMeeting(c.env.DB, teamId, meetingId))) {
      return c.json({ error: 'not_found' }, 404);
    }

    const title = optionalString(body.title, 300);
    if (!title) return c.json({ error: 'missing_title' }, 400);

    const count = await c.env.DB.prepare(
      'SELECT COUNT(*) AS n FROM meeting_agenda_items WHERE team_id = ? AND meeting_id = ?',
    )
      .bind(teamId, meetingId)
      .first<{ n: number }>();
    if ((count?.n ?? 0) >= MAX_AGENDA_ITEMS) {
      return c.json({ error: 'agenda_full', max: MAX_AGENDA_ITEMS }, 409);
    }

    const id = uuid();
    const now = nowSeconds();
    const position = await nextPosition(
      c.env.DB,
      'meeting_agenda_items',
      teamId,
      meetingId,
    );

    await c.env.DB.prepare(
      `INSERT INTO meeting_agenda_items
         (id, team_id, meeting_id, position, title, detail, owner_member_id,
          minutes_planned, sub_team, done, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    )
      .bind(
        id,
        teamId,
        meetingId,
        position,
        title,
        optionalString(body.detail, 2000),
        optionalString(body.owner_member_id, 64),
        boundedInt(body.minutes_planned, 1, 600),
        optionalString(body.sub_team, 40),
        member.id,
        now,
        now,
      )
      .run();

    const row = await c.env.DB.prepare(
      `SELECT ${AGENDA_COLUMNS} FROM meeting_agenda_items WHERE id = ? AND team_id = ?`,
    )
      .bind(id, teamId)
      .first();
    return c.json({ item: row }, 201);
  },
);

notes.patch(
  '/:id/agenda/:itemId',
  sameOriginOnly,
  requireMember,
  denyRole('viewer'),
  async (c) => {
    const body = await readJson(c);
    if (!body) return c.json({ error: 'invalid_body' }, 400);

    const { teamId } = authOf(c);
    const sets: string[] = [];
    const values: unknown[] = [];

    if (body.title !== undefined) {
      const title = optionalString(body.title, 300);
      if (!title) return c.json({ error: 'missing_title' }, 400);
      sets.push('title = ?');
      values.push(title);
    }
    if (body.detail !== undefined) {
      sets.push('detail = ?');
      values.push(optionalString(body.detail, 2000));
    }
    if (body.owner_member_id !== undefined) {
      sets.push('owner_member_id = ?');
      values.push(optionalString(body.owner_member_id, 64));
    }
    if (body.minutes_planned !== undefined) {
      sets.push('minutes_planned = ?');
      values.push(boundedInt(body.minutes_planned, 1, 600));
    }
    if (body.done !== undefined) {
      sets.push('done = ?');
      values.push(body.done ? 1 : 0);
    }
    if (sets.length === 0) return c.json({ error: 'nothing_to_update' }, 400);

    sets.push('updated_at = ?');
    values.push(nowSeconds());

    const result = await c.env.DB.prepare(
      `UPDATE meeting_agenda_items SET ${sets.join(', ')}
        WHERE id = ? AND team_id = ? AND meeting_id = ?`,
    )
      .bind(...values, c.req.param('itemId'), teamId, c.req.param('id'))
      .run();
    if (result.meta.changes === 0) return c.json({ error: 'not_found' }, 404);

    const row = await c.env.DB.prepare(
      `SELECT ${AGENDA_COLUMNS} FROM meeting_agenda_items WHERE id = ? AND team_id = ?`,
    )
      .bind(c.req.param('itemId'), teamId)
      .first();
    return c.json({ item: row });
  },
);

notes.delete(
  '/:id/agenda/:itemId',
  sameOriginOnly,
  requireMember,
  denyRole('viewer'),
  async (c) => {
    const { teamId } = authOf(c);
    const result = await c.env.DB.prepare(
      'DELETE FROM meeting_agenda_items WHERE id = ? AND team_id = ? AND meeting_id = ?',
    )
      .bind(c.req.param('itemId'), teamId, c.req.param('id'))
      .run();
    if (result.meta.changes === 0) return c.json({ error: 'not_found' }, 404);
    return c.json({ ok: true });
  },
);

/**
 * Seed the notes from the agenda and mark the meeting as under way.
 *
 * `WHERE started_at IS NULL` is the whole concurrency story for the one button
 * fifteen people press at once: the second press seeds nothing and returns what
 * the first one made.
 */
notes.post(
  '/:id/start',
  sameOriginOnly,
  requireMember,
  denyRole('viewer'),
  async (c) => {
    const { teamId, member } = authOf(c);
    const meetingId = c.req.param('id');
    const meeting = await ownedMeeting(c.env.DB, teamId, meetingId);
    if (!meeting) return c.json({ error: 'not_found' }, 404);

    const season = await currentSeasonRow(c.env.DB, teamId);
    if (!season) return c.json({ error: 'no_current_season' }, 409);

    const now = nowSeconds();
    let docId: string | null = null;

    if (meeting.started_at === null) {
      const { results: agenda } = await c.env.DB.prepare(
        `SELECT id, title FROM meeting_agenda_items
          WHERE team_id = ? AND meeting_id = ? ORDER BY position ASC`,
      )
        .bind(teamId, meetingId)
        .all<{ id: string; title: string }>();

      // One document per meeting rather than two blocks per agenda item: a
      // heading for each point, with an empty paragraph under it so there is
      // somewhere to start typing without first reaching for the mouse.
      const content: unknown[] = [];
      for (const item of agenda) {
        content.push({
          type: 'heading',
          attrs: { level: 2 },
          content: [{ type: 'text', text: item.title }],
        });
        content.push({ type: 'paragraph' });
      }
      if (content.length === 0) content.push({ type: 'paragraph' });
      const body = JSON.stringify({ type: 'doc', content });
      const parsed = parseContent(body);
      // Cannot fail — the body is built here from titles the API already bounded
      // — but an agenda of 300 items would trip MAX_NODES, and seeding a document
      // the content route would then refuse to accept is worse than not seeding.
      const text = 'text' in parsed ? parsed.text : '';

      docId = uuid();
      const title = await meetingTitle(c.env.DB, teamId, meetingId);
      await c.env.DB.batch([
        c.env.DB.prepare(
          `UPDATE meetings SET status = 'held', started_at = ?, updated_at = ?
            WHERE id = ? AND team_id = ? AND started_at IS NULL`,
        ).bind(now, now, meetingId, teamId),
        c.env.DB.prepare(
          `INSERT INTO note_docs
             (id, team_id, season_id, parent_doc_id, meeting_id, position, title,
              content, content_text, created_by, updated_by, created_at, updated_at)
           VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          docId,
          teamId,
          season.id,
          meetingId,
          POSITION_GAP,
          title,
          body,
          text,
          member.id,
          member.id,
          now,
          now,
        ),
      ]);
    }

    const [meetingRow, docs] = await c.env.DB.batch([
      c.env.DB.prepare(
        'SELECT id, status, started_at, updated_at FROM meetings WHERE id = ? AND team_id = ?',
      ).bind(meetingId, teamId),
      c.env.DB.prepare(
        `SELECT ${DOC_SUMMARY_COLUMNS} FROM note_docs
          WHERE team_id = ? AND meeting_id = ? AND deleted_at IS NULL
          ORDER BY position ASC`,
      ).bind(teamId, meetingId),
    ]);

    return c.json({
      meeting: meetingRow.results[0],
      // The document to open. On a second press this is null and the caller
      // already has the tree, which is what makes the button idempotent.
      doc_id: docId,
      docs: docs.results,
    });
  },
);

export { notes as meetingNotes };
