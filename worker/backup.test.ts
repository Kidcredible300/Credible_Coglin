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
        timezone: 'America/New_York',
        created_at: now,
      },
    ]);
  });

  it('picks up new tables without anyone remembering to add them', async () => {
    // runBackup reads sqlite_master rather than a hardcoded list, so a
    // migration that adds a table is covered the same night it lands. This is
    // the assertion that proves it, because the failure mode is silent: a
    // restore that quietly omits a season's meeting notes looks like a
    // successful backup right up until it is needed.
    const key = await runBackup(env, new Date('2026-09-23T07:00:00Z'));
    const dump = JSON.parse(await (await env.MEDIA.get(key))!.text()) as {
      tables: Record<string, unknown[]>;
    };

    expect(Object.keys(dump.tables)).toEqual(
      expect.arrayContaining([
        'meeting_series',
        'meeting_agenda_items',
        'note_docs',
        'meeting_attendance',
        'meeting_action_items',
        'portfolio_candidates',
      ]),
    );
  });

  it('never carries image bytes, which belong in R2', async () => {
    // The machine-enforced half of "images live in R2, not D1". Storing a
    // pasted photo as a data URL would work in the editor and then quietly
    // multiply the size of every nightly dump by the size of a phone camera
    // roll — and the backup is the last place anyone looks.
    const key = await runBackup(env, new Date('2026-09-24T07:00:00Z'));
    const raw = await (await env.MEDIA.get(key))!.text();
    expect(raw).not.toContain('data:image');
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
