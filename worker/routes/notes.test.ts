import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { call, callJson, inviteAndAccept, signUpCoach, stubResend, whoami } from './_helpers';

beforeAll(() => {
  stubResend();
});

interface Block {
  id: string;
  kind: string;
  text: string;
  position: number;
  media_id: string | null;
  updated_at: number;
}

async function makeMeeting(cookie: string): Promise<string> {
  const season = await callJson<{ starts_at: number }>('/api/season/current', { cookie });
  const created = await callJson<{ meeting: { id: string } }>('/api/meetings', {
    method: 'POST',
    cookie,
    body: JSON.stringify({ starts_at: season.body.starts_at + 7 * 86400 }),
  });
  expect(created.status).toBe(201);
  return created.body.meeting.id;
}

async function addBlock(
  cookie: string,
  meetingId: string,
  body: Record<string, unknown>,
): Promise<Block> {
  const { status, body: result } = await callJson<{ block: Block }>(
    `/api/meetings/${meetingId}/blocks`,
    { method: 'POST', cookie, body: JSON.stringify(body) },
  );
  expect([200, 201]).toContain(status);
  return result.block;
}

async function readBlocks(cookie: string, meetingId: string): Promise<Block[]> {
  const { body } = await callJson<{ blocks: Block[] }>(
    `/api/meetings/${meetingId}/blocks`,
    { cookie },
  );
  return body.blocks;
}

