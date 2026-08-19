import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, NotebookPen } from 'lucide-react';
import { initials, isOverdue, relativeDays } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { Member, Task } from '@/types';

export function TaskCard({
  task,
  assignee,
  now,
  onOpen,
  dragging,
  handle,
}: {
  task: Task;
  assignee?: Member;
  now: number;
  onOpen?: (task: Task) => void;
  dragging?: boolean;
  /** The grip, supplied by the sortable wrapper. Absent in the drag overlay. */
  handle?: React.ReactNode;
}) {
  const overdue = isOverdue(task.due_at, now) && task.status !== 'done';

  return (
    <article
      className={cn(
        'bg-card border-border rounded-md border p-3 text-left shadow-xs',
        dragging && 'opacity-40',
      )}
    >
      <div className="flex items-start gap-1">
        <button
          type="button"
          onClick={() => onOpen?.(task)}
          className="focus-visible:ring-ring min-w-0 flex-1 text-left text-sm leading-snug focus-visible:ring-2 focus-visible:outline-none"
        >
          {task.title}
        </button>
        {handle}
      </div>

      <div className="mt-2.5 flex items-center gap-2">
        {assignee && (
          <span
            title={assignee.display_name}
            className="bg-muted text-muted-foreground inline-flex size-5 items-center justify-center rounded-full text-[10px] font-medium"
          >
            {initials(assignee.display_name)}
          </span>
        )}

        {/* A filled decision log is the Think award's raw material, so it gets a
            visible mark on the card — the point of the product is that this
            work stops being invisible. */}
        {task.decision_log && (
          <span
            className="text-primary-ink inline-flex items-center"
            title="Has a decision log"
          >
            <NotebookPen className="size-3.5" aria-hidden />
            <span className="sr-only">Has a decision log</span>
          </span>
        )}

        {task.due_at !== null && (
          <span
            className={cn(
              'ml-auto text-xs',
              overdue ? 'text-destructive font-medium' : 'text-muted-foreground',
            )}
          >
            {relativeDays(task.due_at, now)}
          </span>
        )}
      </div>
    </article>
  );
}

/**
 * Sortable wrapper. Split out so the drag overlay can render a static card.
 *
 * The drag listeners live on a dedicated grip, not on the card, following
 * DocTree rather than this file's own first attempt. Two reasons it moved:
 * opening a card now leads to an editable dialog, so a tap misread as a drag
 * costs an edit; and listeners on the whole card forced a stopPropagation hack
 * on the title button to get Enter and Space back, which is gone with them.
 */
export function DraggableTaskCard(
  props: Omit<React.ComponentProps<typeof TaskCard>, 'dragging' | 'handle'>,
) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: props.task.id });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
    >
      <TaskCard
        {...props}
        dragging={isDragging}
        handle={
          <button
            type="button"
            {...attributes}
            {...listeners}
            aria-label={`Reorder ${props.task.title}`}
            // touch-none goes on THIS BUTTON and nowhere else, so the column
            // still scrolls under a thumb. Pit day is one hand on a phone.
            className="focus-visible:ring-ring text-muted-foreground hover:text-foreground -mt-1 -mr-1 flex size-11 shrink-0 touch-none cursor-grab items-center justify-center rounded-md focus-visible:ring-2 focus-visible:outline-none md:size-7"
          >
            <GripVertical className="size-4" aria-hidden />
          </button>
        }
      />
    </div>
  );
}
