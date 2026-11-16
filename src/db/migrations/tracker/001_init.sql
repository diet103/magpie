-- tracker.db v1. Connection setup (WAL, foreign keys, busy timeout) happens in src/db/sqlite.ts.

CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT NOT NULL,
  google_sub    TEXT UNIQUE,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

CREATE TABLE collections (
  id            INTEGER PRIMARY KEY,
  slug          TEXT NOT NULL CHECK (slug GLOB '[a-z0-9]*' AND slug NOT GLOB '*[^a-z0-9-]*'),
  name          TEXT NOT NULL,
  description   TEXT NOT NULL,                 -- what belongs here; Claude routes on this
  icon          TEXT,                          -- one emoji
  fields        TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(fields) AND json_type(fields) = 'array'),
  display       TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(display) AND json_type(display) = 'object'),
  visibility    TEXT NOT NULL DEFAULT 'shared' CHECK (visibility IN ('shared','private')),
  owner_id      INTEGER REFERENCES users(id),
  scope_id      INTEGER GENERATED ALWAYS AS (CASE visibility WHEN 'private' THEN owner_id ELSE 0 END) VIRTUAL,
  created_by    INTEGER NOT NULL REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  archived_at   TEXT,
  CHECK (visibility = 'shared' OR owner_id IS NOT NULL)
) STRICT;
-- slugs are unique per scope: shared collections share scope 0, each person's private ones get their own scope
CREATE UNIQUE INDEX collections_scope_slug ON collections(scope_id, slug);

CREATE TABLE entries (
  id               INTEGER PRIMARY KEY,
  collection_id    INTEGER NOT NULL REFERENCES collections(id),
  title            TEXT NOT NULL CHECK (length(trim(title)) > 0),
  title_key        TEXT NOT NULL,              -- normalized title for duplicate detection (set by app)
  fields           TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fields) AND json_type(fields) = 'object'),
  tags             TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags) AND json_type(tags) = 'array'),
  rating           REAL,                     -- overall rating, maintained by triggers: rating_override, else the latest-dated rated log
  rating_override  REAL CHECK (rating_override IS NULL OR (rating_override BETWEEN 0 AND 5 AND rating_override * 2 = CAST(rating_override * 2 AS INTEGER))),
  notes            TEXT NOT NULL DEFAULT '',
  source_text      TEXT,                       -- what the user said when the entry was created
  first_logged_on  TEXT,                       -- maintained by entry_logs triggers
  last_logged_on   TEXT,
  log_count        INTEGER NOT NULL DEFAULT 0,
  created_by       INTEGER NOT NULL REFERENCES users(id),
  updated_by       INTEGER REFERENCES users(id),
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at       TEXT,
  merged_into_id   INTEGER REFERENCES entries(id),
  revision         INTEGER NOT NULL DEFAULT 0  -- bumped by trigger on every change to the entry or its logs
) STRICT;
CREATE INDEX entries_by_collection ON entries(collection_id, deleted_at, last_logged_on);
CREATE INDEX entries_by_title_key ON entries(title_key);

CREATE TABLE entry_logs (
  id            INTEGER PRIMARY KEY,
  entry_id      INTEGER NOT NULL REFERENCES entries(id),
  occurred_on   TEXT NOT NULL CHECK (date(occurred_on) IS occurred_on),   -- real calendar date, YYYY-MM-DD
  note          TEXT NOT NULL DEFAULT '',
  rating        REAL CHECK (rating IS NULL OR (rating BETWEEN 0 AND 5 AND rating * 2 = CAST(rating * 2 AS INTEGER))),
  raw_text      TEXT,                          -- the user's words for this occasion
  created_by    INTEGER NOT NULL REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at    TEXT
) STRICT;
CREATE INDEX entry_logs_by_entry ON entry_logs(entry_id, occurred_on);

CREATE TABLE activity (
  id             INTEGER PRIMARY KEY,
  at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  user_id        INTEGER NOT NULL REFERENCES users(id),
  via            TEXT NOT NULL CHECK (via IN ('mcp','web','cli')),
  client         TEXT,                         -- e.g. 'claude.ai', 'Claude Code', 'web'
  action         TEXT NOT NULL,                -- save_entry, add_log, update_entry, merge_entries, ...
  collection_id  INTEGER REFERENCES collections(id),
  entry_id       INTEGER REFERENCES entries(id),
  summary        TEXT NOT NULL,                -- the one-line confirmation
  raw_text       TEXT,
  before_json    TEXT CHECK (before_json IS NULL OR json_valid(before_json)),
  after_json     TEXT CHECK (after_json IS NULL OR json_valid(after_json)),
  undone_by      INTEGER REFERENCES activity(id)
) STRICT;
CREATE INDEX activity_by_user ON activity(user_id, at);
CREATE INDEX activity_by_entry ON activity(entry_id, at);

-- Full-text search. Standalone FTS5 table kept in sync by pure-SQL triggers,
-- so edits made with sqlite3 or a GUI stay searchable too.
CREATE VIRTUAL TABLE entries_fts USING fts5(
  title, tags, fields, notes, logs, said,
  tokenize = 'porter unicode61 remove_diacritics 2',
  prefix = '2 3'
);

CREATE VIEW entry_search_doc AS
SELECT
  e.id    AS id,
  e.title AS title,
  coalesce((SELECT group_concat(j.value, ' ') FROM json_each(e.tags) j), '') AS tags,
  coalesce((SELECT group_concat(CAST(j.value AS TEXT), ' ') FROM json_each(e.fields) j
            WHERE j.type IN ('text','integer','real','array')), '') AS fields,
  e.notes AS notes,
  coalesce((SELECT group_concat(l.note, ' ') FROM entry_logs l
            WHERE l.entry_id = e.id AND l.deleted_at IS NULL), '') AS logs,
  trim(coalesce(e.source_text, '') || ' ' ||
       coalesce((SELECT group_concat(l.raw_text, ' ') FROM entry_logs l
                 WHERE l.entry_id = e.id AND l.deleted_at IS NULL AND l.raw_text IS NOT NULL), '') || ' ' ||
       coalesce((SELECT group_concat(m.source_text, ' ') FROM entries m
                 WHERE m.merged_into_id = e.id AND m.source_text IS NOT NULL), '')) AS said
