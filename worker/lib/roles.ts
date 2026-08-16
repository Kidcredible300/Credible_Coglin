/**
 * Roles and sub-teams, server side.
 *
 * Duplicated from `src/types.ts` rather than imported: tsconfig.worker.json
 * includes only `worker/`, and wiring the client tree into the Worker build to
 * share seven string literals would be a worse trade than this file. The two
 * lists must stay in sync — if you add a sub-team, add it in both places.
 *
 * More importantly, these are the *validators*. The client's copy is for
 * rendering labels; this copy decides what is allowed into D1, and a role or
 * sub-team arriving from a request body is never trusted without passing
 * through here.
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

const ROLES: readonly Role[] = ['coach', 'mentor', 'student', 'viewer'];

const SUB_TEAMS: readonly SubTeam[] = [
  'build',
  'programming',
  'cad',
  'outreach',
  'portfolio',
  'business',
  'drive',
];

/** Roles a coach may hand out via an invite. Notably not `coach` itself for
 *  now — a second coach is rare enough in the alpha that promoting by hand is
 *  safer than an invite link that mints full roster control. */
export const INVITABLE_ROLES: readonly Role[] = ['mentor', 'student', 'viewer'];

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export function isSubTeam(value: unknown): value is SubTeam {
  return (
    typeof value === 'string' && (SUB_TEAMS as readonly string[]).includes(value)
  );
}

/**
 * Normalise a sub-team list from a request body into the json-string form the
 * `members.sub_teams` column holds. Unknown entries are dropped rather than
 * rejected: a client on a stale bundle sending a retired sub-team should not
 * fail to add a student to the roster.
 */
export function normaliseSubTeams(value: unknown): string {
  if (!Array.isArray(value)) return '[]';
  const seen = new Set<SubTeam>();
  for (const entry of value) if (isSubTeam(entry)) seen.add(entry);
  return JSON.stringify(SUB_TEAMS.filter((st) => seen.has(st)));
}
