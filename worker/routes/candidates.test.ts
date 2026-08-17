import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { call, callJson, inviteAndAccept, signUpCoach, stubResend } from './_helpers';

beforeAll(() => {
  stubResend();
});

interface Candidate {
  id: string;
  source_type: string;
  source_id: string;
  state: string;
  suggested_award: string | null;
  preview?: { text?: string; kind?: string } | null;
  source_deleted?: boolean;
}

async function meetingWithBlock(
  cookie: string,
  text = 'a paragraph worth keeping',
): Promise<{ meetingId: string; blockId: string }> {
  const season = await callJson<{ starts_at: number }>('/api/season/current', { cookie });
  const meeting = await callJson<{ meeting: { id: string } }>('/api/meetings', {
    method: 'POST',
    cookie,
    body: JSON.stringify({ starts_at: season.body.starts_at + 7 * 86400 }),
  });
  const block = await callJson<{ block: { id: string } }>(
    `/api/meetings/${meeting.body.meeting.id}/blocks`,
    { method: 'POST', cookie, body: JSON.stringify({ text }) },
  );
  return { meetingId: meeting.body.meeting.id, blockId: block.body.block.id };
}

describe('flagging', () => {
  it('flags a paragraph and lists it with enough context to read later', async () => {
    const cookie = await signUpCoach(6100);
    const { meetingId, blockId } = await meetingWithBlock(cookie, 'We moved to a 4-bar');

    const flagged = await callJson<{ candidate: Candidate }>(
      '/api/portfolio/candidates',
      {
        method: 'POST',
        cookie,
        body: JSON.stringify({ source_type: 'meeting_block', source_id: blockId }),
      },
    );
    expect(flagged.status).toBe(201);
    expect(flagged.body.candidate.state).toBe('candidate');
    // No award required at flag time — that is a March question.
    expect(flagged.body.candidate.suggested_award).toBeNull();

    const { body } = await callJson<{ candidates: Candidate[] }>(
      '/api/portfolio/candidates',
      { cookie },
    );
    expect(body.candidates).toHaveLength(1);
    // Hydrated, so the inbox does not have to open the meeting to be readable.
    expect(body.candidates[0].preview?.text).toBe('We moved to a 4-bar');
    expect(body.candidates[0].source_deleted).toBe(false);
    void meetingId;
  });

  it('is idempotent, so a double tap reads as "yes, it worked"', async () => {
    const cookie = await signUpCoach(6101);
    const { blockId } = await meetingWithBlock(cookie);
    const payload = JSON.stringify({
      source_type: 'meeting_block',
      source_id: blockId,
    });

    const first = await callJson<{ candidate: Candidate }>('/api/portfolio/candidates', {
      method: 'POST',
      cookie,
      body: payload,
    });
    const second = await callJson<{ candidate: Candidate }>('/api/portfolio/candidates', {
      method: 'POST',
      cookie,
      body: payload,
    });

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.candidate.id).toBe(first.body.candidate.id);

    const { body } = await callJson<{ candidates: Candidate[] }>(
      '/api/portfolio/candidates',
      { cookie },
    );
    expect(body.candidates).toHaveLength(1);
  });

  it('unflags by source, without the client knowing the candidate id', async () => {
    const cookie = await signUpCoach(6102);
    const { blockId } = await meetingWithBlock(cookie);
    await call('/api/portfolio/candidates', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ source_type: 'meeting_block', source_id: blockId }),
    });

    const removed = await call(
      `/api/portfolio/candidates?source_type=meeting_block&source_id=${blockId}`,
      { method: 'DELETE', cookie },
    );
    expect(removed.status).toBe(200);

    const { body } = await callJson<{ candidates: Candidate[] }>(
      '/api/portfolio/candidates',
      { cookie },
    );
    expect(body.candidates).toHaveLength(0);
  });

  it('flags a whole meeting as well as a paragraph', async () => {
    // "an entry, single paragraph, picture, or whole page" — the page is the
    // meeting, and both live in the same inbox.
    const cookie = await signUpCoach(6103);
    const { meetingId, blockId } = await meetingWithBlock(cookie);

    for (const [type, id] of [
      ['meeting', meetingId],
      ['meeting_block', blockId],
    ] as const) {
      const response = await call('/api/portfolio/candidates', {
        method: 'POST',
        cookie,
        body: JSON.stringify({ source_type: type, source_id: id }),
      });
      expect(response.status).toBe(201);
    }

    const { body } = await callJson<{ candidates: Candidate[] }>(
      '/api/portfolio/candidates',
      { cookie },
    );
    expect(body.candidates.map((c) => c.source_type).sort()).toEqual([
      'meeting',
      'meeting_block',
    ]);
  });

  it('refuses to flag something that is not there', async () => {
    const cookie = await signUpCoach(6104);
    const { status, body } = await callJson<{ error: string }>(
      '/api/portfolio/candidates',
      {
        method: 'POST',
        cookie,
        body: JSON.stringify({
          source_type: 'meeting_block',
          source_id: crypto.randomUUID(),
        }),
      },
    );
    expect(status).toBe(404);
    expect(body.error).toBe('source_not_found');
  });

  it('keeps a flag listed when its block is deleted, and says so', async () => {
    const cookie = await signUpCoach(6105);
    const { meetingId, blockId } = await meetingWithBlock(cookie);
    await call('/api/portfolio/candidates', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ source_type: 'meeting_block', source_id: blockId }),
    });

    await call(`/api/meetings/${meetingId}/blocks/${blockId}`, {
      method: 'DELETE',
      cookie,
    });

    const { body } = await callJson<{ candidates: Candidate[] }>(
      '/api/portfolio/candidates',
      { cookie },
    );
    expect(body.candidates).toHaveLength(1);
    // The flag was one person's decision; the delete was another's action.
    expect(body.candidates[0].source_deleted).toBe(true);
  });
});

