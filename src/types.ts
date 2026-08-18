/**
 * Domain types, mirroring migrations/0001_init.sql field-for-field.
 *
 * These deliberately use the DATABASE's names and shapes — snake_case columns,
 * epoch-SECONDS timestamps, json-as-string — rather than a prettier client
 * model. Mock fixtures that drift from the schema would quietly bake wrong
 * assumptions into every screen, and the whole point of the mock layer is that
 * Phase 1 can swap the transport without touching a single component.
 */

export type Role = 'coach' | 'mentor' | 'student' | 'viewer';

export type SubTeam =
  | 'build'
  | 'programming'
  | 'cad'
  | 'outreach'
  | 'portfolio'
  | 'business'
  | 'drive';

export const SUB_TEAMS: { id: SubTeam; label: string }[] = [
  { id: 'build', label: 'Build' },
  { id: 'programming', label: 'Programming' },
  { id: 'cad', label: 'CAD' },
  { id: 'outreach', label: 'Outreach' },
  { id: 'portfolio', label: 'Portfolio' },
  { id: 'business', label: 'Business' },
  { id: 'drive', label: 'Drive team' },
];

export type TaskStatus = 'todo' | 'doing' | 'blocked' | 'done';

export const TASK_COLUMNS: { id: TaskStatus; label: string }[] = [
  { id: 'todo', label: 'To do' },
  { id: 'doing', label: 'In progress' },
  { id: 'blocked', label: 'Blocked' },
  { id: 'done', label: 'Done' },
];

export interface Team {
  id: string;
  team_number: number;
  name: string;
  region: string | null;
  /**
   * IANA zone. Every recurring meeting is resolved against it, so a wrong value
   * here materialises a whole season an hour off rather than failing.
   */
  timezone: string;
  created_at: number;
}

export interface Season {
  id: string;
  team_id: string;
  label: string;
  starts_at: number;
  ends_at: number;
  is_current: number;
}

export interface Member {
  id: string;
  team_id: string;
  role: Role;
  sub_teams: SubTeam[];
  display_name: string;
  handle: string | null;
  status: string;
  /**
   * Null when there is no photo, and always null for a viewer — a sponsor is
   * not handed pictures of other people's children. See 0004_roster_photos.sql.
   */
  photo_media_id: string | null;
  /**
   * Whether a coach has recorded that the signed FIRST Consent and Release is
   * on file. A photo cannot be attached until it is true. Deliberately a
   * boolean rather than the timestamp: the roster needs to know whether it may
   * hold a photo, not to publish when a form was signed.
   */
  photo_consent: boolean;
  created_at: number;
}

/**
 * One student on one evening.
 *
 * `state` is the whole disposition. `other` carries its explanation in `note`
 * ("leaving early for dentist") and the Worker will not accept it without one.
 * `excused`, `arrived_late`, `left_early` and `minutes` were retired in
 * migrations/0005_attendance.sql, which has the reasoning.
 */
export type AttendanceState = 'present' | 'absent' | 'other';

export interface AttendanceRecord {
  id: string;
  member_id: string;
  state: AttendanceState;
  note: string | null;
  recorded_by: string | null;
  recorded_at: number;
}

export interface Board {
  id: string;
  team_id: string;
  season_id: string;
  name: string;
  sub_team: SubTeam | null;
  position: number;
}

export interface Task {
  id: string;
  team_id: string;
  board_id: string;
  title: string;
  body: string | null;
  assignee_member_id: string | null;
  status: TaskStatus;
  due_at: number | null;
  position: number;
  /** "What we tried, why we changed it" — the Think award's raw material. */
  decision_log: string | null;
  created_at: number;
  updated_at: number;
}

export interface OutreachEvent {
  id: string;
  team_id: string;
  season_id: string;
  title: string;
  occurred_at: number;
  hours: number;
  people_reached: number;
  what_we_learned: string | null;
  created_by: string | null;
  created_at: number;
}

export type CalendarKind =
  | 'meet'
  | 'qualifier'
  | 'championship'
  | 'deadline'
  | 'kickoff'
  | 'other';

export interface CalendarEvent {
  id: string;
  team_id: string;
  season_id: string;
  kind: CalendarKind;
  title: string;
  starts_at: number;
  ends_at: number | null;
}

export type MeetingKind =
  | 'build'
  | 'general'
  | 'outreach'
  | 'design_review'
  | 'business'
  | 'drive_practice'
  | 'competition'
  | 'other';

export const MEETING_KINDS: { id: MeetingKind; label: string }[] = [
  { id: 'build', label: 'Build' },
  { id: 'general', label: 'General' },
  { id: 'outreach', label: 'Outreach' },
  { id: 'design_review', label: 'Design review' },
  { id: 'business', label: 'Business' },
  { id: 'drive_practice', label: 'Drive practice' },
  { id: 'competition', label: 'Competition' },
  { id: 'other', label: 'Other' },
];

