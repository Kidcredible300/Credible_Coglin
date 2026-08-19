import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import worker from '../index';
import {
  ORIGIN,
  call,
  callJson,
  inviteAndAccept,
  signUpCoach,
  stubResend,
  whoami,
} from './_helpers';

/**
 * Boards, tasks and the op stream.
 *
 * `/mutate` is the highest-risk endpoint in the app — batched writes, per-op
 * validation, and tenancy scoping on three columns at once — and it shipped
 * without a suite. Most of what is asserted here is the tenancy rule
 * (`worker/lib/tenancy.ts`): a board id is not a capability, and naming
 * somebody else's is a 404 rather than a read.
 *
 * Team numbers are the isolation key across suites; this file owns 82xx.
 */

beforeAll(() => {
  stubResend();
});

type Board = { id: string; name: string; sub_team: string | null; position: number };
type Task = {
  id: string;
  board_id: string;
  title: string;
  body: string | null;
  status: string;
  due_at: number | null;
  position: number;
  decision_log: string | null;
  assignee_member_id: string | null;
  updated_at: number;
};

async function makeBoard(cookie: string, name = 'Build'): Promise<string> {
  const { status, body } = await callJson<{ board: Board }>('/api/boards', {
    method: 'POST',
    cookie,
    body: JSON.stringify({ name }),
  });
  expect(status).toBe(201);
  return body.board.id;
}

async function makeTask(
  cookie: string,
  boardId: string,
  overrides: Record<string, unknown> = {},
): Promise<Task> {
  const { status, body } = await callJson<{ task: Task }>('/api/tasks', {
    method: 'POST',
    cookie,
    body: JSON.stringify({ board_id: boardId, title: 'Mount the chassis', ...overrides }),
  });
  expect(status).toBe(201);
  return body.task;
}

function mutate(cookie: string, boardId: string, ops: unknown[]) {
  return callJson<{ ok: true; tasks: Task[]; error?: string; max?: number }>(
    `/api/boards/${boardId}/mutate`,
    { method: 'POST', cookie, body: JSON.stringify({ ops }) },
  );
}

