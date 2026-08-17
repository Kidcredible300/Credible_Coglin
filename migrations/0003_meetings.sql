-- Meetings, notes and portfolio candidates (COG-036).
--
-- The shape of everything below is forced by one product requirement: a student
-- must be able to flag an entry, a single paragraph, a picture, or a whole page
-- as a candidate for the portfolio. Paragraph-level flagging means a note body
-- cannot be one TEXT blob — every paragraph and every image needs an id that is
-- stable across edits, joinable, and indexable. Hence `meeting_note_blocks` as
-- rows rather than a JSON document on `meetings`.
--
-- The query that settles that argument is the candidates inbox: "the 50 most
-- recent flagged paragraphs this season, with their meeting title and date". As
-- rows that is one statement reading ~150 rows. As a JSON column it cannot be
-- expressed in SQL at all — you read every meeting of the season and parse each
-- document in the Worker. Rows also give last-write-wins at PARAGRAPH
-- granularity instead of document granularity, which is the difference between
-- two students taking notes together and two students overwriting each other.
--
-- ATTENDANCE IS A DELIBERATE, ACCEPTED TRADE, in the spirit of 0002's refusal
-- to store an invite email. `meeting_attendance` is the first table in this
-- schema that records where a named minor was on a named evening. That is real
-- PII about children, it lands in the nightly R2 dump like everything else, and
-- it is kept anyway because the Sustain award requires documented progress
-- tracking and "who is still showing up in February" is the team's own record
-- of itself. What bounds it: no times of arrival beyond an optional duration,
-- no location, no free-text about a person beyond a coach's own note, and it
-- cascades away with the member row. If you are here to add a richer log of
-- individual students — that is the trade being refused, not an oversight.
--
-- Migration mechanics, all of which have bitten someone:
--   * wrangler splits this file on semicolons, so there must not be one inside
--     a comment or a string literal, and there can be no triggers (a BEGIN/END
--     body contains them). `updated_at` is maintained by the Worker instead.
--   * `meeting_series` is created BEFORE the ALTER that references it. SQLite
--     requires the target of an added REFERENCES column to already exist.
--   * a column added with REFERENCES must default to NULL, and a column added
--     NOT NULL must have a non-NULL default. Both rules are obeyed below.
--   * `meetings.agenda`, `meetings.notes` and `meetings.attendees` are NOT
--     dropped. Migrations here are append-only, a drop rewrites the table, and
--     scripts/restore-backup.mjs still reads dumps that contain them. They are
--     legacy from 0001: never written again, never read by the new API.

-- ------------------------------------------------------------------- timezone

-- A recurring meeting is a wall-clock rule and every timestamp here is epoch
-- seconds, so the rule can only be materialised against a zone. It belongs to
-- the team because a team meets in one place: "Tuesdays at 6pm" means 6pm at the
-- shop, not 6pm wherever the coach's laptop happens to be that week.
--
-- The default is a plausible-and-fixable value rather than UTC, which is wrong
-- for every FIRST team on earth and wrong in a way nobody notices until a
-- season is already materialised.
ALTER TABLE teams ADD COLUMN timezone TEXT NOT NULL DEFAULT 'America/New_York';

-- --------------------------------------------------------------------- series

