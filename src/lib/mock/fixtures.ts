/**
 * Mock season for a plausible FTC team, mid-2026-27.
 *
 * Written to look like real use rather than lorem: half-finished mechanisms,
 * a couple of overdue tasks, an outreach log with uneven entries, decision logs
 * on some tasks and not others. A skeleton full of tidy placeholder rows makes
 * the UI look better than it is and hides exactly the states that matter.
 */
import type {
  AwardCriterion,
  Board,
  CalendarEvent,
  Meeting,
  Member,
  OutreachEvent,
  Season,
  Task,
  Team,
} from '@/types';

/** Fixed "now" so the mock never drifts: 2026-12-06T18:00:00Z. */
export const MOCK_NOW = 1796580000;
const DAY = 86400;

export const team: Team = {
  id: 'team_1',
  team_number: 14584,
  name: 'Ferrous Wheels',
  region: 'Maryland',
  created_at: MOCK_NOW - 400 * DAY,
};

export const season: Season = {
  id: 'season_1',
  team_id: team.id,
  label: '2026-27',
  starts_at: 1788480000, // Sep 5 2026 kickoff
  ends_at: 1811808000,
  is_current: 1,
};

export const members: Member[] = [
  m('mem_1', 'Dana Okafor', 'coach', [], null),
  m('mem_2', 'Ray Whitfield', 'mentor', ['build', 'cad'], null),
  m('mem_3', 'Priya Raman', 'student', ['programming', 'drive'], 'priya'),
  m('mem_4', 'Eli Brandt', 'student', ['build'], 'eli'),
  m('mem_5', 'Nadia Cole', 'student', ['portfolio', 'outreach'], 'nadia'),
  m('mem_6', 'Theo Vance', 'student', ['cad', 'build'], 'theo'),
  m('mem_7', 'Sam Iyer', 'student', ['programming'], 'sam'),
  m('mem_8', 'Junie Park', 'student', ['outreach', 'business'], 'junie'),
  m('mem_9', 'Marcus Hale', 'student', ['build', 'drive'], 'marcus'),
  m('mem_10', 'Wren Castillo', 'student', ['portfolio'], 'wren'),
];

function m(
  id: string,
  display_name: string,
  role: Member['role'],
  sub_teams: Member['sub_teams'],
  handle: string | null,
): Member {
  return {
    id,
    team_id: team.id,
    user_id: `user_${id}`,
    role,
    sub_teams,
    display_name,
    handle,
    status: 'active',
    created_at: season.starts_at,
  };
}

export const boards: Board[] = [
  b('board_1', 'Build', 'build', 0),
  b('board_2', 'Programming', 'programming', 1),
  b('board_3', 'CAD', 'cad', 2),
  b('board_4', 'Portfolio', 'portfolio', 3),
  b('board_5', 'Outreach', 'outreach', 4),
];

function b(
  id: string,
  name: string,
  sub_team: Board['sub_team'],
  position: number,
): Board {
  return {
    id,
    team_id: team.id,
    season_id: season.id,
    name,
    sub_team,
    position,
  };
}

let taskSeq = 0;
function t(
  board_id: string,
  title: string,
  status: Task['status'],
  assignee_member_id: string | null,
  opts: {
    due_in_days?: number | null;
    decision_log?: string | null;
    body?: string | null;
  } = {},
): Task {
  taskSeq += 1;
  return {
    id: `task_${taskSeq}`,
    team_id: team.id,
    board_id,
    title,
    body: opts.body ?? null,
    assignee_member_id,
    status,
    due_at:
      opts.due_in_days === undefined || opts.due_in_days === null
        ? null
        : MOCK_NOW + opts.due_in_days * DAY,
    position: taskSeq,
    decision_log: opts.decision_log ?? null,
    created_at: MOCK_NOW - 30 * DAY,
    updated_at: MOCK_NOW - 2 * DAY,
  };
}

