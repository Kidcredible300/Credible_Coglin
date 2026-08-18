/**
 * Meeting vocabulary and the recurrence expander.
 *
 * The validators mirror `roles.ts`: these are the server's copy, and a value
 * arriving in a request body is never written to D1 without passing through
 * here. `src/types.ts` holds the client's copy for rendering labels — the two
 * must be kept in sync by hand, for the reason `roles.ts:1-13` explains, and
 * `meetings.test.ts` asserts that every kind declared below is actually
 * accepted end to end.
 */
import {
  addLocalDay,
  localDateInZone,
  localDayOfWeek,
  toSlot,
  zonedMinuteToEpoch,
  type LocalDate,
} from './tz';

/**
 * Every enum here declares its VALUES first and derives its type from them.
 *
 * The obvious alternative — a hand-written union plus a matching array — has a
 * silent failure mode that already bit once: `general` was added to the
 * `MeetingKind` union but not to the array, so the client offered it in a
 * dropdown and the server answered 400 `invalid_kind`. TypeScript cannot catch
 * that, because a `readonly MeetingKind[]` missing an entry is perfectly legal.
 *
 * Derived the other way round, the array IS the definition and the type cannot
 * disagree with it. Adding a value is one edit in one place.
 *
 * These lists are still duplicated from `src/types.ts` (see `roles.ts` for why
 * the worker tsconfig cannot share them), so a value added on one side of that
 * boundary and not the other remains a hand-checked risk — but a value added to
 * one HALF of a single side is now impossible.
 */

export const MEETING_KINDS = [
  'build',
  'general',
  'outreach',
  'design_review',
  'business',
  'drive_practice',
  'competition',
  'other',
] as const;
export type MeetingKind = (typeof MEETING_KINDS)[number];

export const MEETING_STATUSES = ['planned', 'held', 'cancelled'] as const;
export type MeetingStatus = (typeof MEETING_STATUSES)[number];

/**
 * The disposition, and now the whole of it.
 *
 * `excused` is retired and so are the `arrived_late` / `left_early` marks that
 * used to sit on top of these. The comment that stood here defended splitting
 * them out because they co-occur, which is true and was still the wrong trade —
 * see migrations/0005_attendance.sql for the argument. `other` plus the row's
 * `note` carries every case they carried, in a form a coach will actually fill
 * in on a phone.
 *
 * `other` REQUIRES a note. An unexplained `other` says strictly less about a
 * student than `absent` does while looking like it says more, and there is no
 * CHECK constraint to stop one — so routes/records.ts enforces it, and so must
 * any future writer.
 */
export const ATTENDANCE_STATES = ['present', 'absent', 'other'] as const;
export type AttendanceState = (typeof ATTENDANCE_STATES)[number];

export const BLOCK_KINDS = [
  'heading',
  'paragraph',
  'bullet',
  'decision',
  'action',
  'image',
] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];

export const ACTION_STATUSES = ['open', 'done', 'dropped'] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];

export const CANDIDATE_STATES = [
  'candidate',
  'shortlisted',
  'placed',
  'rejected',
] as const;
export type CandidateState = (typeof CANDIDATE_STATES)[number];

export const CANDIDATE_SOURCE_TYPES = [
  'meeting',
  'meeting_block',
  'media',
  'task',
  'outreach_event',
] as const;
export type CandidateSourceType = (typeof CANDIDATE_SOURCE_TYPES)[number];

export const AWARD_KEYS = [
  'inspire',
  'think',
  'connect',
  'reach',
  'sustain',
  'innovate',
  'control',
  'design',
] as const;
export type AwardKey = (typeof AWARD_KEYS)[number];

const oneOf =
  <T extends string>(values: readonly T[]) =>
  (value: unknown): value is T =>
    typeof value === 'string' && (values as readonly string[]).includes(value);

export const isMeetingKind = oneOf(MEETING_KINDS);
export const isMeetingStatus = oneOf(MEETING_STATUSES);
export const isAttendanceState = oneOf(ATTENDANCE_STATES);
export const isBlockKind = oneOf(BLOCK_KINDS);
export const isActionStatus = oneOf(ACTION_STATUSES);
export const isCandidateState = oneOf(CANDIDATE_STATES);
export const isCandidateSourceType = oneOf(CANDIDATE_SOURCE_TYPES);
export const isAwardKey = oneOf(AWARD_KEYS);

// ------------------------------------------------------------------ ordering

/**
 * Gap between adjacent `position` values.
 *
 * Wide enough that inserting between two blocks stays a single-row write for
 * ~10 consecutive insertions at the same spot before the midpoints get small
 * enough to want a renormalise.
 */
export const POSITION_GAP = 1024;

