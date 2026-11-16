#!/bin/sh
# Starts the tracker under Litestream. Fails closed: it never silently starts with an empty database.
set -eu

DB=/data/tracker.db
mkdir -p /data
chown -R node:node /data
as_node() { setpriv --reuid=node --regid=node --init-groups "$@"; }

# Prints "ok" (tracker schema present), "empty" (a readable database with no tables at all, e.g. a zero-byte
# file left by a failed copy) or "error" (anything else). Only a confirmed-empty file is ever moved aside.
schema_state() {
  if ! out="$(as_node sqlite3 "$DB" 'PRAGMA user_version; SELECT count(*) FROM sqlite_schema;' 2>&1)"; then
    echo error
    return
  fi
  v="$(echo "$out" | sed -n 1p)"
  n="$(echo "$out" | sed -n 2p)"
  if [ "${v:-0}" -ge 1 ] 2>/dev/null; then echo ok
  elif [ "$v" = "0" ] && [ "$n" = "0" ]; then echo empty
  else echo error
  fi
}

if [ -f "$DB" ]; then
  state="$(schema_state)"
  if [ "$state" = "empty" ]; then
    stamp="$(date +%Y%m%d%H%M%S)"
    echo "$DB is an empty database; moving it aside as $DB.empty-$stamp" >&2
    for f in "$DB" "$DB-wal" "$DB-shm"; do
      if [ -f "$f" ]; then mv "$f" "$f.empty-$stamp"; fi
    done
  elif [ "$state" != "ok" ]; then
    echo "$DB exists but couldn't be read as a tracker database. Refusing to start; inspect it with fly ssh console." >&2
    exit 1
  fi
fi

replicating=0
if [ -n "${R2_BUCKET:-}" ] && [ -n "${R2_ACCOUNT_ID:-}" ] && [ -n "${LITESTREAM_ACCESS_KEY_ID:-}" ] && [ -n "${LITESTREAM_SECRET_ACCESS_KEY:-}" ]; then
  replicating=1
fi

if [ ! -f "$DB" ]; then
  if [ "$replicating" = 1 ]; then
    echo "No local database; restoring from the Litestream replica if there is one." >&2
    # Restored beside the real name and moved into place only once it has passed its checks. A copy that fails
    # them must not be sitting at $DB on the next start, where it would be taken for the live database.
    RESTORING="$DB.restoring"
    rm -f "$RESTORING" "$RESTORING-wal" "$RESTORING-shm"
    as_node litestream restore -config /etc/litestream.yml -if-replica-exists -o "$RESTORING" "$DB"
    if [ -f "$RESTORING" ]; then
      result="$(as_node sqlite3 "$RESTORING" 'PRAGMA integrity_check' 2>&1 || true)"
      if [ "$result" != "ok" ]; then
        echo "Restored database failed its checks (integrity_check: $result). It was left at $RESTORING for a look and is not in use." >&2
        exit 1
      fi
      mv "$RESTORING" "$DB"
      rm -f "$RESTORING-wal" "$RESTORING-shm"
    fi
  fi
  if [ -f "$DB" ]; then
    if [ "$(schema_state)" != "ok" ]; then
      echo "Restored database is not a tracker database. Moving it aside as $DB.rejected." >&2
      mv "$DB" "$DB.rejected"
      exit 1
    fi
    # Never bring back old sessions or refresh tokens after a restore.
    rm -f /data/auth.db /data/auth.db-wal /data/auth.db-shm
    echo "Restored $DB from the replica; auth.db was reset, so sign in and reconnect Claude again." >&2
  elif [ "${BOOTSTRAP_EMPTY_DB:-}" != "1" ]; then
    echo "No database and no replica. Set BOOTSTRAP_EMPTY_DB=1 for the very first deploy only." >&2
    exit 1
  fi
fi

if [ "$replicating" = 1 ]; then
  exec setpriv --reuid=node --regid=node --init-groups litestream replicate -config /etc/litestream.yml -exec "node src/server.ts"
fi
echo "WARNING: R2 is not configured, so there is no continuous backup." >&2
exec setpriv --reuid=node --regid=node --init-groups node src/server.ts