export const tasks: Task[] = [
  // Build
  t('board_1', 'Rebuild intake with compliant wheels', 'doing', 'mem_4', {
    due_in_days: 3,
    decision_log:
      'Started with surgical tubing — grabbed two samples at once and jammed. Swapped to 35A compliant wheels at 1.5in spacing; single-intake rate went up and the jam disappeared. Keeping tubing spares for the sorter.',
  }),
  t('board_1', 'Shorten the lift by one stage', 'doing', 'mem_9', {
    due_in_days: 6,
    decision_log:
      'Four stages cleared the high goal but flexed badly at full extension and cost us 1.2s. Dropped to three and added a diagonal brace.',
  }),
  t('board_1', 'Fix the drivetrain rattle before Saturday', 'blocked', 'mem_9', {
    due_in_days: -1,
    body: 'Waiting on the 8mm hex spacers — ordered Tuesday, not here yet.',
  }),
  t('board_1', 'Cut and tap the new side plates', 'todo', 'mem_6', {
    due_in_days: 9,
  }),
  t('board_1', 'Robot passes size inspection', 'done', 'mem_4', {
    decision_log:
      'Failed the first check by 4mm at the intake. Moved the bumper mount inboard rather than cutting the intake.',
  }),
  t('board_1', 'Label every wire at both ends', 'done', 'mem_2', {}),

  // Programming
  t('board_2', 'Autonomous: score two preload samples', 'doing', 'mem_3', {
    due_in_days: 4,
    decision_log:
      'Dead-reckoning drifted about 6in over the run. Added odometry pods and a heading correction at each waypoint; repeatability is now within 2in across 10 runs.',
  }),
  t('board_2', 'Tune the lift PID under load', 'todo', 'mem_7', {
    due_in_days: 5,
  }),
  t('board_2', 'Driver-controlled speed limiter toggle', 'todo', 'mem_3', {
    due_in_days: 12,
    body: 'Marcus keeps overshooting the pole at full speed. Half-speed on the right bumper.',
  }),
  t('board_2', 'Write up the sensor suite for Control', 'todo', 'mem_7', {
    due_in_days: 20,
    body: 'Portfolio needs this — no source code, just what each sensor does and why.',
  }),
  t('board_2', 'Set up the odometry pods', 'done', 'mem_3', {}),

  // CAD
  t('board_3', 'Model the three-stage lift', 'doing', 'mem_6', {
    due_in_days: 7,
  }),
  t('board_3', 'Render exploded view for the portfolio', 'todo', 'mem_6', {
    due_in_days: 18,
  }),
  t('board_3', 'Print v3 intake brackets', 'done', 'mem_6', {
    decision_log:
      'PLA cracked at the mount under match loads. Reprinted in PETG at 60% infill — survived a full practice day.',
  }),

  // Portfolio
  t('board_4', 'Draft the engineering-process pages', 'doing', 'mem_10', {
    due_in_days: 14,
    body: 'Pull from the build decision logs — the intake and lift entries are the strongest.',
  }),
  t('board_4', 'Team plan: skill goals and steps', 'todo', 'mem_5', {
    due_in_days: 16,
    body: 'Connect requires this in writing.',
  }),
  t('board_4', 'Sustainability + finance plan with progress tracking', 'todo', 'mem_5', {
    due_in_days: 21,
  }),
  t('board_4', 'Lock the 15-page outline', 'blocked', 'mem_10', {
    due_in_days: -3,
    body: 'Waiting on the CAD renders and the outreach totals.',
  }),

  // Outreach
  t('board_5', 'Book the spring library demo', 'todo', 'mem_8', {
    due_in_days: 11,
  }),
  t('board_5', 'Thank-you notes to Fabrication Plus', 'todo', 'mem_8', {
    due_in_days: 2,
  }),
  t('board_5', 'Mentor the middle-school FLL team', 'doing', 'mem_5', {
    due_in_days: 8,
    decision_log:
      'First session we lectured for 40 minutes and lost them. Second session opened with a build challenge and talked afterwards — far better.',
  }),
];

