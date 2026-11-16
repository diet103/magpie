// Sealed text. What a sensitive collection holds, and the Ask chat's conversation, are encrypted before they
// reach tracker.db: AES-256-GCM under a key derived from FILES_KEY (a Fly secret, so it is not on the disk or in
// any backup of it). A sealed value is "v1:" + base64(iv (12) + tag (16) + ciphertext) of a small JSON object.
//
// The app reads through views that exist only on its own connection, in memory, and open what is sealed:
//   open_entries, open_logs, open_activity   the tables, with sealed text opened
//   open_fts                                 the search index the app uses, with every entry's words
// Anything that opens the file without the key (sqlite3, a GUI, a backup) sees the sealed rows as they are stored.
// The words to write are prepared by src/domain/sealed.ts; triggers in migration 009 refuse text that arrives
// in the wrong form.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

type DB = DatabaseSync;
export type Parts = Record<string, string | null>;

const PREFIX = 'v1:';

interface Vault {
  key: Buffer | undefined;
  /** The value opened last. One row's parts are asked for one after another, so this saves most of the work. */
  last?: { sealed: string; parts: Parts };
}

const vaults = new WeakMap<DB, Vault>();

function vaultOf(db: DB): Vault {
  const v = vaults.get(db);
  if (!v) throw new Error('This database connection was opened without openVault.');
  return v;
}

/** Whether this server has the key that sealing needs. */
export function canSeal(db: DB): boolean {
  return vaultOf(db).key !== undefined;
}

