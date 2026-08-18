import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { call, callJson, inviteAndAccept, signUpCoach, stubResend, whoami } from './_helpers';
import { MAX_DEPTH, MAX_DOCS } from '../lib/notes';

beforeAll(() => {
  stubResend();
});

interface Doc {
  id: string;
  parent_doc_id: string | null;
  meeting_id: string | null;
  position: number;
  title: string;
  content: string;
  content_text: string;
  rev: number;
  created_by: string | null;
  updated_by: string | null;
  updated_at: number;
}

const body = (text: string) =>
  JSON.stringify({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  });

async function makeMeeting(cookie: string): Promise<string> {
  const season = await callJson<{ starts_at: number }>('/api/season/current', { cookie });
  const created = await callJson<{ meeting: { id: string } }>('/api/meetings', {
    method: 'POST',
    cookie,
    body: JSON.stringify({ starts_at: season.body.starts_at + 7 * 86400 }),
  });
  return created.body.meeting.id;
}

async function makeDoc(
  cookie: string,
  input: Record<string, unknown> = {},
): Promise<Doc> {
  const { status, body: result } = await callJson<{ doc: Doc }>('/api/notes', {
    method: 'POST',
    cookie,
    body: JSON.stringify(input),
  });
  expect([200, 201]).toContain(status);
  return result.doc;
}

async function putContent(
  cookie: string,
  docId: string,
  content: string,
  baseRev?: number,
) {
  return await callJson<{ doc: Doc; unchanged?: boolean; error?: string }>(
    `/api/notes/${docId}/content`,
    {
      method: 'PUT',
      cookie,
      body: JSON.stringify({ content, ...(baseRev !== undefined ? { base_rev: baseRev } : {}) }),
    },
  );
}

async function tree(cookie: string) {
  const { body: result } = await callJson<{
    docs: (Doc & { content_bytes: number; meeting_title: string | null })[];
    flagged: string[];
  }>('/api/notes', { cookie });
  return result;
}

