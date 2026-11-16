// "Download my data": built from explicitly permitted rows only (plan 3.7), never by deleting hidden rows from a full copy.
// The copy is the person's own and must be readable without the server's key, so what is sealed on the server is
// opened in it, the way the photos are.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { all, openTrackerDb, run, tx } from '../db/sqlite.ts';
import { collectionRows } from '../domain/activity.ts';
import { visibleCollections } from '../domain/collections.ts';
import { readStored, type FileStore } from '../domain/files.ts';
import { activityVisible } from '../domain/privacy.ts';
import { openSnapshot } from '../domain/sealed.ts';
import type { ActivityRow, AttachmentRow, Ctx, EntryRow, LogRow } from '../domain/types.ts';
import { zipStream, type ZipFile } from './zip.ts';

interface Visible {
  users: { id: number; email: string; display_name: string; created_at: string }[];
  collections: ReturnType<typeof collectionRows>;
  entries: EntryRow[];
  logs: LogRow[];
  activity: ActivityRow[];
  attachments: AttachmentRow[];
}

export function visibleData(ctx: Ctx): Visible {
  const colls = visibleCollections(ctx, { includeArchived: true });
  const ids = colls.map((c) => c.id);
  const collections = collectionRows(ctx.db, ids);
  const ph = (n: number) => Array.from({ length: n }, () => '?').join(',') || 'NULL';
  const plain = <T extends { sealed?: string | null }>({ sealed: _sealed, ...row }: T) => row;
  const opened = (json: string | null) => (json ? JSON.stringify(openSnapshot(ctx.db, JSON.parse(json))) : json);
  let entries = (ids.length ? all<EntryRow>(ctx.db, `SELECT * FROM open_entries WHERE collection_id IN (${ph(ids.length)}) ORDER BY id`, ...ids) : []).map(plain);
  const exported = new Set(entries.map((e) => e.id));
  // A merged entry whose keeper isn't visible would dangle; leave it out.
  entries = entries.filter((e) => e.merged_into_id === null || exported.has(e.merged_into_id));
  const entryIds = entries.map((e) => e.id);
  const logs = entryIds.length
    ? all<LogRow>(ctx.db, `SELECT * FROM open_logs WHERE entry_id IN (${ph(entryIds.length)}) ORDER BY id`, ...entryIds).map(plain)
    : [];
  const cache = new Map<string, boolean>();
  const collIds = new Set(collections.map((c) => c.id));
  const entrySet = new Set(entryIds);
  const activity = all<ActivityRow>(ctx.db, 'SELECT * FROM open_activity ORDER BY id')
    .filter((a) => activityVisible(ctx.db, a, ctx.actor.userId, cache))
    // Belt and braces: never point at rows the export leaves out.
    .map((a) => ({
      ...plain(a),
      before_json: opened(a.before_json),
      after_json: opened(a.after_json),
      entry_id: a.entry_id !== null && entrySet.has(a.entry_id) ? a.entry_id : null,
      collection_id: a.collection_id !== null && collIds.has(a.collection_id) ? a.collection_id : null,
    }));
  const users = all<Visible['users'][number]>(ctx.db, 'SELECT id, email, display_name, created_at FROM users ORDER BY id');
  // Rows only. The pictures themselves are encrypted on the server; exportZip adds them to its archive.
  const attachments = entryIds.length
    ? all<AttachmentRow>(ctx.db, `SELECT * FROM attachments WHERE entry_id IN (${ph(entryIds.length)}) ORDER BY id`, ...entryIds)
    : [];
  return { users, collections, entries, logs, activity, attachments };
}

export function exportJson(ctx: Ctx): string {
  const v = visibleData(ctx);
  const parse = (s: string | null) => (s ? JSON.parse(s) : null);
  return JSON.stringify(
    {
      exported_at: new Date().toISOString(),
      exported_by: ctx.actor.name,
      users: v.users,
      collections: v.collections.map((c) => ({ ...c, fields: parse(c.fields), display: parse(c.display) })),
      entries: v.entries.map((e) => ({ ...e, fields: parse(e.fields), tags: parse(e.tags) })),
      logs: v.logs,
      attachments: v.attachments,
      activity: v.activity.map((a) => ({ ...a, before_json: parse(a.before_json), after_json: parse(a.after_json) })),
    },
    null,
    2,
  );
}

