import { useMemo, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import * as api from '@/lib/api';
import { cn } from '@/lib/utils';
import { MEETING_KINDS, WEEKDAYS, type MeetingKind } from '@/types';

/**
 * One form for both a one-off meeting and a whole season's worth.
 *
 * Structurally a copy of InviteDialog — native form, FormData on submit,
 * uncontrolled text inputs, controlled state only for the Selects and the day
 * chips, inline role="alert" errors — because a second dialog convention in a
 * nine-screen app is a cost with no benefit.
 */

/** Local date as YYYYMMDD, which is what the series API speaks. */
function slotFromDateInput(value: string): number {
  const [y, m, d] = value.split('-').map(Number);
  return y * 10000 + m * 100 + d;
}

/** Epoch seconds from the two native inputs, in the browser's own zone. */
function epochFromInputs(date: string, time: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return Math.floor(new Date(y, m - 1, d, hh, mm, 0, 0).getTime() / 1000);
}

function minutesFromTimeInput(value: string): number {
  const [hh, mm] = value.split(':').map(Number);
  return hh * 60 + mm;
}

function toDateInput(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`;
}

/**
 * How many occurrences a rule produces, for the summary line.
 *
 * Clamps to the season the same way the server does. Without that the count is
 * a promise the server then quietly breaks — scheduling from mid-August offered
 * "36 meetings" and created 32, because the season does not start until
 * September. A preview that disagrees with the outcome is worse than no
 * preview, since its whole job is to be checked against.
 */
function countOccurrences(
  days: number[],
  fromInput: string,
  untilInput: string,
  bounds: { floor: string; last: string } | null,
): number {
  if (days.length === 0 || !fromInput || !untilInput) return 0;
  // Matches the server: the start is only pulled forward to the season floor
  // (the day after the previous season ended), and the end is capped at the
  // season's own last day.
  const from = bounds && fromInput < bounds.floor ? bounds.floor : fromInput;
  const until = bounds && untilInput > bounds.last ? bounds.last : untilInput;
  if (from > until) return 0;

  const [fy, fm, fd] = from.split('-').map(Number);
  const [uy, um, ud] = until.split('-').map(Number);
  const cursor = new Date(fy, fm - 1, fd);
  const end = new Date(uy, um - 1, ud);
  let n = 0;
  // Bounded so a mistyped year cannot spin the render.
  for (let i = 0; i < 400 && cursor <= end; i++) {
    if (days.includes(cursor.getDay())) n++;
    cursor.setDate(cursor.getDate() + 1);
  }
  return n;
}

const DURATIONS = [
  { value: '60', label: '1 hour' },
  { value: '90', label: '1½ hours' },
  { value: '120', label: '2 hours' },
  { value: '180', label: '3 hours' },
  { value: '240', label: '4 hours' },
];

const ERROR_COPY: Record<string, string> = {
  no_days_selected: 'Pick at least one day of the week.',
  too_many_occurrences: 'That repeats too many times. Try a shorter run of dates.',
  no_occurrences_in_range: 'That rule does not land on any date in this season.',
  invalid_date_range: 'The end date comes before the start date.',
  invalid_starts_at: 'That date and time could not be read.',
  invalid_duration: 'Pick a length between 15 minutes and 14 hours.',
  no_current_season: 'This team has no current season yet.',
  forbidden: 'Only coaches and mentors can schedule meetings.',
};

export function ScheduleMeetingDialog({
  onScheduled,
  season,
}: {
  onScheduled: () => void;
  /**
   * Used to bound the date inputs and the count. Optional because the dialog
   * must still work while the season request is in flight — the server clamps
   * regardless, so this only affects what the coach is shown beforehand.
   */
  season?: { starts_at: number; ends_at: number } | null;
}) {
  const [open, setOpen] = useState(false);
  const [repeats, setRepeats] = useState(false);
  const [kind, setKind] = useState<MeetingKind>('build');
  const [duration, setDuration] = useState('120');
  const [days, setDays] = useState<number[]>([]);
  const [dateValue, setDateValue] = useState(() => toDateInput(new Date()));
  const [untilValue, setUntilValue] = useState('');
  const [timeValue, setTimeValue] = useState('18:00');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * The season as date-input strings, converted the same way the server does
   * (epoch -> local date), so the two agree about where the season begins.
   */
  const bounds = useMemo(() => {
    if (!season) return null;
    const last = new Date(season.ends_at * 1000);
    // The day after the previous season ended, computed the same way the server
    // does it, so the preview and the outcome agree.
    const floor = new Date(last);
    floor.setFullYear(floor.getFullYear() - 1);
    floor.setDate(floor.getDate() + 1);
    return { floor: toDateInput(floor), last: toDateInput(last) };
  }, [season]);

  const occurrences = useMemo(
    () => countOccurrences(days, dateValue, untilValue, bounds),
    [days, dateValue, untilValue, bounds],
  );

  /** True when the coach picked a date the server is going to move. */
  const clamped = bounds !== null && dateValue < bounds.floor;

  function reset() {
    setRepeats(false);
    setKind('build');
    setDuration('120');
    setDays([]);
    setDateValue(toDateInput(new Date()));
    setUntilValue('');
    setTimeValue('18:00');
    setError(null);
    setPending(false);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const title = String(data.get('title') ?? '').trim();
    const location = String(data.get('location') ?? '').trim();

    setPending(true);
    setError(null);
    try {
      if (repeats) {
        await api.createSeries({
          title: title || undefined,
          kind,
          location: location || null,
          days_of_week: days,
          start_minute: minutesFromTimeInput(timeValue),
          duration_minutes: Number(duration),
          starts_on: slotFromDateInput(dateValue),
          until: untilValue ? slotFromDateInput(untilValue) : undefined,
          // The browser's zone is the best available guess at the shop's, and
          // the coach can correct the team's zone in settings. Sending it
          // explicitly beats letting the server assume.
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        });
      } else {
        await api.createMeeting({
          starts_at: epochFromInputs(dateValue, timeValue),
          title: title || undefined,
          kind,
          location: location || null,
          duration_minutes: Number(duration),
        });
      }
      onScheduled();
      setOpen(false);
      reset();
    } catch (err) {
      const code = err instanceof Error ? err.message : 'unknown';
      setError(ERROR_COPY[code] ?? 'Could not schedule that. Try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">Schedule</Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <form onSubmit={onSubmit}>
          <DialogHeader>
            <DialogTitle className="u-display text-xl">Schedule a meeting</DialogTitle>
            <DialogDescription>
              One meeting, or the whole season in one go.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-1.5">
              <Label htmlFor="meeting-title">Title</Label>
              <Input id="meeting-title" name="title" placeholder="Team meeting" />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="meeting-date">{repeats ? 'First date' : 'Date'}</Label>
                {/* Native date and time inputs, not a calendar component. These
                    users are on phones and school Chromebooks, where this opens
                    the OS picker they already know — touch-sized, localised,
                    and the control screen readers have actually been tested
                    against. A react-day-picker grid would be more bundle for a
                    worse mobile experience. */}
                {/* Deliberately unbounded. An earlier version set `min` to the
                    season's first day, which the browser then enforced with
                    "value must be 8/31/2026 or later" — because a season
                    starting Sept 1 UTC is Aug 31 in the Americas. Teams meet in
                    August, so the fence was wrong twice over: wrong about the
                    date, and wrong that there should be one. */}
                <Input
                  id="meeting-date"
                  type="date"
                  required
                  value={dateValue}
                  onChange={(e) => setDateValue(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="meeting-time">Start time</Label>
                <Input
                  id="meeting-time"
                  type="time"
                  required
                  value={timeValue}
                  onChange={(e) => setTimeValue(e.target.value)}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="meeting-length">Length</Label>
                <Select value={duration} onValueChange={setDuration}>
                  <SelectTrigger id="meeting-length">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DURATIONS.map((d) => (
                      <SelectItem key={d.value} value={d.value}>
                        {d.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="meeting-kind">Kind</Label>
                <Select value={kind} onValueChange={(v) => setKind(v as MeetingKind)}>
                  <SelectTrigger id="meeting-kind">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MEETING_KINDS.map((k) => (
                      <SelectItem key={k.id} value={k.id}>
                        {k.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="meeting-location">Where</Label>
              <Input id="meeting-location" name="location" placeholder="Shop" />
            </div>

            <div className="border-border rounded-md border p-3">
              <label className="flex min-h-11 items-center gap-2.5 text-sm font-medium">
                <input
                  type="checkbox"
                  checked={repeats}
                  onChange={(e) => setRepeats(e.target.checked)}
                  className="size-4"
                />
                Repeats weekly
              </label>

              {repeats && (
                <div className="mt-3 space-y-3">
                  <div className="space-y-1.5">
                    <span className="u-eyebrow">On these days</span>
                    <div className="flex gap-1.5">
                      {WEEKDAYS.map((day) => {
                        const on = days.includes(day.id);
                        return (
                          <button
                            key={day.id}
                            type="button"
                            aria-pressed={on}
                            aria-label={day.label}
                            onClick={() =>
                              setDays((prev) =>
                                prev.includes(day.id)
                                  ? prev.filter((d) => d !== day.id)
                                  : [...prev, day.id],
                              )
                            }
                            className={cn(
                              'focus-visible:ring-ring size-11 rounded-md border text-sm font-medium focus-visible:ring-2 focus-visible:outline-none',
                              on
                                ? 'border-primary bg-primary text-primary-foreground'
                                : 'border-border text-muted-foreground',
                            )}
                          >
                            {day.short}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="meeting-until">Until</Label>
                    <Input
                      id="meeting-until"
                      type="date"
                      min={bounds?.floor}
                      max={bounds?.last}
                      value={untilValue}
                      onChange={(e) => setUntilValue(e.target.value)}
                    />
                    <p className="text-muted-foreground text-xs">
                      Leave blank to run to the end of the season.
                    </p>
                  </div>

                  {/* Plain English and a count, above the button rather than
                      after the fact. A coach who has accidentally described 300
                      meetings should find out here, not in the index. */}
                  {days.length > 0 && untilValue && (
                    <p className="text-muted-foreground text-sm">
                      {days.length === 7
                        ? 'Every day'
                        : `Every ${days
                            .slice()
                            .sort((a, b) => a - b)
                            .map((d) => WEEKDAYS[d].label)
                            .join(' and ')}`}
                      , starting {clamped && bounds ? bounds.floor : dateValue} —{' '}
                      <span className="tabular font-mono">{occurrences}</span>{' '}
                      {occurrences === 1 ? 'meeting' : 'meetings'}.
                      {clamped && ' That is as early as this season goes.'}
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>

          {error && (
            <p role="alert" className="text-destructive mb-4 text-sm">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button type="submit" disabled={pending || (repeats && days.length === 0)}>
              {pending ? 'Scheduling…' : repeats ? 'Schedule series' : 'Schedule'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
