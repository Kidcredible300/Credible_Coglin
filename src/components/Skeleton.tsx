import { cn } from '@/lib/utils';

/** Loading placeholder. Pulse is suppressed under prefers-reduced-motion. */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn('bg-muted animate-pulse rounded-md', className)}
      aria-hidden
    />
  );
}
