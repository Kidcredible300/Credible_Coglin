import { useCallback, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import {
  addMonths,
  dayKey,
  formatDayName,
  formatMonthTitle,
  formatTime,
  monthGrid,
  monthOfDay,
  type CalendarMonth,
} from '@/lib/format';
import { cn } from '@/lib/utils';
import { WEEKDAYS, type MeetingSummary } from '@/types';

/**
 * The schedule as a month grid.
 *
 * Renders the grid and nothing else: no day list, because the Dashboard has no
 * room for one and /meetings already owns a row renderer that the day list should
 * reuse verbatim, so the calendar's day list and the list view stay the same
 * object rather than two things that drift.
 *
 * Fully controlled. `selectedDay` drives a list the parent renders, so it has to
 * live there anyway, and a half-controlled component ends up with two sources of
 * truth for which month is showing.
 *
 * Read-only for every role, viewers included. Scheduling stays behind
 * ScheduleMeetingDialog and its coach gate — drag-to-reschedule is deliberately
 * absent, because moving a meeting is entangled with series semantics
 * (series_id, series_slot, detached_at) and a drag cannot express "detach this
 * occurrence from its rule", so it would either lie or silently detach.
 */

export interface MeetingCalendarProps {
  /**
   * Every meeting the caller has, in any order — this buckets by day and relies
   * on the server's ORDER BY starts_at within a bucket.
   *
   * Pass the UNSPLIT list. Meetings.tsx reverses its `past` array so the newest
   * is first in the list view, and handing that to a grid renders a Saturday's
   * 9am and 2pm upside down inside one cell.
   */
  meetings: MeetingSummary[];
  now: number;
  month: CalendarMonth;
  /**
   * Omit to hide the arrows. That is how the Dashboard's mini month declines to
   * be a navigation surface: no arrows, no month state, and no second place in
   * the app where "which month am I looking at" can be wrong.
   */
  onMonthChange?: (month: CalendarMonth) => void;
  /** YYYYMMDD, or null for nothing chosen. */
  selectedDay: number | null;
  onSelectDay: (day: number) => void;
  /** 'full' for /meetings; 'compact' for the Dashboard, which never shows titles. */
  density?: 'full' | 'compact';
}

function cellLabel(day: number, meetings: MeetingSummary[]): string {
  const date = formatDayName(day);
  if (meetings.length === 0) return `${date}, no meetings`;
  if (meetings.length === 1) {
    const m = meetings[0];
    const when = formatTime(m.starts_at);
    return m.status === 'cancelled'
      ? `${date}, ${m.title} at ${when}, cancelled`
      : `${date}, ${m.title} at ${when}`;
  }
  return `${date}, ${meetings.length} meetings`;
}

export function MeetingCalendar({
  meetings,
  now,
  month,
  onMonthChange,
  selectedDay,
  onSelectDay,
  density = 'full',
}: MeetingCalendarProps) {
  const gridRef = useRef<HTMLDivElement>(null);
  /** The roving-tabindex cursor. Only set once a key has been pressed. */
  const [focusedDay, setFocusedDay] = useState<number | null>(null);
  const movedByKeyboard = useRef(false);

  /**
   * Depends on `meetings` alone, NOT on `now`.
   *
   * api.now() is called during render in both consumers, so `now` is a new value
   * every render — Meetings.tsx already has that bug and its memo does nothing.
   * `todayKey` below is a modulo, not a memo.
   */
  const byDay = useMemo(() => {
    const map = new Map<number, MeetingSummary[]>();
    for (const meeting of meetings) {
      const key = dayKey(meeting.starts_at);
      const bucket = map.get(key);
      if (bucket) bucket.push(meeting);
      else map.set(key, [meeting]);
    }
    return map;
  }, [meetings]);

  const cells = useMemo(() => monthGrid(month.y, month.m), [month.y, month.m]);
  const todayKey = dayKey(now);
  const titleId = `cal-${month.y}-${month.m}`;

  /**
   * Focus follows the cursor into newly rendered cells, but only after a KEY
   * press — otherwise a re-render from new data would steal focus from wherever
   * the user actually is.
   */
  const focusAfterRender = useCallback((day: number) => {
    movedByKeyboard.current = true;
    setFocusedDay(day);
    requestAnimationFrame(() => {
      if (!movedByKeyboard.current) return;
      movedByKeyboard.current = false;
      gridRef.current
        ?.querySelector<HTMLButtonElement>(`[data-day="${day}"]`)
        ?.focus();
    });
  }, []);

  /**
   * Moving off the visible month CHANGES the month rather than stopping at the
   * edge. A grid that traps the caret on the 1st is the version people report as
   * broken — and the lead and trail cells are real, clickable days that hold real
   * meetings (teams meet in August), so there is nothing there to protect.
   */
  const move = useCallback(
    (from: number, days: number) => {
      const y = Math.floor(from / 10000);
      const m = Math.floor((from % 10000) / 100);
      const d = new Date(Date.UTC(y, m - 1, (from % 100) + days));
      const next =
        d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
      const nextMonth = monthOfDay(next);
      if (nextMonth.y !== month.y || nextMonth.m !== month.m) {
        onMonthChange?.(nextMonth);
      }
      focusAfterRender(next);
    },
    [focusAfterRender, month.m, month.y, onMonthChange],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, day: number) => {
      const step: Record<string, number> = {
        ArrowLeft: -1,
        ArrowRight: 1,
        ArrowUp: -7,
        ArrowDown: 7,
      };
      if (event.key in step) {
        event.preventDefault();
        move(day, step[event.key]);
        return;
      }
      if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        const weekday = cells.indexOf(day) % 7;
        move(day, event.key === 'Home' ? -weekday : 6 - weekday);
        return;
      }
      if (event.key === 'PageUp' || event.key === 'PageDown') {
        // No-op without arrows: the Dashboard's month is fixed.
        if (!onMonthChange) return;
        event.preventDefault();
        move(day, event.key === 'PageUp' ? -28 : 28);
      }
      // Enter and Space are left to the native button.
    },
    [cells, move, onMonthChange],
  );

  /**
   * Exactly one cell is reachable by Tab: the keyboard cursor if there is one,
   * else the selected day if it is visible, else today if it is, else the 1st.
   */
  const tabDay = useMemo(() => {
    const visible = (day: number | null) => day !== null && cells.includes(day);
    if (visible(focusedDay)) return focusedDay;
    if (visible(selectedDay)) return selectedDay;
    if (visible(todayKey)) return todayKey;
    return month.y * 10000 + month.m * 100 + 1;
  }, [cells, focusedDay, month.m, month.y, selectedDay, todayKey]);

  return (
    <div className="bg-card border-border overflow-hidden rounded-lg border">
      <div className="border-border flex items-center justify-between gap-2 border-b px-2 py-2">
        {/* aria-live so pressing an arrow announces the new month rather than
            silently repainting 42 cells. */}
        <h3
          id={titleId}
          aria-live="polite"
          className={cn('u-display px-2', density === 'compact' ? 'text-sm' : 'text-base')}
        >
          {formatMonthTitle(month)}
        </h3>
        {onMonthChange && (
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label="Previous month"
              onClick={() => onMonthChange(addMonths(month, -1))}
              className="focus-visible:ring-ring text-muted-foreground hover:text-foreground flex size-11 items-center justify-center rounded-md focus-visible:ring-2 focus-visible:outline-none md:size-8"
            >
              <ChevronLeft className="size-4" aria-hidden />
            </button>
            <button
              type="button"
              aria-label="Next month"
              onClick={() => onMonthChange(addMonths(month, 1))}
              className="focus-visible:ring-ring text-muted-foreground hover:text-foreground flex size-11 items-center justify-center rounded-md focus-visible:ring-2 focus-visible:outline-none md:size-8"
            >
              <ChevronRight className="size-4" aria-hidden />
            </button>
          </div>
        )}
      </div>

      <div ref={gridRef} role="grid" aria-labelledby={titleId}>
        <div role="row" className="border-border grid grid-cols-7 border-b">
          {WEEKDAYS.map((weekday) => (
            <span
              key={weekday.id}
              role="columnheader"
              /* `short` is single letters, so Tuesday and Thursday are both "T"
                 and Saturday and Sunday are both "S". The full name is the
                 accessible name; the letter is only the drawing. */
              aria-label={weekday.label}
              className="u-eyebrow py-2 text-center text-[10px]"
            >
              {weekday.short}
            </span>
          ))}
        </div>

        {[0, 1, 2, 3, 4, 5].map((row) => (
          <div role="row" key={row} className="grid grid-cols-7">
            {cells.slice(row * 7, row * 7 + 7).map((day) => (
              <DayCell
                key={day}
                day={day}
                meetings={byDay.get(day) ?? []}
                inMonth={monthOfDay(day).m === month.m}
                isToday={day === todayKey}
                selected={day === selectedDay}
                density={density}
                tabIndex={day === tabDay ? 0 : -1}
                onSelect={onSelectDay}
                onKeyDown={onKeyDown}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function DayCell({
  day,
  meetings,
  inMonth,
  isToday,
  selected,
  density,
  tabIndex,
  onSelect,
  onKeyDown,
}: {
  day: number;
  meetings: MeetingSummary[];
  inMonth: boolean;
  isToday: boolean;
  selected: boolean;
  density: 'full' | 'compact';
  tabIndex: number;
  onSelect: (day: number) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>, day: number) => void;
}) {
  const count = meetings.length;

  return (
    <div
      role="gridcell"
      aria-selected={selected}
      className="border-border min-w-0 border-r border-b last:border-r-0"
    >
      <button
        type="button"
        data-day={day}
        tabIndex={tabIndex}
        aria-label={cellLabel(day, meetings)}
        onClick={() => onSelect(day)}
        onKeyDown={(event) => onKeyDown(event, day)}
        className={cn(
          // The height sits on the button so the whole cell is the target — 44px
          // floor everywhere, taller only where there is room for titles.
          'focus-visible:ring-ring relative flex w-full flex-col gap-1 p-1 text-left focus-visible:ring-2 focus-visible:ring-inset focus-visible:outline-none',
          density === 'compact' ? 'aspect-square min-h-11' : 'min-h-11 md:min-h-20 md:p-1.5',
          selected && 'bg-accent',
          // Outside-month days stay live and are only dimmed. Clicking Aug 31 in
          // the September grid must show Aug 31 — teams meet in August, which is
          // the whole reason the list endpoint does not default its date window.
          !inMonth && 'text-muted-foreground/60',
        )}
      >
        {/* Today is a brand bar across the top of the cell. A filled disc behind
            the date is the obvious choice and is wrong: it would be the only
            other fill in this grid, so it reads as "selected" on the one day you
            have not selected. */}
        {isToday && <span className="u-bar absolute inset-x-1 top-0 h-[3px]" aria-hidden />}

        <span
          className={cn('tabular font-mono text-xs leading-none', isToday && 'font-bold')}
        >
          {day % 100}
        </span>

        {/* Bars on a phone: at 375px seven columns get about 49px, which fits a
            44px target but not a word. Three, then a count — four stacked
            hairlines in 49px is texture, not information. aria-hidden throughout,
            because the cell's label already says how many, in words. */}
        {count > 0 && (
          <span
            className={cn('flex flex-col gap-0.5', density === 'full' && 'md:hidden')}
            aria-hidden
          >
            {meetings.slice(0, 3).map((meeting) => (
              <span
                key={meeting.id}
                className={cn(
                  'h-1 rounded-[1px]',
                  // A cancelled meeting must not read as a meeting night, and
                  // must not read as an empty one either.
                  meeting.status === 'cancelled'
                    ? 'bg-muted-foreground/35'
                    : 'bg-primary',
                )}
              />
            ))}
            {count > 3 && (
              <span className="text-muted-foreground tabular font-mono text-[10px] leading-none">
                +{count - 3}
              </span>
            )}
          </span>
        )}

        {density === 'full' && count > 0 && (
          <span className="hidden min-w-0 flex-col gap-0.5 md:flex" aria-hidden>
            {meetings.slice(0, 2).map((meeting) => (
              <span
                key={meeting.id}
                className={cn(
                  'truncate rounded-[2px] px-1 py-0.5 text-[11px] leading-tight',
                  meeting.status === 'cancelled'
                    ? 'text-muted-foreground line-through'
                    : 'bg-primary/15 text-foreground',
                )}
              >
                {meeting.title}
              </span>
            ))}
            {count > 2 && (
              <span className="text-muted-foreground px-1 text-[11px]">
                +{count - 2} more
              </span>
            )}
          </span>
        )}
      </button>
    </div>
  );
}