/** The position for a block dropped between two others. */
export function positionBetween(before: number | null, after: number | null): number {
  if (before === null && after === null) return POSITION_GAP;
  if (before === null) return (after as number) - POSITION_GAP;
  if (after === null) return before + POSITION_GAP;
  return (before + after) / 2;
}

// ---------------------------------------------------------------- recurrence

/**
 * Occurrences a series generates. 200 is generous — a 39-week season meeting
 * three times a week is 117 — and hitting it is reported rather than silently
 * truncated, because a coach who has accidentally described 300 meetings needs
 * to find out before they are written.
 */
export const MAX_OCCURRENCES = 200;

/**
 * Independent bound on the day-walk itself, so a corrupt `until` cannot spin
 * the loop even if it somehow produces no occurrences. A Sept 1 - May 31 season
 * is ~273 days, so this is roughly 1.5x the longest legitimate walk.
 */
export const MAX_DAY_ITERATIONS = 400;

export interface SeriesRule {
  /** Ints 0..6, Sunday = 0. */
  daysOfWeek: number[];
  /** Minutes after local midnight. */
  startMinute: number;
  durationMinutes: number;
  timezone: string;
  /** Local dates as YYYYMMDD. */
  startsOn: number;
  until: number;
}

export interface Occurrence {
  slot: number;
  startsAt: number;
  endsAt: number;
}

export interface Expansion {
  occurrences: Occurrence[];
  /** True when the rule would have produced more than MAX_OCCURRENCES. */
  exceeded: boolean;
}

/**
 * Materialise a recurrence rule into concrete occurrences.
 *
 * Walks the LOCAL CALENDAR and resolves each occurrence independently. Both
 * halves matter: iterating on epochs drifts an hour at a DST boundary, and
 * deriving one occurrence from the previous one propagates that drift through
 * the rest of the season. See `tz.ts` for why.
 *
 * Returns rather than throws on overflow so the caller can answer with a count
 * the coach can act on.
 */
export function expandSeries(rule: SeriesRule): Expansion {
  const occurrences: Occurrence[] = [];
  const days = new Set(rule.daysOfWeek);
  if (days.size === 0 || rule.startsOn > rule.until) {
    return { occurrences, exceeded: false };
  }

  let cursor: LocalDate = {
    y: Math.floor(rule.startsOn / 10000),
    m: Math.floor((rule.startsOn % 10000) / 100),
    d: rule.startsOn % 100,
  };

  for (let i = 0; i < MAX_DAY_ITERATIONS; i++) {
    const slot = toSlot(cursor);
    if (slot > rule.until) break;

    if (days.has(localDayOfWeek(cursor))) {
      if (occurrences.length >= MAX_OCCURRENCES) {
        return { occurrences, exceeded: true };
      }
      const startsAt = zonedMinuteToEpoch(cursor, rule.startMinute, rule.timezone);
      occurrences.push({
        slot,
        startsAt,
        endsAt: startsAt + rule.durationMinutes * 60,
      });
    }
    cursor = addLocalDay(cursor);
  }

  return { occurrences, exceeded: false };
}

/**
 * The season's bounds as local-date slots.
 *
 * Necessary because `currentSeason()` in `routes/auth.ts` builds `ends_at` as
 * May 31 23:59:59 **UTC**, which is 7:59pm Eastern — so comparing a 6pm May 31
 * meeting against that epoch would put the last meeting of the season outside
 * its own season. Converting both ends to local dates first makes the
 * comparison a calendar comparison, which is what a season actually is.
 */
export function seasonSlots(
  startsAt: number,
  endsAt: number,
  timezone: string,
): { first: number; floor: number; last: number } {
  const lastDate = localDateInZone(endsAt, timezone);
  // The day after the previous season ended — same calendar day, a year back,
  // plus one. For a Sept 1 - May 31 season that lands on June 1, and it stays
  // correct across leap years because addLocalDay owns the month arithmetic.
  const previousSeasonEnd = { y: lastDate.y - 1, m: lastDate.m, d: lastDate.d };

  return {
    first: toSlot(localDateInZone(startsAt, timezone)),
    /**
     * The earliest date a recurrence rule may begin.
     *
     * NOT the season's own first day, which was the original bug. FTC kickoff is
     * in September but teams meet through the summer to prepare, so clamping a
     * rule up to September 1 made preseason meetings unschedulable. Anything
     * after the previous season finished belongs to this one.
     */
    floor: toSlot(addLocalDay(previousSeasonEnd, 1)),
    last: toSlot(lastDate),
  };
}

/** Validate and normalise a days-of-week array from a request body. */
export function normaliseDaysOfWeek(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const seen = new Set<number>();
  for (const entry of value) {
    if (typeof entry !== 'number' || !Number.isInteger(entry) || entry < 0 || entry > 6) {
      return null;
    }
    seen.add(entry);
  }
  return [...seen].sort((a, b) => a - b);
}