export function seal(db: DB, parts: Parts): string {
  const { key } = vaultOf(db);
  if (!key) throw new Error('There is no FILES_KEY to seal with.');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const sealed = Buffer.concat([cipher.update(JSON.stringify(parts), 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString('base64');
}

export function unseal(db: DB, sealed: string): Parts {
  const vault = vaultOf(db);
  if (vault.last?.sealed === sealed) return vault.last.parts;
  if (!vault.key) throw new Error('This database holds sealed text, and there is no FILES_KEY to open it with.');
  if (!sealed.startsWith(PREFIX)) throw new Error('A sealed value is in a form this version does not know.');
  const blob = Buffer.from(sealed.slice(PREFIX.length), 'base64');
  let parts: Parts;
  try {
    const decipher = createDecipheriv('aes-256-gcm', vault.key, blob.subarray(0, 12));
    decipher.setAuthTag(blob.subarray(12, 28));
    parts = JSON.parse(Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]).toString('utf8')) as Parts;
  } catch {
    throw new Error('Sealed text could not be opened. FILES_KEY is not the key it was saved with, or the value is damaged.');
  }
  vault.last = { sealed, parts };
  return parts;
}

const opened = (column: string, empty: string) =>
  `CASE WHEN sealed IS NULL THEN ${column} ELSE ${empty === 'NULL' ? `unseal_part(sealed, '${column}')` : `coalesce(unseal_part(sealed, '${column}'), ${empty})`} END AS ${column}`;

const FTS_COLUMNS = 'title, tags, fields, notes, logs, said';
const REINDEX = `
  DELETE FROM open_fts WHERE rowid = NEW.id;
  INSERT INTO open_fts(rowid, ${FTS_COLUMNS}) SELECT id, ${FTS_COLUMNS} FROM open_search_doc WHERE id = NEW.id;`;

const OPEN_SCHEMA = `
CREATE TEMP VIEW open_entries AS
SELECT id, collection_id, title, title_key, ${opened('fields', `'{}'`)}, tags, rating, rating_override,
       ${opened('notes', `''`)}, ${opened('source_text', 'NULL')},
       first_logged_on, last_logged_on, log_count, created_by, updated_by, created_at, updated_at, deleted_at,
       merged_into_id, revision, sealed
  FROM main.entries;

CREATE TEMP VIEW open_logs AS
SELECT id, entry_id, occurred_on, ${opened('note', `''`)}, rating, ${opened('raw_text', 'NULL')},
       created_by, created_at, updated_at, deleted_at, sealed
  FROM main.entry_logs;

CREATE TEMP VIEW open_activity AS
SELECT id, at, user_id, via, client, action, collection_id, entry_id, ${opened('summary', `''`)},
       ${opened('raw_text', 'NULL')}, before_json, after_json, undone_by, sealed
  FROM main.activity;

-- The same document entry_search_doc builds for the index on disk, from the opened rows.
CREATE TEMP VIEW open_search_doc AS
SELECT
  e.id    AS id,
  e.title AS title,
  coalesce((SELECT group_concat(j.value, ' ') FROM json_each(e.tags) j), '') AS tags,
  coalesce((SELECT group_concat(CAST(j.value AS TEXT), ' ') FROM json_each(e.fields) j
            WHERE j.type IN ('text','integer','real','array')), '') AS fields,
  e.notes AS notes,
  coalesce((SELECT group_concat(l.note, ' ') FROM open_logs l
            WHERE l.entry_id = e.id AND l.deleted_at IS NULL), '') AS logs,
  trim(coalesce(e.source_text, '') || ' ' ||
       coalesce((SELECT group_concat(l.raw_text, ' ') FROM open_logs l
                 WHERE l.entry_id = e.id AND l.deleted_at IS NULL AND l.raw_text IS NOT NULL), '') || ' ' ||
       coalesce((SELECT group_concat(m.source_text, ' ') FROM open_entries m
                 WHERE m.merged_into_id = e.id AND m.source_text IS NOT NULL), '')) AS said
FROM open_entries e
WHERE e.deleted_at IS NULL AND e.merged_into_id IS NULL;

CREATE VIRTUAL TABLE temp.open_fts USING fts5(
  ${FTS_COLUMNS},
  tokenize = 'porter unicode61 remove_diacritics 2',
  prefix = '2 3'
);

-- Kept in step the way the index on disk is: every change to an entry row re-indexes it, and the log triggers
-- touch the entry row.
CREATE TEMP TRIGGER open_fts_ai AFTER INSERT ON main.entries BEGIN${REINDEX}
END;
CREATE TEMP TRIGGER open_fts_au AFTER UPDATE ON main.entries BEGIN${REINDEX}
END;
CREATE TEMP TRIGGER open_fts_ad AFTER DELETE ON main.entries BEGIN
  DELETE FROM open_fts WHERE rowid = OLD.id;
END;
`;

/**
 * Gives a connection to tracker.db its key, the open_ views and the in-memory search index. It opens every
 * sealed entry once to fill the index, so a key that does not fit what is saved stops the start here, before
 * anything can be shown empty or written over.
 */
export function openVault(db: DB, filesKey: Buffer | undefined) {
  const key = filesKey ? Buffer.from(hkdfSync('sha256', filesKey, Buffer.alloc(0), 'magpie sealed text v1', 32)) : undefined;
  vaults.set(db, { key });
  // The temp schema holds opened text (the search index). It must never be a file.
  db.exec('PRAGMA temp_store = MEMORY');
  db.function('unseal_part', { deterministic: true }, (sealed, part) => unseal(db, String(sealed))[String(part)] ?? null);
  db.exec(OPEN_SCHEMA);
  try {
    db.exec(`INSERT INTO open_fts(rowid, ${FTS_COLUMNS}) SELECT id, ${FTS_COLUMNS} FROM open_search_doc`);
    for (const table of ['entries', 'entry_logs', 'activity', 'chat_messages']) {
      const row = db.prepare(`SELECT sealed FROM main.${table} WHERE sealed IS NOT NULL LIMIT 1`).get() as { sealed: string } | undefined;
      if (row) unseal(db, row.sealed);
    }
  } catch (err) {
    throw new Error(
      `The sensitive entries in this database cannot be opened: ${err instanceof Error ? err.message : String(err)} ` +
        'Set FILES_KEY to the key they were saved with (setup wrote a copy to magpie-photo-key.txt).',
    );
  }
}
