import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  call,
  callJson,
  inviteAndAccept,
  signUpCoach,
  stubResend,
  whoami,
} from './_helpers';
import { partsInZone } from '../lib/tz';
import { MEETING_KINDS } from '../lib/meetings';

beforeAll(() => {
  stubResend();
});

const NY = 'America/New_York';

interface Meeting {
  id: string;
  title: string;
  starts_at: number;
  ends_at: number | null;
  kind: string;
  status: string;
  series_id: string | null;
  series_slot: number | null;
  detached_at: number | null;
  location: string | null;
}

/** What the wall clock in `tz` reads at this instant, as HH:MM. */
function clockAt(epochSeconds: number, tz: string): string {
  const p = partsInZone(epochSeconds, tz);
  return `${String(p.hh).padStart(2, '0')}:${String(p.mm).padStart(2, '0')}`;
}

async function createMeeting(
  cookie: string,
  body: Record<string, unknown>,
): Promise<Meeting> {
  const { status, body: result } = await callJson<{ meeting: Meeting }>('/api/meetings', {
    method: 'POST',
    cookie,
    body: JSON.stringify(body),
  });
  expect(status).toBe(201);
  return result.meeting;
}

/**
 * A start time inside the current season.
 *
 * Tests cannot hardcode a date: `currentSeason()` derives the season from the
 * real clock, so a fixed 2026 timestamp would fall outside the season the
 * moment this suite runs in a different year and every list assertion would
 * quietly return nothing.
 */
async function seasonStart(cookie: string): Promise<number> {
  const { body } = await callJson<{ starts_at: number; ends_at: number }>(
    '/api/season/current',
    { cookie },
  );
  return body.starts_at;
}