FROM entries e
WHERE e.deleted_at IS NULL AND e.merged_into_id IS NULL;

CREATE TRIGGER entries_fts_ai AFTER INSERT ON entries BEGIN
  DELETE FROM entries_fts WHERE rowid = NEW.id;   -- idempotent: other AFTER INSERT triggers may already have indexed it
  INSERT INTO entries_fts(rowid, title, tags, fields, notes, logs, said)
    SELECT id, title, tags, fields, notes, logs, said FROM entry_search_doc WHERE id = NEW.id;
END;
CREATE TRIGGER entries_fts_au AFTER UPDATE ON entries BEGIN
  DELETE FROM entries_fts WHERE rowid = OLD.id;
  INSERT INTO entries_fts(rowid, title, tags, fields, notes, logs, said)
    SELECT id, title, tags, fields, notes, logs, said FROM entry_search_doc WHERE id = NEW.id;
END;
CREATE TRIGGER entries_fts_ad AFTER DELETE ON entries BEGIN
  DELETE FROM entries_fts WHERE rowid = OLD.id;
END;

-- Log changes refresh the parent's aggregates; that UPDATE fires entries_fts_au, which reindexes it.
CREATE TRIGGER entry_logs_ai AFTER INSERT ON entry_logs BEGIN
  UPDATE entries SET
    log_count       = (SELECT count(*)         FROM entry_logs l WHERE l.entry_id = entries.id AND l.deleted_at IS NULL),
    first_logged_on = (SELECT min(occurred_on) FROM entry_logs l WHERE l.entry_id = entries.id AND l.deleted_at IS NULL),
    last_logged_on  = (SELECT max(occurred_on) FROM entry_logs l WHERE l.entry_id = entries.id AND l.deleted_at IS NULL),
    rating          = coalesce(rating_override, (SELECT l.rating FROM entry_logs l
                        WHERE l.entry_id = entries.id AND l.deleted_at IS NULL AND l.rating IS NOT NULL
                        ORDER BY l.occurred_on DESC, l.id DESC LIMIT 1))
  WHERE id = NEW.entry_id;
END;
CREATE TRIGGER entry_logs_au AFTER UPDATE ON entry_logs BEGIN
  UPDATE entries SET
    log_count       = (SELECT count(*)         FROM entry_logs l WHERE l.entry_id = entries.id AND l.deleted_at IS NULL),
    first_logged_on = (SELECT min(occurred_on) FROM entry_logs l WHERE l.entry_id = entries.id AND l.deleted_at IS NULL),
    last_logged_on  = (SELECT max(occurred_on) FROM entry_logs l WHERE l.entry_id = entries.id AND l.deleted_at IS NULL),
    rating          = coalesce(rating_override, (SELECT l.rating FROM entry_logs l
                        WHERE l.entry_id = entries.id AND l.deleted_at IS NULL AND l.rating IS NOT NULL
                        ORDER BY l.occurred_on DESC, l.id DESC LIMIT 1))
  WHERE id IN (OLD.entry_id, NEW.entry_id);
END;
CREATE TRIGGER entry_logs_ad AFTER DELETE ON entry_logs BEGIN
  UPDATE entries SET
    log_count       = (SELECT count(*)         FROM entry_logs l WHERE l.entry_id = entries.id AND l.deleted_at IS NULL),
    first_logged_on = (SELECT min(occurred_on) FROM entry_logs l WHERE l.entry_id = entries.id AND l.deleted_at IS NULL),
    last_logged_on  = (SELECT max(occurred_on) FROM entry_logs l WHERE l.entry_id = entries.id AND l.deleted_at IS NULL),
    rating          = coalesce(rating_override, (SELECT l.rating FROM entry_logs l
                        WHERE l.entry_id = entries.id AND l.deleted_at IS NULL AND l.rating IS NOT NULL
                        ORDER BY l.occurred_on DESC, l.id DESC LIMIT 1))
  WHERE id = OLD.entry_id;
END;

-- Overall rating = rating_override if set, else the rating of the latest-dated rated log.
CREATE TRIGGER entries_rating_ai AFTER INSERT ON entries BEGIN
  UPDATE entries SET rating = coalesce(rating_override, (SELECT l.rating FROM entry_logs l
      WHERE l.entry_id = entries.id AND l.deleted_at IS NULL AND l.rating IS NOT NULL
      ORDER BY l.occurred_on DESC, l.id DESC LIMIT 1))
  WHERE id = NEW.id;
END;
CREATE TRIGGER entries_rating_au AFTER UPDATE OF rating_override ON entries BEGIN
  UPDATE entries SET rating = coalesce(rating_override, (SELECT l.rating FROM entry_logs l
      WHERE l.entry_id = entries.id AND l.deleted_at IS NULL AND l.rating IS NOT NULL
      ORDER BY l.occurred_on DESC, l.id DESC LIMIT 1))
  WHERE id = NEW.id;
END;
-- Any change to an entry row (app, GUI, or the log triggers above) bumps its revision once.
CREATE TRIGGER entries_revision AFTER UPDATE ON entries WHEN NEW.revision = OLD.revision BEGIN
  UPDATE entries SET revision = OLD.revision + 1 WHERE id = NEW.id;
END;

PRAGMA user_version = 1;