describe('boards', () => {
  it('creates a board in the current season and lists it', async () => {
    const coach = await signUpCoach(8200);
    const id = await makeBoard(coach, 'Programming');

    const { status, body } = await callJson<{ boards: Board[] }>('/api/boards', { cookie: coach });
    expect(status).toBe(200);
    expect(body.boards.map((b) => b.id)).toEqual([id]);
    expect(body.boards[0].name).toBe('Programming');
  });

  it('rejects a name that is only whitespace', async () => {
    const coach = await signUpCoach(8201);
    const { status, body } = await callJson<{ error: string }>('/api/boards', {
      method: 'POST',
      cookie: coach,
      body: JSON.stringify({ name: '   ' }),
    });
    expect(status).toBe(400);
    expect(body.error).toBe('missing_name');
  });

  it('rejects a sub_team that is not one of the seven', async () => {
    const coach = await signUpCoach(8202);
    const { status, body } = await callJson<{ error: string }>('/api/boards', {
      method: 'POST',
      cookie: coach,
      body: JSON.stringify({ name: 'Marketing', sub_team: 'marketing' }),
    });
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_sub_team');
  });

  it('renames a board and files it under a sub-team', async () => {
    const coach = await signUpCoach(8203);
    const id = await makeBoard(coach);

    const { status, body } = await callJson<{ board: Board }>(`/api/boards/${id}`, {
      method: 'PATCH',
      cookie: coach,
      body: JSON.stringify({ name: 'Drivetrain', sub_team: 'build' }),
    });
    expect(status).toBe(200);
    expect(body.board.name).toBe('Drivetrain');
    expect(body.board.sub_team).toBe('build');
  });

  it('clears a sub-team with an explicit null', async () => {
    const coach = await signUpCoach(8204);
    const id = await makeBoard(coach);
    await callJson(`/api/boards/${id}`, {
      method: 'PATCH',
      cookie: coach,
      body: JSON.stringify({ sub_team: 'cad' }),
    });

    const { body } = await callJson<{ board: Board }>(`/api/boards/${id}`, {
      method: 'PATCH',
      cookie: coach,
      body: JSON.stringify({ sub_team: null }),
    });
    expect(body.board.sub_team).toBeNull();
  });

  it('answers nothing_to_update for an empty patch', async () => {
    const coach = await signUpCoach(8205);
    const id = await makeBoard(coach);
    const { status, body } = await callJson<{ error: string }>(`/api/boards/${id}`, {
      method: 'PATCH',
      cookie: coach,
      body: JSON.stringify({}),
    });
    expect(status).toBe(400);
    expect(body.error).toBe('nothing_to_update');
  });

  it('refuses to delete a board holding tasks, then obeys force', async () => {
    const coach = await signUpCoach(8206);
    const id = await makeBoard(coach);
    await makeTask(coach, id);

    const blocked = await callJson<{ error: string; tasks: number }>(`/api/boards/${id}`, {
      method: 'DELETE',
      cookie: coach,
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toBe('board_has_tasks');
    expect(blocked.body.tasks).toBe(1);

    const forced = await call(`/api/boards/${id}?force=1`, { method: 'DELETE', cookie: coach });
    expect(forced.status).toBe(200);

    // The tasks went with it, via ON DELETE CASCADE.
    const left = await env.DB.prepare('SELECT COUNT(*) AS n FROM tasks WHERE board_id = ?')
      .bind(id)
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
  });
});

describe('board revision', () => {
  it('moves when a task is added or edited', async () => {
    const coach = await signUpCoach(8210);
    const boardId = await makeBoard(coach);

    const empty = await callJson<{ rev: number; count: number }>(
      `/api/boards/${boardId}/rev`,
      { cookie: coach },
    );
    expect(empty.body).toEqual({ rev: 0, count: 0 });

    const task = await makeTask(coach, boardId);
    const afterCreate = await callJson<{ rev: number; count: number }>(
      `/api/boards/${boardId}/rev`,
      { cookie: coach },
    );
    expect(afterCreate.body.count).toBe(1);
    expect(afterCreate.body.rev).toBe(task.updated_at);
  });

  /**
   * The reason `count` exists alongside `rev`.
   *
   * MAX(updated_at) cannot see a DELETE. Two tasks written in the same second
   * share a timestamp, so removing one leaves the max exactly where it was and
   * a rev-only poll would never refetch — the deleted card would sit on every
   * other client's screen until they reloaded.
   */
  it('changes when a task is deleted even though the max timestamp does not', async () => {
    const coach = await signUpCoach(8211);
    const boardId = await makeBoard(coach);
    const first = await makeTask(coach, boardId, { title: 'One' });
    const second = await makeTask(coach, boardId, { title: 'Two' });

    const before = await callJson<{ rev: number; count: number }>(
      `/api/boards/${boardId}/rev`,
      { cookie: coach },
    );

    await call(`/api/tasks/${first.id}`, { method: 'DELETE', cookie: coach });

    const after = await callJson<{ rev: number; count: number }>(
      `/api/boards/${boardId}/rev`,
      { cookie: coach },
    );

    // Same second, so the timestamp is unchanged...
    expect(after.body.rev).toBe(second.updated_at);
    expect(after.body.rev).toBe(before.body.rev);
    // ...and only the count reveals the deletion.
    expect(after.body.count).toBe(1);
    expect(before.body.count).toBe(2);
  });

  it('does not leak another team board revision', async () => {
    const mine = await signUpCoach(8212);
    const theirs = await signUpCoach(8213);
    const theirBoard = await makeBoard(theirs);

    const { status } = await callJson(`/api/boards/${theirBoard}/rev`, { cookie: mine });
    expect(status).toBe(404);
  });
});

describe('tasks', () => {
  it('spaces new tasks 1024 apart and orders by position', async () => {
    const coach = await signUpCoach(8220);
    const boardId = await makeBoard(coach);
    await makeTask(coach, boardId, { title: 'First' });
    await makeTask(coach, boardId, { title: 'Second' });

    const { body } = await callJson<{ tasks: Task[] }>(
      `/api/tasks?board_id=${boardId}`,
      { cookie: coach },
    );
    expect(body.tasks.map((t) => t.title)).toEqual(['First', 'Second']);
    expect(body.tasks.map((t) => t.position)).toEqual([1024, 2048]);
  });

  it('filters by status and rejects one that is not a column', async () => {
    const coach = await signUpCoach(8221);
    const boardId = await makeBoard(coach);
    await makeTask(coach, boardId, { title: 'Open' });
    await makeTask(coach, boardId, { title: 'Shipped', status: 'done' });

    const done = await callJson<{ tasks: Task[] }>(
      `/api/tasks?board_id=${boardId}&status=done`,
      { cookie: coach },
    );
    expect(done.body.tasks.map((t) => t.title)).toEqual(['Shipped']);

    const bogus = await callJson<{ error: string }>(
      `/api/tasks?board_id=${boardId}&status=finished`,
      { cookie: coach },
    );
    expect(bogus.status).toBe(400);
    expect(bogus.body.error).toBe('invalid_status');
  });

  it('will not attach a task to another team board', async () => {
    const mine = await signUpCoach(8222);
    const theirs = await signUpCoach(8223);
    const theirBoard = await makeBoard(theirs);

    const { status, body } = await callJson<{ error: string }>('/api/tasks', {
      method: 'POST',
      cookie: mine,
      body: JSON.stringify({ board_id: theirBoard, title: 'Trespass' }),
    });
    expect(status).toBe(404);
    expect(body.error).toBe('not_found');

    const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM tasks WHERE board_id = ?')
      .bind(theirBoard)
      .first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });

  /**
   * The regression test that matters most.
   *
   * `/mutate`'s update_task wrote every field as COALESCE(?, col), which made a
   * null indistinguishable from an absent key — so a due date or a decision log
   * could be written once and never emptied. The decision log is the Think
   * award's raw material and a student's first draft of it is usually wrong.
   */
  it('clears due_at and decision_log through an explicit null', async () => {
    const coach = await signUpCoach(8224);
    const boardId = await makeBoard(coach);
    const task = await makeTask(coach, boardId, {
      due_at: 1_800_000_000,
      decision_log: 'Tried 4in wheels, too slow.',
    });
    expect(task.due_at).toBe(1_800_000_000);

    const cleared = await mutate(coach, boardId, [
      { op: 'update_task', task_id: task.id, patch: { due_at: null, decision_log: null } },
    ]);
    expect(cleared.status).toBe(200);
    const after = cleared.body.tasks.find((t) => t.id === task.id);
    expect(after?.due_at).toBeNull();
    expect(after?.decision_log).toBeNull();
    // And the title it did not mention is untouched.
    expect(after?.title).toBe('Mount the chassis');
  });

  it('leaves absent fields alone while changing the named one', async () => {
    const coach = await signUpCoach(8225);
    const boardId = await makeBoard(coach);
    const task = await makeTask(coach, boardId, {
      body: 'Torque to spec',
      decision_log: 'Keep the 6in wheels.',
    });

    const { body } = await callJson<{ task: Task }>(`/api/tasks/${task.id}`, {
      method: 'PATCH',
      cookie: coach,
      body: JSON.stringify({ title: 'Mount the drivetrain' }),
    });
    expect(body.task.title).toBe('Mount the drivetrain');
    expect(body.task.body).toBe('Torque to spec');
    expect(body.task.decision_log).toBe('Keep the 6in wheels.');
  });

  it('refuses to blank a title', async () => {
    const coach = await signUpCoach(8226);
    const boardId = await makeBoard(coach);
    const task = await makeTask(coach, boardId);

    const { status, body } = await callJson<{ error: string }>(`/api/tasks/${task.id}`, {
      method: 'PATCH',
      cookie: coach,
      body: JSON.stringify({ title: '  ' }),
    });
    expect(status).toBe(400);
    expect(body.error).toBe('missing_title');
  });
});

describe('mutate', () => {
  it('applies a move and reorder in one batch', async () => {
    const coach = await signUpCoach(8230);
    const boardId = await makeBoard(coach);
    const a = await makeTask(coach, boardId, { title: 'A' });
    const b = await makeTask(coach, boardId, { title: 'B' });

    const { status, body } = await mutate(coach, boardId, [
      { op: 'move_task', task_id: a.id, status: 'doing', position: 512 },
      { op: 'move_task', task_id: b.id, status: 'todo', position: 4096 },
    ]);
    expect(status).toBe(200);
    const byId = new Map(body.tasks.map((t) => [t.id, t]));
    expect(byId.get(a.id)?.status).toBe('doing');
    expect(byId.get(a.id)?.position).toBe(512);
    expect(byId.get(b.id)?.position).toBe(4096);
    // Returned in position order, which is what the client renders.
    expect(body.tasks.map((t) => t.title)).toEqual(['A', 'B']);
  });

  it('accepts a fractional midpoint position', async () => {
    const coach = await signUpCoach(8231);
    const boardId = await makeBoard(coach);
    const task = await makeTask(coach, boardId);

    const { body } = await mutate(coach, boardId, [
      { op: 'move_task', task_id: task.id, status: 'todo', position: 1536 },
    ]);
    expect(body.tasks[0].position).toBe(1536);
  });

  it('accepts position 0 rather than treating it as missing', async () => {
    const coach = await signUpCoach(8232);
    const boardId = await makeBoard(coach);
    const task = await makeTask(coach, boardId);

    const { status, body } = await mutate(coach, boardId, [
      { op: 'move_task', task_id: task.id, status: 'blocked', position: 0 },
    ]);
    expect(status).toBe(200);
    expect(body.tasks[0].position).toBe(0);
  });

  it('rejects a position that is not a number', async () => {
    const coach = await signUpCoach(8233);
    const boardId = await makeBoard(coach);
    const task = await makeTask(coach, boardId);

    const { status, body } = await mutate(coach, boardId, [
      { op: 'move_task', task_id: task.id, status: 'todo', position: 'later' },
    ]);
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_position');
  });

  it('creates and deletes through ops', async () => {
    const coach = await signUpCoach(8234);
    const boardId = await makeBoard(coach);

    const created = await mutate(coach, boardId, [
      {
        op: 'create_task',
        task: { id: 'fixed-task-id', title: 'Wire the odometry pods', status: 'todo', position: 1024 },
      },
    ]);
    expect(created.body.tasks.map((t) => t.title)).toEqual(['Wire the odometry pods']);

    // Idempotent: a wifi retry must not double-create. ON CONFLICT DO NOTHING.
    const retried = await mutate(coach, boardId, [
      {
        op: 'create_task',
        task: { id: 'fixed-task-id', title: 'Wire the odometry pods', status: 'todo', position: 1024 },
      },
    ]);
    expect(retried.body.tasks).toHaveLength(1);

    const deleted = await mutate(coach, boardId, [
      { op: 'delete_task', task_id: 'fixed-task-id' },
    ]);
    expect(deleted.body.tasks).toHaveLength(0);
  });

  it('rejects the whole batch when one op is invalid', async () => {
    const coach = await signUpCoach(8235);
    const boardId = await makeBoard(coach);
    const task = await makeTask(coach, boardId);

    const { status, body } = await mutate(coach, boardId, [
      { op: 'move_task', task_id: task.id, status: 'doing', position: 1024 },
      { op: 'move_task', task_id: task.id, status: 'sideways', position: 2048 },
    ]);
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_status');

    // Nothing from the good op landed either — validation runs before the batch.
    const row = await env.DB.prepare('SELECT status FROM tasks WHERE id = ?')
      .bind(task.id)
      .first<{ status: string }>();
    expect(row?.status).toBe('todo');
  });

  it('rejects an unknown op', async () => {
    const coach = await signUpCoach(8236);
    const boardId = await makeBoard(coach);
    const { status, body } = await mutate(coach, boardId, [{ op: 'burn_board' }]);
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_op');
  });

  it('caps a batch at 200 ops', async () => {
    const coach = await signUpCoach(8237);
    const boardId = await makeBoard(coach);
    const task = await makeTask(coach, boardId);

    const ops = Array.from({ length: 201 }, (_, i) => ({
      op: 'move_task',
      task_id: task.id,
      status: 'todo',
      position: i,
    }));
    const { status, body } = await mutate(coach, boardId, ops);
    expect(status).toBe(409);
    expect(body.error).toBe('too_many_ops');
    expect(body.max).toBe(200);
  });

  it('allows a renumber of a full column inside the cap', async () => {
    const coach = await signUpCoach(8238);
    const boardId = await makeBoard(coach);
    const tasks = [];
    for (let i = 0; i < 60; i += 1) {
      tasks.push(await makeTask(coach, boardId, { title: `T${i}` }));
    }

    const ops = tasks.map((t, i) => ({
      op: 'move_task',
      task_id: t.id,
      status: 'todo',
      position: (i + 1) * 1024,
    }));
    const { status, body } = await mutate(coach, boardId, ops);
    expect(status).toBe(200);
    expect(body.tasks).toHaveLength(60);
    expect(body.tasks[0].position).toBe(1024);
    expect(body.tasks[59].position).toBe(60 * 1024);
  });

  it('will not touch a task on another team board', async () => {
    const mine = await signUpCoach(8239);
    const theirs = await signUpCoach(8240);
    const theirBoard = await makeBoard(theirs);
    const theirTask = await makeTask(theirs, theirBoard);
    const myBoard = await makeBoard(mine);

    // Naming their board is a 404 — the id is not a capability.
    const cross = await mutate(mine, theirBoard, [
      { op: 'delete_task', task_id: theirTask.id, status: 'todo', position: 0 },
    ]);
    expect(cross.status).toBe(404);

    // Naming their TASK against my own board is scoped away by board_id and
    // team_id together, so it silently affects nothing.
    const sneaky = await mutate(mine, myBoard, [
      { op: 'delete_task', task_id: theirTask.id },
    ]);
    expect(sneaky.status).toBe(200);

    const survived = await env.DB.prepare('SELECT COUNT(*) AS n FROM tasks WHERE id = ?')
      .bind(theirTask.id)
      .first<{ n: number }>();
    expect(survived?.n).toBe(1);
  });
});

describe('roles', () => {
  it('lets a student write tasks but not create or delete a board', async () => {
    const coach = await signUpCoach(8250);
    const boardId = await makeBoard(coach);
    const student = await inviteAndAccept(coach, { role: 'student', handle: 'robin' });

    const task = await makeTask(student.cookie, boardId, { title: 'Print a bracket' });
    const moved = await mutate(student.cookie, boardId, [
      { op: 'move_task', task_id: task.id, status: 'doing', position: 2048 },
    ]);
    expect(moved.status).toBe(200);

    const madeBoard = await callJson('/api/boards', {
      method: 'POST',
      cookie: student.cookie,
      body: JSON.stringify({ name: 'Sneaky' }),
    });
    expect(madeBoard.status).toBe(403);

    const deleted = await call(`/api/boards/${boardId}?force=1`, {
      method: 'DELETE',
      cookie: student.cookie,
    });
    expect(deleted.status).toBe(403);
  });

  it('lets a mentor create a board but not delete one', async () => {
    const coach = await signUpCoach(8251);
    const boardId = await makeBoard(coach);
    const mentor = await inviteAndAccept(coach, { role: 'mentor', handle: 'sam' });

    const made = await callJson<{ board: Board }>('/api/boards', {
      method: 'POST',
      cookie: mentor.cookie,
      body: JSON.stringify({ name: 'Outreach' }),
    });
    expect(made.status).toBe(201);

    const deleted = await call(`/api/boards/${boardId}?force=1`, {
      method: 'DELETE',
      cookie: mentor.cookie,
    });
    expect(deleted.status).toBe(403);
  });

  it('gives a viewer reads and refuses every write', async () => {
    const coach = await signUpCoach(8252);
    const boardId = await makeBoard(coach);
    const task = await makeTask(coach, boardId);
    const viewer = await inviteAndAccept(coach, { role: 'viewer', handle: 'grandad' });

    const list = await callJson<{ boards: Board[] }>('/api/boards', { cookie: viewer.cookie });
    expect(list.status).toBe(200);
    expect(list.body.boards).toHaveLength(1);
    const rev = await callJson(`/api/boards/${boardId}/rev`, { cookie: viewer.cookie });
    expect(rev.status).toBe(200);

    const created = await callJson('/api/tasks', {
      method: 'POST',
      cookie: viewer.cookie,
      body: JSON.stringify({ board_id: boardId, title: 'Nope' }),
    });
    expect(created.status).toBe(403);

    const patched = await callJson(`/api/tasks/${task.id}`, {
      method: 'PATCH',
      cookie: viewer.cookie,
      body: JSON.stringify({ title: 'Nope' }),
    });
    expect(patched.status).toBe(403);

    const removed = await call(`/api/tasks/${task.id}`, {
      method: 'DELETE',
      cookie: viewer.cookie,
    });
    expect(removed.status).toBe(403);

    const mutated = await mutate(viewer.cookie, boardId, [
      { op: 'move_task', task_id: task.id, status: 'done', position: 1024 },
    ]);
    expect(mutated.status).toBe(403);
  });

  it('requires a session at all', async () => {
    const anon = await callJson('/api/boards');
    expect(anon.status).toBe(401);
  });

  /**
   * Built as a raw Request rather than through `call()`, which sets a
   * same-origin header unconditionally and so cannot express this case. Same
   * shape as the cross-site test in auth.test.ts.
   *
   * `sameOriginOnly` is shared middleware and already covered there, but board
   * writes are the mutation a student fires hundreds of times an evening, so it
   * is worth pinning here too.
   */
  it('refuses a write from a foreign origin', async () => {
    const coach = await signUpCoach(8253);
    const request = new Request(`${ORIGIN}/api/boards`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://evil.example',
        Cookie: coach,
      },
      body: JSON.stringify({ name: 'Injected' }),
    });
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(403);
  });
});

