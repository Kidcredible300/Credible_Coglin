import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { call, callJson, inviteAndAccept, signUpCoach, stubResend, whoami } from './_helpers';
import { purgeRetiredRosterPhotos } from './media';

beforeAll(() => {
  stubResend();
});

function join(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
const ascii = (t: string) => new Uint8Array([...t].map((c) => c.charCodeAt(0)));
const be32 = (n: number) =>
  new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const chunk = (type: string, data: Uint8Array) =>
  join(be32(data.length), ascii(type), data, be32(0));

function png(w = 400, h = 400, extra: Uint8Array[] = []): Uint8Array {
  return join(
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', join(be32(w), be32(h), new Uint8Array([8, 6, 0, 0, 0]))),
    ...extra,
    chunk('IDAT', new Uint8Array([0x78, 0x9c, 0x00])),
    chunk('IEND', new Uint8Array(0)),
  );
}

function uploadPhoto(cookie: string, memberId: string, bytes = png()): Promise<Response> {
  return call(`/api/members/${memberId}/photo`, {
    method: 'POST',
    cookie,
    headers: { 'Content-Type': 'image/png' },
    body: bytes as unknown as BodyInit,
  });
}

describe('the consent gate', () => {
  it('refuses a photo until a coach has recorded the signed form', async () => {
    const coach = await signUpCoach(9100);
    const student = await inviteAndAccept(coach, { role: 'student', handle: 'ada' });
    const adaId = (await whoami(student.cookie)).member_id;

    // This is the whole point of the feature's design: a coach's own permission
    // is not a parent's, so the upload is refused rather than warned about.
    const blocked = await callJson<{ error: string }>(
      `/api/members/${adaId}/photo`,
      {
        method: 'POST',
        cookie: coach,
        headers: { 'Content-Type': 'image/png' },
        body: png() as unknown as BodyInit,
      },
    );
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toBe('photo_consent_required');

    // Nothing was stored on the way to refusing.
    const stored = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM media WHERE kind = 'roster_photo'",
    ).first<{ n: number }>();
    expect(stored?.n).toBe(0);

    const consented = await call(`/api/members/${adaId}/photo-consent`, {
      method: 'POST',
      cookie: coach,
    });
    expect(consented.status).toBe(200);

    const uploaded = await uploadPhoto(coach, adaId);
    expect(uploaded.status).toBe(201);
  });

  it('records who attested and when, not just that somebody did', async () => {
    const coach = await signUpCoach(9101);
    const student = await inviteAndAccept(coach, { role: 'student', handle: 'ada2' });
    const adaId = (await whoami(student.cookie)).member_id;
    const coachId = (await whoami(coach)).member_id;

    await call(`/api/members/${adaId}/photo-consent`, { method: 'POST', cookie: coach });

    const row = await env.DB.prepare(
      'SELECT photo_consent_at, photo_consent_by FROM members WHERE id = ?',
    )
      .bind(adaId)
      .first<{ photo_consent_at: number | null; photo_consent_by: string | null }>();
    // An attestation with no author is not an attestation.
    expect(row?.photo_consent_at).toBeGreaterThan(0);
    expect(row?.photo_consent_by).toBe(coachId);
  });

  it('withdrawing consent takes the photo down with it', async () => {
    const coach = await signUpCoach(9102);
    const student = await inviteAndAccept(coach, { role: 'student', handle: 'ada3' });
    const adaId = (await whoami(student.cookie)).member_id;

    await call(`/api/members/${adaId}/photo-consent`, { method: 'POST', cookie: coach });
    const uploaded = await uploadPhoto(coach, adaId);
    const { id: mediaId } = (await uploaded.json()) as { id: string };
    const key = (
      await env.DB.prepare('SELECT r2_key FROM media WHERE id = ?')
        .bind(mediaId)
        .first<{ r2_key: string }>()
    )?.r2_key;

    const withdrawn = await call(`/api/members/${adaId}/photo-consent`, {
      method: 'DELETE',
      cookie: coach,
    });
    expect(withdrawn.status).toBe(200);

    // A parent asking for the picture to come down and a record saying consent
    // is on file cannot both be true.
    const member = await env.DB.prepare(
      'SELECT photo_media_id, photo_consent_at FROM members WHERE id = ?',
    )
      .bind(adaId)
      .first<{ photo_media_id: string | null; photo_consent_at: number | null }>();
    expect(member?.photo_media_id).toBeNull();
    expect(member?.photo_consent_at).toBeNull();

    // Actually gone, not merely unreferenced.
    expect(await env.DB.prepare('SELECT id FROM media WHERE id = ?').bind(mediaId).first())
      .toBeNull();
    expect(await env.MEDIA.get(key!)).toBeNull();
  });

  it('strips EXIF from a roster photo like any other upload', async () => {
    const coach = await signUpCoach(9103);
    const student = await inviteAndAccept(coach, { role: 'student', handle: 'ada4' });
    const adaId = (await whoami(student.cookie)).member_id;
    await call(`/api/members/${adaId}/photo-consent`, { method: 'POST', cookie: coach });

    const withGps = png(400, 400, [
      chunk('eXIf', ascii('GPSLatitude 42.3601 GPSLongitude -71.0589')),
    ]);
    const uploaded = await uploadPhoto(coach, adaId, withGps);
    const { id } = (await uploaded.json()) as { id: string };

    const key = (
      await env.DB.prepare('SELECT r2_key FROM media WHERE id = ?')
        .bind(id)
        .first<{ r2_key: string }>()
    )?.r2_key;
    const text = await (await env.MEDIA.get(key!))!.text();
    // A photo of a child's face carrying the coordinates of where it was taken
    // is the exact thing this pipeline exists to prevent.
    expect(text).not.toContain('GPSLatitude');
    expect(text).not.toContain('42.3601');
  });

  it('replaces rather than accumulating when a better photo turns up', async () => {
    const coach = await signUpCoach(9104);
    const student = await inviteAndAccept(coach, { role: 'student', handle: 'ada5' });
    const adaId = (await whoami(student.cookie)).member_id;
    await call(`/api/members/${adaId}/photo-consent`, { method: 'POST', cookie: coach });

    const first = (await (await uploadPhoto(coach, adaId)).json()) as { id: string };
    const second = (await (await uploadPhoto(coach, adaId, png(300, 300))).json()) as {
      id: string;
    };
    expect(second.id).not.toBe(first.id);

    expect(
      await env.DB.prepare('SELECT id FROM media WHERE id = ?').bind(first.id).first(),
    ).toBeNull();
    const member = await env.DB.prepare(
      'SELECT photo_media_id FROM members WHERE id = ?',
    )
      .bind(adaId)
      .first<{ photo_media_id: string }>();
    expect(member?.photo_media_id).toBe(second.id);
  });
});

