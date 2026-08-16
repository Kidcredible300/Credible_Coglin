/**
 * Agendas and meeting notes (COG-036, phase 2).
 *
 * Agenda items are planning and happen before; note blocks are capture and
 * happen during. Two tables, two route groups, one screen.
 *
 * The write model is deliberately split, and the split is the interesting part:
 *
 *   PATCH /blocks/:id   the keystroke path. Debounced on the client, one row
 *                       written, and a no-op edit writes nothing at all.
 *   PUT   /blocks       the structural path. Rare, atomic, one batch. Used for
 *                       reorder, multi-block paste, and range delete.
 *
 * Neither alone works. A whole-document PUT on every autosave writes forty rows
 * per keystroke burst and clobbers a co-editor's paragraph every time it fires.
 * Per-block PATCH alone turns a six-line paste or a drag into six unordered
 * round trips, so a failure halfway leaves visibly scrambled notes.
 *
 * Blocks are SOFT deleted. A student deleting a paragraph must not destroy a
 * portfolio flag somebody else put on it, and undo is table stakes in an editor.
 */
import { Hono } from 'hono';
import { nowSeconds, uuid } from '../lib/crypto';
import { boundedInt, optionalString, readJson } from '../lib/http';
import { isBlockKind, POSITION_GAP, positionBetween } from '../lib/meetings';
import {
  auth as authOf,
  denyRole,
  requireMember,
  sameOriginOnly,
  type AppEnv,
} from '../lib/tenancy';

const notes = new Hono<AppEnv>();

/** Past this a meeting is not a meeting, it is a document with a problem. */
const MAX_BLOCKS = 500;
const MAX_AGENDA_ITEMS = 100;
const MAX_TEXT = 20_000;
/** A single structural write. Larger than any paste a student makes by hand. */
const MAX_PUT_BLOCKS = 250;

const BLOCK_COLUMNS = `id, meeting_id, position, kind, text, media_id,
        source_agenda_item_id, created_by_member_id, updated_by_member_id,
        created_at, updated_at`;

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
  table: 'meeting_note_blocks' | 'meeting_agenda_items',
  teamId: string,
  meetingId: string,
): Promise<number> {
  const live =
    table === 'meeting_note_blocks' ? ' AND deleted_at IS NULL' : '';
  const row = await db
    .prepare(
      `SELECT MAX(position) AS max FROM ${table}
        WHERE team_id = ? AND meeting_id = ?${live}`,
    )
    .bind(teamId, meetingId)
    .first<{ max: number | null }>();
  return (row?.max ?? 0) + POSITION_GAP;
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

    const now = nowSeconds();

    if (meeting.started_at === null) {
      const { results: agenda } = await c.env.DB.prepare(
        `SELECT id, title FROM meeting_agenda_items
          WHERE team_id = ? AND meeting_id = ? ORDER BY position ASC`,
      )
        .bind(teamId, meetingId)
        .all<{ id: string; title: string }>();

      const statements = [
        c.env.DB.prepare(
          `UPDATE meetings SET status = 'held', started_at = ?, updated_at = ?
            WHERE id = ? AND team_id = ? AND started_at IS NULL`,
        ).bind(now, now, meetingId, teamId),
      ];

      let position = POSITION_GAP;
      for (const item of agenda) {
        // A heading per agenda point, and an empty paragraph under it so there
        // is somewhere to start typing without first reaching for the mouse.
        statements.push(
          c.env.DB.prepare(
            `INSERT INTO meeting_note_blocks
               (id, team_id, meeting_id, position, kind, text, source_agenda_item_id,
                created_by_member_id, updated_by_member_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'heading', ?, ?, ?, ?, ?, ?)`,
          ).bind(
            uuid(),
            teamId,
            meetingId,
            position,
            item.title,
            item.id,
            member.id,
            member.id,
            now,
            now,
          ),
        );
        position += POSITION_GAP;
        statements.push(
          c.env.DB.prepare(
            `INSERT INTO meeting_note_blocks
               (id, team_id, meeting_id, position, kind, text,
                created_by_member_id, updated_by_member_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'paragraph', '', ?, ?, ?, ?)`,
          ).bind(uuid(), teamId, meetingId, position, member.id, member.id, now, now),
        );
        position += POSITION_GAP;
      }

      await c.env.DB.batch(statements);
    }

    const [meetingRow, blocks] = await c.env.DB.batch([
      c.env.DB.prepare(
        'SELECT id, status, started_at, updated_at FROM meetings WHERE id = ? AND team_id = ?',
      ).bind(meetingId, teamId),
      c.env.DB.prepare(
        `SELECT ${BLOCK_COLUMNS} FROM meeting_note_blocks
          WHERE team_id = ? AND meeting_id = ? AND deleted_at IS NULL
          ORDER BY position ASC`,
      ).bind(teamId, meetingId),
    ]);

    return c.json({ meeting: meetingRow.results[0], blocks: blocks.results });
  },
);

