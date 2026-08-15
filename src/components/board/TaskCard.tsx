import { useDraggable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { NotebookPen } from 'lucide-react';
import { initials, isOverdue, relativeDays } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { Member, Task } from '@/types';

export function TaskCard({
  task,
  assignee,
  now,
  onOpen,
  dragging,
}: {
  task: Task;
  assignee?: Member;
  now: number;
  onOpen?: (task: Task) => void;
  dragging?: boolean;
}) {
  const overdue = isOverdue(task.due_at, now) && task.status !== 'done';

  return (
    <article
      className={cn(
        'bg-card border-border rounded-md border p-3 text-left shadow-xs',
        dragging && 'opacity-40',
      )}
    >
      <button
        type="button"
        onClick={() => onOpen?.(task)}
        // dnd-kit's KeyboardSensor listens on the wrapper and calls
        // preventDefault on Enter/Space, which would swallow this button's
        // activation. Keep the keystroke local so the card stays openable by
        // keyboard while the rest of it remains draggable.
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
        }}
        className="focus-visible:ring-ring w-full text-left text-sm leading-snug focus-visible:ring-2 focus-visible:outline-none"
      >
        {task.title}
      </button>

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

/** Draggable wrapper. Split out so the drag overlay can render a static card. */
export function DraggableTaskCard(
  props: Omit<React.ComponentProps<typeof TaskCard>, 'dragging'>,
) {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({ id: props.task.id });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform) }}
      // dnd-kit puts role=button + tabIndex here, so cards are keyboard
      // reachable and draggable with space + arrow keys.
      {...listeners}
      {...attributes}
      // touch-none is required by dnd-kit's PointerSensor — without it the
      // browser claims the gesture for scrolling on touch devices. select-none
      // stops a drag from turning into a text selection across cards.
      className="touch-none select-none focus-visible:ring-ring rounded-md focus-visible:ring-2 focus-visible:outline-none"
    >
      <TaskCard {...props} dragging={isDragging} />
    </div>
  );
}
