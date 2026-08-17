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
 *   REAL   getTeam, getCurrentSeason, listMembers, meetings, series
 *   EMPTY  boards, tasks, outreach, calendar, award criteria
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
  AgendaItem,
  AttendanceRecord,
  AttendanceState,
  AwardCriterion,
  AwardKey,
  Board,
  BoardOp,
  BlockKind,
  CalendarEvent,
  CandidateSourceType,
  CandidateState,
  Meeting,
  NoteBlock,
  MeetingKind,
  MeetingSeries,
  MeetingStatus,
  MeetingSummary,
  Member,
  OutreachEvent,
  PortfolioCandidate,
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

/**
 * Every write goes through here.
 *
 * Extracted from `createInvite` when meetings brought the count of hand-rolled
 * POSTs to four. The 401 branch is the reason it must be one function and not a
 * convention: a write that forgets to broadcast SESSION_EXPIRED leaves the user
 * staring at a generic failure on a screen that will never work again until
 * they reload.
 *
 * The thrown Error carries the server's machine-readable code (`invalid_kind`,
 * `too_many_occurrences`), which the calling component maps to copy. Codes, not
 * sentences, cross this boundary.
 */
async function send<T>(
  path: string,
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  body?: unknown,
): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    cache: 'no-store',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 401) {
    signalExpired();
    throw new Unauthenticated();
  }
  if (!response.ok) {
    const failure = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(failure.error ?? `request_failed_${response.status}`);
  }
  return (await response.json()) as T;
}

export function getTeam(): Promise<Team> {
  return get<Team>('/api/team');
}

