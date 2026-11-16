// How the text of a sensitive collection is written and read back (the encryption itself is src/db/vault.ts).
//
// Reading: use open_entries, open_logs and open_activity wherever what a row says matters. They are the tables
// with sealed text opened, and each row still carries its `sealed` value. The tables themselves hold a sealed
// row's text columns empty.
// Writing: every statement that sets an entry's or a log's text sets all of its text columns and `sealed`
// together, from entryText() or logText(). The triggers in migration 009 refuse anything else.
// History: the rows kept in an activity's before_json and after_json are in stored form, never opened, and
// all of them are sealed when the change touches anything sensitive. When an entry comes into a sensitive
// collection, sealHistory() goes back over what was recorded about it earlier.
// The file: sealing text that was stored plain leaves a rewrite of the file owed (rewriteDue).
import { all, get, onCommit, run, tx, type DB } from '../db/sqlite.ts';
import { canSeal, seal, unseal } from '../db/vault.ts';
import { UserError } from './errors.ts';
import { nowIso } from './time.ts';
import type { EntryRow, LogRow, Snapshot } from './types.ts';

export interface EntryText {
  fields: string;
  notes: string;
  source_text: string | null;
}

export interface LogText {
  note: string;
  raw_text: string | null;
}

interface Sealable {
  sealed?: string | null;
}

/** The SET clauses that go with entryText() and logText(). */
export const ENTRY_TEXT_SET = 'fields = ?, notes = ?, source_text = ?, sealed = ?';
export const LOG_TEXT_SET = 'note = ?, raw_text = ?, sealed = ?';

function sealParts(db: DB, parts: Record<string, string | null>): string {
  if (!canSeal(db)) {
    throw new UserError("This server has no FILES_KEY, so it can't keep anything in a sensitive collection. Run setup again; it adds the missing key.");
  }
  return seal(db, parts);
}

export function isSensitive(db: DB, collectionId: number): boolean {
  return get<{ sensitive: number }>(db, 'SELECT sensitive FROM collections WHERE id = ?', collectionId)?.sensitive === 1;
}

const hasEntryText = (t: EntryText) => t.fields !== '{}' || t.notes !== '' || t.source_text !== null;
const hasLogText = (t: LogText) => t.note !== '' || t.raw_text !== null;

/** An entry's fields, notes, source_text and sealed, as its collection stores them. */
export function entryText(db: DB, sensitive: boolean | number, t: EntryText): [string, string, string | null, string | null] {
  if (!sensitive) return [t.fields, t.notes, t.source_text, null];
  if (!hasEntryText(t)) return ['{}', '', null, null];
  return ['{}', '', null, sealParts(db, { fields: t.fields, notes: t.notes, source_text: t.source_text })];
}

/** A log's note, raw_text and sealed, as its entry's collection stores them. */
export function logText(db: DB, sensitive: boolean | number, t: LogText): [string, string | null, string | null] {
  if (!sensitive) return [t.note, t.raw_text, null];
  if (!hasLogText(t)) return ['', null, null];
  return ['', null, sealParts(db, { note: t.note, raw_text: t.raw_text })];
}

/** An activity row's summary, raw_text and sealed. */
export function activityText(db: DB, sensitive: boolean | number, t: { summary: string; raw_text: string | null }): [string, string | null, string | null] {
  if (!sensitive) return [t.summary, t.raw_text, null];
  return ['', null, sealParts(db, { summary: t.summary, raw_text: t.raw_text })];
}

/** A chat message's text, sources and sealed. The chat is sealed whenever the server has a key. */
export function chatText(db: DB, t: { text: string; sources: string }): [string, string, string | null] {
  if (!canSeal(db)) return [t.text, t.sources, null];
  return ['', '[]', seal(db, { text: t.text, sources: t.sources })];
}

export function openChat<T extends { text: string; sources: string } & Sealable>(db: DB, row: T): T {
  if (!row.sealed) return row;
  const p = unseal(db, row.sealed);
  return { ...row, text: p.text ?? '', sources: p.sources ?? '[]' };
}

/** A stored entry row (from a snapshot, say) with its text opened. */
export function openEntry<T extends EntryText & Sealable>(db: DB, row: T): T {
  if (!row.sealed) return row;
  const p = unseal(db, row.sealed);
  return { ...row, fields: p.fields ?? '{}', notes: p.notes ?? '', source_text: p.source_text ?? null };
}

