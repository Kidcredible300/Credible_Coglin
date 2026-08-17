/**
 * Request-body helpers.
 *
 * `readJson` was written twice — once in `routes/auth.ts` and again in
 * `routes/invites.ts` — before the meetings routes needed a third and fourth
 * copy. Three is where a convention stops being a convention and starts being
 * copy-paste, so it lives here now.
 */

/**
 * Parse a JSON object body, or null.
 *
 * Null covers malformed JSON, a body that is valid JSON but not an object
 * (`"hello"`, `[1,2]`, `null`), and an absent body. Callers answer all of those
 * the same way — 400 `invalid_body` — because none of them can be acted on and
 * distinguishing them only tells a prober how the parser is built.
 */
export async function readJson(c: {
  req: { json: () => Promise<unknown> };
}): Promise<Record<string, unknown> | null> {
  try {
    const body = await c.req.json();
    return body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** A trimmed string, or null when absent or blank. */
export function optionalString(value: unknown, maxLength = 2000): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, maxLength);
}

/**
 * An integer within bounds, or null.
 *
 * Rejects non-integers rather than rounding them: a fractional `start_minute`
 * is a client bug, and silently flooring it would materialise a season at the
 * wrong time rather than reporting the problem.
 */
export function boundedInt(
  value: unknown,
  min: number,
  max: number,
): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  if (value < min || value > max) return null;
  return value;
}
