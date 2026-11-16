import { all, get, type DB } from '../db/sqlite.ts';
import type { ActivityRow, Snapshot } from './types.ts';

export function visibleTo(c: { visibility: string; owner_id: number | null }, userId: number): boolean {
  return c.visibility === 'shared' || c.owner_id === userId;
}

function placeholders(n: number) {
  return Array.from({ length: n }, () => '?').join(',');
}

/**
 * Checks that the entries (and everything attached to them) are the user's alone, which is required before
 * they can go into a private collection. Returns the reason they aren't, or null if they are.
 */
export function notSolelyMine(db: DB, entryIds: number[], userId: number): string | null {
  const ids = [...new Set(entryIds)];
  if (ids.length === 0) return null;
  const ph = placeholders(ids.length);
  const other = get<{ id: number; title: string; name: string }>(
    db,
    `SELECT e.id, e.title, u.display_name AS name FROM entries e JOIN users u ON u.id = e.created_by
      WHERE e.id IN (${ph}) AND e.created_by != ? LIMIT 1`,
    ...ids,
    userId,
  );
  if (other) return `${other.name} added "${other.title}" (#${other.id})`;
  const log = get<{ entry_id: number; title: string; name: string }>(
    db,
    `SELECT l.entry_id, e.title, u.display_name AS name FROM entry_logs l
       JOIN entries e ON e.id = l.entry_id JOIN users u ON u.id = l.created_by
      WHERE l.entry_id IN (${ph}) AND l.created_by != ? LIMIT 1`,
    ...ids,
    userId,
  );
  if (log) return `${log.name} logged something on "${log.title}" (#${log.entry_id})`;
  const merged = get<{ id: number; name: string }>(
    db,
    `SELECT m.merged_into_id AS id, u.display_name AS name FROM entries m JOIN users u ON u.id = m.created_by
      WHERE m.merged_into_id IN (${ph}) AND m.created_by != ? LIMIT 1`,
    ...ids,
    userId,
  );
  if (merged) return `#${merged.id} includes an entry ${merged.name} added`;
  const edit = get<{ entry_id: number; name: string }>(
    db,
    `SELECT a.entry_id, u.display_name AS name FROM activity a JOIN users u ON u.id = a.user_id
      WHERE a.entry_id IN (${ph}) AND a.user_id != ? LIMIT 1`,
    ...ids,
    userId,
  );
  if (edit) return `${edit.name} has edited #${edit.entry_id}`;
  // Changes that touch several entries at once (a fill, a field rename, Clear ticked, Move all) carry no single
  // entry id; the entries they changed are in the snapshot they kept.
  const many = get<{ name: string }>(
    db,
    `SELECT u.display_name AS name FROM activity a JOIN users u ON u.id = a.user_id
      WHERE a.user_id != ? AND a.entry_id IS NULL AND a.after_json IS NOT NULL
        AND EXISTS (SELECT 1 FROM json_each(a.after_json, '$.entries') j WHERE json_extract(j.value, '$.id') IN (${ph}))
      LIMIT 1`,
    userId,
    ...ids,
  );
  if (many) return `${many.name} has changed entries in it`;
  return null;
}

/** All entry ids in a collection, including deleted and merged ones. */
export function allEntryIdsIn(db: DB, collectionId: number): number[] {
  return all<{ id: number }>(db, 'SELECT id FROM entries WHERE collection_id = ?', collectionId).map((r) => r.id);
}

/**
 * An activity row is visible only if every entry and collection it references, including those inside its
 * snapshots, is currently visible to the viewer.
 */
export function activityVisible(db: DB, row: ActivityRow, userId: number, cache = new Map<string, boolean>()): boolean {
  const entryIds = new Set<number>();
  const collectionIds = new Set<number>();
  if (row.entry_id) entryIds.add(row.entry_id);
  if (row.collection_id) collectionIds.add(row.collection_id);
  for (const json of [row.before_json, row.after_json]) {
    if (!json) continue;
    let snap: Snapshot;
    try {
      snap = JSON.parse(json) as Snapshot;
    } catch {
      return false;
    }
    for (const e of snap.entries ?? []) {
      entryIds.add(e.id);
      collectionIds.add(e.collection_id);
    }
    for (const l of snap.logs ?? []) entryIds.add(l.entry_id);
    for (const c of snap.collections ?? []) collectionIds.add(c.id);
    for (const p of snap.attachments ?? []) if (p.entry_id !== null) entryIds.add(p.entry_id);
  }
  for (const id of collectionIds) if (!collectionVisible(db, id, userId, cache)) return false;
  for (const id of entryIds) if (!entryVisible(db, id, userId, cache)) return false;
  return true;
}

/**
 * An entry is visible if its collection is, and so is the collection of every entry it was merged into
 * (a shared entry merged into a private one has effectively become private).
 */
function entryVisible(db: DB, id: number, userId: number, cache: Map<string, boolean>): boolean {
  const key = `e${id}`;
  let ok = cache.get(key);
  if (ok !== undefined) return ok;
  ok = true;
  let cur: number | null = id;
  let hops = 0;
  for (; cur !== null && hops < 10; hops++) {
    const e: { collection_id: number; merged_into_id: number | null } | undefined = get(
      db,
      'SELECT collection_id, merged_into_id FROM entries WHERE id = ?',
      cur,
    );
    // A purged entry has no row; its activity was already stripped, so it doesn't hide anything.
    if (!e) break;
    if (!collectionVisible(db, e.collection_id, userId, cache)) {
      ok = false;
      break;
    }
    cur = e.merged_into_id;
  }
  // A chain too long to finish checking counts as hidden.
  if (cur !== null && hops >= 10) ok = false;
  cache.set(key, ok);
  return ok;
}

function collectionVisible(db: DB, id: number, userId: number, cache: Map<string, boolean>): boolean {
  const key = `c${id}`;
  let ok = cache.get(key);
  if (ok === undefined) {
    const c = get<{ visibility: string; owner_id: number | null }>(
      db,
      'SELECT visibility, owner_id FROM collections WHERE id = ?',
      id,
    );
    ok = c ? visibleTo(c, userId) : false;
    cache.set(key, ok);
  }
  return ok;
}
