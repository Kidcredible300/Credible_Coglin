/**
 * The tenancy boundary. This is the file `migrations/0001_init.sql` and the
 * README both point at.
 *
 * The rule, restated because it is the one bug this codebase cannot ship: a
 * request never names its own team. `team_id` comes from the authenticated
 * session's membership row and nowhere else. Handlers read it off the context
 * via `auth(c).teamId` — they are never handed a team id from a body, a query
 * string, or a path segment.
 *
 * Practically that means a handler cannot express a cross-team read by
 * accident. To write one you would have to go out of your way to bypass this
 * module, which is exactly the friction we want.
 */
import type { Context, MiddlewareHandler } from 'hono';
import { getSessionUser, type SessionUser } from './session';
import type { Bindings } from '../types';
import type { Role } from './roles';

export interface MemberRow {
  id: string;
  team_id: string;
  role: Role;
  display_name: string;
  handle: string | null;
  sub_teams: string;
}

export interface AuthContext {
  user: SessionUser;
  member: MemberRow;
  teamId: string;
}

export type AppEnv = {
  Bindings: Bindings;
  Variables: { auth: AuthContext };
};

/**
 * CSRF guard for state-changing routes. The session cookie is SameSite=Lax,
 * which already blocks cross-site form POSTs; this is the second layer, via
 * Origin with a Sec-Fetch-Site fallback for same-origin fetches that omit it.
 */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get('Origin');
  if (!origin) {
    const site = request.headers.get('Sec-Fetch-Site');
    return site === null || site === 'same-origin' || site === 'none';
  }
  try {
    const o = new URL(origin);
    if (o.hostname === 'localhost' || o.hostname === '127.0.0.1') return true;
    return o.host === new URL(request.url).host;
  } catch {
    return false;
  }
}

export const sameOriginOnly: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!isSameOrigin(c.req.raw)) return c.json({ error: 'forbidden' }, 403);
  await next();
};

/**
 * Resolve session -> user -> membership, or 401.
 *
 * A user with no active membership is treated as unauthenticated rather than
 * as an empty account: there is no such thing as a signed-in user without a
 * team in this product, so a membership-less session is a bug or a removed
 * member, and both should land back on the login screen.
 */
export const requireMember: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = await getSessionUser(c.req.raw, c.env);
  if (!user) return c.json({ error: 'unauthenticated' }, 401);

  // Ordered so the result is stable rather than whatever D1 returns first. A
  // user on two teams is only possible under Club tier (COG-023), which also
  // brings the team switcher that will make this an explicit choice; until
  // then, oldest membership wins and it is deterministic.
  const member = await c.env.DB.prepare(
    `SELECT id, team_id, role, display_name, handle, sub_teams
       FROM members
      WHERE user_id = ? AND status = 'active'
      ORDER BY created_at ASC
      LIMIT 1`,
  )
    .bind(user.id)
    .first<MemberRow>();
  if (!member) return c.json({ error: 'unauthenticated' }, 401);

  c.set('auth', { user, member, teamId: member.team_id });
  await next();
};

/**
 * Coach-or-mentor gate for routes that change the roster. Deliberately a
 * separate middleware rather than an `if` inside handlers, so "who may do this"
 * is visible in the route table.
 */
export function requireRole(...roles: Role[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const { member } = auth(c);
    if (!roles.includes(member.role)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    await next();
  };
}

/** Typed accessor, so handlers never reach for `c.get('auth')!` themselves. */
export function auth(c: Context<AppEnv>): AuthContext {
  return c.get('auth');
}