function insertAll(db: ReturnType<typeof openTrackerDb>, table: string, rows: Record<string, unknown>[], skip: string[] = []) {
  if (rows.length === 0) return;
  const cols = Object.keys(rows[0]).filter((c) => !skip.includes(c));
  const stmt = db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
  for (const r of rows) stmt.run(...(cols.map((c) => r[c]) as never[]));
}

/** A standalone tracker.db with the same schema, holding only what this user can see. */
export function exportSqlite(ctx: Ctx, v = visibleData(ctx)): Uint8Array {
  // The copy is readable (that is its point), so while it is being built it sits in a folder only this
  // process's user can open, and the folder goes when the copy has been read back.
  const dir = mkdtempSync(join(tmpdir(), EXPORT_PREFIX));
  const path = join(dir, 'tracker.db');
  const out = openTrackerDb(path, true);
  try {
    out.exec('PRAGMA journal_mode = DELETE');
    tx(out, () => {
      out.exec('PRAGMA defer_foreign_keys = ON');
      insertAll(out, 'users', v.users);
      // Entries go in as plain text, which the triggers only take while their collection is not marked
      // sensitive, so the mark is put back once they are in.
      insertAll(out, 'collections', v.collections.map((c) => ({ ...c, sensitive: 0 })));
      insertAll(out, 'entries', v.entries as unknown as Record<string, unknown>[], ['rating', 'log_count', 'first_logged_on', 'last_logged_on']);
      insertAll(out, 'entry_logs', v.logs as unknown as Record<string, unknown>[]);
      insertAll(out, 'activity', v.activity.map((a) => ({ ...a, undone_by: null })) as unknown as Record<string, unknown>[]);
      insertAll(out, 'attachments', v.attachments as unknown as Record<string, unknown>[]);
      run(out, 'UPDATE entries SET rating_override = rating_override');
      for (const c of v.collections) if (c.sensitive) run(out, 'UPDATE collections SET sensitive = 1 WHERE id = ?', c.id);
    });
    out.close();
    return readFileSync(path);
  } finally {
    try {
      out.close();
    } catch {
      // already closed
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

const EXPORT_PREFIX = 'tracker-export-';
/** Removes what a download left behind if the server was stopped in the middle of one. Run at start. */
export function sweepExports(): number {
  const left = readdirSync(tmpdir()).filter((name) => name.startsWith(EXPORT_PREFIX));
  for (const name of left) rmSync(join(tmpdir(), name), { recursive: true, force: true });
  return left.length;
}

/** A file or folder name that is safe in an archive opened on any system. */
function safeName(text: string): string {
  const cleaned = text
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  return cleaned.slice(0, 80) || 'untitled';
}

/**
 * Everything the person can see, in one archive: the SQLite copy, and every photo and PDF as it was added, in a
 * folder for its collection and entry. Photos that were removed are left out. The archive is built as it is
 * read, one photo at a time.
 */
export function exportZip(ctx: Ctx, store: FileStore): ReadableStream<Uint8Array> {
  const v = visibleData(ctx);
  const database = exportSqlite(ctx, v);
  const collectionName = new Map(v.collections.map((c) => [c.id, c.name]));
  const entries = new Map(v.entries.map((e) => [e.id, e]));
  const photos = v.attachments.filter((a) => a.deleted_at === null && a.entry_id !== null);
  function* files(): Generator<ZipFile> {
    yield { name: 'tracker.db', bytes: database };
    const missing: string[] = [];
    for (const a of photos) {
      const entry = entries.get(a.entry_id!)!;
      const name = `photos/${safeName(collectionName.get(entry.collection_id) ?? 'Collection')}/${safeName(entry.title)} (#${entry.id})/${a.id} ${safeName(a.filename)}`;
      try {
        yield { name, bytes: readStored(store, a.id) };
      } catch (err) {
        missing.push(`${name}: ${err instanceof Error ? err.message : 'could not be read'}`);
      }
    }
    const lines = [
      'Your Magpie data.',
      '',
      'tracker.db is a SQLite database with everything you can see: collections, entries, logs and history.',
      'On the server, what a sensitive collection holds is encrypted. In this copy it is not, so keep the copy somewhere safe.',
      photos.length
        ? 'photos holds your photos and PDFs as they were added, in a folder for each collection and entry. The number in front of each file name is its id in the attachments table.'
        : 'There are no photos or PDFs on the entries you can see.',
    ];
    if (missing.length) lines.push('', 'These could not be included:', ...missing);
    yield { name: 'READ ME.txt', bytes: Buffer.from(`${lines.join('\r\n')}\r\n`, 'utf8') };
  }
  return zipStream(files());
}