describe('triage', () => {
  it('lets a student shortlist and set aside, but not place on a page', async () => {
    const coach = await signUpCoach(6200);
    const { blockId } = await meetingWithBlock(coach);
    const student = await inviteAndAccept(coach, { role: 'student', handle: 'triager' });

    const flagged = await callJson<{ candidate: Candidate }>(
      '/api/portfolio/candidates',
      {
        method: 'POST',
        cookie: student.cookie,
        body: JSON.stringify({ source_type: 'meeting_block', source_id: blockId }),
      },
    );
    expect(flagged.status).toBe(201);

    const shortlisted = await callJson<{ candidate: Candidate }>(
      `/api/portfolio/candidates/${flagged.body.candidate.id}`,
      {
        method: 'PATCH',
        cookie: student.cookie,
        body: JSON.stringify({ state: 'shortlisted', suggested_award: 'think' }),
      },
    );
    expect(shortlisted.status).toBe(200);
    expect(shortlisted.body.candidate.state).toBe('shortlisted');
    expect(shortlisted.body.candidate.suggested_award).toBe('think');

    // Fifteen pages is a scarce, contested resource, so placement is not theirs.
    const placed = await call(
      `/api/portfolio/candidates/${flagged.body.candidate.id}`,
      {
        method: 'PATCH',
        cookie: student.cookie,
        body: JSON.stringify({ state: 'placed', placed_page_id: 'x' }),
      },
    );
    expect(placed.status).toBe(403);
  });

  it('does not unmark the source when something is set aside', async () => {
    const cookie = await signUpCoach(6201);
    const { blockId } = await meetingWithBlock(cookie);
    const flagged = await callJson<{ candidate: Candidate }>(
      '/api/portfolio/candidates',
      {
        method: 'POST',
        cookie,
        body: JSON.stringify({ source_type: 'meeting_block', source_id: blockId }),
      },
    );

    await call(`/api/portfolio/candidates/${flagged.body.candidate.id}`, {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ state: 'rejected' }),
    });

    // The row survives, so the student's own mark in their own notes is intact.
    const row = await env.DB.prepare(
      'SELECT state FROM portfolio_candidates WHERE source_id = ?',
    )
      .bind(blockId)
      .first<{ state: string }>();
    expect(row?.state).toBe('rejected');
  });

  it('rejects an unknown award key rather than storing it', async () => {
    const cookie = await signUpCoach(6202);
    const { blockId } = await meetingWithBlock(cookie);
    const { status, body } = await callJson<{ error: string }>(
      '/api/portfolio/candidates',
      {
        method: 'POST',
        cookie,
        body: JSON.stringify({
          source_type: 'meeting_block',
          source_id: blockId,
          suggested_award: 'best_robot',
        }),
      },
    );
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_award');
  });

  it('blocks viewers from flagging at all', async () => {
    // A viewer is a parent or a sponsor. An outsider should not be nominating
    // content into the team's award submission.
    const coach = await signUpCoach(6203);
    const { blockId } = await meetingWithBlock(coach);
    const viewer = await inviteAndAccept(coach, { role: 'viewer', handle: 'sponsor' });

    const response = await call('/api/portfolio/candidates', {
      method: 'POST',
      cookie: viewer.cookie,
      body: JSON.stringify({ source_type: 'meeting_block', source_id: blockId }),
    });
    expect(response.status).toBe(403);
  });
});

