#!/usr/bin/env node
/**
 * Turn a nightly backup (COG-040) into SQL that rebuilds a database.
 *
 * This exists so the restore path is something we have actually run, not
 * something we believe would work. A backup that has never been restored is a
 * guess, and the night we need it is the worst possible time to find that out —
 * so `npm run db:restore:dry` is part of the release checklist.
 *
 * It deliberately does NOT apply anything itself. It writes SQL to stdout or a
 * file, and a human runs `wrangler d1 execute` against a named database. The
 * one operation this tool could perform is "overwrite a real team's season",
 * and that should require typing the target out.
 *
 * Usage:
 *   node scripts/restore-backup.mjs <backup.json> [--out restore.sql]
 *
 * Then, against a NON-PRODUCTION database first:
 *   npx wrangler d1 execute coglin-staging --remote --file restore.sql
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [, , input, ...rest] = process.argv;
if (!input) {
  console.error('usage: restore-backup.mjs <backup.json> [--out file.sql]');
  process.exit(1);
}

const outIndex = rest.indexOf('--out');
const outFile = outIndex === -1 ? null : rest[outIndex + 1];

const backup = JSON.parse(readFileSync(input, 'utf8'));

/**
 * Order matters: parents before children, because the schema has real foreign
 * keys. Anything not listed here is appended afterwards in whatever order the
 * dump had, which is fine for tables that reference only these.
 */
const FIRST = ['users', 'teams', 'seasons', 'members'];
/** Rebuilt by the runtime, not restored. Sessions especially: replaying them
 *  would hand back live credentials that everyone has since rotated past. */
const SKIP = ['sessions', 'd1_migrations', '_cf_KV'];

/**
 * Columns that older dumps carry and the schema no longer has.
 *
 * The restore path builds its INSERT column list from the keys of each dumped
 * row, so a column that has since been dropped names something that does not
 * exist and the whole statement fails. Backups are kept for 30 days
 * (worker/backup.ts), which is how long a schema change stays able to break a
 * restore — and `npm run db:restore:sql` is on the release checklist precisely so
 * that does not go unnoticed.
 *
 * This is also why 0005 KEPT meeting_attendance.arrived_late, left_early and
 * minutes rather than dropping them: nothing has to be listed here if nothing
 * gets dropped, and an unwritten column costs nothing.
 */
const GONE = { meeting_action_items: ['block_id'] };

function literal(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (value instanceof Uint8Array || Array.isArray(value)) {
    return `X'${Buffer.from(value).toString('hex')}'`;
  }
  return `'${String(value).replace(/'/g, "''")}'`;
}

const names = Object.keys(backup.tables);
const ordered = [
  ...FIRST.filter((t) => names.includes(t)),
  ...names.filter((t) => !FIRST.includes(t)),
].filter((t) => !SKIP.includes(t));

const lines = [
  `-- Restore generated from ${input}`,
  `-- Backup taken ${backup.taken_at} from environment "${backup.environment}"`,
  `-- Skipped (rebuilt at runtime): ${SKIP.join(', ')}`,
  '',
  'PRAGMA defer_foreign_keys = ON;',
  '',
];

let total = 0;
for (const table of ordered) {
  const rows = backup.tables[table] ?? [];
  if (rows.length === 0) continue;
  lines.push(`-- ${table}: ${rows.length} row(s)`);
  const gone = GONE[table] ?? [];
  for (const row of rows) {
    const cols = Object.keys(row).filter((c) => !gone.includes(c));
    const values = cols.map((c) => literal(row[c])).join(', ');
    lines.push(
      `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${values});`,
    );
    total++;
  }
  lines.push('');
}

const sql = lines.join('\n');
if (outFile) {
  writeFileSync(outFile, sql);
  console.error(
    `wrote ${outFile}: ${total} row(s) across ${ordered.length} table(s)`,
  );
} else {
  process.stdout.write(sql);
}
