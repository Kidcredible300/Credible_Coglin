/**
 * Local wall-clock time in a named zone, resolved to epoch seconds.
 *
 * A recurring meeting is a wall-clock rule — "Tuesdays at 6pm" — but every
 * timestamp in this schema is epoch seconds. Converting between the two is the
 * whole job of this file, and it is the one piece of the meetings feature that
 * fails *silently* when it is wrong.
 *
 * The failure it exists to prevent: materialising a season by adding 7 * 86400
 * to the previous occurrence. That is correct until the first DST transition
 * and wrong for every occurrence after it, so a 6pm build meeting quietly
 * becomes 5pm in November and a team shows up an hour late in March. Both US
 * transitions land mid-FTC-season, so this is not a theoretical case.
 *
 * The two rules that make it correct:
 *
 *   1. Iterate the LOCAL CALENDAR, never the epoch. `addLocalDay` walks a
 *      {y,m,d} triple. The gap between two consecutive local midnights is not
 *      constant, so epoch arithmetic cannot express "the next day".
 *   2. Resolve each occurrence INDEPENDENTLY from (local date, local time,
 *      zone). No occurrence is derived from another.
 *
 * There is no dependency here on purpose. workerd ships the full ICU timezone
 * database, so `Intl.DateTimeFormat` with a `timeZone` is the authority — and
 * it stays correct across future tzdata updates in a way a bundled table would
 * not.
 */

/** The parts of a wall clock, in some zone. */
export interface LocalParts {
  y: number;
  m: number; // 1-12, not 0-11 — this is a calendar, not a Date
  d: number;
  hh: number;
  mm: number;
  ss: number;
}

/** Just the date half, which is what recurrence iterates over. */
export interface LocalDate {
  y: number;
  m: number;
  d: number;
}

/**
 * Formatters are cached because expansion calls into them a few hundred times
 * per series and constructing an Intl.DateTimeFormat is the expensive part.
 * The cache is per-isolate and keyed by zone, so it is bounded by the number of
 * distinct team timezones an isolate happens to serve.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let fmt = formatters.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      // h23 rather than hour12:false. The latter is documented to give midnight
      // as hour "24" under some ICU versions, which reads as a valid number and
      // silently shifts a date by a day.
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(tz, fmt);
  }
  return fmt;
}

/**
 * Is this a zone the runtime actually knows?
 *
 * Constructing a formatter is the check: an unknown IANA name throws RangeError.
 * `Intl.supportedValuesOf` would be a list to search, but it is not universally
 * present and this is both cheaper and exact.
 */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.length === 0 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The wall clock in `tz` at this instant. */
export function partsInZone(epochSeconds: number, tz: string): LocalParts {
  const parts = formatterFor(tz).formatToParts(new Date(epochSeconds * 1000));
  const get = (type: string): number => {
    const found = parts.find((p) => p.type === type);
    return found ? Number(found.value) : 0;
  };
  return {
    y: get('year'),
    m: get('month'),
    d: get('day'),
    hh: get('hour'),
    mm: get('minute'),
    ss: get('second'),
  };
}

export function localDateInZone(epochSeconds: number, tz: string): LocalDate {
  const { y, m, d } = partsInZone(epochSeconds, tz);
  return { y, m, d };
}

/**
 * The zone's UTC offset, in seconds, at a given instant.
 *
 * Read the wall clock in the zone, then reinterpret those same digits as if
 * they were UTC. The difference between that and the real instant IS the
 * offset — which is why this needs no table and no arithmetic about which
 * rules are in force.
 */
export function tzOffsetSeconds(epochSeconds: number, tz: string): number {
  const p = partsInZone(epochSeconds, tz);
  const asIfUtc = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss) / 1000;
  return asIfUtc - epochSeconds;
}

