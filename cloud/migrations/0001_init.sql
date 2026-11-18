-- Cloud edition schema (Cloudflare D1 / SQLite).
-- Every user-owned table references users(id) ON DELETE CASCADE, so deleting a user deletes all of their data.
-- No Jira issue payloads are stored: only what monitoring and notification history need.

PRAGMA foreign_keys = ON;

-- One row per Atlassian account that has signed in.
CREATE TABLE users (
  id                   TEXT PRIMARY KEY,              -- random id, never shown to other users
  atlassian_account_id TEXT NOT NULL UNIQUE,
  name                 TEXT NOT NULL,
  email                TEXT,
  picture              TEXT,
  created_at           INTEGER NOT NULL,              -- epoch ms
  last_seen_at         INTEGER NOT NULL
);

-- Browser sessions. Only a SHA-256 hash of the session token is stored; the token itself lives in an
-- HttpOnly cookie, so a database leak does not leak usable sessions.
CREATE TABLE sessions (
  id_hash      TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,                       -- absolute expiry
  last_used_at INTEGER NOT NULL,                       -- idle expiry is checked against this
  user_agent   TEXT
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX sessions_expiry ON sessions(expires_at);

-- The OAuth 2.0 (3LO) grant. Atlassian issues one grant per app per account, covering every site the
-- user consented to, so there is one row per user.
CREATE TABLE oauth_grants (
  user_id           TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enc_tokens        TEXT NOT NULL,                     -- AES-256-GCM(iv || ciphertext) of {access, refresh}, AAD bound to user_id
  key_id            TEXT NOT NULL,                     -- which encryption key encrypted it (for key rotation)
  access_expires_at INTEGER NOT NULL,
  scopes            TEXT NOT NULL,
  version           INTEGER NOT NULL DEFAULT 1,        -- optimistic concurrency for rotating refresh tokens
  lease_until       INTEGER NOT NULL DEFAULT 0,        -- short lock while one worker refreshes
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  updated_at        INTEGER NOT NULL
);

-- Jira sites the grant can reach (from /oauth/token/accessible-resources).
CREATE TABLE jira_sites (
  user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cloud_id TEXT NOT NULL,
  name     TEXT NOT NULL,
  url      TEXT NOT NULL,
  PRIMARY KEY (user_id, cloud_id)
);

-- Per-user settings, including the server-side notification rules that apply when no tab is open.
CREATE TABLE user_settings (
  user_id            TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  active_cloud_id    TEXT,
  severity_fields    TEXT NOT NULL DEFAULT 'Defect Severity, Severity',
  issue_types        TEXT NOT NULL DEFAULT 'Bug',
  severity_ids       TEXT NOT NULL DEFAULT '[]',       -- resolved field ids (JSON)
  severity_names     TEXT NOT NULL DEFAULT '[]',       -- their display names, lower-cased (JSON)
  monitor_enabled    INTEGER NOT NULL DEFAULT 1,
  monitor_paused     INTEGER NOT NULL DEFAULT 0,
  interval_min       INTEGER NOT NULL DEFAULT 5,
  closed_window_days INTEGER NOT NULL DEFAULT 90,
  slot               INTEGER NOT NULL,                 -- 0..59: spreads users across cron minutes
  notify_prefs       TEXT NOT NULL DEFAULT '{}',       -- event types, quiet hours, time zone, frequency (JSON)
  updated_at         INTEGER NOT NULL
);

-- Incremental monitoring checkpoint for the active site.
CREATE TABLE monitor_state (
  user_id        TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  cloud_id       TEXT NOT NULL,
  initialized    INTEGER NOT NULL DEFAULT 0,           -- 0 until the baseline is recorded (history is never announced)
  snapshot       TEXT NOT NULL DEFAULT '{}',           -- { issueKey: [updated, summary, project] } (JSON)
  seen           TEXT NOT NULL DEFAULT '[]',           -- stable ids of changelog items / comments already turned into events
  status_cats    TEXT NOT NULL DEFAULT '{}',           -- status id -> category, filled lazily
  priority_names TEXT,                                 -- the site's priority order (JSON)
  checked_at     INTEGER NOT NULL DEFAULT 0,           -- last successful check (written at most every 20 min when idle)
  reconciled_at  INTEGER NOT NULL DEFAULT 0,           -- last full list comparison
  deferred       INTEGER NOT NULL DEFAULT 0,           -- 1 = ran out of budget, finish next minute
  failures       INTEGER NOT NULL DEFAULT 0,
  backoff_until  INTEGER NOT NULL DEFAULT 0,
  last_error     TEXT
);

-- Notification history. `pushed`: 0 = waiting to be delivered, 1 = delivered or nothing to deliver, 2 = gave up.
CREATE TABLE events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  at          INTEGER NOT NULL,                        -- detected
  occurred_at TEXT NOT NULL,                           -- happened in Jira
  issue_key   TEXT NOT NULL,
  summary     TEXT NOT NULL,
  project     TEXT NOT NULL,
  url         TEXT NOT NULL,
  actor       TEXT,
  from_v      TEXT,
  to_v        TEXT,
  detail      TEXT,
  escalated   INTEGER NOT NULL DEFAULT 0,
  importance  TEXT NOT NULL,
  own         INTEGER NOT NULL DEFAULT 0,
  read        INTEGER NOT NULL DEFAULT 0,
  pushed      INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX events_user ON events(user_id, id);
CREATE INDEX events_pending ON events(user_id, id) WHERE pushed = 0;

-- Web Push subscriptions, one per browser/device.
CREATE TABLE push_subscriptions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint   TEXT NOT NULL UNIQUE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  label      TEXT,
  created_at INTEGER NOT NULL,
  last_ok_at INTEGER,
  failures   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX push_user ON push_subscriptions(user_id);

-- Fixed-window counters for abuse-prone endpoints (sign-in). Rows expire via the hourly cleanup.
CREATE TABLE rate_limits (
  bucket     TEXT PRIMARY KEY,
  count      INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