describe('note blocks', () => {
  it('appends blocks in order and reads them back', async () => {
    const cookie = await signUpCoach(5100);
    const meetingId = await makeMeeting(cookie);

    await addBlock(cookie, meetingId, { kind: 'heading', text: 'Intake' });
    await addBlock(cookie, meetingId, { kind: 'paragraph', text: 'Tried a 4-bar.' });
    await addBlock(cookie, meetingId, { kind: 'decision', text: 'Going with the 4-bar.' });

    const blocks = await readBlocks(cookie, meetingId);
    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'paragraph', 'decision']);
    expect(blocks.map((b) => b.text)).toEqual([
      'Intake',
      'Tried a 4-bar.',
      'Going with the 4-bar.',
    ]);
    // Sparse positions, so an insert-between is a one-row write.
    expect(blocks[1].position).toBeGreaterThan(blocks[0].position);
  });

  it('inserts between two blocks without renumbering the tail', async () => {
    const cookie = await signUpCoach(5101);
    const meetingId = await makeMeeting(cookie);

    const first = await addBlock(cookie, meetingId, { text: 'one' });
    const third = await addBlock(cookie, meetingId, { text: 'three' });
    const second = await addBlock(cookie, meetingId, {
      text: 'two',
      after_id: first.id,
    });

    const blocks = await readBlocks(cookie, meetingId);
    expect(blocks.map((b) => b.text)).toEqual(['one', 'two', 'three']);
    // The block that was already there did not move.
    const thirdNow = blocks.find((b) => b.id === third.id);
    expect(thirdNow?.position).toBe(third.position);
    expect(second.position).toBeGreaterThan(first.position);
    expect(second.position).toBeLessThan(third.position);
  });

  it('accepts a client-chosen id so a flag can attach before the save lands', async () => {
    const cookie = await signUpCoach(5102);
    const meetingId = await makeMeeting(cookie);
    const chosen = crypto.randomUUID();

    const block = await addBlock(cookie, meetingId, { id: chosen, text: 'typed fast' });
    expect(block.id).toBe(chosen);
  });

  it('returns the existing row when a create is retried', async () => {
    // Flaky shop wifi means the client retries. A retried insert that the
    // server already applied must not duplicate a paragraph the student
    // watched appear once.
    const cookie = await signUpCoach(5103);
    const meetingId = await makeMeeting(cookie);
    const id = crypto.randomUUID();

    await addBlock(cookie, meetingId, { id, text: 'only once' });
    const retry = await callJson<{ block: Block }>(`/api/meetings/${meetingId}/blocks`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ id, text: 'only once' }),
    });
    expect(retry.status).toBe(200);
    expect(retry.body.block.id).toBe(id);
    expect(await readBlocks(cookie, meetingId)).toHaveLength(1);
  });

  it('writes nothing when an autosave has not actually changed the text', async () => {
    const cookie = await signUpCoach(5104);
    const meetingId = await makeMeeting(cookie);
    const block = await addBlock(cookie, meetingId, { text: 'unchanged' });

    const same = await callJson<{ unchanged?: boolean }>(
      `/api/meetings/${meetingId}/blocks/${block.id}`,
      { method: 'PATCH', cookie, body: JSON.stringify({ text: 'unchanged' }) },
    );
    expect(same.status).toBe(200);
    // The conditional UPDATE matched nothing, which is the point: an idle
    // editor firing its debounce costs zero rows written.
    expect(same.body.unchanged).toBe(true);

    const changed = await callJson<{ unchanged?: boolean; block: Block }>(
      `/api/meetings/${meetingId}/blocks/${block.id}`,
      { method: 'PATCH', cookie, body: JSON.stringify({ text: 'changed' }) },
    );
    expect(changed.body.unchanged).toBeUndefined();
    expect(changed.body.block.text).toBe('changed');
  });

  it('soft deletes and restores, keeping the block out of reads in between', async () => {
    const cookie = await signUpCoach(5105);
    const meetingId = await makeMeeting(cookie);
    const block = await addBlock(cookie, meetingId, { text: 'delete me' });

    const deleted = await callJson<{ candidate_orphaned: boolean }>(
      `/api/meetings/${meetingId}/blocks/${block.id}`,
      { method: 'DELETE', cookie },
    );
    expect(deleted.status).toBe(200);
    expect(deleted.body.candidate_orphaned).toBe(false);
    expect(await readBlocks(cookie, meetingId)).toHaveLength(0);

    // Still in D1 — this is a soft delete, which is what makes undo possible.
    const row = await env.DB.prepare(
      'SELECT deleted_at, text FROM meeting_note_blocks WHERE id = ?',
    )
      .bind(block.id)
      .first<{ deleted_at: number | null; text: string }>();
    expect(row?.deleted_at).not.toBeNull();
    expect(row?.text).toBe('delete me');

    const restored = await call(
      `/api/meetings/${meetingId}/blocks/${block.id}/restore`,
      { method: 'POST', cookie },
    );
    expect(restored.status).toBe(200);
    const back = await readBlocks(cookie, meetingId);
    expect(back).toHaveLength(1);
    expect(back[0].text).toBe('delete me');
  });

  it('keeps a portfolio flag alive when the block it points at is deleted', async () => {
    // The rule this encodes: the flag is a decision one person made and the
    // delete is an action another person took, and the second must not silently
    // undo the first.
    const cookie = await signUpCoach(5106);
    const meetingId = await makeMeeting(cookie);
    const block = await addBlock(cookie, meetingId, { text: 'worth keeping' });
    const me = await whoami(cookie);

    const season = await callJson<{ id: string }>('/api/season/current', { cookie });
    await env.DB.prepare(
      `INSERT INTO portfolio_candidates
         (id, team_id, season_id, source_type, source_id, state, flagged_by,
          created_at, updated_at)
       VALUES (?, ?, ?, 'meeting_block', ?, 'candidate', ?, 0, 0)`,
    )
      .bind(crypto.randomUUID(), me.team_id, season.body.id, block.id, me.member_id)
      .run();

    const deleted = await callJson<{ candidate_orphaned: boolean }>(
      `/api/meetings/${meetingId}/blocks/${block.id}`,
      { method: 'DELETE', cookie },
    );
    expect(deleted.body.candidate_orphaned).toBe(true);

    const flag = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM portfolio_candidates WHERE source_id = ?',
    )
      .bind(block.id)
      .first<{ n: number }>();
    expect(flag?.n).toBe(1);
  });

  it('caps the block count rather than letting one meeting grow forever', async () => {
    const cookie = await signUpCoach(5107);
    const meetingId = await makeMeeting(cookie);
    const me = await whoami(cookie);

    // Seeded directly: 500 round trips through the API would make this suite
    // the slowest thing in CI to prove one boundary.
    const statements = Array.from({ length: 500 }, (_, i) =>
      env.DB.prepare(
        `INSERT INTO meeting_note_blocks
           (id, team_id, meeting_id, position, kind, text, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'paragraph', '', 0, 0)`,
      ).bind(crypto.randomUUID(), me.team_id, meetingId, i * 1024),
    );
    for (let i = 0; i < statements.length; i += 50) {
      await env.DB.batch(statements.slice(i, i + 50));
    }

    const { status, body } = await callJson<{ error: string }>(
      `/api/meetings/${meetingId}/blocks`,
      { method: 'POST', cookie, body: JSON.stringify({ text: 'one too many' }) },
    );
    expect(status).toBe(409);
    expect(body.error).toBe('too_many_blocks');
  });
});