describe('meetings CRUD', () => {
  it('creates a meeting with sensible defaults and lists it', async () => {
    const cookie = await signUpCoach(4100);
    const start = (await seasonStart(cookie)) + 7 * 86400;

    const meeting = await createMeeting(cookie, { starts_at: start });
    expect(meeting.title).toBe('Team meeting');
    expect(meeting.kind).toBe('build');
    expect(meeting.status).toBe('planned');
    expect(meeting.ends_at).toBe(start + 120 * 60);
    expect(meeting.series_id).toBeNull();

    const { body } = await callJson<{ meetings: Meeting[] }>('/api/meetings', { cookie });
    expect(body.meetings).toHaveLength(1);
    expect(body.meetings[0].id).toBe(meeting.id);
  });

  it('honours title, kind, location and duration', async () => {
    const cookie = await signUpCoach(4101);
    const start = (await seasonStart(cookie)) + 7 * 86400;

    const meeting = await createMeeting(cookie, {
      starts_at: start,
      title: 'Drive practice',
      kind: 'drive_practice',
      location: 'Cafeteria',
      duration_minutes: 90,
    });
    expect(meeting.title).toBe('Drive practice');
    expect(meeting.kind).toBe('drive_practice');
    expect(meeting.location).toBe('Cafeteria');
    expect(meeting.ends_at).toBe(start + 90 * 60);
  });

  it('accepts every meeting kind it claims to support', async () => {
    // The guard for a real bug: `general` was added to the MeetingKind union but
    // not to the array isMeetingKind() checks, so the dropdown offered it and
    // the server answered 400. Iterating the declared list means a kind that is
    // declared but not accepted fails here rather than in a coach's face.
    const cookie = await signUpCoach(4800);
    const start = (await seasonStart(cookie)) + 7 * 86400;

    for (const kind of MEETING_KINDS) {
      const { status, body } = await callJson<{ meeting: Meeting; error?: string }>(
        '/api/meetings',
        {
          method: 'POST',
          cookie,
          body: JSON.stringify({ starts_at: start, kind }),
        },
      );
      expect(status, `kind ${kind} -> ${body.error ?? 'ok'}`).toBe(201);
      expect(body.meeting.kind).toBe(kind);
    }
  });

  it('rejects nonsense input', async () => {
    const cookie = await signUpCoach(4102);
    const start = await seasonStart(cookie);

    const cases: [Record<string, unknown>, string][] = [
      [{}, 'invalid_starts_at'],
      [{ starts_at: 'tuesday' }, 'invalid_starts_at'],
      [{ starts_at: start, kind: 'karaoke' }, 'invalid_kind'],
      [{ starts_at: start, duration_minutes: 3 }, 'invalid_duration'],
      [{ starts_at: start, duration_minutes: 60 * 24 }, 'invalid_duration'],
    ];

    for (const [body, expected] of cases) {
      const { status, body: result } = await callJson<{ error: string }>('/api/meetings', {
        method: 'POST',
        cookie,
        body: JSON.stringify(body),
      });
      expect(status).toBe(400);
      expect(result.error).toBe(expected);
    }
  });

  it('carries the attendance timing marks, which the roll seeds itself from', async () => {
    // Regression: this projection once omitted arrived_late and left_early. The
    // save worked and the season rollup was right, so the only visible symptom
    // was both marks quietly vanishing whenever anybody reloaded the meeting.
    const cookie = await signUpCoach(4106);
    const meeting = await createMeeting(cookie, {
      starts_at: (await seasonStart(cookie)) + 7 * 86400,
    });
    const me = await whoami(cookie);

    await callJson(`/api/meetings/${meeting.id}/attendance`, {
      method: 'PUT',
      cookie,
      body: JSON.stringify({
        entries: [
          {
            member_id: me.member_id,
            state: 'present',
            arrived_late: true,
            left_early: true,
          },
        ],
      }),
    });

    const { body } = await callJson<{
      attendance: { arrived_late: number; left_early: number }[];
    }>(`/api/meetings/${meeting.id}`, { cookie });
    expect(body.attendance[0].arrived_late).toBe(1);
    expect(body.attendance[0].left_early).toBe(1);
  });

  it('returns every section of a meeting in one read', async () => {
    const cookie = await signUpCoach(4103);
    const meeting = await createMeeting(cookie, {
      starts_at: (await seasonStart(cookie)) + 7 * 86400,
    });

    const { status, body } = await callJson<Record<string, unknown>>(
      `/api/meetings/${meeting.id}`,
      { cookie },
    );
    expect(status).toBe(200);
    // The meeting screen cannot render without all of these, so they arrive
    // together rather than as five follow-up requests.
    expect(Object.keys(body).sort()).toEqual(
      [
        'action_items',
        'agenda',
        'attendance',
        'attendees',
        'blocks',
        'candidates',
        'meeting',
      ].sort(),
    );
  });

  it('cancels without discarding the meeting', async () => {
    const cookie = await signUpCoach(4104);
    const meeting = await createMeeting(cookie, {
      starts_at: (await seasonStart(cookie)) + 7 * 86400,
    });

    const { status, body } = await callJson<{ meeting: Meeting }>(
      `/api/meetings/${meeting.id}/cancel`,
      { method: 'POST', cookie, body: JSON.stringify({ reason: 'Snow day' }) },
    );
    expect(status).toBe(200);
    expect(body.meeting.status).toBe('cancelled');
    // "We called it off for the snowstorm" is part of the season record.
    expect(body.meeting.detached_at).not.toBeNull();

    const still = await call(`/api/meetings/${meeting.id}`, { cookie });
    expect(still.status).toBe(200);
  });

  it('404s on another id shape and on a missing meeting', async () => {
    const cookie = await signUpCoach(4105);
    expect((await call('/api/meetings/nope', { cookie })).status).toBe(404);
  });
});

