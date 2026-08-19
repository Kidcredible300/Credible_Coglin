/**
 * Where a dragged card lands.
 *
 * Every board move used to send `position: 0`, so cards piled up on the same
 * value and a column's order became whatever SQLite felt like returning. That
 * is the bug this file exists to fix, and it is pure so it can be tested — the
 * repo has no DOM test environment, so the arithmetic has to live outside the
 * component the way `docText.ts` lives outside `DocTree.tsx`.
 *
 * The scheme is gap-based, matching `POSITION_GAP` in `worker/lib/meetings.ts`
 * and the `MAX(position) + 1024` the task insert already used: land a card
 * halfway between its new neighbours and only one row is written, no matter how
 * long the column is.
 *
 * `tasks.position` is INTEGER, not REAL like `note_docs.position`, so midpoints
 * are floored and eventually run out — ten consecutive drops into the same slot
 * exhausts a 1024 gap. `positionFor` reports that with null rather than
 * silently colliding, and the caller renumbers the column.
 */
import type { Task, TaskStatus } from '@/types';

export const POSITION_GAP = 1024;

type BoardMove = {
  op: 'move_task';
  task_id: string;
  status: TaskStatus;
  position: number;
};

/** One column's tasks, in the order they should render. */
export function columnTasks(
  tasks: Task[],
  boardId: string,
  status: TaskStatus,
): Task[] {
  return tasks
    .filter((t) => t.board_id === boardId && t.status === status)
    .sort((a, b) => a.position - b.position || a.created_at - b.created_at);
}

/**
 * The position for a card inserted at `index` of an already-ordered column.
 *
 * `ordered` must not contain the card being moved — a card cannot be its own
 * neighbour, and leaving it in shifts every index by one. Callers drop it first.
 *
 * Returns null when there is no integer strictly between the neighbours, which
 * means the column needs renumbering before this move can be expressed.
 */
export function positionFor(ordered: Task[], index: number): number | null {
  const before = index > 0 ? ordered[index - 1]?.position ?? null : null;
  const after = ordered[index]?.position ?? null;

  if (before === null && after === null) return POSITION_GAP;

  // Dropped at the top: step below the first card, unless that would reach 0.
  // Position 0 is a legal value the server accepts, so the floor is a real
  // constraint rather than a sentinel.
  if (before === null) {
    const candidate = Math.floor((after as number) - POSITION_GAP);
    return candidate > 0 ? candidate : null;
  }

  if (after === null) return Math.floor(before) + POSITION_GAP;

  const mid = Math.floor((before + after) / 2);
  return mid > before && mid < after ? mid : null;
}

/**
 * Fresh, evenly-spaced positions for a whole column.
 *
 * Used when `positionFor` reports an exhausted gap. Emitted as one batch so the
 * renumber and the move that needed it land together; a column left half
 * renumbered is worse than the collision it was fixing.
 */
export function renumberOps(ordered: Task[], status: TaskStatus): BoardMove[] {
  return ordered.map((task, i) => ({
    op: 'move_task' as const,
    task_id: task.id,
    status,
    position: (i + 1) * POSITION_GAP,
  }));
}

/**
 * The ops for dropping `taskId` into `status` at `index`.
 *
 * One op when the gap has room, a whole-column renumber plus the move when it
 * does not. Returning the ops rather than performing them keeps this testable
 * and keeps the single write path in one place.
 */
export function moveOps(
  tasks: Task[],
  boardId: string,
  taskId: string,
  status: TaskStatus,
  index: number,
): BoardMove[] {
  const target = columnTasks(tasks, boardId, status).filter((t) => t.id !== taskId);
  const clamped = Math.max(0, Math.min(index, target.length));

  const position = positionFor(target, clamped);
  if (position !== null) {
    return [{ op: 'move_task', task_id: taskId, status, position }];
  }

  // No room. Renumber the column as it will look once the card is in it, which
  // gives every card — the moved one included — a clean 1024-spaced slot.
  const withMoved = [...target];
  const moved = tasks.find((t) => t.id === taskId);
  if (!moved) return [];
  withMoved.splice(clamped, 0, moved);
  return renumberOps(withMoved, status);
}