describe('portfolio pages', () => {
  it('seeds a cover plus fifteen pages once', async () => {
    const cookie = await signUpCoach(6300);
    const first = await callJson<{ pages: { page_no: number }[] }>(
      '/api/portfolio/pages',
      { cookie },
    );
    expect(first.status).toBe(200);
    // The Competition Manual's hard limit: one cover plus fifteen.
    expect(first.body.pages).toHaveLength(16);
    expect(first.body.pages[0].page_no).toBe(0);
    expect(first.body.pages[15].page_no).toBe(15);

    const second = await callJson<{ pages: unknown[] }>('/api/portfolio/pages', {
      cookie,
    });
    expect(second.body.pages).toHaveLength(16);
  });
});

describe('tenancy isolation', () => {
  it('never lets one team flag, read or triage another team\'s work', async () => {
    const alpha = await signUpCoach(6400);
    const beta = await signUpCoach(6401);

    const betaWork = await meetingWithBlock(beta, 'BETA-CANDIDATE-MARKER');
    const betaFlag = await callJson<{ candidate: Candidate }>(
      '/api/portfolio/candidates',
      {
        method: 'POST',
        cookie: beta,
        body: JSON.stringify({
          source_type: 'meeting_block',
          source_id: betaWork.blockId,
        }),
      },
    );

    // Flagging another team's block must not create a row.
    const before = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM portfolio_candidates',
    ).first<{ n: number }>();
    const attempt = await callJson<{ error: string }>('/api/portfolio/candidates', {
      method: 'POST',
      cookie: alpha,
      body: JSON.stringify({
        source_type: 'meeting_block',
        source_id: betaWork.blockId,
      }),
    });
    expect(attempt.status).toBe(404);
    expect(attempt.body.error).toBe('source_not_found');
    const after = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM portfolio_candidates',
    ).first<{ n: number }>();
    expect(after?.n).toBe(before?.n);

    // The inbox never leaks across teams.
    const list = await call('/api/portfolio/candidates', { cookie: alpha });
    expect(await list.text()).not.toContain('BETA-CANDIDATE-MARKER');

    // Triaging another team's candidate by id.
    expect(
      (
        await call(`/api/portfolio/candidates/${betaFlag.body.candidate.id}`, {
          method: 'PATCH',
          cookie: alpha,
          body: JSON.stringify({ state: 'rejected' }),
        })
      ).status,
    ).toBe(404);

    // Unflagging another team's candidate by source.
    expect(
      (
        await call(
          `/api/portfolio/candidates?source_type=meeting_block&source_id=${betaWork.blockId}`,
          { method: 'DELETE', cookie: alpha },
        )
      ).status,
    ).toBe(404);

    const survives = await env.DB.prepare(
      'SELECT state FROM portfolio_candidates WHERE id = ?',
    )
      .bind(betaFlag.body.candidate.id)
      .first<{ state: string }>();
    expect(survives?.state).toBe('candidate');
  });

  it('requires a session', async () => {
    expect((await call('/api/portfolio/candidates')).status).toBe(401);
    expect((await call('/api/portfolio/pages')).status).toBe(401);
    expect(
      (
        await call('/api/portfolio/candidates', {
          method: 'POST',
          body: JSON.stringify({}),
        })
      ).status,
    ).toBe(401);
  });
});
