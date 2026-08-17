/**
 * Recurring meeting series (COG-036, phase 1).
 *
 * A series is a rule; the meetings it describes are real rows, written up front
 * rather than expanded at read time. That choice is what lets a coach move or
 * cancel one Tuesday in November without the rule arguing with them, and it is
 * why every occurrence carries a `series_slot` — its local date, which survives
 * a reschedule and makes re-expansion an idempotent upsert.
 *
 * The rule itself is stored as parts (days, minutes past local midnight, a
 * timezone) and never as an epoch stride. See `lib/tz.ts` for the DST failure
 * that decision exists to prevent.
 */
import { Hono } from 'hono';
import { nowSeconds, uuid } from '../lib/crypto';
import { boundedInt, optionalString, readJson } from '../lib/http';
import {
  expandSeries,
  isMeetingKind,
  MAX_OCCURRENCES,
  normaliseDaysOfWeek,
  seasonSlots,
  type Occurrence,
} from '../lib/meetings';
import { isValidTimeZone } from '../lib/tz';
import {
  auth as authOf,
  requireMember,
  requireRole,
  sameOriginOnly,
  type AppEnv,
} from '../lib/tenancy';

const series = new Hono<AppEnv>();

const MIN_DURATION_MINUTES = 15;
const MAX_DURATION_MINUTES = 14 * 60;
/** D1 caps how much a single batch may carry; occurrences go in chunks. */
const BATCH_CHUNK = 50;

