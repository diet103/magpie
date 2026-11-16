-- auth.db v3: private calendar links, one per person. The link's secret is stored as a SHA-256 hash, like every
-- other credential here, so the link itself can only be shown once, when it is made.
CREATE TABLE calendar_feeds (
  token_hash         TEXT PRIMARY KEY,
  user_id            INTEGER NOT NULL UNIQUE,
  include_sensitive  INTEGER NOT NULL DEFAULT 0 CHECK (include_sensitive IN (0, 1)),
  created_at         TEXT NOT NULL,
  last_fetched_at    TEXT
) STRICT;