describe('structural writes', () => {
  it('inserts, updates, reorders and deletes in one atomic call', async () => {
    const cookie = await signUpCoach(5200);
    const meetingId = await makeMeeting(cookie);

    const a = await addBlock(cookie, meetingId, { text: 'keep' });
    const b = await addBlock(cookie, meetingId, { text: 'drop' });

    const { status, body } = await callJson<{ blocks: Block[] }>(
      `/api/meetings/${meetingId}/blocks`,
      {
        method: 'PUT',
        cookie,
        body: JSON.stringify({
          blocks: [
            { kind: 'heading', text: 'new first' },
            { id: a.id, kind: 'paragraph', text: 'kept and edited' },
          ],
        }),
      },
    );

    expect(status).toBe(200);
    expect(body.blocks.map((x) => x.text)).toEqual(['new first', 'kept and edited']);
    // The block absent from the body is gone from reads...
    expect(body.blocks.find((x) => x.id === b.id)).toBeUndefined();
    // ...but soft-deleted, not destroyed.
    const dropped = await env.DB.prepare(
      'SELECT deleted_at FROM meeting_note_blocks WHERE id = ?',
    )
      .bind(b.id)
      .first<{ deleted_at: number | null }>();
    expect(dropped?.deleted_at).not.toBeNull();
  });

  it('renormalises positions so repeated inserts cannot run out of room', async () => {
    const cookie = await signUpCoach(5201);
    const meetingId = await makeMeeting(cookie);

    const { body } = await callJson<{ blocks: Block[] }>(
      `/api/meetings/${meetingId}/blocks`,
      {
        method: 'PUT',
        cookie,
        body: JSON.stringify({
          blocks: [
            { text: 'a', position: 1.0000001 },
            { text: 'b', position: 1.0000002 },
            { text: 'c', position: 1.0000003 },
          ],
        }),
      },
    );

    const positions = body.blocks.map((x) => x.position);
    expect(positions).toEqual([1024, 2048, 3072]);
  });

  it('refuses an oversized structural write', async () => {
    const cookie = await signUpCoach(5202);
    const meetingId = await makeMeeting(cookie);
    const { status, body } = await callJson<{ error: string }>(
      `/api/meetings/${meetingId}/blocks`,
      {
        method: 'PUT',
        cookie,
        body: JSON.stringify({
          blocks: Array.from({ length: 251 }, () => ({ text: 'x' })),
        }),
      },
    );
    expect(status).toBe(409);
    expect(body.error).toBe('too_many_blocks');
  });
});

describe('agenda and starting a meeting', () => {
  it('seeds a heading and a place to type per agenda item', async () => {
    const cookie = await signUpCoach(5300);
    const meetingId = await makeMeeting(cookie);

    for (const title of ['Intake redesign', 'Outreach at the library']) {
      const created = await call(`/api/meetings/${meetingId}/agenda`, {
        method: 'POST',
        cookie,
        body: JSON.stringify({ title }),
      });
      expect(created.status).toBe(201);
    }

    const started = await callJson<{
      meeting: { status: string; started_at: number };
      blocks: Block[];
    }>(`/api/meetings/${meetingId}/start`, { method: 'POST', cookie });

    expect(started.status).toBe(200);
    expect(started.body.meeting.status).toBe('held');
    expect(started.body.blocks.map((b) => [b.kind, b.text])).toEqual([
      ['heading', 'Intake redesign'],
      ['paragraph', ''],
      ['heading', 'Outreach at the library'],
      ['paragraph', ''],
    ]);
  });

  it('is idempotent, because fifteen people press start at once', async () => {
    const cookie = await signUpCoach(5301);
    const meetingId = await makeMeeting(cookie);
    await call(`/api/meetings/${meetingId}/agenda`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ title: 'Only once' }),
    });

    const first = await callJson<{ blocks: Block[] }>(
      `/api/meetings/${meetingId}/start`,
      { method: 'POST', cookie },
    );
    const second = await callJson<{ blocks: Block[] }>(
      `/api/meetings/${meetingId}/start`,
      { method: 'POST', cookie },
    );

    expect(second.body.blocks).toHaveLength(first.body.blocks.length);
    expect(second.body.blocks.map((b) => b.id)).toEqual(
      first.body.blocks.map((b) => b.id),
    );
  });

  it('does not wipe notes if start is pressed again after typing', async () => {
    const cookie = await signUpCoach(5302);
    const meetingId = await makeMeeting(cookie);
    await call(`/api/meetings/${meetingId}/start`, { method: 'POST', cookie });
    await addBlock(cookie, meetingId, { text: 'real notes' });

    await call(`/api/meetings/${meetingId}/start`, { method: 'POST', cookie });
    const blocks = await readBlocks(cookie, meetingId);
    expect(blocks.map((b) => b.text)).toContain('real notes');
  });
});

