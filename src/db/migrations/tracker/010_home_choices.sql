-- tracker.db v10: two things a person chooses about their own Home page. Personal, like pins: not part of
-- Activity, the data download or query_sql.

-- A date a person has hidden from "Coming up". It is one occurrence: the entry, the date field and the day that
-- was shown. Next year's birthday, or a renewal date that has been changed, is a different row and shows again.
CREATE TABLE hidden_dates (
  user_id     INTEGER NOT NULL REFERENCES users(id),
  entry_id    INTEGER NOT NULL REFERENCES entries(id),
  field       TEXT NOT NULL,
  date        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, entry_id, field, date)
) STRICT;

-- Collections a person keeps first in the list on their Home page.
CREATE TABLE collection_pins (
  user_id        INTEGER NOT NULL REFERENCES users(id),
  collection_id  INTEGER NOT NULL REFERENCES collections(id),
  created_at     TEXT NOT NULL,
  PRIMARY KEY (user_id, collection_id)
) STRICT;
