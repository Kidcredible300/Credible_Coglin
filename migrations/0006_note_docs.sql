-- Notes become documents (COG-043).
--
-- 0003 argued for rows over a blob and was right FOR THE REQUIREMENT IT HAD: a
-- student had to be able to flag one paragraph, so every paragraph needed an id
-- that was stable, joinable and indexable. That requirement is withdrawn — a flag
-- now attaches to a whole document — and the query that settled the original
-- argument, "the 50 most recent flagged things this season with their meeting
-- title and date", is 50 rows of note_docs instead of 150 rows of blocks. Rows
-- bought paragraph granularity and nothing else.
--
-- WHAT THIS COSTS, and it is the real one: 0003 also noted that rows give
-- last-write-wins at PARAGRAPH granularity rather than document granularity,
-- "which is the difference between two students taking notes together and two
-- students overwriting each other". One content column loses that. The mitigation
-- is compare-and-swap on updated_at in routes/notes.ts, which turns a silent
-- overwrite into a 409 the editor can offer a choice about. The real fix is the
-- Durable Object that lib/useNoteSync.ts already names as the roadmap answer.
--
-- WHAT IT BUYS, beyond what was asked for: TipTap's history extension gives undo
-- across the whole document, and selecting across paragraphs to copy starts
-- working. Both were impossible with one textarea per block, and NoteEditor.tsx
-- apologised for both in a comment.
--
-- Migration mechanics are unchanged from 0003:29-40 — wrangler splits on
-- semicolons, so no semicolon inside a comment or a string literal, and no
-- triggers, which is why updated_at stays the Worker's job. There are no ALTER
-- TABLE ADD COLUMN statements here at all, so the rules about defaults on added
-- columns do not bite. note_docs is created BEFORE the rebuild that references
-- it, because SQLite requires an FK target to exist.

-- ------------------------------------------------------------------ note_docs