describe('the rev poll', () => {
  it('changes on every kind of write, and costs one row', async () => {
    const cookie = await signUpCoach(5400);
    const meetingId = await makeMeeting(cookie);

    const rev = async () =>
      (
        await callJson<{ rev: number; count: number }>(
          `/api/meetings/${meetingId}/blocks/rev`,
          { cookie },
        )
      ).body;

    const empty = await rev();
    expect(empty.count).toBe(0);

    const block = await addBlock(cookie, meetingId, { text: 'first' });
    const afterInsert = await rev();
    expect(afterInsert.count).toBe(1);
    expect(afterInsert.rev).toBeGreaterThanOrEqual(empty.rev);

    await callJson(`/api/meetings/${meetingId}/blocks/${block.id}`, {
      method: 'DELETE',
      cookie,
    });
    const afterDelete = await rev();
    expect(afterDelete.count).toBe(0);
  });
});

describe('permissions', () => {
  it('lets students write notes and viewers only read them', async () => {
    const coach = await signUpCoach(5500);
    const meetingId = await makeMeeting(coach);
    const student = await inviteAndAccept(coach, { role: 'student', handle: 'notetaker' });
    const viewer = await inviteAndAccept(coach, { role: 'viewer', handle: 'parent' });

    // Students taking notes is the entire point of the feature.
    const written = await call(`/api/meetings/${meetingId}/blocks`, {
      method: 'POST',
      cookie: student.cookie,
      body: JSON.stringify({ text: 'the build lead said' }),
    });
    expect(written.status).toBe(201);

    const blocked = await call(`/api/meetings/${meetingId}/blocks`, {
      method: 'POST',
      cookie: viewer.cookie,
      body: JSON.stringify({ text: 'not mine to write' }),
    });
    expect(blocked.status).toBe(403);

    const read = await call(`/api/meetings/${meetingId}/blocks`, {
      cookie: viewer.cookie,
    });
    expect(read.status).toBe(200);
  });

  it('lets a student edit a block somebody else wrote', async () => {
    // A shared document where you can only fix your own paragraphs is unusable
    // the moment somebody types a typo and goes home.
    const coach = await signUpCoach(5501);
    const meetingId = await makeMeeting(coach);
    const student = await inviteAndAccept(coach, { role: 'student', handle: 'fixer' });
    const block = await addBlock(coach, meetingId, { text: 'teh intake' });

    const fixed = await callJson<{ block: Block }>(
      `/api/meetings/${meetingId}/blocks/${block.id}`,
      { method: 'PATCH', cookie: student.cookie, body: JSON.stringify({ text: 'the intake' }) },
    );
    expect(fixed.status).toBe(200);
    expect(fixed.body.block.text).toBe('the intake');

    // ...and the record stays answerable about who touched it last.
    const row = await env.DB.prepare(
      'SELECT created_by_member_id, updated_by_member_id FROM meeting_note_blocks WHERE id = ?',
    )
      .bind(block.id)
      .first<{ created_by_member_id: string; updated_by_member_id: string }>();
    expect(row?.created_by_member_id).not.toBe(row?.updated_by_member_id);
  });
});