// ------------------------------------------------------------------- blocks

notes.get('/:id/blocks', requireMember, async (c) => {
  const { teamId } = authOf(c);
  const id = c.req.param('id');
  if (!(await ownedMeeting(c.env.DB, teamId, id))) {
    return c.json({ error: 'not_found' }, 404);
  }
  const { results } = await c.env.DB.prepare(
    `SELECT ${BLOCK_COLUMNS} FROM meeting_note_blocks
      WHERE team_id = ? AND meeting_id = ? AND deleted_at IS NULL
      ORDER BY position ASC`,
  )
    .bind(teamId, id)
    .all();
  const rev = results.reduce(
    (max, r) => Math.max(max, (r as { updated_at: number }).updated_at),
    0,
  );
  return c.json({ blocks: results, rev });
});

/**
 * One row read, so a second note-taker's edits can surface without websockets.
 *
 * Polled every few seconds by an open editor. `rev` is the newest `updated_at`
 * in the meeting, which changes on any insert, edit or soft delete — cheap
 * enough to ask constantly and sufficient to decide whether to refetch.
 */
notes.get('/:id/blocks/rev', requireMember, async (c) => {
  const { teamId } = authOf(c);
  const row = await c.env.DB.prepare(
    `SELECT COALESCE(MAX(updated_at), 0) AS rev, COUNT(*) AS count
       FROM meeting_note_blocks
      WHERE team_id = ? AND meeting_id = ? AND deleted_at IS NULL`,
  )
    .bind(teamId, c.req.param('id'))
    .first<{ rev: number; count: number }>();
  return c.json({ rev: row?.rev ?? 0, count: row?.count ?? 0 });
});