describe('documents', () => {
  it('creates, reads, renames, and round-trips content byte-identical', async () => {
    const cookie = await signUpCoach(6100);
    const doc = await makeDoc(cookie, { title: 'Chassis notes' });
    expect(doc.title).toBe('Chassis notes');
    expect(doc.parent_doc_id).toBeNull();
    expect(doc.meeting_id).toBeNull();

    const content = body('Swapped to 2in wheels');
    const saved = await putContent(cookie, doc.id, content);
    expect(saved.status).toBe(200);
    // Byte-identical, not merely equivalent: the editor round-trips its own JSON
    // and a re-serialisation on the way through would churn every rev.
    expect(saved.body.doc.content).toBe(content);
    expect(saved.body.doc.content_text).toBe('Swapped to 2in wheels');

    const renamed = await callJson<{ doc: Doc }>(`/api/notes/${doc.id}`, {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ title: 'Chassis' }),
    });
    expect(renamed.body.doc.title).toBe('Chassis');
    // A rename must not touch content, or renaming clobbers a co-editor.
    expect(renamed.body.doc.content).toBe(content);
  });

  it('writes nothing when an autosave has not actually changed anything', async () => {
    // The D1 per-row billing invariant, carried over from the block routes. A
    // debounce that fires while nobody is typing must be free.
    const cookie = await signUpCoach(6101);
    const doc = await makeDoc(cookie);
    const content = body('settled');
    const first = await putContent(cookie, doc.id, content);

    const second = await putContent(cookie, doc.id, content);
    expect(second.body.unchanged).toBe(true);
    expect(second.body.doc.updated_at).toBe(first.body.doc.updated_at);
    // And it must not burn a rev: otherwise an idle debounce invalidates a
    // co-editor's base and they get a conflict over a write nobody made.
    expect(second.body.doc.rev).toBe(first.body.doc.rev);
  });

  it('derives content_text server-side and ignores a client that sends its own', async () => {
    const cookie = await signUpCoach(6102);
    const doc = await makeDoc(cookie);
    await callJson(`/api/notes/${doc.id}/content`, {
      method: 'PUT',
      cookie,
      body: JSON.stringify({
        content: body('the real words'),
        content_text: 'LIES',
      }),
    });
    const row = await env.DB.prepare('SELECT content_text FROM note_docs WHERE id = ?')
      .bind(doc.id)
      .first<{ content_text: string }>();
    expect(row?.content_text).toBe('the real words');
  });

  it('refuses a body the editor could not render', async () => {
    const cookie = await signUpCoach(6103);
    const doc = await makeDoc(cookie);
    const forged = JSON.stringify({ type: 'doc', content: [{ type: 'script' }] });
    const response = await callJson<{ error: string }>(`/api/notes/${doc.id}/content`, {
      method: 'PUT',
      cookie,
      body: JSON.stringify({ content: forged }),
    });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_content');
  });

  it('caps the document count rather than letting a season grow forever', async () => {
    const cookie = await signUpCoach(6104);
    const me = await whoami(cookie);
    const season = await callJson<{ id: string }>('/api/season/current', { cookie });

    // Seeded directly, in batches: going through the API MAX_DOCS times would make
    // this the slowest thing in CI for no extra coverage.
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < MAX_DOCS; i += 50) {
      const statements = [];
      for (let j = 0; j < 50 && i + j < MAX_DOCS; j++) {
        statements.push(
          env.DB.prepare(
            `INSERT INTO note_docs
               (id, team_id, season_id, parent_doc_id, meeting_id, position, title,
                content, content_text, created_by, updated_by, created_at, updated_at)
             VALUES (?, ?, ?, NULL, NULL, ?, 'Bulk', '', '', ?, ?, ?, ?)`,
          ).bind(
            `bulk-${i + j}`,
            me.team_id,
            season.body.id,
            (i + j) * 1024,
            me.member_id,
            me.member_id,
            now,
            now,
          ),
        );
      }
      await env.DB.batch(statements);
    }

    const response = await callJson<{ error: string; max: number }>('/api/notes', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ title: 'One too many' }),
    });
    expect(response.status).toBe(409);
    expect(response.body.error).toBe('too_many_docs');
    expect(response.body.max).toBe(MAX_DOCS);
  });

  it('returns the existing row when a create is retried', async () => {
    // Shop wifi retrying a create used to duplicate one paragraph. It would now
    // duplicate a whole document in the sidebar, so this matters more than it did.
    const cookie = await signUpCoach(6105);
    const id = crypto.randomUUID();
    const first = await callJson<{ doc: Doc }>('/api/notes', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ id, title: 'Once' }),
    });
    const second = await callJson<{ doc: Doc }>('/api/notes', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ id, title: 'Once' }),
    });
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.doc.id).toBe(first.body.doc.id);

    const count = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM note_docs WHERE id = ?',
    )
      .bind(id)
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });
});

