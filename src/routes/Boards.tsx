import { useEffect, useMemo, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import * as api from '@/lib/api';
import { useAsync } from '@/lib/useAsync';
import { TASK_COLUMNS, type BoardOp, type Task, type TaskStatus } from '@/types';
import { PageHeader } from '@/components/PageHeader';
import { SampleDataNotice } from '@/components/SampleDataNotice';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/Skeleton';
import { Column } from '@/components/board/Column';
import { DraggableTaskCard, TaskCard } from '@/components/board/TaskCard';
import { TaskDialog } from '@/components/board/TaskDialog';
import { cn } from '@/lib/utils';

export default function Boards() {
  const now = api.now();
  const boards = useAsync(api.listBoards);
  const members = useAsync(api.listMembers);
  const allTasks = useAsync(() => api.listTasks());

  const [boardId, setBoardId] = useState<string | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [openTask, setOpenTask] = useState<Task | null>(null);

  useEffect(() => {
    if (allTasks.data) setTasks(allTasks.data);
  }, [allTasks.data]);

  useEffect(() => {
    if (boards.data && boardId === null) setBoardId(boards.data[0].id);
  }, [boards.data, boardId]);

  const sensors = useSensors(
    // A small distance threshold so tapping a card to open it isn't read as a
    // drag — critical on a phone, where every tap starts as a touch-move.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  );

  const memberById = useMemo(
    () => new Map((members.data ?? []).map((m) => [m.id, m])),
    [members.data],
  );

  const visible = tasks.filter((t) => t.board_id === boardId);

  /**
   * Every mutation goes through the same op shape the server will accept at
   * POST /api/boards/:id/mutate (plan §8), so Phase 1 swaps the transport and
   * the Durable Object later replays this stream unchanged.
   */
  function applyOp(op: BoardOp) {
    setTasks((prev) => {
      switch (op.op) {
        case 'move_task':
          return prev.map((t) =>
            t.id === op.task_id ? { ...t, status: op.status } : t,
          );
        case 'update_task':
          return prev.map((t) =>
            t.id === op.task_id ? { ...t, ...op.patch } : t,
          );
        case 'create_task':
          return [...prev, op.task];
        case 'delete_task':
          return prev.filter((t) => t.id !== op.task_id);
      }
    });
    void api.mutateBoard(op);
  }

  function onDragStart(e: DragStartEvent) {
    setDraggingId(String(e.active.id));
  }

  function onDragEnd(e: DragEndEvent) {
    setDraggingId(null);
    const over = e.over?.id;
    if (!over) return;
    const status = String(over) as TaskStatus;
    const task = tasks.find((t) => t.id === String(e.active.id));
    if (!task || task.status === status) return;
    applyOp({ op: 'move_task', task_id: task.id, status, position: 0 });
  }

  const dragging = tasks.find((t) => t.id === draggingId);

  return (
    <>
      <PageHeader eyebrow="Build season" title="Boards" />

      <div className="px-4 pt-6 md:px-8">
        <SampleDataNotice feature="Boards" />
      </div>

      {/* Board switcher. Horizontal scroll on narrow screens rather than a
          select — five sub-teams is few enough to see all at once. */}
      <div className="border-border overflow-x-auto border-b px-4 md:px-8">
        <div className="flex gap-1 py-2">
          {boards.status === 'loading' && <Skeleton className="h-9 w-64" />}
          {boards.data?.map((b) => (
            <button
              key={b.id}
              onClick={() => setBoardId(b.id)}
              className={cn(
                'focus-visible:ring-ring relative min-h-9 shrink-0 rounded-md px-3 text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none',
                b.id === boardId
                  ? 'text-foreground font-medium'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {b.name}
              {b.id === boardId && (
                <span
                  className="u-tape absolute inset-x-2 -bottom-2 h-[3px]"
                  aria-hidden
                />
              )}
            </button>
          ))}
        </div>
      </div>

      <div className="px-4 py-6 md:px-8">
        {/* boardId is null for a beat after the boards resolve. Without it in
            this condition the screen flashes "no tasks on this board" before
            the first board is selected. */}
        {allTasks.status === 'loading' || boardId === null ? (
          <div className="grid gap-3 md:grid-cols-4">
            {TASK_COLUMNS.map((c) => (
              <Skeleton key={c.id} className="h-64" />
            ))}
          </div>
        ) : visible.length === 0 ? (
          <EmptyState
            title="No tasks on this board yet."
            aside="Coglin has nothing for you to do here — enjoy it while it lasts."
          />
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCorners}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
          >
            {/* Horizontal scroll on phones — pit day means one thumb and a
                narrow screen, not a shrunken desktop grid. */}
            <div className="-mx-4 flex gap-3 overflow-x-auto px-4 pb-2 md:-mx-8 md:px-8 xl:mx-0 xl:grid xl:grid-cols-4 xl:overflow-visible xl:px-0">
              {TASK_COLUMNS.map((col) => {
                const items = visible.filter((t) => t.status === col.id);
                return (
                  <Column
                    key={col.id}
                    status={col.id}
                    label={col.label}
                    count={items.length}
                  >
                    {items.map((t) => (
                      <DraggableTaskCard
                        key={t.id}
                        task={t}
                        assignee={
                          t.assignee_member_id
                            ? memberById.get(t.assignee_member_id)
                            : undefined
                        }
                        now={now}
                        onOpen={setOpenTask}
                      />
                    ))}
                  </Column>
                );
              })}
            </div>

            <DragOverlay>
              {dragging ? (
                <TaskCard
                  task={dragging}
                  assignee={
                    dragging.assignee_member_id
                      ? memberById.get(dragging.assignee_member_id)
                      : undefined
                  }
                  now={now}
                />
              ) : null}
            </DragOverlay>
          </DndContext>
        )}
      </div>

      <TaskDialog
        task={openTask}
        assignee={
          openTask?.assignee_member_id
            ? memberById.get(openTask.assignee_member_id)
            : undefined
        }
        now={now}
        onOpenChange={(open) => !open && setOpenTask(null)}
        onStatusChange={(task, status) => {
          applyOp({ op: 'move_task', task_id: task.id, status, position: 0 });
          setOpenTask({ ...task, status });
        }}
      />
    </>
  );
}
