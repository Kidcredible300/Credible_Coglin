-- Coglin schema v1 (COG-005).
--
-- Tenancy rule: every application table carries team_id as the first column of
-- a composite index, and team_id is NEVER read from a request body — it is
-- resolved from the authenticated session's membership row in
-- worker/lib/tenancy.ts. D1 bills per row *read*, so an unindexed tenant scan
-- costs money as well as leaking.
--
-- All timestamps are epoch SECONDS (INTEGER), matching the Inkubus convention.

-- ---------------------------------------------------------------- identity --

CREATE TABLE users (
  id            TEXT PRIMARY KEY,          -- uuid v4
  email         TEXT UNIQUE,               -- NULL for students (COPPA: minors
                                           -- are provisioned without email)
  password_hash TEXT NOT NULL,             -- pbkdf2$iters$salt$hash
  is_minor      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,             -- sha256 hex of the raw token
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

-- ------------------------------------------------------------ tenant root --

CREATE TABLE teams (
  id          TEXT PRIMARY KEY,
  team_number INTEGER NOT NULL,
  name        TEXT NOT NULL,
  region      TEXT,
  created_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_teams_number ON teams(team_number);

CREATE TABLE seasons (
  id         TEXT PRIMARY KEY,
  team_id    TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  label      TEXT NOT NULL,                -- '2026-27'
  starts_at  INTEGER NOT NULL,
  ends_at    INTEGER NOT NULL,
  is_current INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_seasons_team ON seasons(team_id, is_current);

CREATE TABLE members (
  id           TEXT PRIMARY KEY,
  team_id      TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         TEXT NOT NULL,              -- coach | mentor | student | viewer
  sub_teams    TEXT NOT NULL DEFAULT '[]', -- json array
  display_name TEXT NOT NULL,
  -- Student login is team_number + handle + password, so the handle is
  -- team-scoped by nature and lives here rather than on users. Two students on
  -- different teams may share a handle; two on the same team may not.
  handle       TEXT,
  status       TEXT NOT NULL DEFAULT 'active',
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_members_team ON members(team_id, status);
CREATE UNIQUE INDEX idx_members_team_user ON members(team_id, user_id);
CREATE INDEX idx_members_user ON members(user_id);
CREATE UNIQUE INDEX idx_members_team_handle ON members(team_id, handle);

-- -------------------------------------------------------------- work items --

CREATE TABLE boards (
  id        TEXT PRIMARY KEY,
  team_id   TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  season_id TEXT NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  name      TEXT NOT NULL,
  sub_team  TEXT,
  position  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_boards_team ON boards(team_id, season_id, position);

CREATE TABLE tasks (
  id                TEXT PRIMARY KEY,
  team_id           TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  board_id          TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  title             TEXT NOT NULL,
  body              TEXT,
  assignee_member_id TEXT REFERENCES members(id) ON DELETE SET NULL,
  status            TEXT NOT NULL DEFAULT 'todo',
  due_at            INTEGER,
  position          INTEGER NOT NULL DEFAULT 0,
  -- Raw material for the Think award: "what we tried, why we changed it",
  -- captured at the moment of work rather than reconstructed in March.
  decision_log      TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX idx_tasks_board ON tasks(team_id, board_id, position);
CREATE INDEX idx_tasks_assignee ON tasks(team_id, assignee_member_id);

-- ---------------------------------------------------------------- outreach --

CREATE TABLE outreach_events (
  id               TEXT PRIMARY KEY,
  team_id          TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  season_id        TEXT NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  title            TEXT NOT NULL,
  occurred_at      INTEGER NOT NULL,
  hours            REAL NOT NULL DEFAULT 0,
  people_reached   INTEGER NOT NULL DEFAULT 0,
  what_we_learned  TEXT,
  created_by       TEXT REFERENCES members(id) ON DELETE SET NULL,
  created_at       INTEGER NOT NULL
);
CREATE INDEX idx_outreach_team_season
  ON outreach_events(team_id, season_id, occurred_at);

-- ------------------------------------------------------------------ awards --

CREATE TABLE award_criteria (
  id            TEXT PRIMARY KEY,
  team_id       TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  season_id     TEXT NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  award         TEXT NOT NULL,             -- think | connect | reach | ...
  criterion_key TEXT NOT NULL,
  state         TEXT NOT NULL DEFAULT 'todo',
  notes         TEXT
);
CREATE UNIQUE INDEX idx_award_criteria_unique
  ON award_criteria(team_id, season_id, award, criterion_key);

-- Polymorphic on purpose: award criteria and portfolio pages both link to
-- tasks, outreach entries, and media. One join table beats six.
CREATE TABLE evidence_links (
  id           TEXT PRIMARY KEY,
  team_id      TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL,              -- award_criterion | portfolio_page
  subject_id   TEXT NOT NULL,
  target_type  TEXT NOT NULL,              -- task | outreach_event | media
  target_id    TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_evidence_subject
  ON evidence_links(team_id, subject_type, subject_id);
CREATE INDEX idx_evidence_target
  ON evidence_links(team_id, target_type, target_id);

-- ------------------------------------------------------------------- media --

CREATE TABLE media (
  id          TEXT PRIMARY KEY,
  team_id     TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  season_id   TEXT REFERENCES seasons(id) ON DELETE SET NULL,
  r2_key      TEXT NOT NULL,               -- teams/<team_id>/<season>/<uuid>.<ext>
  kind        TEXT NOT NULL DEFAULT 'photo',
  bytes       INTEGER NOT NULL,
  width       INTEGER,
  height      INTEGER,
  caption     TEXT,
  tags        TEXT NOT NULL DEFAULT '[]',
  uploaded_by TEXT REFERENCES members(id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_media_team ON media(team_id, created_at);
CREATE UNIQUE INDEX idx_media_key ON media(r2_key);

-- --------------------------------------------------------- money & season --

CREATE TABLE budget_lines (
  id           TEXT PRIMARY KEY,
  team_id      TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  season_id    TEXT NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,              -- income | expense
  label        TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  occurred_at  INTEGER NOT NULL
);
CREATE INDEX idx_budget_team_season
  ON budget_lines(team_id, season_id, occurred_at);

CREATE TABLE sponsors (
  id           TEXT PRIMARY KEY,
  team_id      TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  season_id    TEXT NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  tier         TEXT,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  thanked_at   INTEGER
);
CREATE INDEX idx_sponsors_team_season ON sponsors(team_id, season_id);

CREATE TABLE portfolio_pages (
  id              TEXT PRIMARY KEY,
  team_id         TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  season_id       TEXT NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  page_no         INTEGER NOT NULL,        -- 1..15 (cover is 0)
  title           TEXT NOT NULL,
  owner_member_id TEXT REFERENCES members(id) ON DELETE SET NULL,
  state           TEXT NOT NULL DEFAULT 'empty'
);
CREATE UNIQUE INDEX idx_portfolio_page_no
  ON portfolio_pages(team_id, season_id, page_no);

CREATE TABLE calendar_events (
  id        TEXT PRIMARY KEY,
  team_id   TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  season_id TEXT NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  kind      TEXT NOT NULL,                 -- meet | qualifier | deadline | ...
  title     TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  ends_at   INTEGER
);
CREATE INDEX idx_calendar_team_season
  ON calendar_events(team_id, season_id, starts_at);

CREATE TABLE meetings (
  id        TEXT PRIMARY KEY,
  team_id   TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  season_id TEXT NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  starts_at INTEGER NOT NULL,
  agenda    TEXT,
  notes     TEXT,
  attendees TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_meetings_team_season
  ON meetings(team_id, season_id, starts_at);

-- ------------------------------------------------------------ entitlements --

-- Source-agnostic, mirroring the Inkubus `subscriptions` pattern: the paywall
-- check never learns where the money came from, so free-alpha, free-pilot,
-- PO-paid and Stripe-paid are all one code path.
CREATE TABLE entitlements (
  id          TEXT PRIMARY KEY,
  team_id     TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  season_id   TEXT NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  tier        TEXT NOT NULL,               -- rookie | team | club
  source      TEXT NOT NULL,               -- stripe | promo | manual | po
  status      TEXT NOT NULL,               -- active | expired | pending
  verified_at INTEGER,                     -- season-scoped FIRST verification
  expires_at  INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_entitlements_team ON entitlements(team_id, season_id, status);