CREATE TABLE note_docs (
  id             TEXT PRIMARY KEY,
  team_id        TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  season_id      TEXT NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  -- Nesting, Confluence-style. CASCADE so a hard delete of a parent cannot leave
  -- children pointing at a missing row -- SQLite applies it recursively. The
  -- normal delete path is SOFT and never reaches this.
  parent_doc_id  TEXT REFERENCES note_docs(id) ON DELETE CASCADE,
  -- NULL means the document stands on its own, which is the whole point: a design
  -- rationale or a budget writeup is not a meeting artifact.
  --
  -- SET NULL rather than CASCADE, because a meeting row is PROVENANCE, not
  -- ownership. Deleting the Nov 11 meeting must not shred the notes taken that
  -- evening, it must leave them standalone. Same reasoning as
  -- meeting_action_items.task_id in 0003.
  --
  -- DENORMALISED ONTO EVERY DOCUMENT, subdocuments included, and the Worker keeps
  -- a whole tree on one meeting. Deriving it from the tree root would turn "the
  -- documents for this meeting" -- which the meeting screen asks on every load --
  -- into a recursive CTE, to save rewriting a handful of rows on a drag that
  -- happens twice a season.
  meeting_id     TEXT REFERENCES meetings(id) ON DELETE SET NULL,
  -- REAL and sparse, for the reason meeting_note_blocks.position was REAL:
  -- dropping a document between two siblings is a one-row write. Ordering is
  -- among siblings of the same parent only.
  position       REAL NOT NULL DEFAULT 0,
  title          TEXT NOT NULL DEFAULT 'Untitled',
  -- TipTap/ProseMirror JSON, exactly what editor.getJSON() produces.
  --
  -- NOT HTML: storing markup means every consumer needs a sanitiser, and the day
  -- something renders a document outside the editor -- a print view, a digest
  -- mail -- the one that forgets is an XSS. ProseMirror JSON is inert data,
  -- validated against the editor schema on load, and an unknown node type is
  -- dropped rather than executed.
  --
  -- NOT MARKDOWN: there is no markdown library in this project, so it would mean
  -- adding a parser AND a serialiser, which is two lossy conversions where JSON
  -- has none. Markdown also cannot carry an image node's media_id without
  -- inventing a syntax. The request was that TYPING markdown work, which is an
  -- input-rule feature and independent of storage.
  content        TEXT NOT NULL DEFAULT '',
  -- The plain-text projection, derived by the Worker on every content write and
  -- never accepted from a client.
  --
  -- This is the one thing a JSON column takes away and the only reason it is
  -- affordable. The candidates inbox needs an excerpt and search needs a LIKE, and
  -- neither is expressible against JSON in SQL.
  content_text   TEXT NOT NULL DEFAULT '',
  -- The compare-and-swap token, incremented on every content write.
  --
  -- NOT updated_at, which is what the first cut used and which is wrong for the
  -- one case this exists to handle. Every timestamp in this schema is epoch
  -- SECONDS, so two saves inside the same second carry the same updated_at -- and
  -- "two people typing at once" is precisely when a stale write must be caught.
  -- The guard passed exactly when it was needed and failed only under a test that
  -- happened to be slow.
  --
  -- A monotonic counter has no resolution to run out of, and it does not tempt
  -- anybody into making one column milliseconds while the other twenty stay
  -- seconds.
  rev            INTEGER NOT NULL DEFAULT 1,
  created_by     TEXT REFERENCES members(id) ON DELETE SET NULL,
  -- Attribution rather than restriction, verbatim from 0003: anyone on the team
  -- may fix any document, because a shared page where you can only edit your own
  -- half is unusable the moment somebody types a typo and goes home.
  updated_by     TEXT REFERENCES members(id) ON DELETE SET NULL,
  -- Soft delete, and the stakes are higher than they were for a block: one delete
  -- now removes what used to be forty flaggable paragraphs, and a portfolio flag
  -- somebody else put on this document has to outlive it.
  deleted_at     INTEGER,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

-- The /notes sidebar reads the whole season's tree in ONE statement and assembles
-- it in memory. With parent_doc_id and position trailing an equality prefix the
-- scan arrives already grouped by parent and ordered within each group, so the
-- tree build is one pass and no sort. deleted_at sits third for the reason 0003
-- gives: the range scan never touches a deleted row.
CREATE INDEX idx_note_docs_season
  ON note_docs(team_id, season_id, deleted_at, parent_doc_id, position);

-- "The documents attached to this meeting", which GET /api/meetings/:id asks on
-- every load and the series content check asks per occurrence.
CREATE INDEX idx_note_docs_meeting
  ON note_docs(team_id, meeting_id, deleted_at, position);

-- The subtree walk in the reparent guard. Not served by the season index, whose
-- prefix requires season_id, and the recursive CTE does not have one.
CREATE INDEX idx_note_docs_parent
  ON note_docs(team_id, parent_doc_id, deleted_at, position);

-- NO INDEX ON updated_at. There is no "recently edited" screen yet, and an index
-- with no query is a write cost with no reader.

-- CYCLE PREVENTION HAS NO DDL HERE, and that is not an oversight. D1 forbids
-- triggers (the semicolon rule above) and this schema declines CHECK constraints
-- by convention, and neither could walk a parent chain anyway. The invariant that
-- a document is never its own ancestor lives entirely in routes/notes.ts, which
-- walks UP from the proposed parent before every reparent. Do not assume the
-- database is holding it.

-- ------------------------------------------------- meeting_action_items rebuild

-- block_id becomes doc_id, and this is the statement that has to land before the
-- DROP below rather than after it.
--
-- 0003:251 declares block_id REFERENCES meeting_note_blocks(id), and it is the
-- last reference to that table. SQLite leaves a dangling REFERENCES behind in the
-- child's stored schema, and with foreign keys enforced the next INSERT here fails
-- with "no such table: main.meeting_note_blocks". The FK has to go before the
-- parent does.
--
-- A full rebuild rather than DROP COLUMN: dropping a column that carries a
-- REFERENCES clause is precisely the case where SQLite's ALTER TABLE cleanup
-- should not be trusted, and the rebuild is the documented route.
CREATE TABLE meeting_action_items_new (
  id                 TEXT PRIMARY KEY,
  team_id            TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  meeting_id         TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  -- Which document the item was captured in, kept for provenance. Never written
  -- by the current UI: an action item is now the coach's own list for a meeting
  -- rather than a projection of a line somebody typed in the note stream.
  doc_id             TEXT REFERENCES note_docs(id) ON DELETE SET NULL,
  text               TEXT NOT NULL,
  -- Kept and unwritten. The only readers of this list are coaches and mentors, so
  -- offering a student assignee would create an assignment they can never see --
  -- but the column stays so a future shared-action-items feature can use it.
  assignee_member_id TEXT REFERENCES members(id) ON DELETE SET NULL,
  due_at             INTEGER,
  status             TEXT NOT NULL DEFAULT 'open',
  -- SET NULL, not CASCADE, unchanged from 0003: the board task is attribution,
  -- not ownership.
  task_id            TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  created_by         TEXT REFERENCES members(id) ON DELETE SET NULL,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

-- doc_id starts NULL for every existing row: the block_id values point at rows
-- that are about to stop existing, so carrying them across would preserve a
-- reference to nothing.
INSERT INTO meeting_action_items_new
  (id, team_id, meeting_id, doc_id, text, assignee_member_id, due_at, status,
   task_id, created_by, created_at, updated_at)
SELECT id, team_id, meeting_id, NULL, text, assignee_member_id, due_at, status,
       task_id, created_by, created_at, updated_at
  FROM meeting_action_items;

DROP TABLE meeting_action_items;

-- Safe because nothing REFERENCES meeting_action_items: modern SQLite rewrites
-- referring clauses on rename, and here there are none to rewrite.
ALTER TABLE meeting_action_items_new RENAME TO meeting_action_items;

-- Recreated AFTER the rename, never before. Creating them on the _new table would
-- collide with the identically named indexes still sitting on the old one.
CREATE INDEX idx_action_items_meeting
  ON meeting_action_items(team_id, meeting_id, created_at);
CREATE INDEX idx_action_items_assignee
  ON meeting_action_items(team_id, assignee_member_id, status);
CREATE INDEX idx_action_items_open
  ON meeting_action_items(team_id, status, due_at);

-- ------------------------------------------------------------------- the blocks

-- Nothing references it now. Its own indexes go with it.
DROP TABLE meeting_note_blocks;

-- Flags pointing into a table that no longer exists. Destructive by agreement --
-- there is no production data to preserve -- and necessary rather than merely
-- tidy: sourceExists() in routes/candidates.ts would otherwise answer the next
-- inbox read with "no such table".
DELETE FROM portfolio_candidates WHERE source_type = 'meeting_block';

-- meeting_agenda_items is deliberately UNTOUCHED. 0003 kept it separate from the
-- note blocks for two reasons and the first has now retired: source_type
-- 'meeting_block' can no longer be ambiguous because it no longer exists. The
-- second still stands -- the columns are disjoint and one table would be
-- half-NULL -- so the split survives on its own merits rather than by inertia.
