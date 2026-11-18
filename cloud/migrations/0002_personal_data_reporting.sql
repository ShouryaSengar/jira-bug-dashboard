-- Atlassian Personal Data Reporting API support.
-- Apps that store personal data must report each stored accountId (with the time the data was fetched)
-- every cycle period (default 7 days) and erase or refresh the data when Atlassian answers "closed" / "updated".

-- When a signed-in user's name, e-mail and avatar were last fetched from Atlassian.
ALTER TABLE users ADD COLUMN profile_at INTEGER NOT NULL DEFAULT 0;
UPDATE users SET profile_at = last_seen_at;

-- Account id of the person who made a change, so names in the notification history can be reported and scrubbed.
ALTER TABLE events ADD COLUMN actor_id TEXT;
CREATE INDEX events_actor ON events(actor_id) WHERE actor_id IS NOT NULL;

-- When each account was last reported.
CREATE TABLE pdr_reports (
  account_id  TEXT PRIMARY KEY,
  reported_at INTEGER NOT NULL
);

-- Small key/value store for app-wide state (reporting cycle, back-off).
CREATE TABLE app_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
