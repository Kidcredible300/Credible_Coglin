/**
 * The data boundary.
 *
 * Every screen reads through this module and nothing else. The indirection paid
 * for itself in COG-006: team, season and roster moved from fixtures to real
 * `/api` calls below without a single component changing.
 *
 * The rest are still fixtures. Which is which is not cosmetic — a coach must
 * never mistake demo data for their team's, so anything still mocked is marked
 * `MOCK` here and shown as provisional in the UI.
 *
 *   REAL   getTeam, getCurrentSeason, listMembers
 *   MOCK   boards, tasks, outreach, calendar, meetings, award criteria
 *
 * Note there is no `team_id` parameter anywhere. The server derives the tenant
 * from the session's membership row (plan §6); a client that can name its own
 * team_id is a tenancy bug waiting to happen, so the shape of this API refuses
 * to offer one.
 */
import * as fixtures from './mock/fixtures';
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
  const response = await fetch(path, { credentials: 'same-origin' });
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
// Everything below still resolves from fixtures. Each becomes a `get()` call
// as its feature lands (COG-011 boards, COG-014 outreach, COG-013 awards).
// --------------------------------------------------------------------------

export function listBoards(): Promise<Board[]> {
  return resolve(fixtures.boards);
}

export function listTasks(boardId?: string): Promise<Task[]> {
  const all = fixtures.tasks;
  return resolve(boardId ? all.filter((t) => t.board_id === boardId) : all);
}

export function listOutreach(): Promise<OutreachEvent[]> {
  return resolve(
    [...fixtures.outreach].sort((a, b) => b.occurred_at - a.occurred_at),
  );
}

export function listCalendar(): Promise<CalendarEvent[]> {
  return resolve(
    [...fixtures.calendar].sort((a, b) => a.starts_at - b.starts_at),
  );
}

export function listMeetings(): Promise<Meeting[]> {
  return resolve(fixtures.meetings);
}

export function listAwardCriteria(): Promise<AwardCriterion[]> {
  return resolve(fixtures.awardCriteria);
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

/** Server-authoritative "now" stand-in. Mock data is pinned to a fixed date. */
export function now(): number {
  return fixtures.MOCK_NOW;
}