describe('the tree', () => {
  it('reports parent pointers and sibling order', async () => {
    const cookie = await signUpCoach(6110);
    const parent = await makeDoc(cookie, { title: 'Build team' });
    const first = await makeDoc(cookie, { title: 'Chassis', parent_doc_id: parent.id });
    const second = await makeDoc(cookie, { title: 'Wiring', parent_doc_id: parent.id });

    const { docs } = await tree(cookie);
    const byId = new Map(docs.map((d) => [d.id, d]));
    expect(byId.get(first.id)?.parent_doc_id).toBe(parent.id);
    expect(byId.get(second.id)?.parent_doc_id).toBe(parent.id);
    expect(byId.get(first.id)!.position).toBeLessThan(byId.get(second.id)!.position);
  });

  it('orders root siblings, which is the IS-not-equals regression', async () => {
    // Sibling lookups use `parent_doc_id IS ?`. With `=`, NULL never matches, so
    // every root document silently lands on the same position and the sidebar
    // order becomes whatever SQLite feels like. Cheap to write, silent to miss.
    const cookie = await signUpCoach(6111);
    const first = await makeDoc(cookie, { title: 'First' });
    const second = await makeDoc(cookie, { title: 'Second' });
    const third = await makeDoc(cookie, { title: 'Third' });

    const positions = [first, second, third].map((d) => d.position);
    expect(new Set(positions).size).toBe(3);
    expect(positions[0]).toBeLessThan(positions[1]);
    expect(positions[1]).toBeLessThan(positions[2]);
  });

  it('leaves gaps so an insert between two documents is a one-row write', async () => {
    const cookie = await signUpCoach(6112);
    const first = await makeDoc(cookie, { title: 'First' });
    const last = await makeDoc(cookie, { title: 'Last' });
    const middle = await makeDoc(cookie, { title: 'Middle', after_id: first.id });

    expect(middle.position).toBeGreaterThan(first.position);
    expect(middle.position).toBeLessThan(last.position);
    // Nothing else moved.
    const { docs } = await tree(cookie);
    const byId = new Map(docs.map((d) => [d.id, d]));
    expect(byId.get(first.id)?.position).toBe(first.position);
    expect(byId.get(last.id)?.position).toBe(last.position);
  });

  it('lets a document stand on its own or belong to a meeting', async () => {
    const cookie = await signUpCoach(6113);
    const meetingId = await makeMeeting(cookie);
    const standalone = await makeDoc(cookie, { title: 'Budget plan' });
    const attached = await makeDoc(cookie, { title: 'Build notes', meeting_id: meetingId });

    expect(standalone.meeting_id).toBeNull();
    expect(attached.meeting_id).toBe(meetingId);

    // The meeting is joined into the tree so the sidebar can group without a
    // second request.
    const { docs } = await tree(cookie);
    expect(docs.find((d) => d.id === attached.id)?.meeting_title).toBeTruthy();
    expect(docs.find((d) => d.id === standalone.id)?.meeting_title).toBeNull();
  });

  it('makes a child inherit its parent meeting even when the body says otherwise', async () => {
    // The parent wins. A subdocument of a meeting-attached page belongs to that
    // meeting, so naming both is not an error — the parent just decides.
    const cookie = await signUpCoach(6114);
    const meetingId = await makeMeeting(cookie);
    const other = await makeMeeting(cookie);
    const parent = await makeDoc(cookie, { meeting_id: meetingId, title: 'Parent' });

    const child = await makeDoc(cookie, {
      parent_doc_id: parent.id,
      meeting_id: other,
      title: 'Child',
    });
    expect(child.meeting_id).toBe(meetingId);
  });
});