describe('who may see a student\'s face', () => {
  it('hides roster photos from viewers, even by direct URL', async () => {
    const coach = await signUpCoach(9200);
    const student = await inviteAndAccept(coach, { role: 'student', handle: 'ada6' });
    const viewer = await inviteAndAccept(coach, { role: 'viewer', handle: 'sponsor' });
    const adaId = (await whoami(student.cookie)).member_id;

    await call(`/api/members/${adaId}/photo-consent`, { method: 'POST', cookie: coach });
    const { id: mediaId } = (await (await uploadPhoto(coach, adaId)).json()) as {
      id: string;
    };

    // A student may see their teammates — that is the point of the feature.
    expect((await call(`/media/${mediaId}`, { cookie: student.cookie })).status).toBe(200);

    // A sponsor may not be handed pictures of other people's children, and
    // guessing the id must not work either.
    expect((await call(`/media/${mediaId}`, { cookie: viewer.cookie })).status).toBe(404);

    // The roster projection does not even offer the URL to a viewer.
    const rosterAsViewer = await callJson<{ photo_media_id: string | null }[]>(
      '/api/members',
      { cookie: viewer.cookie },
    );
    expect(rosterAsViewer.body.every((m) => m.photo_media_id === null)).toBe(true);

    const rosterAsStudent = await callJson<{ photo_media_id: string | null }[]>(
      '/api/members',
      { cookie: student.cookie },
    );
    expect(rosterAsStudent.body.some((m) => m.photo_media_id === mediaId)).toBe(true);
  });

  it('keeps roster photos out of the media library', async () => {
    const coach = await signUpCoach(9201);
    const student = await inviteAndAccept(coach, { role: 'student', handle: 'ada7' });
    const adaId = (await whoami(student.cookie)).member_id;
    await call(`/api/members/${adaId}/photo-consent`, { method: 'POST', cookie: coach });
    await uploadPhoto(coach, adaId);

    // A browsable gallery of children's faces is not what "put faces to names"
    // asked for.
    const library = await callJson<{ media: unknown[] }>('/api/media', { cookie: coach });
    expect(library.body.media).toHaveLength(0);
  });

  it('refuses a roster photo as portfolio evidence', async () => {
    const coach = await signUpCoach(9202);
    const student = await inviteAndAccept(coach, { role: 'student', handle: 'ada8' });
    const adaId = (await whoami(student.cookie)).member_id;
    await call(`/api/members/${adaId}/photo-consent`, { method: 'POST', cookie: coach });
    const { id: mediaId } = (await (await uploadPhoto(coach, adaId)).json()) as {
      id: string;
    };

    const flagged = await callJson<{ error: string }>('/api/portfolio/candidates', {
      method: 'POST',
      cookie: coach,
      body: JSON.stringify({ source_type: 'media', source_id: mediaId }),
    });
    expect(flagged.status).toBe(404);
    expect(flagged.body.error).toBe('source_not_found');
  });

  it('lets only coaches and mentors attach or remove a photo', async () => {
    const coach = await signUpCoach(9203);
    const student = await inviteAndAccept(coach, { role: 'student', handle: 'ada9' });
    const adaId = (await whoami(student.cookie)).member_id;

    // A student does not upload their own face, and certainly not anybody
    // else's — nor may they attest to a consent form.
    expect(
      (await call(`/api/members/${adaId}/photo-consent`, {
        method: 'POST',
        cookie: student.cookie,
      })).status,
    ).toBe(403);
    expect((await uploadPhoto(student.cookie, adaId)).status).toBe(403);
  });
});