export function openLog<T extends LogText & Sealable>(db: DB, row: T): T {
  if (!row.sealed) return row;
  const p = unseal(db, row.sealed);
  return { ...row, note: p.note ?? '', raw_text: p.raw_text ?? null };
}

/** An entry row as the table holds it: a row read through open_entries has its opened text taken out again. */
export function storedEntry<T extends EntryText & Sealable>(row: T): T {
  return row.sealed ? { ...row, fields: '{}', notes: '', source_text: null } : row;
}

export function storedLog<T extends LogText & Sealable>(row: T): T {
  return row.sealed ? { ...row, note: '', raw_text: null } : row;
}

/** A snapshot fit to be written to the activity table: no row in it carries opened text. */
export function storedSnapshot(snap: Snapshot): Snapshot {
  return {
    ...snap,
    ...(snap.entries ? { entries: snap.entries.map(storedEntry) } : {}),
    ...(snap.logs ? { logs: snap.logs.map(storedLog) } : {}),
  };
}

/** A snapshot with every row opened and no `sealed` left in it, for the data download. */
export function openSnapshot(db: DB, snap: Snapshot): Snapshot {
  const plain = <T extends Sealable>({ sealed: _sealed, ...row }: T) => row;
  return {
    ...snap,
    ...(snap.entries ? { entries: snap.entries.map((e) => plain(openEntry(db, e))) } : {}),
    ...(snap.logs ? { logs: snap.logs.map((l) => plain(openLog(db, l))) } : {}),
  };
}

/**
 * Says the database file is owed a rewrite: text that was stored plain has just been sealed, and older copies
 * of it can remain in parts of the file no longer in use (see rewrite_due in migration 009).
 */
export function rewriteDue(db: DB) {
  run(db, 'INSERT OR IGNORE INTO rewrite_due (id, since) VALUES (1, ?)', nowIso());
}

/**
 * Rewrites the database file if that is owed. `alone` says nothing else has the database open, so the
 * write-ahead log can be emptied as well. Under Litestream it cannot (Litestream reads the log and decides when
 * it is reset): there, pages written before the rewrite stay in the log file until the next restart, when
 * entrypoint.sh opens and closes the database before Litestream starts. Returns whether it rewrote the file.
 */
export function rewriteIfDue(db: DB, alone: boolean): boolean {
  if (!get(db, 'SELECT 1 FROM rewrite_due')) return false;
  db.exec('VACUUM');
  if (alone) db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  run(db, 'DELETE FROM rewrite_due');
  return true;
}

/** From here on, the file is rewritten as soon as a change that asked for it has committed. */
export function rewriteAfterChanges(db: DB, alone: boolean, report: (err?: unknown) => void = () => {}) {
  onCommit(db, () => {
    try {
      if (rewriteIfDue(db, alone)) report();
    } catch (err) {
      // The row in rewrite_due is still there, so the next change, or the next start, tries again.
      report(err);
    }
  });
}

/** The entry at the end of a chain of merges, with its collection. */
function keeperOf(db: DB, id: number): { id: number; collection_id: number; sensitive: number } | undefined {
  let cur = id;
  for (let hops = 0; hops < 10; hops++) {
    const r = get<{ id: number; collection_id: number; merged_into_id: number | null; sensitive: number }>(
      db,
      'SELECT e.id, e.collection_id, e.merged_into_id, c.sensitive FROM entries e JOIN collections c ON c.id = e.collection_id WHERE e.id = ?',
      cur,
    );
    if (!r) return undefined;
    if (r.merged_into_id === null) return r;
    cur = r.merged_into_id;
  }
  return undefined;
}

/**
 * Puts an entry and its logs in the form its collection stores: sealed if it is sensitive, plain if not. For
 * after an entry changes collection or its collection changes. Returns how many rows it rewrote.
 *
 * What was merged into a sensitive entry is sensitive with it. A row that was merged away keeps its own text,
 * so while the entry it went into is sensitive that row is kept sealed: it is moved into that entry's
 * collection if its own is, or has become, an ordinary one.
 */