describe('recurrence', () => {
  it('materialises one occurrence per matching local date', async () => {
    const cookie = await signUpCoach(4200);
    const { status, body } = await callJson<{
      created: number;
      series: { days_of_week: number[] };
    }>('/api/series', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        title: 'Build night',
        days_of_week: [2, 4], // Tuesday, Thursday
        start_minute: 18 * 60,
        duration_minutes: 120,
        timezone: NY,
      }),
    });

    expect(status).toBe(201);
    expect(body.series.days_of_week).toEqual([2, 4]);
    // A Sept-May season, twice a week, is on the order of seventy meetings.
    expect(body.created).toBeGreaterThan(50);

    const list = await callJson<{ meetings: Meeting[] }>('/api/meetings', { cookie });
    expect(list.body.meetings.length).toBe(body.created);
  });

  // The assertion this whole feature's timekeeping rests on. If expansion ever
  // becomes "previous occurrence + 7 days", every meeting after the November
  // transition shifts by an hour and this fails.
  it('holds the local clock time across DST for every occurrence', async () => {
    const cookie = await signUpCoach(4201);
    await callJson('/api/series', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        days_of_week: [2, 4],
        start_minute: 18 * 60,
        timezone: NY,
      }),
    });

    const { body } = await callJson<{ meetings: Meeting[] }>('/api/meetings', { cookie });
    const offenders = body.meetings
      .map((m) => ({ id: m.id, clock: clockAt(m.starts_at, NY) }))
      .filter((m) => m.clock !== '18:00');

    expect(offenders).toEqual([]);
  });

  it('only produces the requested weekdays', async () => {
    const cookie = await signUpCoach(4202);
    await callJson('/api/series', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ days_of_week: [6], start_minute: 9 * 60, timezone: NY }),
    });

    const { body } = await callJson<{ meetings: Meeting[] }>('/api/meetings', { cookie });
    expect(body.meetings.length).toBeGreaterThan(20);
    for (const meeting of body.meetings) {
      const p = partsInZone(meeting.starts_at, NY);
      const dow = new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();
      expect(dow).toBe(6);
    }
  });

  it('is idempotent: re-expanding creates nothing and skips everything', async () => {
    const cookie = await signUpCoach(4203);
    const created = await callJson<{ series: { id: string }; created: number }>(
      '/api/series',
      {
        method: 'POST',
        cookie,
        body: JSON.stringify({ days_of_week: [3], start_minute: 18 * 60, timezone: NY }),
      },
    );

    const again = await callJson<{ created: number; skipped: number }>(
      `/api/series/${created.body.series.id}/expand`,
      { method: 'POST', cookie },
    );
    expect(again.body.created).toBe(0);
    expect(again.body.skipped).toBe(created.body.created);

    const list = await callJson<{ meetings: Meeting[] }>('/api/meetings', { cookie });
    expect(list.body.meetings.length).toBe(created.body.created);
  });

  it('refuses a rule with no days rather than writing nothing quietly', async () => {
    const cookie = await signUpCoach(4204);
    const { status, body } = await callJson<{ error: string }>('/api/series', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ days_of_week: [], start_minute: 600, timezone: NY }),
    });
    expect(status).toBe(400);
    expect(body.error).toBe('no_days_selected');
  });

  it('rejects an out-of-range start minute and an unknown timezone', async () => {
    const cookie = await signUpCoach(4205);
    const bad = [
      [{ days_of_week: [1], start_minute: 2000, timezone: NY }, 'invalid_start_minute'],
      [
        { days_of_week: [1], start_minute: 600, timezone: 'Middle/Earth' },
        'invalid_timezone',
      ],
    ] as const;

    for (const [payload, expected] of bad) {
      const { status, body } = await callJson<{ error: string }>('/api/series', {
        method: 'POST',
        cookie,
        body: JSON.stringify(payload),
      });
      expect(status).toBe(400);
      expect(body.error).toBe(expected);
    }
  });

  it('caps runaway expansion instead of hanging', async () => {
    const cookie = await signUpCoach(4206);
    // Every day of the week, for a whole season, is past the 200 cap.
    const { status, body } = await callJson<{ error: string; max: number }>('/api/series', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        days_of_week: [0, 1, 2, 3, 4, 5, 6],
        start_minute: 18 * 60,
        timezone: NY,
      }),
    });
    expect(status).toBe(400);
    expect(body.error).toBe('too_many_occurrences');
    expect(body.max).toBe(200);

    // And nothing was written on the way to refusing.
    const list = await callJson<{ meetings: Meeting[] }>('/api/meetings', { cookie });
    expect(list.body.meetings).toHaveLength(0);
  });

  it('schedules preseason meetings, and still lists them', async () => {
    // The reported bug: the app refused any date before the season's own first
    // day, which for a Sept 1 UTC season reads as "8/31/2026 or later" in the
    // Americas. Teams meet through the summer, so August has to work — and the
    // nastier half was that the list defaulted its range to the season window,
    // so a preseason meeting would have been created and then invisible.
    const cookie = await signUpCoach(4700);
    const season = await callJson<{ starts_at: number }>('/api/season/current', {
      cookie,
    });

    // Three weeks before the season row begins.
    const preseason = season.body.starts_at - 21 * 86400;
    const meeting = await createMeeting(cookie, {
      starts_at: preseason,
      title: 'Summer build session',
    });
    expect(meeting.starts_at).toBe(preseason);

    const { body } = await callJson<{ meetings: Meeting[] }>('/api/meetings', {
      cookie,
    });
    expect(body.meetings.map((m) => m.id)).toContain(meeting.id);
  });

  it('lets a series begin in preseason but not outlive the season', async () => {
    const cookie = await signUpCoach(4701);
    const created = await callJson<{ created: number }>('/api/series', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        days_of_week: [2],
        start_minute: 18 * 60,
        timezone: NY,
        // Well before the season, and well after it.
        starts_on: 19800101,
        until: 20991231,
      }),
    });
    expect(created.status).toBe(201);

    const season = await callJson<{ starts_at: number; ends_at: number }>(
      '/api/season/current',
      { cookie },
    );
    const { body } = await callJson<{ meetings: Meeting[] }>('/api/meetings', {
      cookie,
    });

    const earliest = Math.min(...body.meetings.map((m) => m.starts_at));
    const latest = Math.max(...body.meetings.map((m) => m.starts_at));

    // Pulled forward only to the day after the previous season ended, which is
    // months BEFORE the season's own first day — the whole point of the fix.
    expect(earliest).toBeLessThan(season.body.starts_at);
    // And still capped at the end of this season rather than running forever.
    expect(latest).toBeLessThan(season.body.ends_at + 86400);
  });

  it('clamps the series end into the season rather than escaping it', async () => {
    const cookie = await signUpCoach(4207);
    await callJson('/api/series', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        days_of_week: [2],
        start_minute: 18 * 60,
        timezone: NY,
        starts_on: 19800101,
        until: 20991231,
      }),
    });

    const season = await callJson<{ starts_at: number; ends_at: number }>(
      '/api/season/current',
      { cookie },
    );
    const { body } = await callJson<{ meetings: Meeting[] }>('/api/meetings', { cookie });

    expect(body.meetings.length).toBeGreaterThan(0);

    // The floor is the day after the PREVIOUS season ended, not this season's
    // first day — preseason is legitimate, so this deliberately does not assert
    // `>= season.starts_at`. A year and a day before the end is the bound.
    const floor = season.body.ends_at - 366 * 86400;
    for (const meeting of body.meetings) {
      expect(meeting.starts_at).toBeGreaterThan(floor);
      // ends_at is 23:59:59 UTC on May 31, which is 7:59pm Eastern — an evening
      // meeting on the season's last day is legitimately after it. Comparing
      // local dates is what makes that not a bug.
      expect(meeting.starts_at).toBeLessThan(season.body.ends_at + 86400);
    }
  });
});

