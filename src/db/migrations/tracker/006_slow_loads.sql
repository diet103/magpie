-- tracker.db v6: page loads that took long on someone's phone, as the phone measured them, so "it felt slow" has
-- an answer. Only the newest are kept. Not part of the data download or query_sql.
CREATE TABLE slow_loads (
  id           INTEGER PRIMARY KEY,
  at           TEXT NOT NULL,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  page         TEXT NOT NULL,     -- the kind of page, never which entry: "/e/N"
  total_ms     INTEGER NOT NULL,
  startup_ms   INTEGER NOT NULL,  -- starting the app's background worker
  connect_ms   INTEGER NOT NULL,  -- reaching the server
  wait_ms      INTEGER NOT NULL,  -- the server working on the answer
  download_ms  INTEGER NOT NULL,
  render_ms    INTEGER NOT NULL,  -- the phone drawing the page
  kind         TEXT NOT NULL,     -- navigate, reload or back_forward
  network      TEXT               -- what the phone called its connection, such as 4g
) STRICT;