export function fitEntry(db: DB, id: number): number {
  const e = get<EntryText & { collection_id: number; merged_into_id: number | null; sealed: string | null; sensitive: number }>(
    db,
    `SELECT e.collection_id, e.merged_into_id, e.fields, e.notes, e.source_text, e.sealed, c.sensitive
       FROM open_entries e JOIN collections c ON c.id = e.collection_id WHERE e.id = ?`,
    id,
  );
  if (!e) return 0;
  let n = 0;
  let sensitive = e.sensitive === 1;
  if (!sensitive && e.merged_into_id !== null) {
    const keeper = keeperOf(db, e.merged_into_id);
    if (keeper?.sensitive) {
      if (e.sealed === null && hasEntryText(e)) rewriteDue(db);
      run(db, `UPDATE entries SET collection_id = ?, ${ENTRY_TEXT_SET} WHERE id = ?`, keeper.collection_id, ...entryText(db, true, e), id);
      sensitive = true;
      n++;
    }
  }
  if (n === 0 && (sensitive ? e.sealed === null && hasEntryText(e) : e.sealed !== null)) {
    if (sensitive) rewriteDue(db);
    run(db, `UPDATE entries SET ${ENTRY_TEXT_SET} WHERE id = ?`, ...entryText(db, sensitive, e), id);
    n++;
  }
  const logs = all<LogText & { id: number; sealed: string | null }>(db, 'SELECT id, note, raw_text, sealed FROM open_logs WHERE entry_id = ?', id);
  for (const l of logs) {
    if (sensitive ? l.sealed === null && hasLogText(l) : l.sealed !== null) {
      if (sensitive) rewriteDue(db);
      run(db, `UPDATE entry_logs SET ${LOG_TEXT_SET} WHERE id = ?`, ...logText(db, sensitive, l), l.id);
      n++;
    }
  }
  if (sensitive && e.merged_into_id === null) {
    const merged = all<{ id: number }>(
      db,
      `SELECT m.id FROM entries m JOIN collections mc ON mc.id = m.collection_id WHERE m.merged_into_id = ? AND mc.sensitive = 0`,
      id,
    );
    for (const m of merged) n += fitEntry(db, m.id);
  }
  return n;
}

/**
 * A snapshot with the text of its entry and log rows sealed: every row, or only those `which` picks. Rows that
 * are sealed already, or have nothing to seal, are left as they are. Returns the same object if nothing changed.
 */
export function sealSnapshot(db: DB, snap: Snapshot, which?: { entry: (e: EntryRow) => boolean; log: (l: LogRow) => boolean }): Snapshot {
  let changed = false;
  const entries = snap.entries?.map((e) => {
    if (e.sealed || !hasEntryText(e) || (which && !which.entry(e))) return e;
    changed = true;
    const [fields, notes, source_text, sealed] = entryText(db, true, e);
    return { ...e, fields, notes, source_text, sealed };
  });
  const logs = snap.logs?.map((l) => {
    if (l.sealed || !hasLogText(l) || (which && !which.log(l))) return l;
    changed = true;
    const [note, raw_text, sealed] = logText(db, true, l);
    return { ...l, note, raw_text, sealed };
  });
  return changed ? { ...snap, ...(entries ? { entries } : {}), ...(logs ? { logs } : {}) } : snap;
}

/**
 * Seals what the activity table recorded about these entries before they were in a sensitive collection: the
 * rows in its snapshots, and the summary and words of each change. With collectionId, the changes recorded
 * against that collection as well. Returns how many activity rows it rewrote.
 */
