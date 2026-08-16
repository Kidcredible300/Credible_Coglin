/**
 * The data boundary.
 *
 * Every screen reads through this module and nothing else. The indirection paid
 * for itself in COG-006: team, season and roster moved from fixtures to real
 * `/api` calls below without a single component changing.
 *
 * Features that have not landed yet return **empty**, not sample data. A real
 * team signing up gets a blank canvas: a dashboard that invents 23 outreach
 * hours and 655 people reached is worse than one showing zero, because zero is
 * true and a coach can act on it. A banner saying "sample data" does not fix
 * that — the numbers still read as theirs at a glance, and the whole product is
 * asking to be trusted with a season that cannot be reconstructed.
 *
 *   REAL   getTeam, getCurrentSeason, listMembers
 *   EMPTY  boards, tasks, outreach, calendar, meetings, award criteria
 *
 * There is no demo-data mode and no `mock/fixtures` import, deliberately. The
 * first attempt kept the fixtures behind a build-time flag on the assumption
 * that dead-branch elimination would strip them; it did not. That module builds
 * its arrays through top-level calls, so Rollup cannot prove it side-effect
 * free and bundled the sample season anyway — a flag away from a real team's
 * dashboard. The only version of this that is actually safe is not importing
 * it. Verify with `npm run build && grep -r "Chesapeake" dist/`.
 *
 *   VITE_DEMO_DATA=1 npm run dev
 *
 * Note there is no `team_id` parameter anywhere. The server derives the tenant
 * from the session's membership row (plan §6); a client that can name its own
 * team_id is a tenancy bug waiting to happen, so the shape of this API refuses
 * to offer one.
 */
import type {
  AwardCriterion,
  Board,
  BoardOp,
  CalendarEvent,
  Meeting,
  Member,
  OutreachEvent,
  Season,
  Task,
  Team,
} from '@/types';

/** Small delay so loading states are real and get designed, not skipped. */
const LATENCY_MS = 180;

function resolve<T>(value: T): Promise<T> {
  return new Promise((r) => setTimeout(() => r(structuredClone(value)), LATENCY_MS));
}


/**
 * Thrown on a 401 so the shell can send the visitor back to the login screen
 * rather than rendering an error state at someone whose session simply aged
 * out. A 30-day sliding session makes this rare, but "rare" over a nine-month
 * season is still every user eventually.
 */
export class Unauthenticated extends Error {
  constructor() {
    super('unauthenticated');
    this.name = 'Unauthenticated';
  }
}

/**
 * Broadcast rather than redirect from here.
 *
 * A 401 can surface in any screen's data call, and the data layer has no
 * router. Firing an event lets SessionProvider — which owns the answer to "is
 * anyone signed in" — flip to anonymous, and the existing route gate does the
 * navigating. One place decides, and this module stays free of routing.
 */
export const SESSION_EXPIRED = 'coglin:session-expired';

function signalExpired(): void {
  window.dispatchEvent(new Event(SESSION_EXPIRED));
}

async function get<T>(path: string): Promise<T> {
  // no-store for the same reason as fetchSession: a cached 401 anywhere in this
  // path trips the session-expired signal and logs the user out of a session
  // that is still perfectly valid.
  const response = await fetch(path, {
    credentials: 'same-origin',
    cache: 'no-store',
  });
  if (response.status === 401) {
    signalExpired();
    throw new Unauthenticated();
  }
  if (!response.ok) throw new Error(`${path} failed: ${response.status}`);
  return (await response.json()) as T;
}

export function getTeam(): Promise<Team> {
  return get<Team>('/api/team');
}

export function getCurrentSeason(): Promise<Season> {
  return get<Season>('/api/season/current');
}

export function listMembers(): Promise<Member[]> {
  return get<Member[]>('/api/members');
}

export interface InviteResult {
  ok: true;
  /** False when the mail failed; the link below is then the only way through. */
  sent: boolean;
  url: string;
  expires_at: number;
}

/**
 * Create an invite. `email` is passed to the server, mailed, and forgotten — it
 * is not persisted and not echoed back (see migrations/0002_invites.sql). The
 * returned `url` is what the coach can copy if the mail never lands.
 */
export async function createInvite(input: {
  email: string;
  display_name: string;
  role: 'mentor' | 'student' | 'viewer';
  sub_teams?: string[];
}): Promise<InviteResult> {
  const response = await fetch('/api/invites', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(input),
  });
  if (response.status === 401) {
    signalExpired();
    throw new Unauthenticated();
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? 'invite_failed');
  }
  return (await response.json()) as InviteResult;
}

// --------------------------------------------------------------------------
// Not built yet. Each returns nothing until its feature lands (COG-011 boards,
// COG-014 outreach, COG-013 awards, COG-016 calendar, COG-036 meetings), at
// which point the body becomes a `get()` call and the screens do not change.
// --------------------------------------------------------------------------

export function listBoards(): Promise<Board[]> {
  return resolve([]);
}

export function listTasks(boardId?: string): Promise<Task[]> {
  const all: Task[] = [];
  return resolve(boardId ? all.filter((t) => t.board_id === boardId) : all);
}

export function listOutreach(): Promise<OutreachEvent[]> {
  return resolve([]);
}

export function listCalendar(): Promise<CalendarEvent[]> {
  return resolve([]);
}

export function listMeetings(): Promise<Meeting[]> {
  return resolve([]);
}

export function listAwardCriteria(): Promise<AwardCriterion[]> {
  return resolve([]);
}

/**
 * Board mutation. Local-only for now, but it takes the same op shape the
 * server will accept at POST /api/boards/:id/mutate, so Phase 1 replaces the
 * body with a fetch and the Durable Object later replays this exact stream.
 */
export function mutateBoard(op: BoardOp): Promise<{ ok: true }> {
  void op;
  return Promise.resolve({ ok: true });
}

/**
 * Now, in epoch seconds.
 *
 * Real time, not the fixtures' pinned date — every "days until" and "overdue"
 * on screen is derived from this, and a hardcoded 2026 date made a live
 * dashboard confidently wrong about the season it was in. Demo mode keeps the
 * dashboard confidently wrong about the season it was in.
 */
export function now(): number {
  return Math.floor(Date.now() / 1000);
}
