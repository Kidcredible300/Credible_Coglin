/**
 * Boards and tasks (COG-011, COG-012).
 *
 * This exists because `src/lib/api.ts` promised it: `mutateBoard` says verbatim
 * that `BoardOp` "takes the same op shape the server will accept at POST
 * /api/boards/:id/mutate". That contract was written before any server existed,
 * and leaving it unfulfilled would mean the kanban's drag-and-drop needed a
 * second, different write path. `/mutate` below is that endpoint, and it takes
 * exactly the union declared in `src/types.ts`.
 *
 * Statuses, the op cap and the patch builder live in `../lib/boards.ts` because
 * `/mutate` and `PATCH /tasks/:id` have to agree about what a patch means.
 */
import { Hono } from 'hono';
import { nowSeconds, uuid } from '../lib/crypto';
import {
  MAX_DUE_AT,
  MAX_OPS,
  TASK_COLUMNS,
  TASK_COLUMNS_T,
  buildTaskPatch,
  isTaskStatus,
  taskPosition,
} from '../lib/boards';
import { boundedInt, optionalString, readJson } from '../lib/http';
import { isSubTeam } from '../lib/roles';
import {
  auth as authOf,
  denyRole,
  requireMember,
  requireRole,
  sameOriginOnly,
  type AppEnv,
} from '../lib/tenancy';

const boards = new Hono<AppEnv>();

const BOARD_COLUMNS = 'id, team_id, season_id, name, sub_team, position';

async function currentSeasonId(db: D1Database, teamId: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT id FROM seasons WHERE team_id = ? AND is_current = 1')
    .bind(teamId)
    .first<{ id: string }>();
  return row?.id ?? null;
}

// ------------------------------------------------------------------- boards

/**
 * Boards for the CURRENT season only.
 *
 * `season_id` was written on every insert from the first migration and never
 * read back, so the alpha team's second season would have opened onto the
 * first season's boards. A team with no current season gets an empty list
 * rather than a 409: a read must not fail, and the empty state already says
 * the right thing.
 */
boards.get('/boards', requireMember, async (c) => {
  const { teamId } = authOf(c);
  const seasonId = await currentSeasonId(c.env.DB, teamId);
  if (!seasonId) return c.json({ boards: [] });

  const { results } = await c.env.DB.prepare(
    `SELECT ${BOARD_COLUMNS} FROM boards
      WHERE team_id = ? AND season_id = ? ORDER BY position ASC`,
  )
    .bind(teamId, seasonId)
    .all();
  return c.json({ boards: results });
});

boards.post(
  '/boards',
  sameOriginOnly,
  requireMember,
  requireRole('coach', 'mentor'),
  async (c) => {
    const body = await readJson(c);
    if (!body) return c.json({ error: 'invalid_body' }, 400);

    const { teamId } = authOf(c);
    const seasonId = await currentSeasonId(c.env.DB, teamId);
    if (!seasonId) return c.json({ error: 'no_current_season' }, 409);

    const name = optionalString(body.name, 100);
    if (!name) return c.json({ error: 'missing_name' }, 400);
    if (body.sub_team !== undefined && body.sub_team !== null && !isSubTeam(body.sub_team)) {
      return c.json({ error: 'invalid_sub_team' }, 400);
    }

    // Season-scoped, matching the read. A team-wide MAX would leave a new
    // season's first board sorting after last season's last one.
    const max = await c.env.DB.prepare(
      'SELECT COALESCE(MAX(position), 0) AS max FROM boards WHERE team_id = ? AND season_id = ?',
    )
      .bind(teamId, seasonId)
      .first<{ max: number }>();

    const id = uuid();
    await c.env.DB.prepare(
      'INSERT INTO boards (id, team_id, season_id, name, sub_team, position) VALUES (?, ?, ?, ?, ?, ?)',
    )
      .bind(id, teamId, seasonId, name, (body.sub_team as string | null) ?? null, (max?.max ?? 0) + 1)
      .run();

    const row = await c.env.DB.prepare(
      `SELECT ${BOARD_COLUMNS} FROM boards WHERE id = ? AND team_id = ?`,
    )
      .bind(id, teamId)
      .first();
    return c.json({ board: row }, 201);
  },
);

