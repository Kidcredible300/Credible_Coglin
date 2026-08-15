/**
 * Formatting helpers. All timestamps in this app are epoch SECONDS, matching
 * the D1 schema — every conversion to milliseconds happens here and nowhere
 * else, so there is one place to be wrong.
 */

const DAY = 86400;

export function toDate(epochSeconds: number): Date {
  return new Date(epochSeconds * 1000);
}

export function formatDate(epochSeconds: number): string {
  return toDate(epochSeconds).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

export function formatLongDate(epochSeconds: number): string {
  return toDate(epochSeconds).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

export function formatTime(epochSeconds: number): string {
  return toDate(epochSeconds).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function daysBetween(from: number, to: number): number {
  return Math.round((to - from) / DAY);
}

/**
 * "in 3 days" / "2 days ago" / "today". Deliberately plain — a due date is
 * operational information, and cute phrasing makes it harder to scan.
 */
export function relativeDays(epochSeconds: number, now: number): string {
  const d = daysBetween(now, epochSeconds);
  if (d === 0) return 'today';
  if (d === 1) return 'tomorrow';
  if (d === -1) return 'yesterday';
  if (d < 0) return `${Math.abs(d)} days ago`;
  return `in ${d} days`;
}

export function isOverdue(dueAt: number | null, now: number): boolean {
  return dueAt !== null && dueAt < now;
}

/** 4.5 → "4.5", 3 → "3". Hours are logged in halves; don't print "3.0". */
export function formatHours(hours: number): string {
  return Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
}

export function formatCount(n: number): string {
  return n.toLocaleString();
}

/** "Nadia Cole" → "NC". Two letters max; initials get crowded past that. */
export function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
}
