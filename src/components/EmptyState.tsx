import type { ReactNode } from 'react';

/**
 * An empty screen is an invitation to act, so the primary line says what to do.
 * Coglin's voice shows up here (plan §4) but never at the cost of clarity —
 * the character is in the aside, not in the instruction.
 */
export function EmptyState({
  title,
  action,
  aside,
}: {
  title: string;
  action?: ReactNode;
  aside?: string;
}) {
  return (
    <div className="border-border rounded-lg border border-dashed px-6 py-12 text-center">
      <p className="text-sm font-medium">{title}</p>
      {aside && (
        <p className="text-muted-foreground mx-auto mt-1 max-w-sm text-sm">
          {aside}
        </p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
