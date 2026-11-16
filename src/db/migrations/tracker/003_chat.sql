-- The Ask box's conversation, kept per person so it is still there when the app is opened again.
-- links is a JSON array of {id, verb}: the entries a reply saved, changed or talked about.
CREATE TABLE chat_messages (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  text TEXT NOT NULL,
  attachment_id INTEGER,
  links TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX chat_messages_by_user ON chat_messages(user_id, id);