notes.post(
  '/:id/blocks',
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

    const kind = body.kind === undefined ? 'paragraph' : body.kind;
    if (!isBlockKind(kind)) return c.json({ error: 'invalid_kind' }, 400);

    const count = await c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM meeting_note_blocks
        WHERE team_id = ? AND meeting_id = ? AND deleted_at IS NULL`,
    )
      .bind(teamId, meetingId)
      .first<{ n: number }>();
    if ((count?.n ?? 0) >= MAX_BLOCKS) {
      return c.json({ error: 'too_many_blocks', max: MAX_BLOCKS }, 409);
    }

    // The client may name the id so a flag can attach to a block that has not
    // finished saving. Validated as a uuid, and unique, so it cannot be used to
    // overwrite an existing row.
    const id =
      typeof body.id === 'string' && /^[0-9a-f-]{36}$/i.test(body.id) ? body.id : uuid();

    let position: number;
    if (typeof body.position === 'number' && Number.isFinite(body.position)) {
      position = body.position;
    } else if (typeof body.after_id === 'string') {
      const neighbours = await c.env.DB.prepare(
        `SELECT position FROM meeting_note_blocks
          WHERE team_id = ? AND meeting_id = ? AND deleted_at IS NULL
          ORDER BY position ASC`,
      )
        .bind(teamId, meetingId)
        .all<{ position: number }>();
      const after = await c.env.DB.prepare(
        'SELECT position FROM meeting_note_blocks WHERE id = ? AND team_id = ?',
      )
        .bind(body.after_id, teamId)
        .first<{ position: number }>();
      const next = after
        ? (neighbours.results.find((n) => n.position > after.position)?.position ?? null)
        : null;
      position = positionBetween(after?.position ?? null, next);
    } else {
      position = await nextPosition(c.env.DB, 'meeting_note_blocks', teamId, meetingId);
    }

    const now = nowSeconds();
    try {
      await c.env.DB.prepare(
        `INSERT INTO meeting_note_blocks
           (id, team_id, meeting_id, position, kind, text, media_id,
            created_by_member_id, updated_by_member_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          id,
          teamId,
          meetingId,
          position,
          kind,
          String(body.text ?? '').slice(0, MAX_TEXT),
          optionalString(body.media_id, 64),
          member.id,
          member.id,
          now,
          now,
        )
        .run();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // The client retried a create it had already made. Returning the existing
      // row is what stops a flaky connection duplicating a paragraph the
      // student watched appear once.
      if (message.includes('UNIQUE')) {
        const existing = await c.env.DB.prepare(
          `SELECT ${BLOCK_COLUMNS} FROM meeting_note_blocks WHERE id = ? AND team_id = ?`,
        )
          .bind(id, teamId)
          .first();
        if (existing) return c.json({ block: existing }, 200);
      }
      throw err;
    }

    const row = await c.env.DB.prepare(
      `SELECT ${BLOCK_COLUMNS} FROM meeting_note_blocks WHERE id = ? AND team_id = ?`,
    )
      .bind(id, teamId)
      .first();
    return c.json({ block: row }, 201);
  },
);

/**
 * The keystroke path.
 *
 * `AND text <> ?` makes an unchanged autosave write zero rows, so a debounce
 * that fires on a paragraph nobody actually edited costs nothing. D1 bills per
 * row written and a shop full of students idling in an open editor would
 * otherwise pay for it.
 */
notes.patch(
  '/:id/blocks/:blockId',
  sameOriginOnly,
  requireMember,
  denyRole('viewer'),
  async (c) => {
    const body = await readJson(c);
    if (!body) return c.json({ error: 'invalid_body' }, 400);

    const { teamId, member } = authOf(c);
    const meetingId = c.req.param('id');
    const blockId = c.req.param('blockId');
    const now = nowSeconds();

    if (body.kind !== undefined && !isBlockKind(body.kind)) {
      return c.json({ error: 'invalid_kind' }, 400);
    }

    // Text-only edits take the cheap conditional path.
    if (
      body.text !== undefined &&
      body.kind === undefined &&
      body.media_id === undefined
    ) {
      const text = String(body.text).slice(0, MAX_TEXT);
      const result = await c.env.DB.prepare(
        `UPDATE meeting_note_blocks
            SET text = ?, updated_at = ?, updated_by_member_id = ?
          WHERE id = ? AND team_id = ? AND meeting_id = ?
            AND deleted_at IS NULL AND text <> ?`,
      )
        .bind(text, now, member.id, blockId, teamId, meetingId, text)
        .run();

      if (result.meta.changes === 0) {
        // Either nothing changed, or the block is not ours. Distinguish, so a
        // cross-tenant PATCH is still a 404 rather than a silent success.
        const exists = await c.env.DB.prepare(
          `SELECT ${BLOCK_COLUMNS} FROM meeting_note_blocks
            WHERE id = ? AND team_id = ? AND meeting_id = ? AND deleted_at IS NULL`,
        )
          .bind(blockId, teamId, meetingId)
          .first();
        if (!exists) return c.json({ error: 'not_found' }, 404);
        return c.json({ block: exists, unchanged: true });
      }

      const row = await c.env.DB.prepare(
        `SELECT ${BLOCK_COLUMNS} FROM meeting_note_blocks WHERE id = ? AND team_id = ?`,
      )
        .bind(blockId, teamId)
        .first();
      return c.json({ block: row });
    }

    const sets: string[] = [];
    const values: unknown[] = [];
    if (body.text !== undefined) {
      sets.push('text = ?');
      values.push(String(body.text).slice(0, MAX_TEXT));
    }
    if (body.kind !== undefined) {
      sets.push('kind = ?');
      values.push(body.kind);
    }
    if (body.media_id !== undefined) {
      sets.push('media_id = ?');
      values.push(optionalString(body.media_id, 64));
    }
    if (body.position !== undefined) {
      const position = Number(body.position);
      if (!Number.isFinite(position)) return c.json({ error: 'invalid_position' }, 400);
      sets.push('position = ?');
      values.push(position);
    }
    if (sets.length === 0) return c.json({ error: 'nothing_to_update' }, 400);

    sets.push('updated_at = ?', 'updated_by_member_id = ?');
    values.push(now, member.id);

    const result = await c.env.DB.prepare(
      `UPDATE meeting_note_blocks SET ${sets.join(', ')}
        WHERE id = ? AND team_id = ? AND meeting_id = ? AND deleted_at IS NULL`,
    )
      .bind(...values, blockId, teamId, meetingId)
      .run();
    if (result.meta.changes === 0) return c.json({ error: 'not_found' }, 404);

    const row = await c.env.DB.prepare(
      `SELECT ${BLOCK_COLUMNS} FROM meeting_note_blocks WHERE id = ? AND team_id = ?`,
    )
      .bind(blockId, teamId)
      .first();
    return c.json({ block: row });
  },
);

