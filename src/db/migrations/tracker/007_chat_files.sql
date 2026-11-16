-- tracker.db v7: a chat message can carry several files (the front and back of a card). A JSON array of
-- attachment ids; attachment_id stays for messages saved before this.
ALTER TABLE chat_messages ADD COLUMN attachment_ids TEXT NOT NULL DEFAULT '[]';
