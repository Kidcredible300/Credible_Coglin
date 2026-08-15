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
  user_id: string;
  role: Role;
  sub_teams: SubTeam[];
  display_name: string;
  handle: string | null;
  status: string;
  created_at: number;
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

export interface Meeting {
  id: string;
  team_id: string;
  season_id: string;
  starts_at: number;
  agenda: string | null;
  notes: string | null;
  attendees: string[];
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
