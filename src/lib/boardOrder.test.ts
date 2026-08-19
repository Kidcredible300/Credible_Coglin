import { describe, expect, it } from 'vitest';
import { POSITION_GAP, columnTasks, moveOps, positionFor, renumberOps } from './boardOrder';
import type { Task, TaskStatus } from '@/types';

/**
 * The drag arithmetic. Pure on purpose: this repo has no DOM test environment,
 * so the only way to pin the behaviour that actually broke — every card landing
 * on position 0 — is to keep it out of the component.
 *
 * Imported relatively because vitest.config.ts declares no `@` alias. The
 * `@/types` import above survives only because it is type-only and erased at
 * transform; a runtime `@/` import in a test will not resolve.
 */

let seq = 0;
const task = (
  id: string,
  position: number,
  status: TaskStatus = 'todo',
  boardId = 'board-1',
): Task => ({
  id,
  team_id: 'team-1',
  board_id: boardId,
  title: id,
  body: null,
  assignee_member_id: null,
  status,
  due_at: null,
  position,
  decision_log: null,
  created_at: (seq += 1),
  updated_at: 0,
});

describe('columnTasks', () => {
  it('takes only this board and this column, in position order', () => {
    const tasks = [
      task('c', 3072),
      task('a', 1024),
      task('elsewhere', 1, 'todo', 'board-2'),
      task('b', 2048),
      task('doing-one', 1024, 'doing'),
    ];
    expect(columnTasks(tasks, 'board-1', 'todo').map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });

  it('breaks a position tie by creation order rather than at random', () => {
    // Boards created before the position fix have whole columns stacked on 0.
    const first = task('first', 0);
    const second = task('second', 0);
    expect(columnTasks([second, first], 'board-1', 'todo').map((t) => t.id)).toEqual([
      'first',
      'second',
    ]);
  });
});

describe('positionFor', () => {
  it('gives the first card in an empty column one gap', () => {
    expect(positionFor([], 0)).toBe(POSITION_GAP);
  });

  it('appends a gap past the last card', () => {
    expect(positionFor([task('a', 1024)], 1)).toBe(2048);
  });

  it('steps a gap below the first card when dropped at the top', () => {
    expect(positionFor([task('a', 4096)], 0)).toBe(3072);
  });

  it('lands halfway between two neighbours', () => {
    expect(positionFor([task('a', 1024), task('b', 2048)], 1)).toBe(1536);
  });

  it('floors the midpoint, since the column is an INTEGER', () => {
    expect(positionFor([task('a', 1024), task('b', 1027)], 1)).toBe(1025);
  });

  it('reports an exhausted gap rather than colliding', () => {
    // Adjacent integers have nothing between them.
    expect(positionFor([task('a', 1024), task('b', 1025)], 1)).toBeNull();
    expect(positionFor([task('a', 1024), task('b', 1024)], 1)).toBeNull();
  });

  it('refuses to run off the bottom of the scale at the top of a column', () => {
    // 0 is a position the server accepts, so there is no room below 1024 for a
    // full gap and no sentinel to fall back on.
    expect(positionFor([task('a', 1024)], 0)).toBeNull();
    expect(positionFor([task('a', 1)], 0)).toBeNull();
  });
});

describe('renumberOps', () => {
  it('respaces a column on clean gaps, in place', () => {
    const ops = renumberOps([task('a', 1024), task('b', 1025), task('c', 1026)], 'doing');
    expect(ops).toEqual([
      { op: 'move_task', task_id: 'a', status: 'doing', position: 1024 },
      { op: 'move_task', task_id: 'b', status: 'doing', position: 2048 },
      { op: 'move_task', task_id: 'c', status: 'doing', position: 3072 },
    ]);
  });
});

describe('moveOps', () => {
  it('moves a card to another column as a single op', () => {
    const tasks = [task('a', 1024), task('b', 1024, 'doing')];
    expect(moveOps(tasks, 'board-1', 'a', 'doing', 1)).toEqual([
      { op: 'move_task', task_id: 'a', status: 'doing', position: 2048 },
    ]);
  });

  it('reorders within a column, which used to be a no-op', () => {
    const tasks = [task('a', 1024), task('b', 2048), task('c', 3072)];
    // Drag c to the middle. Its own row must not count as a neighbour.
    expect(moveOps(tasks, 'board-1', 'c', 'todo', 1)).toEqual([
      { op: 'move_task', task_id: 'c', status: 'todo', position: 1536 },
    ]);
  });

  it('does not treat the moved card as its own neighbour', () => {
    const tasks = [task('a', 1024), task('b', 2048)];
    // Moving a to the end should land past b, not halfway back to itself.
    expect(moveOps(tasks, 'board-1', 'a', 'todo', 1)).toEqual([
      { op: 'move_task', task_id: 'a', status: 'todo', position: 3072 },
    ]);
  });

  it('renumbers the whole column when the gap is used up', () => {
    const tasks = [task('a', 1024), task('b', 1025), task('c', 5000)];
    const ops = moveOps(tasks, 'board-1', 'c', 'todo', 1);

    // Every card gets a slot, including the one being moved, and it is one
    // batch so the board cannot be left half renumbered.
    expect(ops).toHaveLength(3);
    expect(ops.map((o) => o.task_id)).toEqual(['a', 'c', 'b']);
    expect(ops.map((o) => o.position)).toEqual([1024, 2048, 3072]);
    expect(ops.every((o) => o.status === 'todo')).toBe(true);
  });

  it('renumbers a column stacked on 0 by the old bug', () => {
    const tasks = [task('a', 0), task('b', 0), task('c', 0)];
    const ops = moveOps(tasks, 'board-1', 'c', 'todo', 0);
    expect(ops.map((o) => o.task_id)).toEqual(['c', 'a', 'b']);
    expect(ops.map((o) => o.position)).toEqual([1024, 2048, 3072]);
  });

  it('clamps an index past the end of the column', () => {
    const tasks = [task('a', 1024)];
    expect(moveOps(tasks, 'board-1', 'a', 'done', 99)).toEqual([
      { op: 'move_task', task_id: 'a', status: 'done', position: 1024 },
    ]);
  });

  it('still emits a move for an unknown task, and lets the server scope it away', () => {
    // Not this module's job to decide a task exists. The op carries the id, and
    // the UPDATE is bounded by team_id AND board_id, so an id from another team
    // changes no rows. Guessing here would just duplicate the tenancy rule in a
    // second, weaker place.
    expect(moveOps([], 'board-1', 'ghost', 'todo', 0)).toEqual([
      { op: 'move_task', task_id: 'ghost', status: 'todo', position: 1024 },
    ]);
  });
});