describe('season scoping', () => {
  /**
   * A board belongs to a season, and `season_id` was written from the first
   * migration but never read back. Without this the alpha team's second season
   * would open onto the first season's boards — and their data is production
   * data from day one, so there is no wiping it later.
   */
  it('hides boards and tasks from a season that is no longer current', async () => {
    const coach = await signUpCoach(8260);
    const { team_id } = await whoami(coach);
    const oldBoard = await makeBoard(coach, 'Last year');
    await makeTask(coach, oldBoard, { title: 'Ancient history' });

    // Roll the season over the way a new season would.
    await env.DB.prepare('UPDATE seasons SET is_current = 0 WHERE team_id = ?')
      .bind(team_id)
      .run();
    await env.DB.prepare(
      `INSERT INTO seasons (id, team_id, label, starts_at, ends_at, is_current)
       VALUES ('season-8260-next', ?, '2027-28', 1820000000, 1840000000, 1)`,
    )
      .bind(team_id)
      .run();

    const boardsNow = await callJson<{ boards: Board[] }>('/api/boards', { cookie: coach });
    expect(boardsNow.body.boards).toEqual([]);

    const tasksNow = await callJson<{ tasks: Task[] }>('/api/tasks', { cookie: coach });
    expect(tasksNow.body.tasks).toEqual([]);

    // The rows are still there — hidden, not deleted.
    const kept = await env.DB.prepare('SELECT COUNT(*) AS n FROM tasks WHERE board_id = ?')
      .bind(oldBoard)
      .first<{ n: number }>();
    expect(kept?.n).toBe(1);

    // And asking for that board by id still works, so a deep link into last
    // season's board is readable rather than a lie.
    const direct = await callJson<{ tasks: Task[] }>(
      `/api/tasks?board_id=${oldBoard}`,
      { cookie: coach },
    );
    expect(direct.body.tasks).toHaveLength(1);
  });

  it('numbers a new season first board from 1 again', async () => {
    const coach = await signUpCoach(8261);
    const { team_id } = await whoami(coach);
    await makeBoard(coach, 'A');
    await makeBoard(coach, 'B');

    await env.DB.prepare('UPDATE seasons SET is_current = 0 WHERE team_id = ?')
      .bind(team_id)
      .run();
    await env.DB.prepare(
      `INSERT INTO seasons (id, team_id, label, starts_at, ends_at, is_current)
       VALUES ('season-8261-next', ?, '2027-28', 1820000000, 1840000000, 1)`,
    )
      .bind(team_id)
      .run();

    const { body } = await callJson<{ board: Board }>('/api/boards', {
      method: 'POST',
      cookie: coach,
      body: JSON.stringify({ name: 'Fresh' }),
    });
    expect(body.board.position).toBe(1);
  });

  it('does not list another team boards', async () => {
    const mine = await signUpCoach(8262);
    const theirs = await signUpCoach(8263);
    await makeBoard(theirs, 'Theirs');

    const { body } = await callJson<{ boards: Board[] }>('/api/boards', { cookie: mine });
    expect(body.boards).toEqual([]);
  });
});
