-- Attendance becomes one dropdown (COG-044).
--
-- THIS REVERSES THE ARGUMENT AT 0003_meetings.sql:196-215, deliberately, and
-- that comment is worth reading before this one. It is right about the facts:
-- `state` plus `arrived_late` plus `left_early` can express "twenty minutes late
-- and gone before the end", and a single enum cannot. What it got wrong is the
-- cost. A coach in a cold shop marking fifteen names on a phone faces four
-- controls per row and four decisions per person, and the observed result is
-- that the roll does not get taken at all. A record that is precise and empty
-- loses to one that is coarse and kept.
--
-- So: present, absent, other -- and `other` carries free text in the `note`
-- column that already exists. "Leaving early for dentist" is one field, typed
-- once, and it still reads correctly in March, which is more than left_early = 1
-- ever did. `excused` goes with them: a coach who means excused writes the word.
--
-- WHAT THIS GIVES UP, so it is not rediscovered later as a bug:
--   * the Sustain rollup can no longer count excusals separately from
--     absences. `other` is one bucket, and reading it means reading prose.
--   * `minutes` is finished, and with it the hours arithmetic 0003 justified it
--     by. That arithmetic was never built -- GET /attendance/summary has no
--     caller in the client at all -- so this retires an unbuilt feature.
--   * "late AND early" is one sentence now instead of two booleans, and a
--     sentence does not aggregate. Accepted.
--
-- WHAT IT DOES NOT GIVE UP. `note` is still the only free text about a person in
-- this schema, still bounded by the Worker, still cascading away with the member
-- row. Still no arrival time, still no location. The trade 0003:18-27 refused is
-- still refused: this makes the record COARSER, not richer, which is the safe
-- direction for data about a child.
--
-- Migration mechanics are unchanged from 0003:29-40 -- wrangler splits on
-- semicolons, so no semicolon inside a comment or a string literal, no triggers,
-- no transaction wrapper, and a failure halfway is fixed forward.

-- --------------------------------------------------------------------- state

-- No DDL. `state` is plain TEXT with the value set enforced in
-- worker/lib/meetings.ts, which is this schema's convention for every enum --
-- see the closing note in 0004 for the same call on media.kind. The
-- "present | absent | excused" comment at 0003:221 is now wrong and SQLite
-- cannot amend it. ATTENDANCE_STATES is the authority.

-- `excused` collapses into `other`. The note is SEEDED rather than left NULL,
-- because the Worker refuses to write `other` without a detail and a migration
-- should not manufacture a row the API itself could not.
UPDATE meeting_attendance
   SET state = 'other',
       note  = COALESCE(NULLIF(TRIM(note), ''), 'Excused')
 WHERE state = 'excused';

-- The timing marks fold into the note AND flip the row to `other`. Flipping the
-- state is not optional: the new panel only reveals the detail field for
-- `other`, so a note parked on a `present` row would be migrated in and then
-- invisible forever, which is worse than dropping it.
UPDATE meeting_attendance
   SET state = 'other',
       note  = TRIM(
                 COALESCE(NULLIF(TRIM(note), '') || ' - ', '')
                 || CASE
                      WHEN arrived_late = 1 AND left_early = 1
                        THEN 'Arrived late, left early'
                      WHEN arrived_late = 1 THEN 'Arrived late'
                      ELSE 'Left early'
                    END)
 WHERE state = 'present' AND (arrived_late = 1 OR left_early = 1);

-- arrived_late, left_early and minutes are NOT dropped, for the reason 0003:36
-- gives about meetings.agenda. scripts/restore-backup.mjs builds its INSERT
-- column list from the keys of each dumped row, so dropping a column makes every
-- dump taken in the previous 30 days (worker/backup.ts KEEP) unrestorable
-- against this schema -- and `npm run db:restore:sql` is on the release
-- checklist precisely so that path stays exercised. Keeping them costs nothing:
-- two are NOT NULL DEFAULT 0 and one is nullable, so a schema-agnostic INSERT
-- that omits them still succeeds. They are now legacy in exactly the sense
-- meetings.notes is: never written, never read.
--
-- Zeroed so no future reader mistakes a stale mark for a live one.
UPDATE meeting_attendance SET arrived_late = 0, left_early = 0, minutes = NULL;