/** Rename, re-file under a sub-team, or reorder the board tabs. */
boards.patch(
  '/boards/:id',
  sameOriginOnly,
  requireMember,
  requireRole('coach', 'mentor'),
  async (c) => {
    const body = await readJson(c);
    if (!body) return c.json({ error: 'invalid_body' }, 400);
    const { teamId } = authOf(c);
    const id = c.req.param('id');

    const sets: string[] = [];
    const values: unknown[] = [];
    if (body.name !== undefined) {
      const name = optionalString(body.name, 100);
      if (!name) return c.json({ error: 'missing_name' }, 400);
      sets.push('name = ?');
      values.push(name);
    }
    if (body.sub_team !== undefined) {
      if (body.sub_team !== null && !isSubTeam(body.sub_team)) {
        return c.json({ error: 'invalid_sub_team' }, 400);
      }
      sets.push('sub_team = ?');
      values.push(body.sub_team);
    }
    if (body.position !== undefined) {
      const position = boundedInt(body.position, 0, 1_000_000);
      if (position === null) return c.json({ error: 'invalid_position' }, 400);
      sets.push('position = ?');
      values.push(position);
    }
    if (sets.length === 0) return c.json({ error: 'nothing_to_update' }, 400);

    const result = await c.env.DB.prepare(
      `UPDATE boards SET ${sets.join(', ')} WHERE id = ? AND team_id = ?`,
    )
      .bind(...values, id, teamId)
      .run();
    if (result.meta.changes === 0) return c.json({ error: 'not_found' }, 404);

    const row = await c.env.DB.prepare(
      `SELECT ${BOARD_COLUMNS} FROM boards WHERE id = ? AND team_id = ?`,
    )
      .bind(id, teamId)
      .first();
    return c.json({ board: row });
  },
);

boards.delete(
  '/boards/:id',
  sameOriginOnly,
  requireMember,
  requireRole('coach'),
  async (c) => {
    const { teamId } = authOf(c);
    const id = c.req.param('id');
    const force = new URL(c.req.url).searchParams.get('force') === '1';

    const board = await c.env.DB.prepare(
      'SELECT id FROM boards WHERE id = ? AND team_id = ?',
    )
      .bind(id, teamId)
      .first();
    if (!board) return c.json({ error: 'not_found' }, 404);

    if (!force) {
      const tasks = await c.env.DB.prepare(
        'SELECT COUNT(*) AS n FROM tasks WHERE team_id = ? AND board_id = ?',
      )
        .bind(teamId, id)
        .first<{ n: number }>();
      if ((tasks?.n ?? 0) > 0) {
        return c.json({ error: 'board_has_tasks', tasks: tasks?.n ?? 0 }, 409);
      }
    }

    await c.env.DB.prepare('DELETE FROM boards WHERE id = ? AND team_id = ?')
      .bind(id, teamId)
      .run();
    return c.json({ ok: true });
  },
);

/**
 * The board's revision, for polling (COG-009 shipped as polling rather than a
 * Durable Object; see the plan and README).
 *
 * One aggregate query, one row read, on `idx_tasks_board`. Clients poll this
 * and only refetch the task list when the answer changes, so a board nobody is
 * touching costs a single row read per client per tick.
 *
 * `count` is not redundant with `rev`: MAX(updated_at) cannot see a DELETE. Drop
 * the newest card and the max falls back to an older, unchanged timestamp — or,
 * if an older card is deleted, does not move at all. The pair catches every
 * mutation; either alone does not.
 */
boards.get('/boards/:id/rev', requireMember, async (c) => {
  const { teamId } = authOf(c);
  const id = c.req.param('id');

  const board = await c.env.DB.prepare(
    'SELECT id FROM boards WHERE id = ? AND team_id = ?',
  )
    .bind(id, teamId)
    .first();
  if (!board) return c.json({ error: 'not_found' }, 404);

  const row = await c.env.DB.prepare(
    `SELECT COALESCE(MAX(updated_at), 0) AS rev, COUNT(*) AS count
       FROM tasks WHERE team_id = ? AND board_id = ?`,
  )
    .bind(teamId, id)
    .first<{ rev: number; count: number }>();

  return c.json({ rev: row?.rev ?? 0, count: row?.count ?? 0 });
});

// -------------------------------------------------------------------- tasks

/**
 * Tasks, either for one board or for the whole current season.
 *
 * `tasks` carries no `season_id` of its own — it inherits one through
 * `board_id` — so the unfiltered case joins `boards` to avoid handing the
 * dashboard last season's open-task count. With `board_id` given the join is
 * unnecessary: the board is already team-scoped and belongs to exactly one
 * season.
 */
