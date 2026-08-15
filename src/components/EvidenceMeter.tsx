import { cn } from '@/lib/utils';
import type { CriterionState } from '@/types';

/**
 * The signature element.
 *
 * Award readiness is drawn as DISCRETE segments, never a smooth percentage bar,
 * because that is what the underlying data actually is: a countable set of
 * evidence artifacts linked to named criteria (`evidence_links` rows). "4 of 7
 * pieces, and here is which three are missing" is something a team can act on
 * this Tuesday. "57% ready" is not.
 *
 * The segments are square-ended and chunky — the same field-tape logic as the
 * nav markers — so a readiness row reads at a glance from across a workshop.
 */
export function EvidenceMeter({
  states,
  label,
  className,
}: {
  states: CriterionState[];
  label?: string;
  className?: string;
}) {
  const ready = states.filter((s) => s === 'ready').length;

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <div
        className="flex flex-1 gap-1"
        role="img"
        aria-label={`${label ? label + ': ' : ''}${ready} of ${states.length} criteria ready`}
      >
        {states.map((state, i) => (
          <span
            key={i}
            aria-hidden
            className={cn(
              'h-2 flex-1 rounded-[1px]',
              state === 'ready' && 'bg-readiness-ready',
              state === 'partial' && 'bg-readiness-partial',
              state === 'todo' && 'bg-readiness-none',
            )}
          />
        ))}
      </div>
      <span className="tabular text-muted-foreground w-9 shrink-0 text-right font-mono text-xs">
        {ready}/{states.length}
      </span>
    </div>
  );
}
