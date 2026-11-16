-- tracker.db v9: what a sensitive collection holds is sealed. The app encrypts the text (src/db/vault.ts) and
-- puts it in `sealed`, leaving the plain columns empty, so the database file, its snapshots and its backups do
-- not show it. Titles, tags, ratings and dates stay readable. The Ask chat's messages are sealed the same way.
--   entries:       fields, notes, source_text
--   entry_logs:    note, raw_text
--   activity:      summary, raw_text (the rows inside before_json and after_json are kept as they are stored)
--   chat_messages: text, sources
-- SQL cannot encrypt, so the rows already here are sealed by the app the next time it starts (sealPending).
ALTER TABLE entries ADD COLUMN sealed TEXT;
ALTER TABLE entry_logs ADD COLUMN sealed TEXT;
ALTER TABLE activity ADD COLUMN sealed TEXT;
ALTER TABLE chat_messages ADD COLUMN sealed TEXT;

-- The rule, kept by the database itself: text written to an entry in a sensitive collection must arrive sealed,
-- and anywhere else it must arrive plain (query_sql and a GUI read the plain columns). Code that forgets fails
-- here instead of leaving text on the disk.
CREATE TRIGGER entries_sealed_bi BEFORE INSERT ON entries
WHEN CASE (SELECT sensitive FROM collections WHERE id = NEW.collection_id)
       WHEN 1 THEN NEW.fields != '{}' OR NEW.notes != '' OR NEW.source_text IS NOT NULL
       ELSE NEW.sealed IS NOT NULL END
BEGIN
  SELECT RAISE(ABORT, 'entries: text is sealed in a sensitive collection and plain in any other');
END;
CREATE TRIGGER entries_sealed_bu BEFORE UPDATE OF collection_id, fields, notes, source_text, sealed ON entries
WHEN CASE (SELECT sensitive FROM collections WHERE id = NEW.collection_id)
       WHEN 1 THEN NEW.fields != '{}' OR NEW.notes != '' OR NEW.source_text IS NOT NULL
       ELSE NEW.sealed IS NOT NULL END
BEGIN
  SELECT RAISE(ABORT, 'entries: text is sealed in a sensitive collection and plain in any other');
END;
CREATE TRIGGER entry_logs_sealed_bi BEFORE INSERT ON entry_logs
WHEN CASE (SELECT c.sensitive FROM entries e JOIN collections c ON c.id = e.collection_id WHERE e.id = NEW.entry_id)
       WHEN 1 THEN NEW.note != '' OR NEW.raw_text IS NOT NULL
       ELSE NEW.sealed IS NOT NULL END
BEGIN
  SELECT RAISE(ABORT, 'entry_logs: text is sealed in a sensitive collection and plain in any other');
END;
CREATE TRIGGER entry_logs_sealed_bu BEFORE UPDATE OF entry_id, note, raw_text, sealed ON entry_logs
WHEN CASE (SELECT c.sensitive FROM entries e JOIN collections c ON c.id = e.collection_id WHERE e.id = NEW.entry_id)
       WHEN 1 THEN NEW.note != '' OR NEW.raw_text IS NOT NULL
       ELSE NEW.sealed IS NOT NULL END
BEGIN
  SELECT RAISE(ABORT, 'entry_logs: text is sealed in a sensitive collection and plain in any other');
END;

-- The search index on disk now holds only the title and tags of a sealed entry, because that is all its plain
-- columns have. With this setting the words it drops are removed from the index, not just marked as gone.
INSERT INTO entries_fts(entries_fts, rank) VALUES('secure-delete', 1);

-- An entry's search document includes the words of the entries merged into it. When one of those changes how
-- its text is stored, the document is rebuilt (any update of the entry's row does that).
CREATE TRIGGER entries_merged_text_au AFTER UPDATE OF fields, notes, source_text, sealed ON entries
WHEN NEW.merged_into_id IS NOT NULL
BEGIN
  UPDATE entries SET updated_at = updated_at WHERE id = NEW.merged_into_id;
END;

-- Sealing a row that was stored plain rewrites the row, but older copies of its text can remain in parts of
-- the file that are no longer in use. Only rewriting the whole file (VACUUM) clears those. A row here says
-- that is owed; the server does it once the change has committed, and at every start while the row is here.
-- It starts owed, for whatever the rows already in this database held.
CREATE TABLE rewrite_due (
  id     INTEGER PRIMARY KEY CHECK (id = 1),
  since  TEXT NOT NULL
) STRICT;
INSERT INTO rewrite_due (id, since) VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