boards.get('/tasks', requireMember, async (c) => {
  const { teamId } = authOf(c);
  const url = new URL(c.req.url);
  const boardId = url.searchParams.get('board_id');
  const status = url.searchParams.get('status');
  if (status !== null && !isTaskStatus(status)) {
    return c.json({ error: 'invalid_status' }, 400);
  }

  if (boardId) {
    const { results } = await c.env.DB.prepare(
      `SELECT ${TASK_COLUMNS} FROM tasks
        WHERE team_id = ? AND board_id = ?
          AND (? IS NULL OR status = ?)
        ORDER BY position ASC`,
    )
      .bind(teamId, boardId, status, status)
      .all();
    return c.json({ tasks: results });
  }

  const seasonId = await currentSeasonId(c.env.DB, teamId);
  if (!seasonId) return c.json({ tasks: [] });

  const { results } = await c.env.DB.prepare(
    `SELECT ${TASK_COLUMNS_T}
       FROM tasks t
       JOIN boards b ON b.id = t.board_id AND b.team_id = t.team_id
      WHERE t.team_id = ? AND b.season_id = ?
        AND (? IS NULL OR t.status = ?)
      ORDER BY t.position ASC`,
  )
    .bind(teamId, seasonId, status, status)
    .all();
  return c.json({ tasks: results });
});

