/**
 * The data boundary.
 *
 * Every screen reads through this module and nothing else. Today the bodies
 * resolve from mock fixtures; in Phase 1 they become `fetch('/api/…')` calls
 * and no component changes. That is the whole reason this indirection exists —
 * without it, the mock data would be wired through JSX and the swap would mean
 * rewriting every screen.
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

export function getTeam(): Promise<Team> {
  return resolve(fixtures.team);
}

export function getCurrentSeason(): Promise<Season> {
  return resolve(fixtures.season);
}

export function listMembers(): Promise<Member[]> {
  return resolve(fixtures.members);
}

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
