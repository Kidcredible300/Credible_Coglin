-- Invites (COG-006).
--
-- A coach creates an invite, Coglin emails the link, the recipient opens it and
-- chooses their own handle and password. The row here is what makes that link
-- redeemable exactly once.
--
-- THERE IS NO EMAIL COLUMN, AND THAT IS DELIBERATE. The address the coach types
-- is passed straight to the mail binding and then dropped — never bound into a
-- statement, never logged. Coglin's users are 12-18 (COG-003), so the amount of
-- minor PII sitting in D1 should be as close to zero as the product allows, and
-- an invite does not need to remember where it was sent in order to work.
--
-- The cost of that is real and accepted: no "sent to jane@..." in the UI, no
-- one-click resend, no bounce visible in-app. The invite dialog compensates by
-- also showing the coach a copyable link, so a mail that never arrives is never
-- a dead end. If you are here because you want to add `email TEXT` to make
-- resend easier — that is the trade being refused, not an oversight.

CREATE TABLE invites (
  -- SHA-256 of the raw token (peppered), same trick as `sessions`: the value in
  -- the emailed URL is never what is stored, so a D1 leak yields no live links.
  id                  TEXT PRIMARY KEY,
  team_id             TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  role                TEXT NOT NULL,              -- mentor | student | viewer
  display_name        TEXT NOT NULL,              -- so the roster reads right
                                                  -- before the invitee accepts
  sub_teams           TEXT NOT NULL DEFAULT '[]', -- json array
  created_by_member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  created_at          INTEGER NOT NULL,
  expires_at          INTEGER NOT NULL,
  accepted_at         INTEGER,
  accepted_member_id  TEXT REFERENCES members(id) ON DELETE SET NULL
);

-- team_id first, per the tenancy rule: the coach's "pending invites" list is a
-- tenant-scoped read and must not scan other teams' rows.
CREATE INDEX idx_invites_team ON invites(team_id, accepted_at, expires_at);
