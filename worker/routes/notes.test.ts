import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { call, callJson, inviteAndAccept, signUpCoach, stubResend } from './_helpers';

beforeAll(() => {
  stubResend();
});

interface DocSummary {
  id: string;
  title: string;
  content_bytes: number;
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

describe('agenda and starting a meeting', () => {
  it('seeds one document with a heading and a place to type per agenda item', async () => {
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
      doc_id: string | null;
      docs: DocSummary[];
    }>(`/api/meetings/${meetingId}/start`, { method: 'POST', cookie });

    expect(started.status).toBe(200);
    expect(started.body.meeting.status).toBe('held');
    // ONE document now, not two blocks per agenda item — the agenda becomes the
    // document's outline rather than a flat run of sibling rows.
    expect(started.body.docs).toHaveLength(1);
    expect(started.body.doc_id).toBe(started.body.docs[0].id);

    const doc = await callJson<{ doc: { content: string; content_text: string } }>(
      `/api/notes/${started.body.doc_id}`,
      { cookie },
    );
    const parsed = JSON.parse(doc.body.doc.content) as {
      content: { type: string; content?: { text: string }[] }[];
    };
    expect(parsed.content.map((n) => [n.type, n.content?.[0]?.text ?? ''])).toEqual([
      ['heading', 'Intake redesign'],
      ['paragraph', ''],
      ['heading', 'Outreach at the library'],
      ['paragraph', ''],
    ]);
    // content_text is derived on the way in, so search and excerpts work from the
    // first save rather than from the first edit.
    expect(doc.body.doc.content_text).toBe('Intake redesign Outreach at the library');
  });

  it('is idempotent, because fifteen people press start at once', async () => {
    const cookie = await signUpCoach(5301);
    const meetingId = await makeMeeting(cookie);
    await call(`/api/meetings/${meetingId}/agenda`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ title: 'Only once' }),
    });

    const first = await callJson<{ doc_id: string | null; docs: DocSummary[] }>(
      `/api/meetings/${meetingId}/start`,
      { method: 'POST', cookie },
    );
    const second = await callJson<{ doc_id: string | null; docs: DocSummary[] }>(
      `/api/meetings/${meetingId}/start`,
      { method: 'POST', cookie },
    );

    expect(first.body.doc_id).not.toBeNull();
    // The second press seeds nothing and says so by returning a null doc_id: the
    // caller already has the tree. WHERE started_at IS NULL is the whole story.
    expect(second.body.doc_id).toBeNull();
    expect(second.body.docs.map((d) => d.id)).toEqual(
      first.body.docs.map((d) => d.id),
    );
  });

  it('does not wipe notes if start is pressed again after typing', async () => {
    const cookie = await signUpCoach(5302);
    const meetingId = await makeMeeting(cookie);
    const started = await callJson<{ doc_id: string }>(
      `/api/meetings/${meetingId}/start`,
      { method: 'POST', cookie },
    );

    await callJson(`/api/notes/${started.body.doc_id}/content`, {
      method: 'PUT',
      cookie,
      body: JSON.stringify({
        content: JSON.stringify({
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'real notes' }] }],
        }),
      }),
    });

    await call(`/api/meetings/${meetingId}/start`, { method: 'POST', cookie });
    const doc = await callJson<{ doc: { content_text: string } }>(
      `/api/notes/${started.body.doc_id}`,
      { cookie },
    );
    expect(doc.body.doc.content_text).toBe('real notes');
  });

  it('starts a meeting with no agenda at all', async () => {
    // An empty agenda still needs a document with somewhere to put the caret,
    // otherwise the button appears to do nothing.
    const cookie = await signUpCoach(5303);
    const meetingId = await makeMeeting(cookie);
    const started = await callJson<{ doc_id: string; docs: DocSummary[] }>(
      `/api/meetings/${meetingId}/start`,
      { method: 'POST', cookie },
    );
    expect(started.body.docs).toHaveLength(1);
    expect(started.body.docs[0].content_bytes).toBeGreaterThan(0);
  });
});

describe('agenda permissions and tenancy', () => {
  it('lets students edit the agenda and viewers only read it', async () => {
    const coach = await signUpCoach(5500);
    const meetingId = await makeMeeting(coach);
    const student = await inviteAndAccept(coach, { role: 'student', handle: 'planner' });
    const viewer = await inviteAndAccept(coach, { role: 'viewer', handle: 'watcher' });

    expect(
      (
        await call(`/api/meetings/${meetingId}/agenda`, {
          method: 'POST',
          cookie: student.cookie,
          body: JSON.stringify({ title: 'Student point' }),
        })
      ).status,
    ).toBe(201);

    expect(
      (
        await call(`/api/meetings/${meetingId}/agenda`, {
          method: 'POST',
          cookie: viewer.cookie,
          body: JSON.stringify({ title: 'Nope' }),
        })
      ).status,
    ).toBe(403);

    expect(
      (await call(`/api/meetings/${meetingId}/agenda`, { cookie: viewer.cookie })).status,
    ).toBe(200);
  });

  it("never lets one team seed or read another team's agenda", async () => {
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

    // Alpha's start attempt must not have flipped beta's meeting to held, and must
    // not have seeded a document into beta's season.
    const meeting = await env.DB.prepare(
      'SELECT status, started_at FROM meetings WHERE id = ?',
    )
      .bind(betaMeeting)
      .first<{ status: string; started_at: number | null }>();
    expect(meeting?.status).toBe('planned');
    expect(meeting?.started_at).toBeNull();

    const seeded = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM note_docs WHERE meeting_id = ?',
    )
      .bind(betaMeeting)
      .first<{ n: number }>();
    expect(seeded?.n).toBe(0);
  });

  it('requires a session for every agenda route', async () => {
    const paths: [string, string][] = [
      ['GET', '/api/meetings/x/agenda'],
      ['POST', '/api/meetings/x/agenda'],
      ['PATCH', '/api/meetings/x/agenda/y'],
      ['DELETE', '/api/meetings/x/agenda/y'],
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