interface SeriesRow {
  id: string;
  team_id: string;
  season_id: string;
  title: string;
  kind: string;
  location: string | null;
  days_of_week: string;
  start_minute: number;
  duration_minutes: number;
  timezone: string;
  starts_on: number;
  until: number;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

const SERIES_COLUMNS = `id, team_id, season_id, title, kind, location, days_of_week,
        start_minute, duration_minutes, timezone, starts_on, until, created_by,
        created_at, updated_at`;

/** `days_of_week` is a json column; the client's type declares an array. */
function hydrate(row: SeriesRow): Record<string, unknown> {
  return { ...row, days_of_week: JSON.parse(row.days_of_week) as number[] };
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Write occurrences that do not already exist.
 *
 * `ON CONFLICT DO NOTHING` against `idx_meetings_series_slot` is what makes
 * this safe to run repeatedly: extending a series' end date, or retrying after
 * a failed request, adds only the missing dates. Returns how many rows actually
 * landed so the caller can report "created 8, skipped 54" rather than implying
 * it rewrote the season.
 */
async function materialise(
  db: D1Database,
  row: SeriesRow,
  occurrences: Occurrence[],
  memberId: string | null,
): Promise<number> {
  const now = nowSeconds();
  let created = 0;

  for (const group of chunk(occurrences, BATCH_CHUNK)) {
    const results = await db.batch(
      group.map((o) =>
        db
          .prepare(
            `INSERT INTO meetings
               (id, team_id, season_id, title, starts_at, ends_at, location, kind,
                status, series_id, series_slot, created_by, created_at, updated_at,
                agenda, notes, attendees)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?, ?, ?, ?, NULL, NULL, '[]')
             ON CONFLICT (team_id, series_id, series_slot) DO NOTHING`,
          )
          .bind(
            uuid(),
            row.team_id,
            row.season_id,
            row.title,
            o.startsAt,
            o.endsAt,
            row.location,
            row.kind,
            row.id,
            o.slot,
            memberId,
            now,
            now,
          ),
      ),
    );
    for (const r of results) created += r.meta.changes ?? 0;
  }

  return created;
}

/**
 * Read and validate a rule from a request body.
 *
 * Returns either the validated parts or an error code, so the caller decides
 * the status. Every bound is checked here rather than at the database, because
 * a CHECK constraint cannot say *which* field a coach got wrong.
 */
interface RuleInput {
  title: string;
  kind: string;
  location: string | null;
  daysOfWeek: number[];
  startMinute: number;
  durationMinutes: number;
  timezone: string;
  startsOn: number;
  until: number;
}

function readRule(
  body: Record<string, unknown>,
  defaults: {
    timezone: string;
    seasonFirst: number;
    seasonLast: number;
    existing?: SeriesRow;
  },
): { rule: RuleInput } | { error: string } {
  const existing = defaults.existing;

  const daysRaw =
    body.days_of_week === undefined && existing
      ? (JSON.parse(existing.days_of_week) as number[])
      : body.days_of_week;
  const daysOfWeek = normaliseDaysOfWeek(daysRaw);
  if (daysOfWeek === null) return { error: 'invalid_days_of_week' };
  if (daysOfWeek.length === 0) return { error: 'no_days_selected' };

  const startMinute =
    body.start_minute === undefined && existing
      ? existing.start_minute
      : boundedInt(body.start_minute, 0, 1439);
  if (startMinute === null) return { error: 'invalid_start_minute' };

  const durationMinutes =
    body.duration_minutes === undefined
      ? (existing?.duration_minutes ?? 120)
      : boundedInt(body.duration_minutes, MIN_DURATION_MINUTES, MAX_DURATION_MINUTES);
  if (durationMinutes === null) return { error: 'invalid_duration' };

  const timezone =
    body.timezone === undefined
      ? (existing?.timezone ?? defaults.timezone)
      : body.timezone;
  if (!isValidTimeZone(timezone)) return { error: 'invalid_timezone' };

  const kind = body.kind === undefined ? (existing?.kind ?? 'build') : body.kind;
  if (!isMeetingKind(kind)) return { error: 'invalid_kind' };

  const title =
    optionalString(body.title, 200) ?? existing?.title ?? 'Team meeting';
  const location =
    body.location === undefined
      ? (existing?.location ?? null)
      : optionalString(body.location, 200);

  // Bounds are local-date slots, and both ends are clamped into the season.
  // Clamping here is what makes the portfolio's "current-season work only" rule
  // true by construction rather than by a filter somebody might forget.
  const requestedStart =
    body.starts_on === undefined
      ? (existing?.starts_on ?? defaults.seasonFirst)
      : boundedInt(body.starts_on, 19700101, 21000101);
  if (requestedStart === null) return { error: 'invalid_starts_on' };

  const requestedUntil =
    body.until === undefined
      ? (existing?.until ?? defaults.seasonLast)
      : boundedInt(body.until, 19700101, 21000101);
  if (requestedUntil === null) return { error: 'invalid_until' };

  const startsOn = Math.max(requestedStart, defaults.seasonFirst);
  const until = Math.min(requestedUntil, defaults.seasonLast);
  if (startsOn > until) return { error: 'invalid_date_range' };

  return {
    rule: {
      title,
      kind,
      location,
      daysOfWeek,
      startMinute,
      durationMinutes,
      timezone,
      startsOn,
      until,
    },
  };
}

async function seasonContext(
  db: D1Database,
  teamId: string,
): Promise<{ season: { id: string; starts_at: number; ends_at: number }; timezone: string } | null> {
  const season = await db
    .prepare(
      `SELECT id, starts_at, ends_at FROM seasons WHERE team_id = ? AND is_current = 1`,
    )
    .bind(teamId)
    .first<{ id: string; starts_at: number; ends_at: number }>();
  if (!season) return null;
  const team = await db
    .prepare('SELECT timezone FROM teams WHERE id = ?')
    .bind(teamId)
    .first<{ timezone: string }>();
  return { season, timezone: team?.timezone ?? 'America/New_York' };
}

// -------------------------------------------------------------------- create

series.post(
  '/',
  sameOriginOnly,
  requireMember,
  requireRole('coach', 'mentor'),
  async (c) => {
    const body = await readJson(c);
    if (!body) return c.json({ error: 'invalid_body' }, 400);

    const { teamId, member } = authOf(c);
    const ctx = await seasonContext(c.env.DB, teamId);
    if (!ctx) return c.json({ error: 'no_current_season' }, 409);

    const bounds = seasonSlots(ctx.season.starts_at, ctx.season.ends_at, ctx.timezone);
    const parsed = readRule(body, {
      timezone: ctx.timezone,
      seasonFirst: bounds.first,
      seasonLast: bounds.last,
    });
    if ('error' in parsed) return c.json({ error: parsed.error }, 400);
    const rule = parsed.rule;

    const { occurrences, exceeded } = expandSeries({
      daysOfWeek: rule.daysOfWeek,
      startMinute: rule.startMinute,
      durationMinutes: rule.durationMinutes,
      timezone: rule.timezone,
      startsOn: rule.startsOn,
      until: rule.until,
    });
    if (exceeded) {
      return c.json({ error: 'too_many_occurrences', max: MAX_OCCURRENCES }, 400);
    }
    if (occurrences.length === 0) {
      return c.json({ error: 'no_occurrences_in_range' }, 400);
    }

    const now = nowSeconds();
    const row: SeriesRow = {
      id: uuid(),
      team_id: teamId,
      season_id: ctx.season.id,
      title: rule.title,
      kind: rule.kind,
      location: rule.location,
      days_of_week: JSON.stringify(rule.daysOfWeek),
      start_minute: rule.startMinute,
      duration_minutes: rule.durationMinutes,
      timezone: rule.timezone,
      starts_on: rule.startsOn,
      until: rule.until,
      created_by: member.id,
      created_at: now,
      updated_at: now,
    };

    await c.env.DB.prepare(
      `INSERT INTO meeting_series
         (${SERIES_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        row.id,
        row.team_id,
        row.season_id,
        row.title,
        row.kind,
        row.location,
        row.days_of_week,
        row.start_minute,
        row.duration_minutes,
        row.timezone,
        row.starts_on,
        row.until,
        row.created_by,
        row.created_at,
        row.updated_at,
      )
      .run();

    const created = await materialise(c.env.DB, row, occurrences, member.id);

    return c.json(
      {
        series: hydrate(row),
        created,
        skipped: occurrences.length - created,
        first_starts_at: occurrences[0].startsAt,
        last_starts_at: occurrences[occurrences.length - 1].startsAt,
      },
      201,
    );
  },
);

// --------------------------------------------------------------------- list

series.get('/', requireMember, async (c) => {
  const { teamId } = authOf(c);
  const { results } = await c.env.DB.prepare(
    `SELECT ${SERIES_COLUMNS},
            (SELECT COUNT(*) FROM meetings m
              WHERE m.team_id = meeting_series.team_id
                AND m.series_id = meeting_series.id) AS occurrence_count
       FROM meeting_series
      WHERE team_id = ?
      ORDER BY created_at DESC`,
  )
    .bind(teamId)
    .all<SeriesRow & { occurrence_count: number }>();

  return c.json({
    series: results.map((r) => ({
      ...hydrate(r),
      occurrence_count: r.occurrence_count,
    })),
  });
});

// ------------------------------------------------------------------- expand

/**
 * Re-run expansion. Idempotent by construction, so this is the safe way to
 * apply an extended `until` or recover from a partially written create.
 */
series.post(
  '/:id/expand',
  sameOriginOnly,
  requireMember,
  requireRole('coach', 'mentor'),
  async (c) => {
    const { teamId, member } = authOf(c);
    const row = await c.env.DB.prepare(
      `SELECT ${SERIES_COLUMNS} FROM meeting_series WHERE id = ? AND team_id = ?`,
    )
      .bind(c.req.param('id'), teamId)
      .first<SeriesRow>();
    if (!row) return c.json({ error: 'not_found' }, 404);

    const { occurrences, exceeded } = expandSeries({
      daysOfWeek: JSON.parse(row.days_of_week) as number[],
      startMinute: row.start_minute,
      durationMinutes: row.duration_minutes,
      timezone: row.timezone,
      startsOn: row.starts_on,
      until: row.until,
    });
    if (exceeded) {
      return c.json({ error: 'too_many_occurrences', max: MAX_OCCURRENCES }, 400);
    }

    const created = await materialise(c.env.DB, row, occurrences, member.id);
    return c.json({ created, skipped: occurrences.length - created });
  },
);

// ------------------------------------------------------------------- update

/**
 * Edit the rule, applying to future occurrences only.
 *
 * `apply=all` is refused rather than implemented. Rewriting the start times of
 * meetings that already happened corrupts the season record — the notes taken
 * that evening stop matching the time on the meeting they belong to — and no
 * coach wants it badly enough to justify that.
 *
 * Four kinds of occurrence are never touched, and the list is the whole policy:
 * anything in the past, anything already `held`, anything `detached` (a human
 * made a specific decision about that evening), and anything already cancelled.
 * Of what remains, empty planned meetings are deleted and meetings that have
 * content survive as cancelled — so moving Tuesdays to Wednesdays can never
 * destroy notes somebody typed early.
 */
series.patch(
  '/:id',
  sameOriginOnly,
  requireMember,
  requireRole('coach', 'mentor'),
  async (c) => {
    const url = new URL(c.req.url);
    const apply = url.searchParams.get('apply') ?? 'future_only';
    if (apply !== 'future_only') {
      return c.json({ error: 'unsupported_apply_scope', supported: ['future_only'] }, 400);
    }

    const body = await readJson(c);
    if (!body) return c.json({ error: 'invalid_body' }, 400);

    const { teamId, member } = authOf(c);
    const id = c.req.param('id');

    const existing = await c.env.DB.prepare(
      `SELECT ${SERIES_COLUMNS} FROM meeting_series WHERE id = ? AND team_id = ?`,
    )
      .bind(id, teamId)
      .first<SeriesRow>();
    if (!existing) return c.json({ error: 'not_found' }, 404);

    const ctx = await seasonContext(c.env.DB, teamId);
    if (!ctx) return c.json({ error: 'no_current_season' }, 409);
    const bounds = seasonSlots(ctx.season.starts_at, ctx.season.ends_at, ctx.timezone);

    const parsed = readRule(body, {
      timezone: ctx.timezone,
      seasonFirst: bounds.first,
      seasonLast: bounds.last,
      existing,
    });
    if ('error' in parsed) return c.json({ error: parsed.error }, 400);
    const rule = parsed.rule;

    const { occurrences, exceeded } = expandSeries({
      daysOfWeek: rule.daysOfWeek,
      startMinute: rule.startMinute,
      durationMinutes: rule.durationMinutes,
      timezone: rule.timezone,
      startsOn: rule.startsOn,
      until: rule.until,
    });
    if (exceeded) {
      return c.json({ error: 'too_many_occurrences', max: MAX_OCCURRENCES }, 400);
    }

    const now = nowSeconds();
    const wantedSlots = new Set(occurrences.map((o) => o.slot));

    // Only occurrences that are still genuinely "the rule's to manage".
    const { results: mutable } = await c.env.DB.prepare(
      `SELECT m.id, m.series_slot,
              (SELECT COUNT(*) FROM meeting_note_blocks b
                WHERE b.team_id = m.team_id AND b.meeting_id = m.id
                  AND b.deleted_at IS NULL) AS blocks,
              (SELECT COUNT(*) FROM meeting_attendance a
                WHERE a.team_id = m.team_id AND a.meeting_id = m.id) AS attendance,
              (SELECT COUNT(*) FROM meeting_action_items ai
                WHERE ai.team_id = m.team_id AND ai.meeting_id = m.id) AS action_items
         FROM meetings m
        WHERE m.team_id = ? AND m.series_id = ?
          AND m.starts_at > ?
          AND m.status = 'planned'
          AND m.detached_at IS NULL`,
    )
      .bind(teamId, id, now)
      .all<{
        id: string;
        series_slot: number;
        blocks: number;
        attendance: number;
        action_items: number;
      }>();

    const statements: D1PreparedStatement[] = [];
    let cancelled = 0;
    let deleted = 0;

    for (const occurrence of mutable) {
      if (wantedSlots.has(occurrence.series_slot)) continue;
      const hasContent =
        occurrence.blocks > 0 || occurrence.attendance > 0 || occurrence.action_items > 0;
      if (hasContent) {
        statements.push(
          c.env.DB.prepare(
            `UPDATE meetings
                SET status = 'cancelled', cancel_reason = 'series_changed', updated_at = ?
              WHERE id = ? AND team_id = ?`,
          ).bind(now, occurrence.id, teamId),
        );
        cancelled++;
      } else {
        statements.push(
          c.env.DB.prepare('DELETE FROM meetings WHERE id = ? AND team_id = ?').bind(
            occurrence.id,
            teamId,
          ),
        );
        deleted++;
      }
    }

    // Surviving future occurrences take the rule's new title, place, kind and
    // clock. Matched by slot, so a moved-but-not-detached meeting is left where
    // the rule says it should be.
    const bySlot = new Map(occurrences.map((o) => [o.slot, o]));
    let updated = 0;
    for (const occurrence of mutable) {
      const wanted = bySlot.get(occurrence.series_slot);
      if (!wanted) continue;
      statements.push(
        c.env.DB.prepare(
          `UPDATE meetings
              SET title = ?, kind = ?, location = ?, starts_at = ?, ends_at = ?, updated_at = ?
            WHERE id = ? AND team_id = ?`,
        ).bind(
          rule.title,
          rule.kind,
          rule.location,
          wanted.startsAt,
          wanted.endsAt,
          now,
          occurrence.id,
          teamId,
        ),
      );
      updated++;
    }

    statements.push(
      c.env.DB.prepare(
        `UPDATE meeting_series
            SET title = ?, kind = ?, location = ?, days_of_week = ?, start_minute = ?,
                duration_minutes = ?, timezone = ?, starts_on = ?, until = ?, updated_at = ?
          WHERE id = ? AND team_id = ?`,
      ).bind(
        rule.title,
        rule.kind,
        rule.location,
        JSON.stringify(rule.daysOfWeek),
        rule.startMinute,
        rule.durationMinutes,
        rule.timezone,
        rule.startsOn,
        rule.until,
        now,
        id,
        teamId,
      ),
    );

    for (const group of chunk(statements, BATCH_CHUNK)) {
      await c.env.DB.batch(group);
    }

    // Fills in slots the new rule wants that do not exist yet. Slots that are
    // already there — surviving, held, cancelled or detached — hit the upsert's
    // DO NOTHING, which is precisely how a by-hand cancellation stays cancelled
    // through a series edit.
    const created = await materialise(
      c.env.DB,
      {
        ...existing,
        title: rule.title,
        kind: rule.kind,
        location: rule.location,
        days_of_week: JSON.stringify(rule.daysOfWeek),
        start_minute: rule.startMinute,
        duration_minutes: rule.durationMinutes,
        timezone: rule.timezone,
        starts_on: rule.startsOn,
        until: rule.until,
      },
      occurrences,
      member.id,
    );

    const fresh = await c.env.DB.prepare(
      `SELECT ${SERIES_COLUMNS} FROM meeting_series WHERE id = ? AND team_id = ?`,
    )
      .bind(id, teamId)
      .first<SeriesRow>();

    return c.json({
      series: fresh ? hydrate(fresh) : null,
      created,
      updated,
      cancelled,
      deleted,
    });
  },
);

// ------------------------------------------------------------------- delete

/**
 * Drop the rule. Occurrences with content survive it.
 *
 * `series_id` is SET NULL on those rather than cascading, following the
 * schema's CASCADE-for-ownership / SET-NULL-for-attribution convention: the
 * series is where a meeting came from, not what it belongs to.
 */
series.delete(
  '/:id',
  sameOriginOnly,
  requireMember,
  requireRole('coach'),
  async (c) => {
    const { teamId } = authOf(c);
    const id = c.req.param('id');
    const now = nowSeconds();

    const row = await c.env.DB.prepare(
      'SELECT id FROM meeting_series WHERE id = ? AND team_id = ?',
    )
      .bind(id, teamId)
      .first();
    if (!row) return c.json({ error: 'not_found' }, 404);

    const empties = await c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM meetings m
        WHERE m.team_id = ? AND m.series_id = ? AND m.starts_at > ?
          AND m.status = 'planned' AND m.detached_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM meeting_note_blocks b
                           WHERE b.team_id = m.team_id AND b.meeting_id = m.id
                             AND b.deleted_at IS NULL)
          AND NOT EXISTS (SELECT 1 FROM meeting_attendance a
                           WHERE a.team_id = m.team_id AND a.meeting_id = m.id)
          AND NOT EXISTS (SELECT 1 FROM meeting_action_items ai
                           WHERE ai.team_id = m.team_id AND ai.meeting_id = m.id)`,
    )
      .bind(teamId, id, now)
      .first<{ n: number }>();

    await c.env.DB.batch([
      c.env.DB.prepare(
        `DELETE FROM meetings
          WHERE team_id = ? AND series_id = ? AND starts_at > ?
            AND status = 'planned' AND detached_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM meeting_note_blocks b
                             WHERE b.team_id = meetings.team_id AND b.meeting_id = meetings.id
                               AND b.deleted_at IS NULL)
            AND NOT EXISTS (SELECT 1 FROM meeting_attendance a
                             WHERE a.team_id = meetings.team_id AND a.meeting_id = meetings.id)
            AND NOT EXISTS (SELECT 1 FROM meeting_action_items ai
                             WHERE ai.team_id = meetings.team_id AND ai.meeting_id = meetings.id)`,
      ).bind(teamId, id, now),
      // The rest keep their notes and lose only their provenance.
      c.env.DB.prepare(
        'UPDATE meetings SET series_id = NULL, updated_at = ? WHERE team_id = ? AND series_id = ?',
      ).bind(now, teamId, id),
      c.env.DB.prepare('DELETE FROM meeting_series WHERE id = ? AND team_id = ?').bind(
        id,
        teamId,
      ),
    ]);

    return c.json({ ok: true, deleted: empties?.n ?? 0 });
  },
);

export { series };
