/**
 * These tests exist to answer one question before anything is built on top of
 * this file: does workerd's `Intl` carry the full ICU timezone database, and
 * does `formatToParts` honour a `timeZone`?
 *
 * If it does not, `zonedTimeToEpoch` silently returns UTC and every recurring
 * meeting in the product is wrong by an offset — which is exactly the class of
 * bug nobody notices until a team misses a match. So the assertions here are
 * deliberately about observable local time ("this instant reads as 18:00 in New
 * York"), not about a hardcoded epoch number that would pass just as happily if
 * the zone were being ignored.
 */
import { describe, expect, it } from 'vitest';
import {
  addLocalDay,
  fromSlot,
  isValidTimeZone,
  localDateInZone,
  localDayOfWeek,
  partsInZone,
  toSlot,
  tzOffsetSeconds,
  zonedMinuteToEpoch,
  zonedTimeToEpoch,
} from './tz';

const NY = 'America/New_York';

/** "What does the wall clock in `tz` say at this instant?" as HH:MM. */
function clockAt(epochSeconds: number, tz: string): string {
  const p = partsInZone(epochSeconds, tz);
  return `${String(p.hh).padStart(2, '0')}:${String(p.mm).padStart(2, '0')}`;
}

function dateAt(epochSeconds: number, tz: string): string {
  const p = partsInZone(epochSeconds, tz);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

describe('the runtime actually has timezones', () => {
  it('formats a known instant differently in two zones', () => {
    // 2026-11-10T12:00:00Z. If timeZone were being ignored both would be 12:00.
    const noon = Date.UTC(2026, 10, 10, 12, 0, 0) / 1000;
    expect(clockAt(noon, NY)).toBe('07:00');
    expect(clockAt(noon, 'UTC')).toBe('12:00');
    expect(clockAt(noon, 'Asia/Tokyo')).toBe('21:00');
  });

  it('knows the offset changes across a DST boundary', () => {
    const octEvening = zonedTimeToEpoch(2026, 10, 20, 18, 0, NY); // EDT
    const decEvening = zonedTimeToEpoch(2026, 12, 20, 18, 0, NY); // EST
    expect(tzOffsetSeconds(octEvening, NY)).toBe(-4 * 3600);
    expect(tzOffsetSeconds(decEvening, NY)).toBe(-5 * 3600);
  });
});

describe('zonedTimeToEpoch across DST', () => {
  // The FTC season spans both US transitions: fall back Nov 1 2026, spring
  // forward Mar 14 2027. A weekly 6pm meeting has to stay 6pm across both.
  it('keeps 18:00 local on either side of fall-back 2026', () => {
    const before = zonedTimeToEpoch(2026, 10, 27, 18, 0, NY); // Tue, EDT
    const after = zonedTimeToEpoch(2026, 11, 3, 18, 0, NY); // Tue, EST

    expect(clockAt(before, NY)).toBe('18:00');
    expect(clockAt(after, NY)).toBe('18:00');

    // Seven local days apart, but EIGHT * 86400 seconds' worth of epoch minus
    // an hour: 604800 + 3600. This is the assertion that fails if anyone
    // "simplifies" expansion to epoch + 7 days.
    expect(after - before).toBe(7 * 86400 + 3600);
  });

  it('keeps 18:00 local on either side of spring-forward 2027', () => {
    const before = zonedTimeToEpoch(2027, 3, 9, 18, 0, NY); // Tue, EST
    const after = zonedTimeToEpoch(2027, 3, 16, 18, 0, NY); // Tue, EDT

    expect(clockAt(before, NY)).toBe('18:00');
    expect(clockAt(after, NY)).toBe('18:00');
    expect(after - before).toBe(7 * 86400 - 3600);
  });

  it('holds 18:00 local for every Tuesday and Thursday of a whole season', () => {
    // The real materialisation loop, in miniature. If the two-pass offset
    // correction is wrong on any single day, this catches the day.
    let cursor = { y: 2026, m: 9, d: 8 };
    const end = { y: 2027, m: 4, d: 18 };
    const wrong: string[] = [];

    while (toSlot(cursor) <= toSlot(end)) {
      const dow = localDayOfWeek(cursor);
      if (dow === 2 || dow === 4) {
        const at = zonedMinuteToEpoch(cursor, 18 * 60, NY);
        if (clockAt(at, NY) !== '18:00') wrong.push(dateAt(at, NY));
        // And the date must not have slid either.
        if (dateAt(at, NY) !== `${cursor.y}-${String(cursor.m).padStart(2, '0')}-${String(cursor.d).padStart(2, '0')}`) {
          wrong.push(`date-slid:${toSlot(cursor)}`);
        }
      }
      cursor = addLocalDay(cursor);
    }

    expect(wrong).toEqual([]);
  });
});

describe('zones that are not America/New_York', () => {
  it('is stable across both transitions in a no-DST zone', () => {
    const nov = zonedTimeToEpoch(2026, 10, 27, 18, 0, 'America/Phoenix');
    const dec = zonedTimeToEpoch(2026, 11, 3, 18, 0, 'America/Phoenix');
    expect(clockAt(nov, 'America/Phoenix')).toBe('18:00');
    expect(clockAt(dec, 'America/Phoenix')).toBe('18:00');
    expect(dec - nov).toBe(7 * 86400);
  });

  it('handles a half-hour offset', () => {
    const at = zonedTimeToEpoch(2026, 11, 3, 18, 30, 'Asia/Kolkata');
    expect(clockAt(at, 'Asia/Kolkata')).toBe('18:30');
    expect(tzOffsetSeconds(at, 'Asia/Kolkata')).toBe(5 * 3600 + 1800);
  });

  it('handles a 45-minute offset', () => {
    const at = zonedTimeToEpoch(2026, 11, 3, 18, 0, 'Asia/Kathmandu');
    expect(clockAt(at, 'Asia/Kathmandu')).toBe('18:00');
    expect(tzOffsetSeconds(at, 'Asia/Kathmandu')).toBe(5 * 3600 + 2700);
  });

  it('handles a southern-hemisphere zone whose DST runs the other way', () => {
    const jul = zonedTimeToEpoch(2026, 7, 7, 18, 0, 'Australia/Sydney');
    const jan = zonedTimeToEpoch(2027, 1, 5, 18, 0, 'Australia/Sydney');
    expect(clockAt(jul, 'Australia/Sydney')).toBe('18:00');
    expect(clockAt(jan, 'Australia/Sydney')).toBe('18:00');
  });
});

describe('edge cases at the transition itself', () => {
  it('normalises a nonexistent spring-forward local time forward', () => {
    // 2027-03-14 02:30 America/New_York does not exist — the clock jumps 02:00
    // to 03:00. It must resolve to something real rather than throwing, because
    // a throw here would fail a whole season's materialisation.
    const at = zonedTimeToEpoch(2027, 3, 14, 2, 30, NY);
    expect(Number.isFinite(at)).toBe(true);
    expect(clockAt(at, NY)).toBe('03:30');
  });

  it('resolves an ambiguous fall-back local time to one real instant', () => {
    // 2026-11-01 01:30 happens twice. Either is defensible; it must be one of
    // them and it must read back as 01:30.
    const at = zonedTimeToEpoch(2026, 11, 1, 1, 30, NY);
    expect(clockAt(at, NY)).toBe('01:30');
    expect(dateAt(at, NY)).toBe('2026-11-01');
  });

  it('resolves local midnight to the right date', () => {
    const at = zonedTimeToEpoch(2026, 11, 1, 0, 0, NY);
    expect(clockAt(at, NY)).toBe('00:00');
    expect(dateAt(at, NY)).toBe('2026-11-01');
  });
});

describe('local calendar arithmetic', () => {
  it('crosses a month boundary', () => {
    expect(addLocalDay({ y: 2026, m: 9, d: 30 })).toEqual({ y: 2026, m: 10, d: 1 });
  });

  it('crosses a year boundary', () => {
    expect(addLocalDay({ y: 2026, m: 12, d: 31 })).toEqual({ y: 2027, m: 1, d: 1 });
  });

  it('handles a leap day', () => {
    expect(addLocalDay({ y: 2028, m: 2, d: 28 })).toEqual({ y: 2028, m: 2, d: 29 });
    expect(addLocalDay({ y: 2027, m: 2, d: 28 })).toEqual({ y: 2027, m: 3, d: 1 });
  });

  it('does not drift across a DST boundary', () => {
    // The reason this function does its arithmetic in UTC rather than on epochs
    // in the team's zone.
    let cursor = { y: 2026, m: 10, d: 30 };
    for (let i = 0; i < 5; i++) cursor = addLocalDay(cursor);
    expect(cursor).toEqual({ y: 2026, m: 11, d: 4 });
  });

  it('agrees with the zone about the day of week', () => {
    // 2026-09-08 is a Tuesday.
    expect(localDayOfWeek({ y: 2026, m: 9, d: 8 })).toBe(2);
    expect(localDayOfWeek({ y: 2026, m: 9, d: 6 })).toBe(0);
  });

  it('round-trips a slot', () => {
    const date = { y: 2026, m: 11, d: 3 };
    expect(toSlot(date)).toBe(20261103);
    expect(fromSlot(toSlot(date))).toEqual(date);
  });

  it('reads the local date of an instant near midnight', () => {
    // 2026-11-04T02:00:00Z is still Nov 3 in New York. A team's Tuesday-evening
    // meeting is a Wednesday in UTC, which is why slots are local dates.
    const at = Date.UTC(2026, 10, 4, 2, 0, 0) / 1000;
    expect(localDateInZone(at, NY)).toEqual({ y: 2026, m: 11, d: 3 });
    expect(localDateInZone(at, 'UTC')).toEqual({ y: 2026, m: 11, d: 4 });
  });
});

describe('isValidTimeZone', () => {
  it('accepts real IANA names', () => {
    expect(isValidTimeZone(NY)).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Europe/London')).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isValidTimeZone('Middle/Earth')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone('EST5EDT_not_a_zone')).toBe(false);
    expect(isValidTimeZone(null)).toBe(false);
    expect(isValidTimeZone(42)).toBe(false);
    expect(isValidTimeZone('x'.repeat(200))).toBe(false);
  });
});
