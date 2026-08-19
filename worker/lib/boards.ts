/**
 * Task statuses, patch-building and op limits for the boards routes.
 *
 * The status list used to live in `routes/boards.ts`, which made it the only
 * enum guard in the codebase sitting in a route rather than beside its
 * siblings in `lib/roles.ts` and `lib/meetings.ts`. It moved here when
 * `/mutate` and `PATCH /tasks/:id` had to start agreeing about what a patch
 * means — two callers is the point at which the rules stop being local.
 *
 * Duplicated from `src/types.ts` for the same reason `roles.ts` is: the worker
 * tsconfig includes only `worker/`, and this copy is the one that decides what
 * reaches D1. Keep the two lists in sync.
 */
import { boundedInt, optionalString } from './http';

export const TASK_STATUSES = ['todo', 'doing', 'blocked', 'done'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value);
}

/**
 * Cap on ops in one `/mutate` call.
 *
 * Was 50, on the reasoning that "one drag is one op; fifty is a bulk edit
 * nobody performs by hand". Reordering within a column introduced the one
 * legitimate bulk case: when the 1024-gap midpoints between two neighbours are
 * exhausted, the client renumbers that whole column in a single batch. 200 is
 * well past any column an FTC team will build and still far from a payload
 * worth worrying about.
 */
export const MAX_OPS = 200;

/** The furthest-future `due_at` accepted: 2100-01-01. */
export const MAX_DUE_AT = 4_102_444_800;

/** Every task column, for the re-SELECT that follows a write. */
export const TASK_COLUMNS = `id, team_id, board_id, title, body, assignee_member_id, status,
        due_at, position, decision_log, created_at, updated_at`;

/**
 * The same list aliased to `t`, for the one query that joins `boards` to reach
 * `season_id`. Spelled out rather than derived from TASK_COLUMNS by string
 * surgery: a regex over a column list is unreadable and fails silently.
 */
export const TASK_COLUMNS_T = `t.id, t.team_id, t.board_id, t.title, t.body,
        t.assignee_member_id, t.status, t.due_at, t.position, t.decision_log,
        t.created_at, t.updated_at`;

/** A `position` from a request body: any finite number, including 0. */
export function taskPosition(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

export type TaskPatch =
  | { sets: string[]; values: unknown[] }
  | { error: string };

/**
 * Build the SET clause for a task update.
 *
 * The distinction this exists to preserve is **absent vs. explicitly null**.
 * `/mutate`'s `update_task` used to write every field as `COALESCE(?, col)`,
 * which collapses the two: a patch could set a due date but never clear one,
 * and the decision log — the whole point of the task dialog — could be written
 * once and then never emptied. Callers here send only the keys they mean, and a
 * `null` value means clear.
 *
 * `optionalString` returns null for a blank string as well as an absent one,
 * which is what we want: a textarea emptied to whitespace is a request to
 * clear the field, not to store "   ".
 */
export function buildTaskPatch(patch: Record<string, unknown>): TaskPatch {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (patch.title !== undefined) {
    const title = optionalString(patch.title, 200);
    // The one field with no null form — a task with no title is unreachable in
    // the UI, so an empty one is a client bug rather than a clear.
    if (!title) return { error: 'missing_title' };
    sets.push('title = ?');
    values.push(title);
  }
  if (patch.body !== undefined) {
    sets.push('body = ?');
    values.push(optionalString(patch.body, 5000));
  }
  if (patch.status !== undefined) {
    if (!isTaskStatus(patch.status)) return { error: 'invalid_status' };
    sets.push('status = ?');
    values.push(patch.status);
  }
  if (patch.assignee_member_id !== undefined) {
    sets.push('assignee_member_id = ?');
    values.push(optionalString(patch.assignee_member_id, 64));
  }
  if (patch.due_at !== undefined) {
    sets.push('due_at = ?');
    values.push(patch.due_at === null ? null : boundedInt(patch.due_at, 0, MAX_DUE_AT));
  }
  if (patch.decision_log !== undefined) {
    sets.push('decision_log = ?');
    values.push(optionalString(patch.decision_log, 5000));
  }
  if (patch.position !== undefined) {
    const position = taskPosition(patch.position);
    if (position === null) return { error: 'invalid_position' };
    sets.push('position = ?');
    values.push(position);
  }

  if (sets.length === 0) return { error: 'nothing_to_update' };
  return { sets, values };
}
