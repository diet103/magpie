-- auth.db v1: OAuth codes and tokens, Google sign-in flows, web sessions. Never backed up.
CREATE TABLE cimd_cache (
  client_id   TEXT PRIMARY KEY,
  document    TEXT NOT NULL CHECK (json_valid(document)),
  fetched_at  TEXT NOT NULL
) STRICT;
CREATE TABLE auth_requests (
  id              TEXT PRIMARY KEY,
  client_id       TEXT NOT NULL,
  redirect_uri    TEXT NOT NULL,
  state           TEXT,
  code_challenge  TEXT NOT NULL,
  scope           TEXT,
  resource        TEXT,
  created_at      TEXT NOT NULL,
  expires_at      TEXT NOT NULL
) STRICT;
CREATE TABLE login_flows (
  state            TEXT PRIMARY KEY,
  nonce            TEXT NOT NULL,
  code_verifier    TEXT NOT NULL,
  purpose          TEXT NOT NULL CHECK (purpose IN ('web','oauth')),
  auth_request_id  TEXT REFERENCES auth_requests(id),
  return_to        TEXT,
  expires_at       TEXT NOT NULL
) STRICT;
CREATE TABLE auth_codes (
  code_hash        TEXT PRIMARY KEY,
  auth_request_id  TEXT NOT NULL,
  user_id          INTEGER NOT NULL,
  client_id        TEXT NOT NULL,
  redirect_uri     TEXT NOT NULL,
  code_challenge   TEXT NOT NULL,
  scope            TEXT,
  resource         TEXT,
  expires_at       TEXT NOT NULL,
  used_at          TEXT
) STRICT;
CREATE TABLE tokens (
  token_hash    TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('access','refresh','pat')),
  family_id     TEXT,
  user_id       INTEGER NOT NULL,
  client_id     TEXT,
  scope         TEXT,
  resource      TEXT,
  label         TEXT,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  last_used_at  TEXT,
  rotated_at    TEXT,
  successor     TEXT,
  revoked_at    TEXT
) STRICT;
CREATE INDEX tokens_by_family ON tokens(family_id);
CREATE INDEX tokens_by_user ON tokens(user_id, kind);
CREATE TABLE web_sessions (
  id_hash       TEXT PRIMARY KEY,
  user_id       INTEGER NOT NULL,
  csrf_secret   TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  last_seen_at  TEXT,
  user_agent    TEXT
) STRICT;
PRAGMA user_version = 1;
