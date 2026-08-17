-- Roster photos (COG-007 / COG-003).
--
-- Coaches put faces to names in September. Every team already does this on a
-- spreadsheet with a photo of each student, and this is that, moved into the
-- app. It is also the single highest-risk piece of data in Coglin, so the rules
-- are written down here rather than left to whoever touches the upload route
-- next.
--
-- WHAT A PHOTO IS, LEGALLY. A photograph of a child is personal information
-- under COPPA — the rule names photographs explicitly — and Coglin's users are
-- 12-18, so some are under 13. Collecting it needs verifiable PARENTAL consent.
-- A coach's permission is not a parent's permission, and a checkbox in a web app
-- is not verifiable consent.
--
-- WHERE THE CONSENT ACTUALLY COMES FROM. FIRST already requires a signed Consent
-- and Release from every participant's parent or guardian, covering likeness and
-- media. That form is the real artifact and it lives on paper, outside this
-- system. So Coglin does not attempt to obtain consent — it RECORDS that the
-- form exists, as an attestation by a named coach at a known time
-- (`photo_consent_at`, `photo_consent_by`). The upload route refuses to attach a
-- photo until that row is set. If you are here to make the photo field work
-- without the attestation because it is faster, that is the trade being refused.
--
-- WHY THERE IS NO DATE OF BIRTH COLUMN. COPPA's threshold is 13, and Coglin does
-- not know who is under 13 — `users.is_minor` only says "not an adult". The
-- obvious fix is to collect birthdates and branch on them. We do the opposite:
-- the strictest standard applies to EVERY student, so there is one code path and
-- one less piece of PII about a child in the database. Not collecting data is
-- the cheapest compliance measure available.
--
-- NO FACE RECOGNITION, EVER. A plain photograph is expressly NOT a biometric
-- identifier under Illinois BIPA and its siblings in Texas and Washington — but a
-- faceprint derived from one is. Running face detection, recognition, or
-- embeddings over these rows would pull Coglin into biometric-privacy law in
-- three states and turn a roster convenience into a category of liability. There
-- is no feature worth that. This is a permanent constraint, not a phase.
--
-- RETENTION. The 2025 COPPA amendments bar keeping a child's data indefinitely
-- and require a written retention policy, so a roster photo is deleted when the
-- member is no longer active — `members.status <> 'active'` is the trigger, and
-- `worker/backup.ts`'s nightly cron sweeps for photos whose member has been
-- retired. The failure mode that rule has to survive is a coach who never marks
-- a graduated senior inactive, which is why the sweep exists at all rather than
-- trusting the retire path to be taken.
--
-- WHO CAN SEE THEM. Team members. NOT viewers — a viewer is a parent or a
-- sponsor, and an outsider should not be handed a page of children's faces.
-- Enforced in `worker/routes/media.ts`, because a cache header cannot.

ALTER TABLE members ADD COLUMN photo_media_id TEXT REFERENCES media(id) ON DELETE SET NULL;

-- When a coach recorded that the signed Consent and Release is on file for this
-- student, and which coach said so. NULL means no photo may be attached.
ALTER TABLE members ADD COLUMN photo_consent_at INTEGER;
ALTER TABLE members ADD COLUMN photo_consent_by TEXT REFERENCES members(id) ON DELETE SET NULL;

-- The retention sweep and the roster read both want "photos on this team",
-- without scanning members who have none.
CREATE INDEX idx_members_photo ON members(team_id, photo_media_id);

-- `media.kind` gains 'roster_photo' alongside 'photo'. No DDL: the column is
-- plain TEXT with a comment in 0001, per this schema's convention of validating
-- enums in the Worker rather than with a CHECK constraint. The distinction
-- matters because roster photos are excluded from the media library, excluded
-- from portfolio candidates (a student's face is not award evidence), and
-- withheld from viewers.