/**
 * (local date, local time, zone) -> epoch seconds.
 *
 * Two candidates, and then a check — not two blind passes.
 *
 * The first guess uses the offset in force at the *wrong* instant (one
 * offset-width away from the answer). That is right on every ordinary day and
 * can be an hour out near a transition, so a second candidate is computed from
 * the offset measured at the first one. The part that matters is **verifying**:
 * each candidate is formatted back into the zone and only accepted if it reads
 * as the wall clock that was asked for.
 *
 * Blindly preferring the second candidate — the obvious two-pass formulation —
 * is wrong for nonexistent times. Asking for 02:30 on a spring-forward Sunday
 * that way lands on 01:30, i.e. *before* the requested time, which would make a
 * meeting drift backwards past its own agenda. Verifying instead lets the
 * nonexistent case fall through to the documented rule below.
 *
 * Two local times are not one-to-one with instants, and both cases are handled
 * deliberately:
 *
 *   - **Nonexistent** (the hour skipped by spring-forward): normalises FORWARD,
 *     so 02:30 becomes 03:30. Conventional, and a throw here would fail a whole
 *     season's materialisation over a time no team meets at.
 *   - **Ambiguous** (the hour repeated by fall-back): resolves to the FIRST
 *     occurrence, the one still on the old offset. Also conventional, and it
 *     falls out of checking the first candidate first.
 *
 * Neither can affect a 6pm meeting. They are specified anyway because "it never
 * comes up" is how a function acquires undefined behaviour.
 */
export function zonedTimeToEpoch(
  y: number,
  m: number,
  d: number,
  hh: number,
  mm: number,
  tz: string,
): number {
  const asIfUtc = Date.UTC(y, m - 1, d, hh, mm, 0) / 1000;

  const reads = (ts: number): boolean => {
    const p = partsInZone(ts, tz);
    return p.y === y && p.m === m && p.d === d && p.hh === hh && p.mm === mm;
  };

  const firstOffset = tzOffsetSeconds(asIfUtc, tz);
  const first = asIfUtc - firstOffset;
  if (reads(first)) return first;

  const secondOffset = tzOffsetSeconds(first, tz);
  if (secondOffset === firstOffset) return first;
  const second = asIfUtc - secondOffset;
  if (reads(second)) return second;

  // Neither candidate reads back as the requested time, so the requested time
  // does not exist in this zone. The later candidate is the forward shift.
  return Math.max(first, second);
}

/** Convenience: resolve a local date plus minutes-past-local-midnight. */
export function zonedMinuteToEpoch(
  date: LocalDate,
  minutesPastMidnight: number,
  tz: string,
): number {
  return zonedTimeToEpoch(
    date.y,
    date.m,
    date.d,
    Math.floor(minutesPastMidnight / 60),
    minutesPastMidnight % 60,
    tz,
  );
}

/**
 * The next calendar day.
 *
 * Deliberately does its own month-length arithmetic through Date.UTC rather
 * than touching epochs in the team's zone. A local date is a calendar fact with
 * no timezone in it at all, so the safe way to add a day to one is to do the
 * arithmetic somewhere with no DST — and UTC is that place.
 */
export function addLocalDay(date: LocalDate, days = 1): LocalDate {
  const next = new Date(Date.UTC(date.y, date.m - 1, date.d + days));
  return {
    y: next.getUTCFullYear(),
    m: next.getUTCMonth() + 1,
    d: next.getUTCDate(),
  };
}

/** Day of week for a local date. 0 = Sunday, matching JS `Date#getDay`. */
export function localDayOfWeek(date: LocalDate): number {
  return new Date(Date.UTC(date.y, date.m - 1, date.d)).getUTCDay();
}

/**
 * A local date as the integer YYYYMMDD.
 *
 * This is `meetings.series_slot`: an occurrence's stable identity within its
 * series. Rescheduling a meeting changes `starts_at` but never its slot, which
 * is what lets re-expansion be an idempotent upsert instead of a duplicate
 * storm. Sortable and comparable as a plain integer, which epoch seconds are
 * not once a zone is involved.
 */
export function toSlot(date: LocalDate): number {
  return date.y * 10000 + date.m * 100 + date.d;
}

export function fromSlot(slot: number): LocalDate {
  return {
    y: Math.floor(slot / 10000),
    m: Math.floor((slot % 10000) / 100),
    d: slot % 100,
  };
}

/** a < b, for local dates. */
export function localDateBefore(a: LocalDate, b: LocalDate): boolean {
  return toSlot(a) < toSlot(b);
}
