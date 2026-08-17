/**
 * Boards and tasks (COG-011, the slice meetings needs).
 *
 * This exists now because `src/lib/api.ts` already promises it: `mutateBoard`
 * says verbatim that `BoardOp` "takes the same op shape the server will accept
 * at POST /api/boards/:id/mutate". That contract was written before any server
 * existed, and leaving it unfulfilled would mean the kanban's drag-and-drop
 * needed a second, different write path. `/mutate` below is that endpoint, and
 * it takes exactly the union declared in `src/types.ts`.
 */
import { Hono } from 'hono';
import { nowSeconds, uuid } from '../lib/crypto';
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

/** One drag is one op; fifty is a bulk edit nobody performs by hand. */
const MAX_OPS = 50;

const TASK_STATUSES = ['todo', 'doing', 'blocked', 'done'] as const;
type TaskStatus = (typeof TASK_STATUSES)[number];

/**
 * Duplicated from `src/types.ts` for the same reason `roles.ts` is: the worker
 * tsconfig includes only `worker/`, and this copy is the one that decides what
 * reaches D1. Keep the two lists in sync.
 */
function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value);
}

const TASK_COLUMNS = `id, team_id, board_id, title, body, assignee_member_id, status,
        due_at, position, decision_log, created_at, updated_at`;

async function currentSeasonId(db: D1Database, teamId: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT id FROM seasons WHERE team_id = ? AND is_current = 1')
    .bind(teamId)
    .first<{ id: string }>();
  return row?.id ?? null;
}

// ------------------------------------------------------------------- boards

boards.get('/boards', requireMember, async (c) => {
  const { teamId } = authOf(c);
  const { results } = await c.env.DB.prepare(
    `SELECT id, team_id, season_id, name, sub_team, position FROM boards
      WHERE team_id = ? ORDER BY position ASC`,
  )
    .bind(teamId)
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

    const max = await c.env.DB.prepare(
      'SELECT COALESCE(MAX(position), 0) AS max FROM boards WHERE team_id = ?',
    )
      .bind(teamId)
      .first<{ max: number }>();

    const id = uuid();
    await c.env.DB.prepare(
      'INSERT INTO boards (id, team_id, season_id, name, sub_team, position) VALUES (?, ?, ?, ?, ?, ?)',
    )
      .bind(id, teamId, seasonId, name, (body.sub_team as string | null) ?? null, (max?.max ?? 0) + 1)
      .run();

    const row = await c.env.DB.prepare(
      'SELECT id, team_id, season_id, name, sub_team, position FROM boards WHERE id = ? AND team_id = ?',
    )
      .bind(id, teamId)
      .first();
    return c.json({ board: row }, 201);
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

// -------------------------------------------------------------------- tasks

boards.get('/tasks', requireMember, async (c) => {
  const { teamId } = authOf(c);
  const url = new URL(c.req.url);
  const boardId = url.searchParams.get('board_id');
  const status = url.searchParams.get('status');
  if (status !== null && !isTaskStatus(status)) {
    return c.json({ error: 'invalid_status' }, 400);
  }

  const { results } = await c.env.DB.prepare(
    `SELECT ${TASK_COLUMNS} FROM tasks
      WHERE team_id = ?
        AND (? IS NULL OR board_id = ?)
        AND (? IS NULL OR status = ?)
      ORDER BY position ASC`,
  )
    .bind(teamId, boardId, boardId, status, status)
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
      boundedInt(body.due_at, 0, 4_102_444_800),
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

  const sets: string[] = [];
  const values: unknown[] = [];
  if (body.title !== undefined) {
    const title = optionalString(body.title, 200);
    if (!title) return c.json({ error: 'missing_title' }, 400);
    sets.push('title = ?');
    values.push(title);
  }
  if (body.body !== undefined) {
    sets.push('body = ?');
    values.push(optionalString(body.body, 5000));
  }
  if (body.status !== undefined) {
    if (!isTaskStatus(body.status)) return c.json({ error: 'invalid_status' }, 400);
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
  if (body.decision_log !== undefined) {
    sets.push('decision_log = ?');
    values.push(optionalString(body.decision_log, 5000));
  }
  if (body.position !== undefined) {
    sets.push('position = ?');
    values.push(Number(body.position));
  }
  if (sets.length === 0) return c.json({ error: 'nothing_to_update' }, 400);

  sets.push('updated_at = ?');
  values.push(nowSeconds());

  const result = await c.env.DB.prepare(
    `UPDATE tasks SET ${sets.join(', ')} WHERE id = ? AND team_id = ?`,
  )
    .bind(...values, c.req.param('id'), teamId)
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
 * somebody else moved their card.
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
          statements.push(
            c.env.DB.prepare(
              `UPDATE tasks SET status = ?, position = ?, updated_at = ?
                WHERE id = ? AND team_id = ? AND board_id = ?`,
            ).bind(op.status, Number(op.position) || 0, now, op.task_id, teamId, boardId),
          );
          break;
        }
        case 'create_task': {
          const task = op.task as Record<string, unknown> | undefined;
          if (!task) return c.json({ error: 'invalid_op' }, 400);
          const status = isTaskStatus(task.status) ? task.status : 'todo';
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
              boundedInt(task.due_at, 0, 4_102_444_800),
              Number(task.position) || 0,
              optionalString(task.decision_log, 5000),
              now,
              now,
            ),
          );
          break;
        }
        case 'update_task': {
          const patch = (op.patch ?? {}) as Record<string, unknown>;
          if (patch.status !== undefined && !isTaskStatus(patch.status)) {
            return c.json({ error: 'invalid_status' }, 400);
          }
          statements.push(
            c.env.DB.prepare(
              `UPDATE tasks
                  SET title = COALESCE(?, title),
                      body = COALESCE(?, body),
                      status = COALESCE(?, status),
                      assignee_member_id = COALESCE(?, assignee_member_id),
                      due_at = COALESCE(?, due_at),
                      decision_log = COALESCE(?, decision_log),
                      updated_at = ?
                WHERE id = ? AND team_id = ? AND board_id = ?`,
            ).bind(
              optionalString(patch.title, 200),
              optionalString(patch.body, 5000),
              (patch.status as string | undefined) ?? null,
              optionalString(patch.assignee_member_id, 64),
              boundedInt(patch.due_at, 0, 4_102_444_800),
              optionalString(patch.decision_log, 5000),
              now,
              op.task_id,
              teamId,
              boardId,
            ),
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
