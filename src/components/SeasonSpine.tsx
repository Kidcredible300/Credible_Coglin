import { daysBetween, formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { CalendarEvent, Season } from '@/types';

/**
 * Where the team is in the season.
 *
 * FTC teams live in season-time, not calendar-time: everything is "before the
 * qualifier" or "after portfolio print". This is the one orienting fact the
 * dashboard owes them, so it opens the page rather than sitting in a widget.
 *
 * The elapsed run is drawn as field tape laid along the season — the same
 * device as the nav markers, used here at full width where it can carry the
 * page.
 */
export function SeasonSpine({
  season,
  events,
  now,
}: {
  season: Season;
  events: CalendarEvent[];
  now: number;
}) {
  const span = season.ends_at - season.starts_at;
  const pct = (t: number) =>
    Math.min(100, Math.max(0, ((t - season.starts_at) / span) * 100));
  const elapsed = pct(now);
  const upcoming = events.filter((e) => e.starts_at >= now);

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="u-eyebrow">Season {season.label}</span>
        <span className="text-muted-foreground text-xs">
          week {Math.max(1, Math.ceil(daysBetween(season.starts_at, now) / 7))}
        </span>
      </div>

      <div className="relative mt-3 pb-1">
        {/* Track */}
        <div className="bg-muted h-2.5 w-full rounded-[1px]" />
        {/* Elapsed */}
        <div
          className="u-tape absolute top-0 left-0 h-2.5"
          style={{ width: `${elapsed}%` }}
          aria-hidden
        />
        {/* Milestones */}
        {events.map((e) => {
          const past = e.starts_at < now;
          return (
            <span
              key={e.id}
              title={`${e.title} — ${formatDate(e.starts_at)}`}
              style={{ left: `${pct(e.starts_at)}%` }}
              className={cn(
                'absolute top-0 h-2.5 w-[3px] -translate-x-1/2',
                past ? 'bg-primary-foreground/40' : 'bg-foreground/45',
                e.kind === 'deadline' && !past && 'bg-destructive h-4 -translate-y-[3px]',
              )}
            />
          );
        })}
      </div>

      <ol className="text-muted-foreground mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs">
        {upcoming.slice(0, 3).map((e) => (
          <li key={e.id} className="flex items-baseline gap-1.5">
            <span
              className={cn(
                'size-1.5 shrink-0 translate-y-[-1px] rounded-[1px]',
                e.kind === 'deadline' ? 'bg-destructive' : 'bg-foreground/45',
              )}
              aria-hidden
            />
            <span className="text-foreground">{e.title}</span>
            <span className="tabular font-mono">
              {formatDate(e.starts_at)}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