/**
 * Soft delete, and report whether a flag was left pointing at it.
 *
 * The candidate row survives on purpose. The flag is a decision one person
 * made and the delete is an action another person took, and the second should
 * not silently undo the first — so the editor gets `candidate_orphaned` and can
 * say so before it happens again.
 */
notes.delete(
  '/:id/blocks/:blockId',
  sameOriginOnly,
  requireMember,
  denyRole('viewer'),
  async (c) => {
    const { teamId, member } = authOf(c);
    const blockId = c.req.param('blockId');
    const now = nowSeconds();

    const result = await c.env.DB.prepare(
      `UPDATE meeting_note_blocks
          SET deleted_at = ?, updated_at = ?, updated_by_member_id = ?
        WHERE id = ? AND team_id = ? AND meeting_id = ? AND deleted_at IS NULL`,
    )
      .bind(now, now, member.id, blockId, teamId, c.req.param('id'))
      .run();
    if (result.meta.changes === 0) return c.json({ error: 'not_found' }, 404);

    const flag = await c.env.DB.prepare(
      `SELECT id FROM portfolio_candidates
        WHERE team_id = ? AND source_type = 'meeting_block' AND source_id = ?`,
    )
      .bind(teamId, blockId)
      .first();

    return c.json({ ok: true, block_id: blockId, candidate_orphaned: flag !== null });
  },
);

notes.post(
  '/:id/blocks/:blockId/restore',
  sameOriginOnly,
  requireMember,
  denyRole('viewer'),
  async (c) => {
    const { teamId, member } = authOf(c);
    const blockId = c.req.param('blockId');
    const now = nowSeconds();

    const result = await c.env.DB.prepare(
      `UPDATE meeting_note_blocks
          SET deleted_at = NULL, updated_at = ?, updated_by_member_id = ?
        WHERE id = ? AND team_id = ? AND meeting_id = ? AND deleted_at IS NOT NULL`,
    )
      .bind(now, member.id, blockId, teamId, c.req.param('id'))
      .run();
    if (result.meta.changes === 0) return c.json({ error: 'not_found' }, 404);

    const row = await c.env.DB.prepare(
      `SELECT ${BLOCK_COLUMNS} FROM meeting_note_blocks WHERE id = ? AND team_id = ?`,
    )
      .bind(blockId, teamId)
      .first();
    return c.json({ block: row });
  },
);

/**
 * The structural path: replace the document in one atomic batch.
 *
 * Diffs the posted list against the live ids. Entries with a known id are
 * updated, entries without one are inserted with a fresh uuid, and live ids
 * absent from the body are soft-deleted. Returns the canonical list so the
 * client adopts server ids rather than guessing at them.
 */