export function updateTeam(patch: {
  name?: string;
  region?: string | null;
  timezone?: string;
}): Promise<Team> {
  return send<Team>('/api/team', 'PATCH', patch);
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

// ------------------------------------------------------------------ meetings

export function listMeetings(params?: {
  from?: number;
  to?: number;
  status?: MeetingStatus;
  limit?: number;
}): Promise<MeetingSummary[]> {
  const query = new URLSearchParams();
  if (params?.from !== undefined) query.set('from', String(params.from));
  if (params?.to !== undefined) query.set('to', String(params.to));
  if (params?.status) query.set('status', params.status);
  if (params?.limit !== undefined) query.set('limit', String(params.limit));
  const suffix = query.toString() ? `?${query}` : '';
  return get<{ meetings: MeetingSummary[] }>(`/api/meetings${suffix}`).then(
    (r) => r.meetings,
  );
}

/**
 * Everything the meeting screen renders, in one request.
 *
 * `candidates` is what lets the note editor draw its portfolio marks without a
 * second round trip — the flag lives in `portfolio_candidates`, not on the
 * block, so there is exactly one source of truth for whether something is
 * flagged.
 */
export interface MeetingDetail {
  meeting: Meeting;
  agenda: AgendaItem[];
  blocks: NoteBlock[];
  attendance: unknown[];
  action_items: unknown[];
  candidates: PortfolioCandidate[];
  attendees: string[];
}

export function getMeeting(id: string): Promise<MeetingDetail> {
  return get<MeetingDetail>(`/api/meetings/${id}`);
}

export function createMeeting(input: {
  starts_at: number;
  title?: string;
  kind?: MeetingKind;
  location?: string | null;
  duration_minutes?: number;
}): Promise<Meeting> {
  return send<{ meeting: Meeting }>('/api/meetings', 'POST', input).then((r) => r.meeting);
}

export function updateMeeting(
  id: string,
  patch: Partial<
    Pick<Meeting, 'title' | 'starts_at' | 'ends_at' | 'location' | 'kind' | 'status'>
  >,
): Promise<Meeting> {
  return send<{ meeting: Meeting }>(`/api/meetings/${id}`, 'PATCH', patch).then(
    (r) => r.meeting,
  );
}

/** Cancel keeps the row and its notes. Deleting is a different, coach-only act. */
export function cancelMeeting(id: string, reason?: string): Promise<Meeting> {
  return send<{ meeting: Meeting }>(`/api/meetings/${id}/cancel`, 'POST', {
    reason,
  }).then((r) => r.meeting);
}

export function deleteMeeting(id: string, force = false): Promise<{ ok: true }> {
  return send<{ ok: true }>(
    `/api/meetings/${id}${force ? '?force=1' : ''}`,
    'DELETE',
  );
}

export interface SeriesResult {
  series: MeetingSeries;
  created: number;
  skipped: number;
  first_starts_at: number;
  last_starts_at: number;
}

export function createSeries(input: {
  title?: string;
  kind?: MeetingKind;
  location?: string | null;
  days_of_week: number[];
  start_minute: number;
  duration_minutes?: number;
  timezone?: string;
  starts_on?: number;
  until?: number;
}): Promise<SeriesResult> {
  return send<SeriesResult>('/api/series', 'POST', input);
}

export function listSeries(): Promise<MeetingSeries[]> {
  return get<{ series: MeetingSeries[] }>('/api/series').then((r) => r.series);
}

/**
 * Edit a rule. Future occurrences only — the server refuses any other scope,
 * because rewriting the start time of a meeting that already happened
 * desynchronises it from the notes taken that evening.
 */
export function updateSeries(
  id: string,
  patch: Partial<{
    title: string;
    kind: MeetingKind;
    location: string | null;
    days_of_week: number[];
    start_minute: number;
    duration_minutes: number;
    until: number;
  }>,
): Promise<{
  series: MeetingSeries;
  created: number;
  updated: number;
  cancelled: number;
  deleted: number;
}> {
  return send(`/api/series/${id}?apply=future_only`, 'PATCH', patch);
}

export function deleteSeries(id: string): Promise<{ ok: true; deleted: number }> {
  return send(`/api/series/${id}`, 'DELETE');
}

// --------------------------------------------------------------------- notes

export function listBlocks(
  meetingId: string,
): Promise<{ blocks: NoteBlock[]; rev: number }> {
  return get(`/api/meetings/${meetingId}/blocks`);
}

/**
 * One row on the server. Polled by an open editor so a second note-taker's
 * edits surface without a websocket; cheap enough to ask constantly.
 */
export function blocksRev(
  meetingId: string,
): Promise<{ rev: number; count: number }> {
  return get(`/api/meetings/${meetingId}/blocks/rev`);
}

/**
 * The client picks the id so a flag can attach to a paragraph that has not
 * finished saving. A retried create returns the row that already exists rather
 * than duplicating a line the student watched appear once.
 */
export function createBlock(
  meetingId: string,
  input: {
    id?: string;
    kind?: BlockKind;
    text?: string;
    media_id?: string | null;
    after_id?: string;
    position?: number;
  },
): Promise<NoteBlock> {
  return send<{ block: NoteBlock }>(
    `/api/meetings/${meetingId}/blocks`,
    'POST',
    input,
  ).then((r) => r.block);
}

/** The keystroke path. An unchanged text write costs nothing server-side. */
export function updateBlock(
  meetingId: string,
  blockId: string,
  patch: { text?: string; kind?: BlockKind; media_id?: string | null; position?: number },
): Promise<NoteBlock> {
  return send<{ block: NoteBlock }>(
    `/api/meetings/${meetingId}/blocks/${blockId}`,
    'PATCH',
    patch,
  ).then((r) => r.block);
}

/** Soft delete. `candidate_orphaned` says a portfolio flag outlived the block. */
export function deleteBlock(
  meetingId: string,
  blockId: string,
): Promise<{ ok: true; block_id: string; candidate_orphaned: boolean }> {
  return send(`/api/meetings/${meetingId}/blocks/${blockId}`, 'DELETE');
}

export function restoreBlock(
  meetingId: string,
  blockId: string,
): Promise<NoteBlock> {
  return send<{ block: NoteBlock }>(
    `/api/meetings/${meetingId}/blocks/${blockId}/restore`,
    'POST',
  ).then((r) => r.block);
}

/** The structural path: reorder, multi-block paste, range delete. Atomic. */
export function replaceBlocks(
  meetingId: string,
  blocks: {
    id?: string;
    kind: BlockKind;
    text: string;
    media_id?: string | null;
  }[],
): Promise<{ blocks: NoteBlock[]; rev: number }> {
  return send(`/api/meetings/${meetingId}/blocks`, 'PUT', { blocks });
}

export function createAgendaItem(
  meetingId: string,
  input: { title: string; detail?: string; owner_member_id?: string; minutes_planned?: number },
): Promise<AgendaItem> {
  return send<{ item: AgendaItem }>(
    `/api/meetings/${meetingId}/agenda`,
    'POST',
    input,
  ).then((r) => r.item);
}

export function updateAgendaItem(
  meetingId: string,
  itemId: string,
  patch: { title?: string; detail?: string | null; done?: boolean },
): Promise<AgendaItem> {
  return send<{ item: AgendaItem }>(
    `/api/meetings/${meetingId}/agenda/${itemId}`,
    'PATCH',
    patch,
  ).then((r) => r.item);
}

export function deleteAgendaItem(
  meetingId: string,
  itemId: string,
): Promise<{ ok: true }> {
  return send(`/api/meetings/${meetingId}/agenda/${itemId}`, 'DELETE');
}

/** Seeds notes from the agenda and marks the meeting under way. Idempotent. */
export function startMeeting(
  meetingId: string,
): Promise<{ meeting: Meeting; blocks: NoteBlock[] }> {
  return send(`/api/meetings/${meetingId}/start`, 'POST');
}

// -------------------------------------------------------- portfolio candidates

/**
 * Flag something for the portfolio. Idempotent — re-flagging returns the row
 * that already exists, so a double tap reads as "yes, it worked".
 */
export function flagCandidate(input: {
  source_type: CandidateSourceType;
  source_id: string;
  suggested_award?: AwardKey | null;
  why?: string;
}): Promise<PortfolioCandidate> {
  return send<{ candidate: PortfolioCandidate }>(
    '/api/portfolio/candidates',
    'POST',
    input,
  ).then((r) => r.candidate);
}

/** Unflag by source, so a toggle does not need to know the candidate id. */
export function unflagCandidate(
  sourceType: CandidateSourceType,
  sourceId: string,
): Promise<{ ok: true }> {
  const query = new URLSearchParams({
    source_type: sourceType,
    source_id: sourceId,
  });
  return send(`/api/portfolio/candidates?${query}`, 'DELETE');
}

/**
 * A candidate plus enough of its source to be readable in March without
 * opening the meeting it came from.
 */
export interface HydratedCandidate extends PortfolioCandidate {
  preview: {
    id: string;
    kind?: string;
    text?: string;
    media_id?: string | null;
    meeting_id?: string;
    meeting_title?: string;
    meeting_starts_at?: number;
    title?: string;
    starts_at?: number;
    caption?: string | null;
  } | null;
  /** The block was deleted after being flagged; the flag deliberately survives. */
  source_deleted: boolean;
}

export function listCandidates(state?: CandidateState): Promise<HydratedCandidate[]> {
  const suffix = state ? `?state=${state}` : '';
  return get<{ candidates: HydratedCandidate[] }>(
    `/api/portfolio/candidates${suffix}`,
  ).then((r) => r.candidates);
}

export function updateCandidate(
  id: string,
  patch: {
    state?: CandidateState;
    suggested_award?: AwardKey | null;
    why?: string | null;
    placed_page_id?: string;
  },
): Promise<PortfolioCandidate> {
  return send<{ candidate: PortfolioCandidate }>(
    `/api/portfolio/candidates/${id}`,
    'PATCH',
    patch,
  ).then((r) => r.candidate);
}

// ---------------------------------------------------------- boards and tasks

export function listBoards(): Promise<Board[]> {
  return get<{ boards: Board[] }>('/api/boards').then((r) => r.boards);
}

export function listTasks(boardId?: string): Promise<Task[]> {
  const suffix = boardId ? `?board_id=${encodeURIComponent(boardId)}` : '';
  return get<{ tasks: Task[] }>(`/api/tasks${suffix}`).then((r) => r.tasks);
}

export function createBoard(input: { name: string; sub_team?: string | null }): Promise<Board> {
  return send<{ board: Board }>('/api/boards', 'POST', input).then((r) => r.board);
}

/** Action items captured in a meeting, once promoted to real board tasks. */
export function listActionItems(status?: 'open' | 'done' | 'dropped'): Promise<
  {
    id: string;
    meeting_id: string;
    text: string;
    assignee_member_id: string | null;
    due_at: number | null;
    status: string;
    task_id: string | null;
  }[]
> {
  const suffix = status ? `?status=${status}` : '';
  return get<{ action_items: [] }>(`/api/action-items${suffix}`).then(
    (r) => r.action_items,
  );
}

export function createActionItem(
  meetingId: string,
  input: {
    text: string;
    assignee_member_id?: string | null;
    due_at?: number | null;
    block_id?: string;
  },
): Promise<{ id: string }> {
  return send<{ action_item: { id: string } }>(
    `/api/meetings/${meetingId}/action-items`,
    'POST',
    input,
  ).then((r) => r.action_item);
}

/** Turn a meeting's action item into a board task. Creates a board if needed. */
export function promoteActionItem(
  meetingId: string,
  actionItemId: string,
  boardId?: string,
): Promise<{ task: Task }> {
  return send(
    `/api/meetings/${meetingId}/action-items/${actionItemId}/promote`,
    'POST',
    { board_id: boardId },
  );
}

export function putAttendance(
  meetingId: string,
  entries: {
    member_id: string;
    /** null clears the entry rather than recording an absence. */
    state: AttendanceState | null;
    arrived_late?: boolean;
    left_early?: boolean;
    minutes?: number;
    note?: string;
  }[],
): Promise<{ attendance: AttendanceRecord[] }> {
  return send(`/api/meetings/${meetingId}/attendance`, 'PUT', { entries });
}

/** Check yourself in. The server ignores any member id in the body. */
export function checkInSelf(
  meetingId: string,
  arrivedLate = false,
): Promise<{ ok: true; member_id: string; arrived_late: boolean }> {
  return send(`/api/meetings/${meetingId}/attendance/self`, 'POST', {
    arrived_late: arrivedLate,
  });
}

export function attendanceSummary(): Promise<{
  meetings_held: number;
  members: {
    member_id: string;
    display_name: string;
    present: number;
    excused: number;
    absent: number;
    arrived_late: number;
    left_early: number;
    minutes: number;
  }[];
}> {
  return get('/api/attendance/summary');
}

// -------------------------------------------------------------- roster photos

/**
 * Record that the signed FIRST Consent and Release is on file for this student.
 *
 * Coglin cannot obtain verifiable parental consent and does not pretend to — a
 * named coach attests, at a known time, that the real paper form exists. The
 * upload below refuses until this has been called.
 */
export function recordPhotoConsent(memberId: string): Promise<{ ok: true }> {
  return send(`/api/members/${memberId}/photo-consent`, 'POST');
}

/** Withdraw consent. Takes the photo down in the same call. */
export function withdrawPhotoConsent(memberId: string): Promise<{ ok: true }> {
  return send(`/api/members/${memberId}/photo-consent`, 'DELETE');
}

export function deleteMemberPhoto(memberId: string): Promise<{ ok: true }> {
  return send(`/api/members/${memberId}/photo`, 'DELETE');
}

// --------------------------------------------------------------------------
// Not built yet. Each returns nothing until its feature lands (COG-014
// outreach, COG-013 awards, COG-016 calendar), at which point the body becomes
// a `get()` call and the screens do not change.
// --------------------------------------------------------------------------

export function listOutreach(): Promise<OutreachEvent[]> {
  return resolve([]);
}

export function listCalendar(): Promise<CalendarEvent[]> {
  return resolve([]);
}

export function listAwardCriteria(): Promise<AwardCriterion[]> {
  return resolve([]);
}

/**
 * Board mutation.
 *
 * The endpoint this always promised now exists. The op shape is unchanged, so
 * the Durable Object (COG-009) can still replay this exact stream to a second
 * viewer later without the write path moving.
 *
 * Fire-and-forget with local state already updated, matching how Boards.tsx
 * applies ops optimistically. A failed op currently just does not persist —
 * rollback is the thing to add when this screen gets real use.
 */
export function mutateBoard(boardId: string, op: BoardOp): Promise<{ ok: true }> {
  return send(`/api/boards/${boardId}/mutate`, 'POST', { ops: [op] });
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
