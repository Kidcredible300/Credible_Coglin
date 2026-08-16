import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { runBackup } from './backup';

/**
 * The point of these is not that `put` was called — it is that the dump could
 * actually rebuild the season. A backup nobody has read is a guess.
 */
describe('nightly backup', () => {
  it('captures real rows, not just the schema', async () => {
    const now = Math.floor(Date.UTC(2026, 8, 20) / 1000);
    await env.DB.prepare(
      `INSERT INTO teams (id, team_number, name, region, created_at)
       VALUES ('t1', 607, 'Dragon Slayers', 'NY', ?)`,
    )
      .bind(now)
      .run();

    const key = await runBackup(env, new Date('2026-09-20T07:00:00Z'));
    expect(key).toBe('backups/2026-09-20.json');

    const object = await env.MEDIA.get(key);
    expect(object).not.toBeNull();

    const dump = JSON.parse(await object!.text()) as {
      tables: Record<string, Record<string, unknown>[]>;
    };

    // Every table in the schema is present...
    expect(Object.keys(dump.tables)).toEqual(
      expect.arrayContaining(['teams', 'members', 'invites', 'users']),
    );
    // ...and the row is really in there, values and all.
    expect(dump.tables.teams).toEqual([
      {
        id: 't1',
        team_number: 607,
        name: 'Dragon Slayers',
        region: 'NY',
        created_at: now,
      },
    ]);
  });

  it('includes the migration ledger, so a restore knows where it stands', async () => {
    const key = await runBackup(env, new Date('2026-09-21T07:00:00Z'));
    const dump = JSON.parse(await (await env.MEDIA.get(key))!.text()) as {
      tables: Record<string, unknown[]>;
    };
    // Restoring rows into a database at the wrong schema version is how a
    // restore turns one bad night into two, so the ledger has to come along.
    expect(dump.tables.d1_migrations).toBeDefined();
  });

  it('overwrites rather than accumulating when run twice in a day', async () => {
    await runBackup(env, new Date('2026-09-22T07:00:00Z'));
    await runBackup(env, new Date('2026-09-22T09:30:00Z'));
    const listed = await env.MEDIA.list({ prefix: 'backups/2026-09-22' });
    expect(listed.objects).toHaveLength(1);
  });
});