describe('tenancy isolation', () => {
  it('never lets one team read or write another team\'s notes', async () => {
    const alpha = await signUpCoach(5600);
    const beta = await signUpCoach(5601);

    const betaMeeting = await makeMeeting(beta);
    const betaBlock = await addBlock(beta, betaMeeting, {
      text: 'BETA-NOTES-MARKER',
    });

    // Reading another team's blocks by meeting id.
    const read = await call(`/api/meetings/${betaMeeting}/blocks`, { cookie: alpha });
    expect(read.status).toBe(404);
    expect(await read.text()).not.toContain('BETA-NOTES-MARKER');

    // Writing into another team's meeting.
    expect(
      (
        await call(`/api/meetings/${betaMeeting}/blocks`, {
          method: 'POST',
          cookie: alpha,
          body: JSON.stringify({ text: 'ALPHA WAS HERE' }),
        })
      ).status,
    ).toBe(404);

    // Editing another team's block, naming both ids correctly.
    expect(
      (
        await call(`/api/meetings/${betaMeeting}/blocks/${betaBlock.id}`, {
          method: 'PATCH',
          cookie: alpha,
          body: JSON.stringify({ text: 'ALPHA WAS HERE' }),
        })
      ).status,
    ).toBe(404);

    expect(
      (
        await call(`/api/meetings/${betaMeeting}/blocks/${betaBlock.id}`, {
          method: 'DELETE',
          cookie: alpha,
        })
      ).status,
    ).toBe(404);

    expect(
      (
        await call(`/api/meetings/${betaMeeting}/blocks`, {
          method: 'PUT',
          cookie: alpha,
          body: JSON.stringify({ blocks: [{ text: 'ALPHA WAS HERE' }] }),
        })
      ).status,
    ).toBe(404);

    // The row is byte-identical afterwards. Checked against D1 directly,
    // because "not found" and "the UPDATE matched zero rows" look the same
    // from outside and only one of them is safe.
    const row = await env.DB.prepare(
      'SELECT text, deleted_at FROM meeting_note_blocks WHERE id = ?',
    )
      .bind(betaBlock.id)
      .first<{ text: string; deleted_at: number | null }>();
    expect(row?.text).toBe('BETA-NOTES-MARKER');
    expect(row?.deleted_at).toBeNull();

    const count = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM meeting_note_blocks WHERE meeting_id = ?',
    )
      .bind(betaMeeting)
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it('never lets one team seed or read another team\'s agenda', async () => {
    const alpha = await signUpCoach(5602);
    const beta = await signUpCoach(5603);
    const betaMeeting = await makeMeeting(beta);

    await call(`/api/meetings/${betaMeeting}/agenda`, {
      method: 'POST',
      cookie: beta,
      body: JSON.stringify({ title: 'BETA-AGENDA-MARKER' }),
    });

    const read = await call(`/api/meetings/${betaMeeting}/agenda`, { cookie: alpha });
    expect(read.status).toBe(404);
    expect(await read.text()).not.toContain('BETA-AGENDA-MARKER');

    expect(
      (await call(`/api/meetings/${betaMeeting}/start`, { method: 'POST', cookie: alpha }))
        .status,
    ).toBe(404);

    // Alpha's start attempt must not have flipped beta's meeting to held.
    const meeting = await env.DB.prepare(
      'SELECT status, started_at FROM meetings WHERE id = ?',
    )
      .bind(betaMeeting)
      .first<{ status: string; started_at: number | null }>();
    expect(meeting?.status).toBe('planned');
    expect(meeting?.started_at).toBeNull();
  });

  it('requires a session for every notes route', async () => {
    const paths: [string, string][] = [
      ['GET', '/api/meetings/x/blocks'],
      ['GET', '/api/meetings/x/blocks/rev'],
      ['POST', '/api/meetings/x/blocks'],
      ['PUT', '/api/meetings/x/blocks'],
      ['PATCH', '/api/meetings/x/blocks/y'],
      ['DELETE', '/api/meetings/x/blocks/y'],
      ['GET', '/api/meetings/x/agenda'],
      ['POST', '/api/meetings/x/agenda'],
      ['POST', '/api/meetings/x/start'],
    ];
    for (const [method, path] of paths) {
      const response = await call(path, {
        method,
        ...(method === 'GET' || method === 'DELETE' ? {} : { body: JSON.stringify({}) }),
      });
      expect(response.status, `${method} ${path}`).toBe(401);
    }
  });
});