describe('series edits apply to the future only', () => {
  it('moves empty future occurrences and never touches ones with content', async () => {
    const cookie = await signUpCoach(4300);
    const created = await callJson<{ series: { id: string }; created: number }>(
      '/api/series',
      {
        method: 'POST',
        cookie,
        body: JSON.stringify({ days_of_week: [2], start_minute: 18 * 60, timezone: NY }),
      },
    );
    const seriesId = created.body.series.id;

    const before = await callJson<{ meetings: Meeting[] }>('/api/meetings', { cookie });
    const future = before.body.meetings.filter((m) => m.starts_at > Date.now() / 1000);

    // Give one future occurrence content, and detach another by hand.
    const withContent = future[1];
    const detached = future[2];

    // Seeded straight into D1 because the blocks API is phase 2. Using the real
    // route would be better and will replace this then; what must not happen is
    // skipping the case, because "somebody typed notes into next Tuesday before
    // the schedule changed" is exactly the data this policy exists to protect.
    const team = await whoami(cookie);
    await env.DB.prepare(
      `INSERT INTO meeting_note_blocks
         (id, team_id, meeting_id, position, kind, text, created_at, updated_at)
       VALUES (?, ?, ?, 1024, 'paragraph', 'Typed this early', 0, 0)`,
    )
      .bind(crypto.randomUUID(), team.team_id, withContent.id)
      .run();

    await callJson(`/api/meetings/${detached.id}`, {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ location: 'Moved by hand' }),
    });

    const patched = await callJson<{
      created: number;
      updated: number;
      cancelled: number;
      deleted: number;
    }>(`/api/series/${seriesId}?apply=future_only`, {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ days_of_week: [3] }), // Tuesdays -> Wednesdays
    });

    expect(patched.status).toBe(200);
    expect(patched.body.created).toBeGreaterThan(0);
    // Empty Tuesdays disappear; the one with notes on it does not.
    expect(patched.body.deleted).toBeGreaterThan(0);
    expect(patched.body.cancelled).toBe(1);

    const after = await callJson<{ meetings: Meeting[] }>('/api/meetings', { cookie });
    const stillThere = new Map(after.body.meetings.map((m) => [m.id, m]));

    // The hand-moved one survives untouched: an explicit decision about one
    // evening outranks the rule that generated it.
    expect(stillThere.get(detached.id)?.location).toBe('Moved by hand');
    expect(stillThere.get(detached.id)?.status).toBe('planned');

    // The one somebody had already typed into survives as cancelled rather than
    // being deleted. Moving Tuesdays to Wednesdays must never destroy notes.
    expect(stillThere.get(withContent.id)?.status).toBe('cancelled');
    const keptBlocks = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM meeting_note_blocks WHERE meeting_id = ?',
    )
      .bind(withContent.id)
      .first<{ n: number }>();
    expect(keptBlocks?.n).toBe(1);

    // Past occurrences are never rewritten.
    const past = before.body.meetings.filter((m) => m.starts_at <= Date.now() / 1000);
    for (const meeting of past) {
      const now = stillThere.get(meeting.id);
      expect(now?.starts_at).toBe(meeting.starts_at);
    }
  });

  it('refuses to rewrite the past', async () => {
    const cookie = await signUpCoach(4301);
    const created = await callJson<{ series: { id: string } }>('/api/series', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ days_of_week: [2], start_minute: 18 * 60, timezone: NY }),
    });

    const { status, body } = await callJson<{ error: string }>(
      `/api/series/${created.body.series.id}?apply=all`,
      { method: 'PATCH', cookie, body: JSON.stringify({ days_of_week: [3] }) },
    );
    expect(status).toBe(400);
    expect(body.error).toBe('unsupported_apply_scope');
  });
});