notes.put(
  '/:id/blocks',
  sameOriginOnly,
  requireMember,
  denyRole('viewer'),
  async (c) => {
    const body = await readJson(c);
    if (!body || !Array.isArray(body.blocks)) {
      return c.json({ error: 'invalid_body' }, 400);
    }
    const incoming = body.blocks as Record<string, unknown>[];
    if (incoming.length > MAX_PUT_BLOCKS) {
      return c.json({ error: 'too_many_blocks', max: MAX_PUT_BLOCKS }, 409);
    }

    const { teamId, member } = authOf(c);
    const meetingId = c.req.param('id');
    if (!(await ownedMeeting(c.env.DB, teamId, meetingId))) {
      return c.json({ error: 'not_found' }, 404);
    }

    const { results: live } = await c.env.DB.prepare(
      `SELECT id FROM meeting_note_blocks
        WHERE team_id = ? AND meeting_id = ? AND deleted_at IS NULL`,
    )
      .bind(teamId, meetingId)
      .all<{ id: string }>();
    const liveIds = new Set(live.map((r) => r.id));

    const now = nowSeconds();
    const statements: D1PreparedStatement[] = [];
    const keptIds = new Set<string>();

    incoming.forEach((entry, index) => {
      const kind = entry.kind === undefined ? 'paragraph' : entry.kind;
      if (!isBlockKind(kind)) return;
      const text = String(entry.text ?? '').slice(0, MAX_TEXT);
      const mediaId = optionalString(entry.media_id, 64);
      // Renormalised rather than trusting client floats: a long editing session
      // of inserts-between eventually produces positions too close to bisect,
      // and a structural write is exactly the moment to reset the spacing.
      const position = (index + 1) * POSITION_GAP;
      const id = typeof entry.id === 'string' ? entry.id : null;

      if (id && liveIds.has(id)) {
        keptIds.add(id);
        statements.push(
          c.env.DB.prepare(
            `UPDATE meeting_note_blocks
                SET kind = ?, text = ?, media_id = ?, position = ?,
                    updated_at = ?, updated_by_member_id = ?
              WHERE id = ? AND team_id = ? AND meeting_id = ?`,
          ).bind(kind, text, mediaId, position, now, member.id, id, teamId, meetingId),
        );
      } else {
        const newId = id ?? uuid();
        keptIds.add(newId);
        statements.push(
          c.env.DB.prepare(
            `INSERT INTO meeting_note_blocks
               (id, team_id, meeting_id, position, kind, text, media_id,
                created_by_member_id, updated_by_member_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (id) DO UPDATE SET
               kind = excluded.kind, text = excluded.text,
               media_id = excluded.media_id, position = excluded.position,
               deleted_at = NULL, updated_at = excluded.updated_at,
               updated_by_member_id = excluded.updated_by_member_id`,
          ).bind(
            newId,
            teamId,
            meetingId,
            position,
            kind,
            text,
            mediaId,
            member.id,
            member.id,
            now,
            now,
          ),
        );
      }
    });

    for (const id of liveIds) {
      if (keptIds.has(id)) continue;
      statements.push(
        c.env.DB.prepare(
          `UPDATE meeting_note_blocks
              SET deleted_at = ?, updated_at = ?, updated_by_member_id = ?
            WHERE id = ? AND team_id = ? AND meeting_id = ?`,
        ).bind(now, now, member.id, id, teamId, meetingId),
      );
    }

    if (statements.length > 0) await c.env.DB.batch(statements);

    const { results } = await c.env.DB.prepare(
      `SELECT ${BLOCK_COLUMNS} FROM meeting_note_blocks
        WHERE team_id = ? AND meeting_id = ? AND deleted_at IS NULL
        ORDER BY position ASC`,
    )
      .bind(teamId, meetingId)
      .all();

    return c.json({ blocks: results, rev: now });
  },
);

export { notes };