describe('moving', () => {
  it('reparents and reorders through one route', async () => {
    const cookie = await signUpCoach(6120);
    const a = await makeDoc(cookie, { title: 'A' });
    const b = await makeDoc(cookie, { title: 'B' });

    const moved = await callJson<{ doc: Doc }>(`/api/notes/${b.id}/move`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ parent_doc_id: a.id }),
    });
    expect(moved.status).toBe(200);
    expect(moved.body.doc.parent_doc_id).toBe(a.id);
  });

  it('moves a document to another meeting and to standalone', async () => {
    const cookie = await signUpCoach(6121);
    const first = await makeMeeting(cookie);
    const second = await makeMeeting(cookie);
    const doc = await makeDoc(cookie, { meeting_id: first, title: 'Wrong date' });

    const toSecond = await callJson<{ doc: Doc }>(`/api/notes/${doc.id}/move`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ meeting_id: second }),
    });
    expect(toSecond.body.doc.meeting_id).toBe(second);

    const toNone = await callJson<{ doc: Doc }>(`/api/notes/${doc.id}/move`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ meeting_id: null }),
    });
    expect(toNone.body.doc.meeting_id).toBeNull();
  });

  it('refuses every shape of cycle and changes nothing when it does', async () => {
    // Onto itself, onto its child, and onto its GRANDCHILD — the last is the one a
    // naive one-level check waves through, and it is what turns a tree into a ring
    // that the sidebar renders as an infinite loop.
    const cookie = await signUpCoach(6122);
    const root = await makeDoc(cookie, { title: 'Root' });
    const child = await makeDoc(cookie, { parent_doc_id: root.id, title: 'Child' });
    const grandchild = await makeDoc(cookie, {
      parent_doc_id: child.id,
      title: 'Grandchild',
    });

    for (const target of [root.id, child.id, grandchild.id]) {
      const response = await callJson<{ error: string }>(`/api/notes/${root.id}/move`, {
        method: 'POST',
        cookie,
        body: JSON.stringify({ parent_doc_id: target }),
      });
      expect(response.status, target).toBe(409);
      expect(response.body.error, target).toBe('cycle');

      // A rejected move that half-applied is the bug that matters, so assert
      // against the row rather than trusting the status code.
      const row = await env.DB.prepare(
        'SELECT parent_doc_id FROM note_docs WHERE id = ?',
      )
        .bind(root.id)
        .first<{ parent_doc_id: string | null }>();
      expect(row?.parent_doc_id, target).toBeNull();
    }
  });

  it('rewrites the meeting on every descendant, not just the one dragged', async () => {
    // The denormalisation invariant. meeting_id is on every row so "the documents
    // for this meeting" stays one indexed read instead of a recursive CTE, which
    // means a move has to carry the whole subtree with it.
    const cookie = await signUpCoach(6123);
    const first = await makeMeeting(cookie);
    const second = await makeMeeting(cookie);

    const root = await makeDoc(cookie, { meeting_id: first, title: 'Root' });
    const child = await makeDoc(cookie, { parent_doc_id: root.id, title: 'Child' });
    const grandchild = await makeDoc(cookie, {
      parent_doc_id: child.id,
      title: 'Grandchild',
    });

    const moved = await callJson<{ moved: number }>(`/api/notes/${root.id}/move`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ meeting_id: second }),
    });
    expect(moved.body.moved).toBe(3);

    for (const id of [root.id, child.id, grandchild.id]) {
      const row = await env.DB.prepare('SELECT meeting_id FROM note_docs WHERE id = ?')
        .bind(id)
        .first<{ meeting_id: string }>();
      expect(row?.meeting_id, id).toBe(second);
    }
  });

  it('refuses to nest deeper than the tree allows', async () => {
    // Loops until the server refuses rather than hardcoding a level count, so this
    // keeps testing the guard rather than a stale constant if MAX_DEPTH moves.
    const cookie = await signUpCoach(6124);
    let parentId: string | null = null;
    let refused: { error: string; max: number } | null = null;

    for (let i = 0; i < MAX_DEPTH + 3; i++) {
      const response: {
        status: number;
        body: { doc: Doc; error: string; max: number };
      } = await callJson<{ doc: Doc; error: string; max: number }>(
        '/api/notes',
        {
          method: 'POST',
          cookie,
          body: JSON.stringify({
            title: `Level ${i}`,
            ...(parentId ? { parent_doc_id: parentId } : {}),
          }),
        },
      );
      if (response.status === 409) {
        refused = { error: response.body.error, max: response.body.max };
        break;
      }
      expect(response.status).toBe(201);
      parentId = response.body.doc.id;
    }

    expect(refused).not.toBeNull();
    expect(refused?.error).toBe('too_deep');
    expect(refused?.max).toBe(MAX_DEPTH);
  });
});

describe('concurrent editors', () => {
  it('answers a stale write with a conflict instead of overwriting', async () => {
    // This test exists to document the regression the single-column format
    // introduces. Blocks gave last-write-wins per PARAGRAPH; one content column
    // gives it per DOCUMENT, and compare-and-swap is what turns a silently lost
    // paragraph into a choice the editor can offer. Not optional.
    const coach = await signUpCoach(6130);
    const other = await inviteAndAccept(coach, { role: 'student', handle: 'coeditor' });
    const doc = await makeDoc(coach, { title: 'Shared' });

    // `rev`, not updated_at. Both writes below land in the same second, which is
    // exactly the case a timestamp cannot distinguish and a counter can — and
    // "two people typing at once" is the whole reason this guard exists.
    const rev = doc.rev;
    const mine = await putContent(coach, doc.id, body('coach wrote this'), rev);
    expect(mine.status).toBe(200);
    expect(mine.body.doc.rev).toBe(rev + 1);

    // The student still holds the old rev.
    const theirs = await putContent(other.cookie, doc.id, body('student wrote this'), rev);
    expect(theirs.status).toBe(409);
    expect(theirs.body.error).toBe('stale_content');
    // The server's copy rides along so the editor can offer keep-mine or load-theirs.
    expect(theirs.body.doc.content_text).toBe('coach wrote this');

    const row = await env.DB.prepare('SELECT content_text FROM note_docs WHERE id = ?')
      .bind(doc.id)
      .first<{ content_text: string }>();
    expect(row?.content_text).toBe('coach wrote this');
  });

  it('accepts a write with the rev the last save returned', async () => {
    // The client must adopt the returned updated_at as its new base. Forgetting
    // that makes the second save 409 against the first, which is the most likely
    // bug in useDocSync.
    const cookie = await signUpCoach(6131);
    const doc = await makeDoc(cookie);
    const first = await putContent(cookie, doc.id, body('one'), doc.rev);
    const second = await putContent(cookie, doc.id, body('two'), first.body.doc.rev);
    expect(second.status).toBe(200);
    expect(second.body.doc.content_text).toBe('two');
  });

  it('lets a client that sends no base_rev through, so a stale bundle still saves', async () => {
    const cookie = await signUpCoach(6132);
    const doc = await makeDoc(cookie);
    await putContent(cookie, doc.id, body('first'));
    const response = await putContent(cookie, doc.id, body('second'));
    expect(response.status).toBe(200);
  });
});