export type MeetingStatus = 'planned' | 'held' | 'cancelled';

export interface Meeting {
  id: string;
  team_id: string;
  season_id: string;
  title: string;
  starts_at: number;
  ends_at: number | null;
  location: string | null;
  kind: MeetingKind;
  status: MeetingStatus;
  series_id: string | null;
  /** The occurrence's local date as YYYYMMDD — its identity within a series. */
  series_slot: number | null;
  detached_at: number | null;
  started_at: number | null;
  ended_at: number | null;
  cancel_reason: string | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * Counts the list endpoint computes so the index does not have to fetch a
 * meeting's contents to say whether it has any.
 */
export interface MeetingSummary extends Meeting {
  attendance_count: number;
  block_count: number;
  flagged_count: number;
}

/**
 * A recurrence rule. Stored as parts rather than an epoch stride: `start_minute`
 * is minutes after LOCAL midnight, and `starts_on`/`until` are local dates as
 * YYYYMMDD. See worker/lib/tz.ts for why an epoch stride is wrong.
 */
export interface MeetingSeries {
  id: string;
  team_id: string;
  season_id: string;
  title: string;
  kind: MeetingKind;
  location: string | null;
  /** 0 = Sunday, matching Date#getDay. */
  days_of_week: number[];
  start_minute: number;
  duration_minutes: number;
  timezone: string;
  starts_on: number;
  until: number;
  created_at: number;
  updated_at: number;
}

/**
 * A block is the unit of a meeting's notes AND the unit of portfolio flagging.
 * Those are the same thing on purpose: "flag this paragraph", "flag this
 * picture" and "flag this decision" are one gesture against one row.
 */
export type BlockKind =
  | 'heading'
  | 'paragraph'
  | 'bullet'
  | 'decision'
  | 'action'
  | 'image';

export interface NoteBlock {
  id: string;
  meeting_id: string;
  /** REAL, sparse. Inserting between two blocks is a one-row write. */
  position: number;
  kind: BlockKind;
  text: string;
  media_id: string | null;
  source_agenda_item_id: string | null;
  created_by_member_id: string | null;
  updated_by_member_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface AgendaItem {
  id: string;
  meeting_id: string;
  position: number;
  title: string;
  detail: string | null;
  owner_member_id: string | null;
  minutes_planned: number | null;
  sub_team: string | null;
  done: number;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

export const WEEKDAYS: { id: number; short: string; label: string }[] = [
  { id: 0, short: 'S', label: 'Sunday' },
  { id: 1, short: 'M', label: 'Monday' },
  { id: 2, short: 'T', label: 'Tuesday' },
  { id: 3, short: 'W', label: 'Wednesday' },
  { id: 4, short: 'T', label: 'Thursday' },
  { id: 5, short: 'F', label: 'Friday' },
  { id: 6, short: 'S', label: 'Saturday' },
];

/**
 * A flag saying "this might belong in the portfolio", plus a judgement about it.
 *
 * Source-agnostic from the start so the Awards screen and the outreach log can
 * feed the same inbox later without a schema change. `meeting_block` covers
 * three of the four things the product asks students to be able to flag — a
 * paragraph, a picture, and a decision or action entry — because all three are
 * blocks. `meeting` covers the fourth: the whole page.
 *
 * This is the single source of truth for whether something is flagged; blocks
 * carry no `flagged_at` of their own, so a mark cannot drift from its record.
 */
export type CandidateSourceType =
  | 'meeting'
  | 'meeting_block'
  | 'media'
  | 'task'
  | 'outreach_event';

export type CandidateState = 'candidate' | 'shortlisted' | 'placed' | 'rejected';

export interface PortfolioCandidate {
  id: string;
  source_type: CandidateSourceType;
  source_id: string;
  suggested_award: AwardKey | null;
  why: string | null;
  state: CandidateState;
  placed_page_id: string | null;
  flagged_by: string | null;
  created_at: number;
}

/** The eight judged awards. Criteria come from the Competition Manual §6. */
export type AwardKey =
  | 'inspire'
  | 'think'
  | 'connect'
  | 'reach'
  | 'sustain'
  | 'innovate'
  | 'control'
  | 'design';

export type CriterionState = 'todo' | 'partial' | 'ready';

export interface AwardCriterion {
  id: string;
  team_id: string;
  season_id: string;
  award: AwardKey;
  criterion_key: string;
  state: CriterionState;
  notes: string | null;
}

/**
 * Board mutations use the same op shape the server will accept at
 * POST /api/boards/:id/mutate, so the Durable Object can later replay this
 * exact stream to subscribers without the client's write path changing.
 */
export type BoardOp =
  | { op: 'move_task'; task_id: string; status: TaskStatus; position: number }
  | { op: 'create_task'; task: Task }
  | { op: 'update_task'; task_id: string; patch: Partial<Task> }
  | { op: 'delete_task'; task_id: string };
