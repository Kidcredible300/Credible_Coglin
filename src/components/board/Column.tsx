import { useDroppable } from '@dnd-kit/core';
import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';
import type { TaskStatus } from '@/types';

export function Column({
  status,
  label,
  count,
  children,
}: {
  status: TaskStatus;
  label: string;
  count: number;
  children: ReactNode;
}) {
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
          {count}
        </span>
      </header>
      <div className="flex flex-1 flex-col gap-2 px-2 pb-2">{children}</div>
    </section>
  );
}
