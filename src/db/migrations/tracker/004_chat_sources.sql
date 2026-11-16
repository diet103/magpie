-- Web pages a reply drew on, as a JSON array of {url, title}.
ALTER TABLE chat_messages ADD COLUMN sources TEXT NOT NULL DEFAULT '[]';