export function sealHistory(db: DB, entryIds: number[], collectionId?: number): number {
  const given = [...new Set(entryIds)].filter((x) => Number.isInteger(x));
  if (given.length === 0 && collectionId === undefined) return 0;
  // What was merged into these entries was recorded under its own id before that.
  const merged = given.length ? all<{ id: number }>(db, `SELECT id FROM entries WHERE merged_into_id IN (${given.join(',')})`).map((r) => r.id) : [];
  const ids = new Set([...given, ...merged]);
  const list = [...ids].join(',') || 'NULL';
  // Logs that are on these entries now may sit in older snapshots under the entry they were on then.
  const logIds = new Set(all<{ id: number }>(db, `SELECT id FROM entry_logs WHERE entry_id IN (${list})`).map((r) => r.id));
  const logList = [...logIds].join(',') || 'NULL';
  const mentions = (key: string, field: string, among: string) =>
    ['before_json', 'after_json'].map((col) => `EXISTS (SELECT 1 FROM json_each(a.${col}, '$.${key}') j WHERE json_extract(j.value, '$.${field}') IN (${among}))`);
  const where = [
    ...(collectionId !== undefined && Number.isInteger(collectionId) ? [`a.collection_id = ${collectionId}`] : []),
    `a.entry_id IN (${list})`,
    ...mentions('entries', 'id', list),
    ...mentions('logs', 'entry_id', list),
    ...mentions('logs', 'id', logList),
  ].join(' OR ');
  const rows = all<{ id: number; summary: string; raw_text: string | null; before_json: string | null; after_json: string | null; sealed: string | null }>(
    db,
    `SELECT a.id, a.summary, a.raw_text, a.before_json, a.after_json, a.sealed FROM activity a WHERE ${where}`,
  );
  const which = { entry: (e: EntryRow) => ids.has(e.id), log: (l: LogRow) => ids.has(l.entry_id) || logIds.has(l.id) };
  const fix = (json: string | null): string | null => {
    if (!json) return json;
    let snap: Snapshot;
    try {
      snap = JSON.parse(json) as Snapshot;
    } catch {
      return json;
    }
    const sealed = sealSnapshot(db, snap, which);
    return sealed === snap ? json : JSON.stringify(sealed);
  };
  let n = 0;
  for (const a of rows) {
    const before = fix(a.before_json);
    const after = fix(a.after_json);
    const [summary, rawText, sealed] =
      a.sealed === null && (a.summary !== '' || a.raw_text !== null) ? activityText(db, true, a) : [a.summary, a.raw_text, a.sealed];
    if (before === a.before_json && after === a.after_json && sealed === a.sealed) continue;
    run(db, 'UPDATE activity SET summary = ?, raw_text = ?, before_json = ?, after_json = ?, sealed = ? WHERE id = ?', summary, rawText, before, after, sealed, a.id);
    n++;
  }
  if (n) rewriteDue(db);
  return n;
}

/**
 * Brings everything in a collection into the form the collection stores, after its sensitive setting changed:
 * every entry and log, and, when it is sensitive, its history. Returns how many rows it rewrote.
 */
export function fitCollection(db: DB, collectionId: number): number {
  const idsIn = () => all<{ id: number }>(db, 'SELECT id FROM entries WHERE collection_id = ?', collectionId).map((r) => r.id);
  let n = 0;
  for (const id of idsIn()) n += fitEntry(db, id);
  // Asked again, because fitting may have brought merged entries into the collection.
  if (isSensitive(db, collectionId)) n += sealHistory(db, idsIn(), collectionId);
  // Each row that was sealed has been re-indexed without its words. Rebuilding the index on disk from those
  // documents also drops what it still held of them from before.
  if (n) run(db, "INSERT INTO entries_fts(entries_fts) VALUES('rebuild')");
  return n;
}

/**
 * Seals whatever is stored plain and should not be: the entries of sensitive collections saved before sealing
 * existed (or restored from a copy made then), and the Ask chat. Run at every start; it finds nothing to do
 * once it has been through. Without a key it does nothing. Returns how many rows it rewrote.
 */
export function sealPending(db: DB): number {
  if (!canSeal(db)) return 0;
  return tx(db, () => {
    let n = 0;
    const colls = all<{ id: number }>(
      db,
      `SELECT c.id FROM collections c
        WHERE c.sensitive = 1 OR EXISTS (SELECT 1 FROM entries e WHERE e.collection_id = c.id AND e.sealed IS NOT NULL)`,
    );
    for (const c of colls) n += fitCollection(db, c.id);
    for (const m of all<{ id: number; text: string; sources: string }>(db, 'SELECT id, text, sources FROM chat_messages WHERE sealed IS NULL')) {
      run(db, 'UPDATE chat_messages SET text = ?, sources = ?, sealed = ? WHERE id = ?', ...chatText(db, m), m.id);
      n++;
    }
    if (n) rewriteDue(db);
    return n;
  });
}

/**
 * What the server does to the database at every start: seals whatever is still plain and should not be, then
 * rewrites the file if that, or anything before it, left a rewrite owed. These are ordinary writes, so
 * Litestream replicates them like any others; the rewritten pages replace the old ones in the file at
 * Litestream's next checkpoint.
 */
export function tidy(db: DB, alone: boolean): { sealed: number; rewritten: boolean } {
  const sealed = sealPending(db);
  return { sealed, rewritten: rewriteIfDue(db, alone) };
}
