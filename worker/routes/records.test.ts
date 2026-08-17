import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { call, callJson, inviteAndAccept, signUpCoach, stubResend, whoami } from './_helpers';

beforeAll(() => {
  stubResend();
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

describe('attendance', () => {
  it('records the roll and leaves unnamed members alone', async () => {
    const coach = await signUpCoach(8100);
    const meetingId = await makeMeeting(coach);
    const ada = await inviteAndAccept(coach, { role: 'student', handle: 'ada' });
    const grace = await inviteAndAccept(coach, { role: 'student', handle: 'grace' });
    const adaId = (await whoami(ada.cookie)).member_id;
    const graceId = (await whoami(grace.cookie)).member_id;

    await callJson(`/api/meetings/${meetingId}/attendance`, {
      method: 'PUT',
      cookie: coach,
      body: JSON.stringify({
        entries: [
          { member_id: adaId, state: 'present' },
          { member_id: graceId, state: 'excused', note: 'Away meet' },
        ],
      }),
    });

    // A second coach marking only one person must not erase the other.
    const second = await callJson<{
      attendance: { member_id: string; state: string; arrived_late: number }[];
    }>(`/api/meetings/${meetingId}/attendance`, {
      method: 'PUT',
      cookie: coach,
      body: JSON.stringify({
        entries: [{ member_id: adaId, state: 'present', arrived_late: true }],
      }),
    });

    const byMember = new Map(second.body.attendance.map((a) => [a.member_id, a]));
    expect(byMember.get(adaId)?.state).toBe('present');
    expect(byMember.get(adaId)?.arrived_late).toBe(1);
    // Grace was not named in the second write and keeps her excusal.
    expect(byMember.get(graceId)?.state).toBe('excused');
  });

  it('records arriving late AND leaving early on the same evening', async () => {
    // The case the first cut of this schema could not express. A single enum
    // with a `late` value forces a choice about which half of the evening
    // mattered, and coaches track both because both are true.
    const coach = await signUpCoach(8104);
    const meetingId = await makeMeeting(coach);
    const ada = await inviteAndAccept(coach, { role: 'student', handle: 'halfway' });
    const adaId = (await whoami(ada.cookie)).member_id;

    const { body } = await callJson<{
      attendance: {
        member_id: string;
        state: string;
        arrived_late: number;
        left_early: number;
        minutes: number | null;
      }[];
    }>(`/api/meetings/${meetingId}/attendance`, {
      method: 'PUT',
      cookie: coach,
      body: JSON.stringify({
        entries: [
          {
            member_id: adaId,
            state: 'present',
            arrived_late: true,
            left_early: true,
            minutes: 70,
          },
        ],
      }),
    });

    const row = body.attendance.find((a) => a.member_id === adaId);
    expect(row?.state).toBe('present');
    expect(row?.arrived_late).toBe(1);
    expect(row?.left_early).toBe(1);
    // The time actually in the room, which is what the Sustain hours want.
    expect(row?.minutes).toBe(70);
  });

  it('no longer accepts late as a state', async () => {
    const coach = await signUpCoach(8105);
    const meetingId = await makeMeeting(coach);
    const ada = await inviteAndAccept(coach, { role: 'student', handle: 'notastate' });
    const adaId = (await whoami(ada.cookie)).member_id;

    const { status, body } = await callJson<{ error: string }>(
      `/api/meetings/${meetingId}/attendance`,
      {
        method: 'PUT',
        cookie: coach,
        body: JSON.stringify({ entries: [{ member_id: adaId, state: 'late' }] }),
      },
    );
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_state');
  });

  it('lets a student check in only themselves', async () => {
    const coach = await signUpCoach(8101);
    const meetingId = await makeMeeting(coach);
    const ada = await inviteAndAccept(coach, { role: 'student', handle: 'ada2' });
    const grace = await inviteAndAccept(coach, { role: 'student', handle: 'grace2' });
    const adaId = (await whoami(ada.cookie)).member_id;
    const graceId = (await whoami(grace.cookie)).member_id;

    // The body names Grace; the route uses the session's own membership. A
    // student marking a friend present would make the whole record worthless.
    const response = await callJson<{ member_id: string }>(
      `/api/meetings/${meetingId}/attendance/self`,
      {
        method: 'POST',
        cookie: ada.cookie,
        body: JSON.stringify({ arrived_late: true, member_id: graceId }),
      },
    );
    expect(response.status).toBe(200);
    expect(response.body.member_id).toBe(adaId);

    const rows = await env.DB.prepare(
      'SELECT member_id FROM meeting_attendance WHERE meeting_id = ?',
    )
      .bind(meetingId)
      .all<{ member_id: string }>();
    expect(rows.results.map((r) => r.member_id)).toEqual([adaId]);
  });

  it('refuses a student taking the roll for the team', async () => {
    const coach = await signUpCoach(8102);
    const meetingId = await makeMeeting(coach);
    const student = await inviteAndAccept(coach, { role: 'student', handle: 'roll' });
    const response = await call(`/api/meetings/${meetingId}/attendance`, {
      method: 'PUT',
      cookie: student.cookie,
      body: JSON.stringify({ entries: [] }),
    });
    expect(response.status).toBe(403);
  });

  it('rolls up the season, which is what Sustain asks for', async () => {
    const coach = await signUpCoach(8103);
    const ada = await inviteAndAccept(coach, { role: 'student', handle: 'ada3' });
    const adaId = (await whoami(ada.cookie)).member_id;

    for (let i = 0; i < 3; i++) {
      const meetingId = await makeMeeting(coach);
      await call(`/api/meetings/${meetingId}/attendance`, {
        method: 'PUT',
        cookie: coach,
        body: JSON.stringify({
          entries: [{ member_id: adaId, state: i === 2 ? 'excused' : 'present' }],
        }),
      });
    }

    const { body } = await callJson<{
      members: {
        member_id: string;
        present: number;
        excused: number;
        arrived_late: number;
        minutes: number;
      }[];
    }>('/api/attendance/summary', { cookie: coach });
    const ada3 = body.members.find((m) => m.member_id === adaId);
    expect(ada3?.present).toBe(2);
    expect(ada3?.excused).toBe(1);
    // The marks roll up alongside the states rather than competing with them.
    expect(ada3?.arrived_late).toBe(0);
  });
});

describe('action items and promotion', () => {
  it('promotes an action item onto a board, carrying assignee and due date', async () => {
    const coach = await signUpCoach(8200);
    const meetingId = await makeMeeting(coach);
    const ada = await inviteAndAccept(coach, { role: 'student', handle: 'ada4' });
    const adaId = (await whoami(ada.cookie)).member_id;
    const due = 1_800_000_000;

    const item = await callJson<{ action_item: { id: string } }>(
      `/api/meetings/${meetingId}/action-items`,
      {
        method: 'POST',
        cookie: coach,
        body: JSON.stringify({
          text: 'Reprint the intake bracket',
          assignee_member_id: adaId,
          due_at: due,
        }),
      },
    );
    expect(item.status).toBe(201);

    const promoted = await callJson<{
      task: { id: string; title: string; assignee_member_id: string; due_at: number };
    }>(`/api/meetings/${meetingId}/action-items/${item.body.action_item.id}/promote`, {
      method: 'POST',
      cookie: coach,
      body: JSON.stringify({}),
    });

    expect(promoted.status).toBe(201);
    expect(promoted.body.task.title).toBe('Reprint the intake bracket');
    expect(promoted.body.task.assignee_member_id).toBe(adaId);
    expect(promoted.body.task.due_at).toBe(due);

    // The team had no boards, so one was created rather than asking.
    const boards = await callJson<{ boards: { name: string }[] }>('/api/boards', {
      cookie: coach,
    });
    expect(boards.body.boards.map((b) => b.name)).toContain('Action items');
  });

  it('refuses to promote the same item twice', async () => {
    const coach = await signUpCoach(8201);
    const meetingId = await makeMeeting(coach);
    const item = await callJson<{ action_item: { id: string } }>(
      `/api/meetings/${meetingId}/action-items`,
      { method: 'POST', cookie: coach, body: JSON.stringify({ text: 'Once only' }) },
    );

    const path = `/api/meetings/${meetingId}/action-items/${item.body.action_item.id}/promote`;
    expect((await call(path, { method: 'POST', cookie: coach, body: '{}' })).status).toBe(201);
    const second = await callJson<{ error: string }>(path, {
      method: 'POST',
      cookie: coach,
      body: '{}',
    });
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('already_promoted');

    // Scoped to this team: storage is isolated per test FILE, so a global count
    // would be measuring every fixture above as well.
    const tasks = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM tasks
        WHERE team_id = (SELECT id FROM teams WHERE team_number = 8201)`,
    ).first<{ n: number }>();
    expect(tasks?.n).toBe(1);
  });

  it('carries the nearest decision forward as the task decision log', async () => {
    // Free Think-award material: the reasoning was typed at the moment it
    // happened rather than reconstructed in March.
    const coach = await signUpCoach(8202);
    const meetingId = await makeMeeting(coach);

    await call(`/api/meetings/${meetingId}/blocks`, {
      method: 'POST',
      cookie: coach,
      body: JSON.stringify({
        kind: 'decision',
        text: 'Went with the 4-bar because the elevator kept binding',
      }),
    });
    const actionBlock = await callJson<{ block: { id: string } }>(
      `/api/meetings/${meetingId}/blocks`,
      {
        method: 'POST',
        cookie: coach,
        body: JSON.stringify({ kind: 'action', text: 'Reprint the bracket' }),
      },
    );

    const item = await callJson<{ action_item: { id: string } }>(
      `/api/meetings/${meetingId}/action-items`,
      {
        method: 'POST',
        cookie: coach,
        body: JSON.stringify({
          text: 'Reprint the bracket',
          block_id: actionBlock.body.block.id,
        }),
      },
    );

    const promoted = await callJson<{ task: { decision_log: string | null } }>(
      `/api/meetings/${meetingId}/action-items/${item.body.action_item.id}/promote`,
      { method: 'POST', cookie: coach, body: '{}' },
    );
    expect(promoted.body.task.decision_log).toBe(
      'Went with the 4-bar because the elevator kept binding',
    );
  });

  it('lets a student capture and promote an action item', async () => {
    const coach = await signUpCoach(8203);
    const meetingId = await makeMeeting(coach);
    const student = await inviteAndAccept(coach, { role: 'student', handle: 'doer' });

    const item = await callJson<{ action_item: { id: string } }>(
      `/api/meetings/${meetingId}/action-items`,
      {
        method: 'POST',
        cookie: student.cookie,
        body: JSON.stringify({ text: 'Order more polycarb' }),
      },
    );
    expect(item.status).toBe(201);

    const promoted = await call(
      `/api/meetings/${meetingId}/action-items/${item.body.action_item.id}/promote`,
      { method: 'POST', cookie: student.cookie, body: '{}' },
    );
    expect(promoted.status).toBe(201);
  });
});

describe('board mutate', () => {
  it('applies the op stream the client already speaks', async () => {
    const coach = await signUpCoach(8300);
    const board = await callJson<{ board: { id: string } }>('/api/boards', {
      method: 'POST',
      cookie: coach,
      body: JSON.stringify({ name: 'Build' }),
    });
    const boardId = board.body.board.id;

    const task = await callJson<{ task: { id: string } }>('/api/tasks', {
      method: 'POST',
      cookie: coach,
      body: JSON.stringify({ board_id: boardId, title: 'Cut the plate' }),
    });

    const mutated = await callJson<{ tasks: { id: string; status: string }[] }>(
      `/api/boards/${boardId}/mutate`,
      {
        method: 'POST',
        cookie: coach,
        body: JSON.stringify({
          ops: [
            {
              op: 'move_task',
              task_id: task.body.task.id,
              status: 'doing',
              position: 2048,
            },
          ],
        }),
      },
    );
    expect(mutated.status).toBe(200);
    expect(mutated.body.tasks[0].status).toBe('doing');
  });

  it('rejects an unknown op rather than applying the rest', async () => {
    const coach = await signUpCoach(8301);
    const board = await callJson<{ board: { id: string } }>('/api/boards', {
      method: 'POST',
      cookie: coach,
      body: JSON.stringify({ name: 'Build' }),
    });

    const response = await callJson<{ error: string }>(
      `/api/boards/${board.body.board.id}/mutate`,
      {
        method: 'POST',
        cookie: coach,
        body: JSON.stringify({ ops: [{ op: 'drop_database' }] }),
      },
    );
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_op');
  });
});

describe('tenancy isolation', () => {
  it('never lets one team touch another\'s attendance, actions or boards', async () => {
    const alpha = await signUpCoach(8400);
    const beta = await signUpCoach(8401);

    const betaMeeting = await makeMeeting(beta);
    const alphaMember = await whoami(alpha);

    const betaItem = await callJson<{ action_item: { id: string } }>(
      `/api/meetings/${betaMeeting}/action-items`,
      {
        method: 'POST',
        cookie: beta,
        body: JSON.stringify({ text: 'BETA-ACTION-MARKER' }),
      },
    );
    const betaBoard = await callJson<{ board: { id: string } }>('/api/boards', {
      method: 'POST',
      cookie: beta,
      body: JSON.stringify({ name: 'BETA-BOARD-MARKER' }),
    });

    // The cross-tenant write a naive upsert would happily accept: alpha marking
    // their OWN member present at beta's meeting.
    const attendance = await callJson<{ error: string }>(
      `/api/meetings/${betaMeeting}/attendance`,
      {
        method: 'PUT',
        cookie: alpha,
        body: JSON.stringify({
          entries: [{ member_id: alphaMember.member_id, state: 'present' }],
        }),
      },
    );
    expect(attendance.status).toBe(404);
    const written = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM meeting_attendance WHERE meeting_id = ?',
    )
      .bind(betaMeeting)
      .first<{ n: number }>();
    expect(written?.n).toBe(0);

    // Promoting another team's action item onto your own board.
    expect(
      (
        await call(
          `/api/meetings/${betaMeeting}/action-items/${betaItem.body.action_item.id}/promote`,
          { method: 'POST', cookie: alpha, body: '{}' },
        )
      ).status,
    ).toBe(404);

    // Lists never leak.
    const actions = await call('/api/action-items', { cookie: alpha });
    expect(await actions.text()).not.toContain('BETA-ACTION-MARKER');
    const boardList = await call('/api/boards', { cookie: alpha });
    expect(await boardList.text()).not.toContain('BETA-BOARD-MARKER');

    // Mutating another team's board.
    expect(
      (
        await call(`/api/boards/${betaBoard.body.board.id}/mutate`, {
          method: 'POST',
          cookie: alpha,
          body: JSON.stringify({ ops: [] }),
        })
      ).status,
    ).toBe(404);

    const stillThere = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM meeting_action_items WHERE meeting_id = ?',
    )
      .bind(betaMeeting)
      .first<{ n: number }>();
    expect(stillThere?.n).toBe(1);
  });

  it('requires a session', async () => {
    for (const path of ['/api/boards', '/api/tasks', '/api/action-items', '/api/attendance/summary']) {
      expect((await call(path)).status, path).toBe(401);
    }
  });
});
