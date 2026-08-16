/**
 * Nightly D1 -> R2 backup (COG-040).
 *
 * This exists because production holds one real FIRST team's entire season from
 * day one — an outreach log and portfolio history that cannot be recreated if
 * they are lost. D1 has point-in-time recovery, but PITR is a Cloudflare-side
 * feature protecting against Cloudflare-side loss; it does not protect against
 * us, and "us" is the likelier failure. A bad migration or a mistaken DELETE at
 * 11pm the night before a qualifier is the scenario this guards.
 *
 * The dump is plain JSON of every table. That is only reasonable because of the
 * scale: one team is on the order of a thousand rows across everything, and
 * even at the plan's full-penetration ceiling of 8,000 teams a per-team export
 * stays small. If this ever grows past a few MB, this is the thing to revisit —
 * not because JSON is wrong, but because a whole-database read on a cron is.
 */
import type { Bindings } from './types';

/** Kept in R2 before the oldest is dropped. A month covers "we noticed at the
 *  next competition" without being an unbounded bill. */
const KEEP = 30;

interface Backup {
  taken_at: string;
  environment: string;
  tables: Record<string, unknown[]>;
}

async function listTables(db: D1Database): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'
        ORDER BY name`,
    )
    .all<{ name: string }>();
  return results.map((r) => r.name);
}

export async function runBackup(env: Bindings, now: Date): Promise<string> {
  const tables = await listTables(env.DB);
  const dump: Backup = {
    taken_at: now.toISOString(),
    environment: env.ENVIRONMENT ?? 'local',
    tables: {},
  };

  for (const table of tables) {
    // The table name comes from sqlite_master, not from user input, so the
    // interpolation here cannot be influenced by a request. Bound parameters
    // are not available for identifiers.
    const { results } = await env.DB.prepare(`SELECT * FROM "${table}"`).all();
    dump.tables[table] = results;
  }

  // Date-stamped, so a second run on the same day overwrites rather than
  // accumulating — the cron is daily and a manual re-run should not eat a slot.
  const key = `backups/${now.toISOString().slice(0, 10)}.json`;
  await env.MEDIA.put(key, JSON.stringify(dump), {
    httpMetadata: { contentType: 'application/json' },
  });

  await prune(env);
  return key;
}

/**
 * Drop everything past the newest KEEP. Keys are date-stamped, so lexical order
 * is chronological order and no metadata read is needed to sort them.
 */
async function prune(env: Bindings): Promise<void> {
  const listed = await env.MEDIA.list({ prefix: 'backups/', limit: 1000 });
  const keys = listed.objects.map((o) => o.key).sort();
  const stale = keys.slice(0, Math.max(0, keys.length - KEEP));
  if (stale.length > 0) await env.MEDIA.delete(stale);
}

export const scheduled: ExportedHandlerScheduledHandler<Bindings> = (
  event,
  env,
  ctx,
) => {
  // waitUntil rather than await: the cron's own timeout is what should bound
  // this, and a rejected promise here would otherwise be an unhandled one.
  ctx.waitUntil(
    runBackup(env, new Date(event.scheduledTime))
      .then((key) => console.log(`backup written: ${key}`))
      .catch((err) => {
        console.error(
          'backup failed:',
          err instanceof Error ? err.message : String(err),
        );
        // Rethrow so the failure shows as a failed cron invocation in the
        // dashboard instead of a silent success. A backup that quietly stopped
        // running is the worst version of this feature.
        throw err;
      }),
  );
};
