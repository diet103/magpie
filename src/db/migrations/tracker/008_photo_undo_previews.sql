-- tracker.db v8: a removed photo can be brought back, photos get a small preview, and the off-site backup is told
-- when a photo is gone for good.
--
-- The table is rebuilt so that an id is never handed out twice (AUTOINCREMENT). A phone keeps a photo under its
-- id for good and the off-site copy is stored under it, so a new photo must never get the id of an old one.
CREATE TABLE attachments_v8 (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id      INTEGER REFERENCES entries(id),
  filename      TEXT NOT NULL,
  mime          TEXT NOT NULL,
  size          INTEGER NOT NULL,
  created_by    INTEGER NOT NULL REFERENCES users(id),
  created_at    TEXT NOT NULL,
  -- Set when the photo is removed. Undo clears it; 30 days later the row and the file are cleared out.
  deleted_at    TEXT,
  -- Size in bytes of the small preview in DATA_DIR/files/<id>.small.enc, or NULL when there is none.
  preview_size  INTEGER
) STRICT;
INSERT INTO attachments_v8 (id, entry_id, filename, mime, size, created_by, created_at, deleted_at)
  SELECT id, entry_id, filename, mime, size, created_by, created_at, deleted_at FROM attachments;
DROP TABLE attachments;
ALTER TABLE attachments_v8 RENAME TO attachments;
CREATE INDEX attachments_by_entry ON attachments(entry_id);

-- Ids that were handed out and cleared away before this are not recorded anywhere, and a phone may still hold a
-- picture under one of them. Leave a gap above the highest id in use so none of them comes round again.
INSERT INTO sqlite_sequence (name, seq) SELECT 'attachments', 0 WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'attachments');
UPDATE sqlite_sequence SET seq = seq + 1000 WHERE name = 'attachments';

-- Photos whose rows are gone for good, kept until the nightly job has removed their copies from the off-site
-- backup. A trigger fills it so that no way of deleting a row can be missed.
CREATE TABLE removed_attachments (
  id          INTEGER PRIMARY KEY,
  removed_at  TEXT NOT NULL
) STRICT;
CREATE TRIGGER attachments_removed AFTER DELETE ON attachments BEGIN
  INSERT OR REPLACE INTO removed_attachments (id, removed_at) VALUES (old.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