describe('retention', () => {
  it('purges the photo of a member who is no longer active', async () => {
    const coach = await signUpCoach(9300);
    const student = await inviteAndAccept(coach, { role: 'student', handle: 'grad' });
    const adaId = (await whoami(student.cookie)).member_id;
    await call(`/api/members/${adaId}/photo-consent`, { method: 'POST', cookie: coach });
    const { id: mediaId } = (await (await uploadPhoto(coach, adaId)).json()) as {
      id: string;
    };
    const key = (
      await env.DB.prepare('SELECT r2_key FROM media WHERE id = ?')
        .bind(mediaId)
        .first<{ r2_key: string }>()
    )?.r2_key;

    // The sweep exists because the realistic failure is a coach who never marks
    // a graduated senior inactive. Once they do, the photo goes on its own.
    await env.DB.prepare("UPDATE members SET status = 'retired' WHERE id = ?")
      .bind(adaId)
      .run();

    const purged = await purgeRetiredRosterPhotos(env);
    expect(purged).toBeGreaterThanOrEqual(1);

    expect(
      await env.DB.prepare('SELECT id FROM media WHERE id = ?').bind(mediaId).first(),
    ).toBeNull();
    expect(await env.MEDIA.get(key!)).toBeNull();
    const member = await env.DB.prepare(
      'SELECT photo_media_id FROM members WHERE id = ?',
    )
      .bind(adaId)
      .first<{ photo_media_id: string | null }>();
    expect(member?.photo_media_id).toBeNull();
  });

  it('leaves active members alone', async () => {
    const coach = await signUpCoach(9301);
    const student = await inviteAndAccept(coach, { role: 'student', handle: 'active' });
    const adaId = (await whoami(student.cookie)).member_id;
    await call(`/api/members/${adaId}/photo-consent`, { method: 'POST', cookie: coach });
    const { id: mediaId } = (await (await uploadPhoto(coach, adaId)).json()) as {
      id: string;
    };

    await purgeRetiredRosterPhotos(env);
    expect(
      await env.DB.prepare('SELECT id FROM media WHERE id = ?').bind(mediaId).first(),
    ).not.toBeNull();
  });
});

describe('tenancy isolation', () => {
  it('never lets one team attach to, or read, another team\'s roster photo', async () => {
    const alpha = await signUpCoach(9400);
    const beta = await signUpCoach(9401);
    const betaStudent = await inviteAndAccept(beta, { role: 'student', handle: 'betakid' });
    const betaId = (await whoami(betaStudent.cookie)).member_id;

    await call(`/api/members/${betaId}/photo-consent`, { method: 'POST', cookie: beta });
    const { id: mediaId } = (await (await uploadPhoto(beta, betaId)).json()) as {
      id: string;
    };

    // Alpha cannot attest for beta's student...
    expect(
      (await call(`/api/members/${betaId}/photo-consent`, {
        method: 'POST',
        cookie: alpha,
      })).status,
    ).toBe(404);
    // ...nor attach a photo to them...
    expect((await uploadPhoto(alpha, betaId)).status).toBe(404);
    // ...nor take theirs down...
    expect(
      (await call(`/api/members/${betaId}/photo`, { method: 'DELETE', cookie: alpha }))
        .status,
    ).toBe(404);
    // ...nor look at it.
    expect((await call(`/media/${mediaId}`, { cookie: alpha })).status).toBe(404);

    const survives = await env.DB.prepare(
      'SELECT photo_media_id, photo_consent_at FROM members WHERE id = ?',
    )
      .bind(betaId)
      .first<{ photo_media_id: string | null; photo_consent_at: number | null }>();
    expect(survives?.photo_media_id).toBe(mediaId);
    expect(survives?.photo_consent_at).toBeGreaterThan(0);
  });
});