describe('soft delete', () => {
  it('hides a document and its descendants, and restores exactly that set', async () => {
    const cookie = await signUpCoach(6140);
    const root = await makeDoc(cookie, { title: 'Root' });
    const child = await makeDoc(cookie, { parent_doc_id: root.id, title: 'Child' });
    const bystander = await makeDoc(cookie, { title: 'Bystander' });

    const deleted = await callJson<{ deleted: string[] }>(`/api/notes/${root.id}`, {
      method: 'DELETE',
      cookie,
    });
    expect(deleted.status).toBe(200);
    expect(deleted.body.deleted.sort()).toEqual([root.id, child.id].sort());

    const { docs } = await tree(cookie);
    expect(docs.map((d) => d.id)).toEqual([bystander.id]);

    // The rows are still there, which is what makes undo possible.
    const rows = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM note_docs WHERE id IN (?, ?) AND deleted_at IS NOT NULL',
    )
      .bind(root.id, child.id)
      .first<{ n: number }>();
    expect(rows?.n).toBe(2);

    const restored = await call(`/api/notes/${root.id}/restore`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ ids: deleted.body.deleted }),
    });
    expect(restored.status).toBe(200);
    const after = await tree(cookie);
    expect(after.docs.map((d) => d.id).sort()).toEqual(
      [root.id, child.id, bystander.id].sort(),
    );
  });

  it('keeps a portfolio flag listed when its document is deleted, and says so', async () => {
    // The flag was one person's decision and the delete is another person's
    // action, so the inbox keeps the row and reports the orphaning rather than
    // quietly dropping somebody else's judgement.
    const cookie = await signUpCoach(6141);
    const doc = await makeDoc(cookie, { title: 'Worth keeping' });
    await call('/api/portfolio/candidates', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ source_type: 'note_doc', source_id: doc.id }),
    });

    const deleted = await callJson<{ candidate_orphaned: boolean }>(
      `/api/notes/${doc.id}`,
      { method: 'DELETE', cookie },
    );
    expect(deleted.body.candidate_orphaned).toBe(true);

    const still = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM portfolio_candidates WHERE source_id = ? AND source_type = 'note_doc'",
    )
      .bind(doc.id)
      .first<{ n: number }>();
    expect(still?.n).toBe(1);
  });

  it('refuses to newly flag a deleted document', async () => {
    const cookie = await signUpCoach(6142);
    const doc = await makeDoc(cookie, { title: 'Gone' });
    await call(`/api/notes/${doc.id}`, { method: 'DELETE', cookie });

    const response = await call('/api/portfolio/candidates', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ source_type: 'note_doc', source_id: doc.id }),
    });
    expect(response.status).toBe(404);
  });
});

