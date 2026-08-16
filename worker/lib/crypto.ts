/**
 * Password hashing and token helpers.
 *
 * Ported from the Inkubus website (`website/inkubus/functions/_lib/crypto.js`),
 * which has been hashing real passwords in production Workers since Jul 2026.
 * Kept deliberately close to that original so a fix in one is obvious in the
 * other.
 *
 * PBKDF2-HMAC-SHA256 via WebCrypto: scrypt and argon2 are not in WebCrypto, and
 * PBKDF2 is the strongest native option in the Workers runtime. 100k is the
 * hard cap in the deployed runtime — higher counts throw NotSupportedError in
 * production even though local dev accepts them. `verifyPassword` reads the
 * count out of the stored hash, so raising this later stays compatible with
 * every hash written before the change.
 */
const PBKDF2_ITERATIONS = 100_000;
const KEY_BYTES = 32;

function b64encode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64decode(str: string): Uint8Array {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function pbkdf2(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    keyMaterial,
    KEY_BYTES * 8,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64encode(salt)}$${b64encode(hash)}`;
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parts = (stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number.parseInt(parts[1], 10);
  if (!Number.isFinite(iterations) || iterations < 1) return false;
  const salt = b64decode(parts[2]);
  const expected = b64decode(parts[3]);
  const actual = await pbkdf2(password, salt, iterations);
  return timingSafeEqual(actual, expected);
}

/**
 * A well-formed hash that no password matches. Verifying against this when the
 * account does not exist keeps the response time of "no such user" and "wrong
 * password" the same, so login timing cannot be used to enumerate accounts.
 * Matters more here than on a normal product: a student handle is guessable
 * ("first name + last initial") and team numbers are public.
 */
export const DUMMY_HASH =
  'pbkdf2$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Opaque token. The raw value only ever leaves in a cookie or an invite URL. */
export function randomToken(bytes = 32): string {
  return hex(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256hex(str: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(str),
  );
  return hex(new Uint8Array(digest));
}

/**
 * The at-rest id for a bearer-ish token (session cookie, invite link).
 *
 * The pepper is the one intentional divergence from the Inkubus original. It
 * lives in a Worker secret rather than in D1, so a database leak alone does not
 * let an attacker precompute ids from stolen tokens — they would need the
 * secret store too. Absent in local dev, which is fine: the fallback still
 * hashes, it just isn't peppered.
 */
export function tokenId(token: string, pepper?: string): Promise<string> {
  return sha256hex(pepper ? `${pepper}:${token}` : token);
}

export function uuid(): string {
  return crypto.randomUUID();
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