describe('permissions', () => {
  it('lets coaches and mentors schedule, and refuses students and viewers', async () => {
    const coach = await signUpCoach(4400);
    const start = (await seasonStart(coach)) + 7 * 86400;

    const mentor = await inviteAndAccept(coach, { role: 'mentor', handle: 'mentor1' });
    const student = await inviteAndAccept(coach, { role: 'student', handle: 'student1' });
    const viewer = await inviteAndAccept(coach, { role: 'viewer', handle: 'viewer1' });

    expect(
      (
        await call('/api/meetings', {
          method: 'POST',
          cookie: mentor.cookie,
          body: JSON.stringify({ starts_at: start }),
        })
      ).status,
    ).toBe(201);

    for (const who of [student, viewer]) {
      const response = await call('/api/meetings', {
        method: 'POST',
        cookie: who.cookie,
        body: JSON.stringify({ starts_at: start }),
      });
      expect(response.status).toBe(403);
    }
  });

  it('lets everyone on the team read the schedule, including viewers', async () => {
    const coach = await signUpCoach(4401);
    await createMeeting(coach, { starts_at: (await seasonStart(coach)) + 7 * 86400 });
    const viewer = await inviteAndAccept(coach, { role: 'viewer', handle: 'viewer2' });

    const { status, body } = await callJson<{ meetings: Meeting[] }>('/api/meetings', {
      cookie: viewer.cookie,
    });
    expect(status).toBe(200);
    expect(body.meetings).toHaveLength(1);
  });

  it('reserves deleting a meeting for the coach', async () => {
    const coach = await signUpCoach(4402);
    const mentor = await inviteAndAccept(coach, { role: 'mentor', handle: 'mentor2' });
    const meeting = await createMeeting(coach, {
      starts_at: (await seasonStart(coach)) + 7 * 86400,
    });

    expect(
      (await call(`/api/meetings/${meeting.id}`, { method: 'DELETE', cookie: mentor.cookie }))
        .status,
    ).toBe(403);
    expect(
      (await call(`/api/meetings/${meeting.id}`, { method: 'DELETE', cookie: coach }))
        .status,
    ).toBe(200);
  });

  it('rejects a write with no session at all', async () => {
    const response = await call('/api/meetings', {
      method: 'POST',
      body: JSON.stringify({ starts_at: 0 }),
    });
    expect(response.status).toBe(401);
  });
});

