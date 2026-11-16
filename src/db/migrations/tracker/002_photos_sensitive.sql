-- tracker.db v2: sensitive collections (details stay out of search output and query_sql) and photo attachments.
ALTER TABLE collections ADD COLUMN sensitive INTEGER NOT NULL DEFAULT 0 CHECK (sensitive IN (0, 1));

-- The bytes live encrypted in DATA_DIR/files/<id>.enc. entry_id is NULL for a photo sent to the built-in
-- assistant that hasn't been attached to an entry yet.
CREATE TABLE attachments (
  id          INTEGER PRIMARY KEY,
  entry_id    INTEGER REFERENCES entries(id),
  filename    TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  created_by  INTEGER NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL,
  deleted_at  TEXT
) STRICT;
CREATE INDEX attachments_by_entry ON attachments(entry_id);