export const outreach: OutreachEvent[] = [
  o('Girl Scouts robotics afternoon', -12, 4.5, 34, 'Hands-on beat slides. Next time bring two robots so nobody waits.'),
  o('Elementary STEM night', -26, 3, 120, 'Huge crowd, thin on volunteers. Six of us minimum next year.'),
  o('FLL team mentoring — session 2', -5, 2, 11, 'Opened with a build challenge instead of a talk. Night and day.'),
  o('FLL team mentoring — session 1', -19, 2, 11, 'Lectured too long. They tuned out around minute fifteen.'),
  o('County library demo', -40, 3.5, 62, null),
  o('Sponsor visit — Fabrication Plus', -47, 1.5, 8, 'They offered shop time on the waterjet, not just cash. Worth more to us.'),
  o('Homecoming parade float', -61, 5, 400, 'Reach, not depth. Good for recruiting; three sign-ups came from it.'),
  o('Rookie team Q&A (Team 21033)', -33, 1.5, 9, 'They asked mostly about the portfolio, not the robot. Telling.'),
];

function o(
  title: string,
  days_ago: number,
  hours: number,
  people_reached: number,
  what_we_learned: string | null,
): OutreachEvent {
  return {
    id: `outreach_${title.replace(/\W+/g, '_').toLowerCase()}`,
    team_id: team.id,
    season_id: season.id,
    title,
    occurred_at: MOCK_NOW + days_ago * DAY,
    hours,
    people_reached,
    what_we_learned,
    created_by: 'mem_8',
    created_at: MOCK_NOW + days_ago * DAY,
  };
}

export const calendar: CalendarEvent[] = [
  c('kickoff', 'Season kickoff', -92),
  c('meet', 'League meet 2', -21),
  c('meet', 'League meet 3', 9),
  c('deadline', 'Portfolio to print', 24),
  c('qualifier', 'Chesapeake qualifier', 31),
  c('championship', 'Maryland championship', 74),
];

function c(
  kind: CalendarEvent['kind'],
  title: string,
  days_from_now: number,
): CalendarEvent {
  return {
    id: `cal_${title.replace(/\W+/g, '_').toLowerCase()}`,
    team_id: team.id,
    season_id: season.id,
    kind,
    title,
    starts_at: MOCK_NOW + days_from_now * DAY,
    ends_at: null,
  };
}

export const meetings: Meeting[] = [
  {
    id: 'meeting_next',
    team_id: team.id,
    season_id: season.id,
    starts_at: MOCK_NOW + 2 * DAY + 3600 * 2,
    agenda: 'Drivetrain rattle · autonomous run-through · portfolio outline',
    notes: null,
    attendees: [],
    created_at: MOCK_NOW - 5 * DAY,
  },
];

/**
 * Award readiness. Not uniform on purpose — Reach and Sustain are the two new
 * 2025-26 awards and are exactly where teams are thinnest, which is the gap
 * the product exists to close.
 */
export const awardCriteria: AwardCriterion[] = [
  ...crit('think', ['process', 'lessons', 'tradeoffs', 'math'], ['ready', 'ready', 'partial', 'todo']),
  ...crit('connect', ['team_plan', 'stem_connections', 'outreach_depth'], ['partial', 'ready', 'ready']),
  ...crit('reach', ['objectives', 'recruit_teams', 'recruit_mentors'], ['partial', 'todo', 'todo']),
  ...crit('sustain', ['finance_plan', 'season_plan', 'progress_tracking'], ['partial', 'todo', 'todo']),
  ...crit('innovate', ['creative_element', 'robustness', 'risk_docs'], ['ready', 'partial', 'todo']),
  ...crit('control', ['sensors', 'autonomous', 'software_docs'], ['ready', 'ready', 'partial']),
  ...crit('design', ['elegance', 'maintainability', 'design_basis'], ['ready', 'partial', 'partial']),
];

function crit(
  award: AwardCriterion['award'],
  keys: string[],
  states: AwardCriterion['state'][],
): AwardCriterion[] {
  return keys.map((criterion_key, i) => ({
    id: `${award}_${criterion_key}`,
    team_id: team.id,
    season_id: season.id,
    award,
    criterion_key,
    state: states[i],
    notes: null,
  }));
}
