-- tracker.db v5: entries a person keeps at the top of their Home page. Personal, like the chat: not part of
-- Activity, the data download or query_sql.
CREATE TABLE pins (
  user_id     INTEGER NOT NULL REFERENCES users(id),
  entry_id    INTEGER NOT NULL REFERENCES entries(id),
  created_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, entry_id)
) STRICT;
