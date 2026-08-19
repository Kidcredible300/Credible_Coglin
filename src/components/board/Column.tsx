import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';
import type { TaskStatus } from '@/types';

export function Column({
  status,
  label,
  ids,
  canEdit,
  onAdd,
  children,
  footer,
}: {
  status: TaskStatus;
  label: string;
  /** Card ids in render order — the sortable context needs them, not the nodes. */
  ids: string[];
  canEdit: boolean;
  onAdd: (status: TaskStatus) => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  // The column is a droppable in its own right as well as a sortable list, so
  // dropping onto empty space below the last card still lands somewhere. Without
  // it an empty column has no target at all and a board can never be started.
  const { setNodeRef, isOver } = useDroppable({ id: status });

  return (
    <section
      ref={setNodeRef}
      aria-label={label}
      className={cn(
        // Fixed width with horizontal scroll until there is genuinely room for
        // four readable columns. Squeezing them in at 768px gives ~120px each,
        // which wraps every task title to four lines.
        'flex w-72 shrink-0 flex-col rounded-lg transition-colors xl:w-auto xl:shrink',
        isOver ? 'bg-accent' : 'bg-muted/40',
      )}
    >
      <header className="flex items-center gap-2 px-3 pt-3 pb-2">
        <span className="u-eyebrow">{label}</span>
        <span className="tabular text-muted-foreground font-mono text-xs">
          {ids.length}
        </span>
      </header>

      <div className="flex flex-1 flex-col gap-2 px-2 pb-2">
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          {children}
        </SortableContext>

        {footer}

        {/* Per-column add, so a task can go straight into Blocked without being
            created in To do and then dragged. Quiet until hovered — four of
            these competing with the cards would be noise. */}
        {canEdit && (
          <button
            type="button"
            onClick={() => onAdd(status)}
            aria-label={`Add a task to ${label}`}
            className="focus-visible:ring-ring text-muted-foreground hover:text-foreground hover:bg-card/60 flex min-h-11 items-center gap-1.5 rounded-md px-2 text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none md:min-h-8"
          >
            <Plus className="size-4" aria-hidden />
            Add
          </button>
        )}
      </div>
    </section>
  );
}