boards.post('/tasks', sameOriginOnly, requireMember, denyRole('viewer'), async (c) => {
  const body = await readJson(c);
  if (!body) return c.json({ error: 'invalid_body' }, 400);

  const { teamId } = authOf(c);
  const boardId = optionalString(body.board_id, 64);
  if (!boardId) return c.json({ error: 'missing_board_id' }, 400);
  const title = optionalString(body.title, 200);
  if (!title) return c.json({ error: 'missing_title' }, 400);

  const board = await c.env.DB.prepare(
    'SELECT id FROM boards WHERE id = ? AND team_id = ?',
  )
    .bind(boardId, teamId)
    .first();
  if (!board) return c.json({ error: 'not_found' }, 404);

  const status = body.status === undefined ? 'todo' : body.status;
  if (!isTaskStatus(status)) return c.json({ error: 'invalid_status' }, 400);

  const max = await c.env.DB.prepare(
    'SELECT COALESCE(MAX(position), 0) AS max FROM tasks WHERE team_id = ? AND board_id = ?',
  )
    .bind(teamId, boardId)
    .first<{ max: number }>();

  const id = uuid();
  const now = nowSeconds();
  await c.env.DB.prepare(
    `INSERT INTO tasks
       (id, team_id, board_id, title, body, assignee_member_id, status, due_at,
        position, decision_log, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      teamId,
      boardId,
      title,
      optionalString(body.body, 5000),
      optionalString(body.assignee_member_id, 64),
      status,
      boundedInt(body.due_at, 0, MAX_DUE_AT),
      (max?.max ?? 0) + 1024,
      optionalString(body.decision_log, 5000),
      now,
      now,
    )
    .run();

  const row = await c.env.DB.prepare(
    `SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ? AND team_id = ?`,
  )
    .bind(id, teamId)
    .first();
  return c.json({ task: row }, 201);
});

boards.patch('/tasks/:id', sameOriginOnly, requireMember, denyRole('viewer'), async (c) => {
  const body = await readJson(c);
  if (!body) return c.json({ error: 'invalid_body' }, 400);
  const { teamId } = authOf(c);

  const patch = buildTaskPatch(body);
  if ('error' in patch) return c.json({ error: patch.error }, 400);

  const result = await c.env.DB.prepare(
    `UPDATE tasks SET ${patch.sets.join(', ')}, updated_at = ? WHERE id = ? AND team_id = ?`,
  )
    .bind(...patch.values, nowSeconds(), c.req.param('id'), teamId)
    .run();
  if (result.meta.changes === 0) return c.json({ error: 'not_found' }, 404);

  const row = await c.env.DB.prepare(
    `SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ? AND team_id = ?`,
  )
    .bind(c.req.param('id'), teamId)
    .first();
  return c.json({ task: row });
});

boards.delete('/tasks/:id', sameOriginOnly, requireMember, denyRole('viewer'), async (c) => {
  const { teamId } = authOf(c);
  const result = await c.env.DB.prepare(
    'DELETE FROM tasks WHERE id = ? AND team_id = ?',
  )
    .bind(c.req.param('id'), teamId)
    .run();
  if (result.meta.changes === 0) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true });
});

/**
 * The op stream the client already speaks.
 *
 * Applied in one batch so a drag that moves a card and reorders its column
 * cannot land half-applied — which, on a board, looks to everyone else like
 * somebody else moved their card. The same batching is what lets the client
 * renumber an exhausted column in a single call.
 */
boards.post(
  '/boards/:id/mutate',
  sameOriginOnly,
  requireMember,
  denyRole('viewer'),
  async (c) => {
    const body = await readJson(c);
    if (!body || !Array.isArray(body.ops)) return c.json({ error: 'invalid_body' }, 400);
    const ops = body.ops as Record<string, unknown>[];
    if (ops.length > MAX_OPS) return c.json({ error: 'too_many_ops', max: MAX_OPS }, 409);

    const { teamId } = authOf(c);
    const boardId = c.req.param('id');
    const board = await c.env.DB.prepare(
      'SELECT id FROM boards WHERE id = ? AND team_id = ?',
    )
      .bind(boardId, teamId)
      .first();
    if (!board) return c.json({ error: 'not_found' }, 404);

    const now = nowSeconds();
    const statements: D1PreparedStatement[] = [];

    for (const op of ops) {
      switch (op.op) {
        case 'move_task': {
          if (!isTaskStatus(op.status)) return c.json({ error: 'invalid_status' }, 400);
          // Not `Number(x) || 0`: that mapped both a legitimate 0 and outright
          // garbage onto the same position, which is how every card ended up
          // stacked at 0 in the first place.
          const position = taskPosition(op.position);
          if (position === null) return c.json({ error: 'invalid_position' }, 400);
          statements.push(
            c.env.DB.prepare(
              `UPDATE tasks SET status = ?, position = ?, updated_at = ?
                WHERE id = ? AND team_id = ? AND board_id = ?`,
            ).bind(op.status, position, now, op.task_id, teamId, boardId),
          );
          break;
        }
        case 'create_task': {
          const task = op.task as Record<string, unknown> | undefined;
          if (!task) return c.json({ error: 'invalid_op' }, 400);
          const status = isTaskStatus(task.status) ? task.status : 'todo';
          const position = taskPosition(task.position);
          if (position === null) return c.json({ error: 'invalid_position' }, 400);
          statements.push(
            c.env.DB.prepare(
              `INSERT INTO tasks
                 (id, team_id, board_id, title, body, assignee_member_id, status,
                  due_at, position, decision_log, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT (id) DO NOTHING`,
            ).bind(
              optionalString(task.id, 64) ?? uuid(),
              teamId,
              boardId,
              optionalString(task.title, 200) ?? 'Untitled',
              optionalString(task.body, 5000),
              optionalString(task.assignee_member_id, 64),
              status,
              boundedInt(task.due_at, 0, MAX_DUE_AT),
              position,
              optionalString(task.decision_log, 5000),
              now,
              now,
            ),
          );
          break;
        }
        case 'update_task': {
          // Shares `buildTaskPatch` with PATCH /tasks/:id so the two cannot
          // drift on the question that matters here: an absent key leaves the
          // column alone, an explicit null clears it. The old COALESCE form
          // could not express the second, which made the decision log and the
          // due date write-once.
          const patch = buildTaskPatch((op.patch ?? {}) as Record<string, unknown>);
          if ('error' in patch) return c.json({ error: patch.error }, 400);
          statements.push(
            c.env.DB.prepare(
              `UPDATE tasks SET ${patch.sets.join(', ')}, updated_at = ?
                WHERE id = ? AND team_id = ? AND board_id = ?`,
            ).bind(...patch.values, now, op.task_id, teamId, boardId),
          );
          break;
        }
        case 'delete_task': {
          statements.push(
            c.env.DB.prepare(
              'DELETE FROM tasks WHERE id = ? AND team_id = ? AND board_id = ?',
            ).bind(op.task_id, teamId, boardId),
          );
          break;
        }
        default:
          return c.json({ error: 'invalid_op' }, 400);
      }
    }

    if (statements.length > 0) await c.env.DB.batch(statements);

    const { results } = await c.env.DB.prepare(
      `SELECT ${TASK_COLUMNS} FROM tasks WHERE team_id = ? AND board_id = ? ORDER BY position ASC`,
    )
      .bind(teamId, boardId)
      .all();
    return c.json({ ok: true, tasks: results });
  },
);

export { boards };