/**
 * The block this codebase requires of every tenant-scoped feature, modelled on
 * the one in auth.test.ts. A cross-team read is the one bug that cannot ship,
 * so these assertions check the database directly rather than trusting an API
 * response to tell the truth about what it did or did not write.
 */
describe('tenancy isolation', () => {
  it('never lets one team see, read or alter another team\'s meetings', async () => {
    const alpha = await signUpCoach(4500);
    const beta = await signUpCoach(4501);

    const betaMeeting = await createMeeting(beta, {
      starts_at: (await seasonStart(beta)) + 7 * 86400,
      title: 'BETA-ONLY-MARKER',
      location: 'BETA-LOCATION',
    });

    // 1. The list never contains the other team's data.
    const alphaList = await call('/api/meetings', { cookie: alpha });
    expect(await alphaList.text()).not.toContain('BETA-ONLY-MARKER');

    // 2. Naming another team's id is a 404, not a 403. A 403 would confirm the
    //    row exists somewhere, which is the same leak arriving more slowly.
    const read = await call(`/api/meetings/${betaMeeting.id}`, { cookie: alpha });
    expect(read.status).toBe(404);

    // 3. A cross-tenant write is refused AND the row is byte-identical
    //    afterwards. Read straight from D1: the API saying "not found" and the
    //    UPDATE having silently matched zero rows look the same from outside,
    //    but only one of them is safe.
    const patch = await call(`/api/meetings/${betaMeeting.id}`, {
      method: 'PATCH',
      cookie: alpha,
      body: JSON.stringify({ title: 'ALPHA WAS HERE', location: 'ALPHA' }),
    });
    expect(patch.status).toBe(404);

    const row = await env.DB.prepare(
      'SELECT title, location, status FROM meetings WHERE id = ?',
    )
      .bind(betaMeeting.id)
      .first<{ title: string; location: string; status: string }>();
    expect(row?.title).toBe('BETA-ONLY-MARKER');
    expect(row?.location).toBe('BETA-LOCATION');

    // 4. Cancel and delete are the destructive pair, and neither may cross.
    expect(
      (await call(`/api/meetings/${betaMeeting.id}/cancel`, { method: 'POST', cookie: alpha }))
        .status,
    ).toBe(404);
    expect(
      (await call(`/api/meetings/${betaMeeting.id}`, { method: 'DELETE', cookie: alpha }))
        .status,
    ).toBe(404);

    const survives = await env.DB.prepare('SELECT status FROM meetings WHERE id = ?')
      .bind(betaMeeting.id)
      .first<{ status: string }>();
    expect(survives?.status).toBe('planned');
  });

  it('never lets one team expand or edit another team\'s series', async () => {
    const alpha = await signUpCoach(4502);
    const beta = await signUpCoach(4503);

    const betaSeries = await callJson<{ series: { id: string }; created: number }>(
      '/api/series',
      {
        method: 'POST',
        cookie: beta,
        body: JSON.stringify({
          title: 'BETA-SERIES-MARKER',
          days_of_week: [2],
          start_minute: 18 * 60,
          timezone: NY,
        }),
      },
    );
    const seriesId = betaSeries.body.series.id;

    const alphaSeries = await call('/api/series', { cookie: alpha });
    expect(await alphaSeries.text()).not.toContain('BETA-SERIES-MARKER');

    expect(
      (await call(`/api/series/${seriesId}/expand`, { method: 'POST', cookie: alpha })).status,
    ).toBe(404);
    expect(
      (
        await call(`/api/series/${seriesId}`, {
          method: 'PATCH',
          cookie: alpha,
          body: JSON.stringify({ days_of_week: [5] }),
        })
      ).status,
    ).toBe(404);
    expect(
      (await call(`/api/series/${seriesId}`, { method: 'DELETE', cookie: alpha })).status,
    ).toBe(404);

    // Beta's season is exactly as it was.
    const count = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM meetings WHERE series_id = ?',
    )
      .bind(seriesId)
      .first<{ n: number }>();
    expect(count?.n).toBe(betaSeries.body.created);

    const rule = await env.DB.prepare(
      'SELECT days_of_week FROM meeting_series WHERE id = ?',
    )
      .bind(seriesId)
      .first<{ days_of_week: string }>();
    expect(rule?.days_of_week).toBe('[2]');
  });

  it('scopes the timezone change to the caller\'s own team', async () => {
    const alpha = await signUpCoach(4504);
    const beta = await signUpCoach(4505);

    await callJson('/api/team', {
      method: 'PATCH',
      cookie: alpha,
      body: JSON.stringify({ timezone: 'America/Los_Angeles' }),
    });

    const betaTeam = await callJson<{ timezone: string }>('/api/team', { cookie: beta });
    expect(betaTeam.body.timezone).toBe('America/New_York');
  });

  it('requires a session for every meetings route', async () => {
    const paths: [string, string][] = [
      ['GET', '/api/meetings'],
      ['POST', '/api/meetings'],
      ['GET', '/api/meetings/anything'],
      ['PATCH', '/api/meetings/anything'],
      ['DELETE', '/api/meetings/anything'],
      ['GET', '/api/series'],
      ['POST', '/api/series'],
    ];
    for (const [method, path] of paths) {
      const response = await call(path, {
        method,
        ...(method === 'GET' || method === 'DELETE'
          ? {}
          : { body: JSON.stringify({}) }),
      });
      expect(response.status, `${method} ${path}`).toBe(401);
    }
  });
});

describe('team timezone', () => {
  it('is coach-only and validated', async () => {
    const coach = await signUpCoach(4600);
    const mentor = await inviteAndAccept(coach, { role: 'mentor', handle: 'mentor3' });

    expect(
      (
        await call('/api/team', {
          method: 'PATCH',
          cookie: mentor.cookie,
          body: JSON.stringify({ timezone: 'UTC' }),
        })
      ).status,
    ).toBe(403);

    const bad = await callJson<{ error: string }>('/api/team', {
      method: 'PATCH',
      cookie: coach,
      body: JSON.stringify({ timezone: 'Middle/Earth' }),
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('invalid_timezone');

    const good = await callJson<{ timezone: string }>('/api/team', {
      method: 'PATCH',
      cookie: coach,
      body: JSON.stringify({ timezone: 'America/Chicago' }),
    });
    expect(good.body.timezone).toBe('America/Chicago');
  });

  it('defaults a new team to a plausible zone rather than UTC', async () => {
    const coach = await signUpCoach(4601);
    const { body } = await callJson<{ timezone: string }>('/api/team', { cookie: coach });
    expect(body.timezone).toBe('America/New_York');
  });
});