CREATE TABLE meeting_series (
  id               TEXT PRIMARY KEY,
  team_id          TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  season_id        TEXT NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  title            TEXT NOT NULL,
  kind             TEXT NOT NULL DEFAULT 'build',
  location         TEXT,
  -- json array of ints 0..6, 0 = Sunday, matching JS Date#getDay
  days_of_week     TEXT NOT NULL DEFAULT '[]',
  -- Minutes after LOCAL midnight, never a UTC time-of-day. A UTC time bakes in
  -- whichever DST regime was in force the day the coach created the series, and
  -- an FTC season spans both transitions.
  start_minute     INTEGER NOT NULL,
  duration_minutes INTEGER NOT NULL DEFAULT 120,
  -- Snapshot of the team timezone at creation. Changing the team's zone later
  -- must not silently reinterpret a season that is already on the calendar.
  timezone         TEXT NOT NULL,
  -- Local dates as YYYYMMDD, not epochs. The bounds of a recurrence rule are
  -- calendar facts and comparing them as integers avoids re-deriving a zone.
  starts_on        INTEGER NOT NULL,
  until            INTEGER NOT NULL,
  created_by       TEXT REFERENCES members(id) ON DELETE SET NULL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE INDEX idx_meeting_series_team
  ON meeting_series(team_id, season_id, starts_on);

-- ------------------------------------------------------------------- meetings

ALTER TABLE meetings ADD COLUMN title TEXT NOT NULL DEFAULT 'Team meeting';
ALTER TABLE meetings ADD COLUMN ends_at INTEGER;
ALTER TABLE meetings ADD COLUMN location TEXT;
-- build | outreach | design_review | business | drive_practice | competition | other
ALTER TABLE meetings ADD COLUMN kind TEXT NOT NULL DEFAULT 'build';
-- planned | held | cancelled
ALTER TABLE meetings ADD COLUMN status TEXT NOT NULL DEFAULT 'planned';
ALTER TABLE meetings ADD COLUMN series_id TEXT REFERENCES meeting_series(id) ON DELETE SET NULL;
-- The occurrence's LOCAL date as YYYYMMDD. This is the load-bearing column for
-- recurrence: it is an occurrence's identity within its series, and it survives
-- a reschedule because moving a meeting changes starts_at and not its slot.
-- Combined with the unique index below, re-expanding a series is an idempotent
-- no-op instead of a duplicate storm.
ALTER TABLE meetings ADD COLUMN series_slot INTEGER;
-- Set when a single occurrence is moved or cancelled by hand. A series edit
-- never touches a detached occurrence: an explicit human decision about one
-- evening outranks the rule that generated it.
ALTER TABLE meetings ADD COLUMN detached_at INTEGER;
ALTER TABLE meetings ADD COLUMN started_at INTEGER;
ALTER TABLE meetings ADD COLUMN ended_at INTEGER;
ALTER TABLE meetings ADD COLUMN cancel_reason TEXT;
ALTER TABLE meetings ADD COLUMN created_by TEXT REFERENCES members(id) ON DELETE SET NULL;
ALTER TABLE meetings ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;

UPDATE meetings SET updated_at = created_at WHERE updated_at = 0;

-- A plain unique index rather than a partial one. SQLite treats NULLs as
-- distinct in a unique index, so every one-off meeting (series_id IS NULL) is
-- exempt automatically — and taking the plain form avoids the rule that an
-- upsert targeting a partial index must repeat its WHERE clause. Doubles as the
-- "list this series' occurrences" index.
CREATE UNIQUE INDEX idx_meetings_series_slot
  ON meetings(team_id, series_id, series_slot);

CREATE INDEX idx_meetings_team_status
  ON meetings(team_id, season_id, status, starts_at);

-- --------------------------------------------------------------------- agenda

-- Agenda items are planning and happen before, note blocks are capture and
-- happen during. They stay separate tables even though both are ordered lists
-- of text on a meeting, because merging them would make
-- portfolio_candidates.source_type = 'meeting_block' ambiguous — the inbox
-- would have to filter a discriminator to avoid offering "Item 3: review CAD"
-- as portfolio evidence. Their columns are disjoint too, so one table would be
-- half-NULL by construction.
CREATE TABLE meeting_agenda_items (
  id              TEXT PRIMARY KEY,
  team_id         TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  meeting_id      TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  position        REAL NOT NULL DEFAULT 0,
  title           TEXT NOT NULL,
  detail          TEXT,
  owner_member_id TEXT REFERENCES members(id) ON DELETE SET NULL,
  minutes_planned INTEGER,
  sub_team        TEXT,
  done            INTEGER NOT NULL DEFAULT 0,
  created_by      TEXT REFERENCES members(id) ON DELETE SET NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX idx_meeting_agenda_meeting
  ON meeting_agenda_items(team_id, meeting_id, position);

-- ---------------------------------------------------------------- note blocks

CREATE TABLE meeting_note_blocks (
  id                    TEXT PRIMARY KEY,
  team_id               TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  meeting_id            TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  -- REAL, not INTEGER, and this diverges from tasks.position on purpose. The
  -- dominant operation in a notes editor is insert-between: every Enter
  -- keypress. With integers that renumbers the tail, so one keystroke writes
  -- forty rows. With floats it writes one. Spacing is 1024 and a bulk reorder
  -- renormalises, so precision never degrades. outreach_events.hours already
  -- establishes REAL in this schema.
  position              REAL NOT NULL DEFAULT 0,
  -- heading | paragraph | bullet | decision | action | image
  --
  -- `decision` earns its place by being the Think award's raw material, and it
  -- is what a promoted action item copies into tasks.decision_log.
  kind                  TEXT NOT NULL DEFAULT 'paragraph',
  text                  TEXT NOT NULL DEFAULT '',
  media_id              TEXT REFERENCES media(id) ON DELETE SET NULL,
  source_agenda_item_id TEXT REFERENCES meeting_agenda_items(id) ON DELETE SET NULL,
  created_by_member_id  TEXT REFERENCES members(id) ON DELETE SET NULL,
  -- Attribution rather than restriction: anyone in the room may fix any block,
  -- because a shared document where you can only edit your own paragraphs is
  -- unusable the moment somebody types a typo and goes home. Recording who
  -- touched it last keeps the record answerable without locking it.
  updated_by_member_id  TEXT REFERENCES members(id) ON DELETE SET NULL,
  -- Soft delete, always. Undo is table stakes in a notes editor, and a student
  -- deleting a paragraph must not silently destroy a portfolio flag that
  -- somebody else put on it.
  deleted_at            INTEGER,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);

-- deleted_at sits third deliberately: with equality on the first three columns
-- the ORDER BY position is satisfied by the index itself, so reading a
-- meeting's live blocks is a pure range scan that never touches a deleted row.
CREATE INDEX idx_meeting_blocks_meeting
  ON meeting_note_blocks(team_id, meeting_id, deleted_at, position);

CREATE INDEX idx_meeting_blocks_media
  ON meeting_note_blocks(team_id, media_id);

-- ----------------------------------------------------------------- attendance

-- Normalised rather than the JSON array on `meetings`, for three reasons. The
-- Sustain rollup is a GROUP BY that an array turns into a parse of the whole
-- season. Marking attendance is a per-student write that an array turns into
-- read-modify-write, so two people taking roll lose each other's marks. And
-- `excused` is exactly the distinction a Sustain narrative needs, which a list
-- of member ids cannot hold.
--
-- STATE AND THE TIMING FLAGS ARE SEPARATE, because they are separate facts. The
-- first cut of this had a single enum including `late`, which cannot express
-- "turned up twenty minutes in and left before the end" — and that is a normal
-- Tuesday, not an edge case. Coaches already track it as independent marks on a
-- spreadsheet, so the schema tracks it that way too: `state` is the disposition,
-- `arrived_late` and `left_early` are marks on top of it, and `minutes` is the
-- time actually in the room, which is what the Sustain hours arithmetic wants.
--
-- member_id CASCADEs rather than SET NULL: members are retired by flipping
-- `status`, so an actual DELETE means "erase this person", and their attendance
-- must go with them.
CREATE TABLE meeting_attendance (
  id           TEXT PRIMARY KEY,
  team_id      TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  meeting_id   TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  member_id    TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  state        TEXT NOT NULL DEFAULT 'present',  -- present | absent | excused
  arrived_late INTEGER NOT NULL DEFAULT 0,
  left_early   INTEGER NOT NULL DEFAULT 0,
  minutes      INTEGER,
  note         TEXT,
  recorded_by  TEXT REFERENCES members(id) ON DELETE SET NULL,
  recorded_at  INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_attendance_unique
  ON meeting_attendance(team_id, meeting_id, member_id);

-- The Sustain rollup: one member's attendance across a season.
CREATE INDEX idx_attendance_member
  ON meeting_attendance(team_id, member_id, recorded_at);

-- --------------------------------------------------------------- action items

-- Separate from `tasks` because a task requires a board_id, and choosing a
-- board mid-sentence while somebody is still talking is exactly the friction
-- that stops anything being captured at all. An action item needs only text.
-- Promotion to a real board task is a later, explicit act.
CREATE TABLE meeting_action_items (
  id                 TEXT PRIMARY KEY,
  team_id            TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  meeting_id         TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  -- Links an `action`-kind note block to its item rather than duplicating the
  -- text: the block holds the line as typed in the note stream, this row holds
  -- assignee, due date and status. Nullable, because an item can also be added
  -- straight from the meeting's action list without ever being a note line.
  block_id           TEXT REFERENCES meeting_note_blocks(id) ON DELETE SET NULL,
  text               TEXT NOT NULL,
  assignee_member_id TEXT REFERENCES members(id) ON DELETE SET NULL,
  due_at             INTEGER,
  status             TEXT NOT NULL DEFAULT 'open',  -- open | done | dropped
  -- SET NULL, not CASCADE: the board task is attribution, not ownership.
  -- Deleting a task must not erase the record that a meeting produced it.
  task_id            TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  created_by         TEXT REFERENCES members(id) ON DELETE SET NULL,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

CREATE INDEX idx_action_items_meeting
  ON meeting_action_items(team_id, meeting_id, created_at);
CREATE INDEX idx_action_items_assignee
  ON meeting_action_items(team_id, assignee_member_id, status);
CREATE INDEX idx_action_items_open
  ON meeting_action_items(team_id, status, due_at);

-- --------------------------------------------------------- portfolio candidates

-- The inbox half of the portfolio planner (COG-017). A candidate is a pointer
-- to anything plus a judgement about it.
--
-- This is NOT a reuse of `evidence_links`, and the reason is that a candidate
-- has no subject. An evidence link is a confirmed edge from something that
-- already exists — an award criterion, a portfolio page — to a piece of
-- evidence. A student flagging a paragraph in November has no page in mind, so
-- there is nothing to put in subject_id without inventing a sentinel, which
-- would be a schema lying about its own shape. The uniqueness semantics differ
-- too: the same photo can back three criteria, but you flag a paragraph once.
--
-- The two tables meet at placement: setting state = 'placed' writes the
-- evidence_links row in the same batch. Candidates is the inbox, evidence_links
-- is the filed result.
CREATE TABLE portfolio_candidates (
  id              TEXT PRIMARY KEY,
  team_id         TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  season_id       TEXT NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  -- meeting | meeting_block | media | task | outreach_event
  --
  -- Polymorphic with no FK, the same trade evidence_links already makes. The
  -- Worker validates that the source exists within the team before inserting,
  -- which is not optional here precisely because the database cannot.
  source_type     TEXT NOT NULL,
  source_id       TEXT NOT NULL,
  -- inspire | think | connect | reach | sustain | innovate | control | design
  -- Nullable: asking a 14-year-old mid-meeting which award a paragraph serves
  -- is how flagging stops happening. It gets tagged later, in the inbox.
  suggested_award TEXT,
  why             TEXT,
  -- candidate | shortlisted | placed | rejected
  state           TEXT NOT NULL DEFAULT 'candidate',
  placed_page_id  TEXT REFERENCES portfolio_pages(id) ON DELETE SET NULL,
  flagged_by      TEXT REFERENCES members(id) ON DELETE SET NULL,
  decided_by      TEXT REFERENCES members(id) ON DELETE SET NULL,
  decided_at      INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

-- One flag per thing per TEAM, not per member: two students flagging the same
-- paragraph is one idempotent act, not two rows to reconcile later. This is
-- also the lookup the editor uses to decide whether to draw the mark.
CREATE UNIQUE INDEX idx_portfolio_candidates_source
  ON portfolio_candidates(team_id, source_type, source_id);

CREATE INDEX idx_portfolio_candidates_inbox
  ON portfolio_candidates(team_id, season_id, state, created_at);

CREATE INDEX idx_portfolio_candidates_award
  ON portfolio_candidates(team_id, season_id, suggested_award, state);

CREATE INDEX idx_portfolio_candidates_page
  ON portfolio_candidates(team_id, placed_page_id);

-- --------------------------------------------------------------------- media

-- The per-team-per-season quota check (SUM(bytes)) had no index to stand on.
CREATE INDEX idx_media_team_season
  ON media(team_id, season_id, created_at);
