import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * A figure and what it counts. No sparkline, no percentage-change chip — a
 * team's outreach hours have no meaningful week-over-week delta, and inventing
 * one would be decoration pretending to be data.
 */
export function StatTile({
  value,
  label,
  hint,
  tone = 'default',
}: {
  value: ReactNode;
  label: string;
  hint?: string;
  tone?: 'default' | 'alert';
}) {
  return (
    <div className="bg-card border-border rounded-lg border p-4">
      <div
        className={cn(
          'tabular u-display text-heading font-mono text-2xl leading-none md:text-3xl',
          tone === 'alert' && 'text-destructive',
        )}
      >
        {value}
      </div>
      <div className="u-eyebrow mt-2">{label}</div>
      {hint && (
        <div className="text-muted-foreground mt-1 text-xs">{hint}</div>
      )}
    </div>
  );
}