describe('permissions', () => {
  it('lets students write documents and viewers only read them', async () => {
    const coach = await signUpCoach(6150);
    const student = await inviteAndAccept(coach, { role: 'student', handle: 'writer' });
    const viewer = await inviteAndAccept(coach, { role: 'viewer', handle: 'reader' });

    const doc = await makeDoc(student.cookie, { title: 'Student notes' });

    for (const [method, path, payload] of [
      ['POST', '/api/notes', { title: 'Nope' }],
      ['PATCH', `/api/notes/${doc.id}`, { title: 'Nope' }],
      ['PUT', `/api/notes/${doc.id}/content`, { content: body('nope') }],
      ['POST', `/api/notes/${doc.id}/move`, {}],
      ['DELETE', `/api/notes/${doc.id}`, {}],
    ] as const) {
      const response = await call(path, {
        method,
        cookie: viewer.cookie,
        body: JSON.stringify(payload),
      });
      expect(response.status, `${method} ${path}`).toBe(403);
    }

    expect((await call('/api/notes', { cookie: viewer.cookie })).status).toBe(200);
    expect((await call(`/api/notes/${doc.id}`, { cookie: viewer.cookie })).status).toBe(200);
  });

  it('lets a student edit a document somebody else started', async () => {
    // Attribution rather than restriction: a shared page where you can only fix
    // your own half is unusable the moment somebody types a typo and goes home.
    const coach = await signUpCoach(6151);
    const student = await inviteAndAccept(coach, { role: 'student', handle: 'fixer' });
    const doc = await makeDoc(coach, { title: 'Coach started this' });

    const edited = await putContent(student.cookie, doc.id, body('student fixed it'));
    expect(edited.status).toBe(200);
    expect(edited.body.doc.created_by).not.toBe(edited.body.doc.updated_by);
  });
});

describe('tenancy isolation', () => {
  it("never lets one team read, write or reparent another team's documents", async () => {
    const alpha = await signUpCoach(6160);
    const beta = await signUpCoach(6161);

    const betaDoc = await makeDoc(beta, { title: 'BETA-NOTES-MARKER' });
    await putContent(beta, betaDoc.id, body('BETA-NOTES-MARKER'));
    const alphaDoc = await makeDoc(alpha, { title: 'Mine' });

    const attempts: [string, string, unknown][] = [
      ['GET', `/api/notes/${betaDoc.id}`, undefined],
      ['GET', `/api/notes/${betaDoc.id}/rev`, undefined],
      ['PATCH', `/api/notes/${betaDoc.id}`, { title: 'Hijacked' }],
      ['PUT', `/api/notes/${betaDoc.id}/content`, { content: body('hijacked') }],
      ['POST', `/api/notes/${betaDoc.id}/move`, { parent_doc_id: alphaDoc.id }],
      ['DELETE', `/api/notes/${betaDoc.id}`, undefined],
      ['POST', `/api/notes/${betaDoc.id}/restore`, {}],
      // The sneaky one: alpha moving their OWN document under a BETA parent. It
      // must 404 and must not create a cross-tenant edge in the tree.
      ['POST', `/api/notes/${alphaDoc.id}/move`, { parent_doc_id: betaDoc.id }],
    ];

    for (const [method, path, payload] of attempts) {
      const response = await call(path, {
        method,
        cookie: alpha,
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });
      expect(response.status, `${method} ${path}`).toBe(404);
      expect(await response.text(), `${method} ${path}`).not.toContain(
        'BETA-NOTES-MARKER',
      );
    }

    // Asserted against the row directly, because "not found" and "the UPDATE
    // matched zero rows" look identical from outside and only one of them is safe.
    const row = await env.DB.prepare(
      'SELECT title, content_text, parent_doc_id, meeting_id, deleted_at FROM note_docs WHERE id = ?',
    )
      .bind(betaDoc.id)
      .first<Record<string, unknown>>();
    expect(row?.title).toBe('BETA-NOTES-MARKER');
    expect(row?.content_text).toBe('BETA-NOTES-MARKER');
    expect(row?.parent_doc_id).toBeNull();
    expect(row?.deleted_at).toBeNull();

    // And alpha's own document did not acquire a foreign parent.
    const mine = await env.DB.prepare(
      'SELECT parent_doc_id FROM note_docs WHERE id = ?',
    )
      .bind(alphaDoc.id)
      .first<{ parent_doc_id: string | null }>();
    expect(mine?.parent_doc_id).toBeNull();

    // The list never leaks either.
    const list = await call('/api/notes', { cookie: alpha });
    expect(await list.text()).not.toContain('BETA-NOTES-MARKER');
  });

  it('requires a session for every document route', async () => {
    const paths: [string, string][] = [
      ['GET', '/api/notes'],
      ['GET', '/api/notes/x'],
      ['GET', '/api/notes/x/rev'],
      ['POST', '/api/notes'],
      ['PATCH', '/api/notes/x'],
      ['PUT', '/api/notes/x/content'],
      ['POST', '/api/notes/x/move'],
      ['DELETE', '/api/notes/x'],
      ['POST', '/api/notes/x/restore'],
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
