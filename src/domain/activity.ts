import { all, get, run, type DB } from '../db/sqlite.ts';
import { activityVisible } from './privacy.ts';
import { activityText, rewriteDue, sealHistory, sealSnapshot, storedSnapshot } from './sealed.ts';
import { nowIso } from './time.ts';
import type { ActivityRow, AttachmentRow, CollectionRow, Ctx, EntryRow, LogRow, Snapshot } from './types.ts';

function byIds<T>(db: DB, table: string, ids: number[]): T[] {
  const uniq = [...new Set(ids)].filter((x) => Number.isInteger(x));
  if (uniq.length === 0) return [];
  return all<T>(db, `SELECT * FROM ${table} WHERE id IN (${uniq.map(() => '?').join(',')}) ORDER BY id`, ...uniq);
}

export const entryRows = (db: DB, ids: number[]) => byIds<EntryRow>(db, 'entries', ids);
export const logRows = (db: DB, ids: number[]) => byIds<LogRow>(db, 'entry_logs', ids);
export const collectionRows = (db: DB, ids: number[]) =>
  byIds<CollectionRow & { scope_id?: number }>(db, 'collections', ids).map(({ scope_id: _s, ...row }) => row as CollectionRow);
export const attachmentRows = (db: DB, ids: number[]) => byIds<AttachmentRow>(db, 'attachments', ids);

/** Plain copies of the rows as they are stored (node:sqlite rows have a null prototype). Sealed text stays sealed. */
export function snapshot(db: DB, ids: { entries?: number[]; logs?: number[]; collections?: number[]; attachments?: number[] }): Snapshot {
  const snap: Snapshot = {};
  if (ids.entries?.length) snap.entries = entryRows(db, ids.entries).map((r) => ({ ...r }));
  if (ids.logs?.length) snap.logs = logRows(db, ids.logs).map((r) => ({ ...r }));
  if (ids.collections?.length) snap.collections = collectionRows(db, ids.collections).map((r) => ({ ...r }));
  if (ids.attachments?.length) snap.attachments = attachmentRows(db, ids.attachments).map((r) => ({ ...r }));
  return snap;
}

/**
 * Records a change. Rows handed in as before and after may have been read through the open_ views; they are
 * put back in stored form here, so no opened text reaches the table. When anything the change touches is in a
 * sensitive collection, its summary and words are sealed, and so is every row in its snapshots: a merge or a
 * move can put a sensitive entry's text into the row of an ordinary one. Whatever was recorded earlier about an
 * entry that has just come into a sensitive collection is sealed as well.
 */
export function recordActivity(
  ctx: Ctx,
  a: {
    action: string;
    collectionId?: number | null;
    entryId?: number | null;
    summary: string;
    rawText?: string | null;
    before?: Snapshot | null;
    after?: Snapshot | null;
  },
): number {
  let before = a.before ? storedSnapshot(a.before) : null;
  let after = a.after ? storedSnapshot(a.after) : null;
  const snaps = [before, after].filter((s) => s !== null);
  const ints = (xs: (number | null | undefined)[]) => [...new Set(xs.filter((x): x is number => Number.isInteger(x)))];
  const collectionIds = ints([a.collectionId, ...snaps.flatMap((s) => [...(s.entries ?? []).map((e) => e.collection_id), ...(s.collections ?? []).map((c) => c.id)])]);
  const entryIds = ints([
    a.entryId,
    ...snaps.flatMap((s) => [...(s.entries ?? []).map((e) => e.id), ...(s.logs ?? []).map((l) => l.entry_id), ...(s.attachments ?? []).map((p) => p.entry_id)]),
  ]);
  const kinds = collectionIds.length
    ? all<{ sensitive: number }>(ctx.db, `SELECT DISTINCT sensitive FROM collections WHERE id IN (${collectionIds.join(',')})`).map((r) => r.sensitive)
    : [];
  const sensitive = kinds.includes(1);
  if (sensitive) {
    if (before) before = sealSnapshot(ctx.db, before);
    if (after) after = sealSnapshot(ctx.db, after);
    // Text has crossed between an ordinary collection and a sensitive one, so some of it was, or is, plain in
    // the file where it should not stay.
    if (kinds.includes(0)) rewriteDue(ctx.db);
  }
  const res = run(
    ctx.db,
    `INSERT INTO activity (at, user_id, via, client, action, collection_id, entry_id, before_json, after_json, summary, raw_text, sealed)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    nowIso(),
    ctx.actor.userId,
    ctx.actor.via,
    ctx.actor.client ?? null,
    a.action,
    a.collectionId ?? null,
    a.entryId ?? null,
    before ? JSON.stringify(before) : null,
    after ? JSON.stringify(after) : null,
    ...activityText(ctx.db, sensitive, { summary: a.summary, raw_text: a.rawText ?? null }),
  );
  if (entryIds.length) {
    const nowSensitive = all<{ id: number }>(
      ctx.db,
      `SELECT e.id FROM entries e JOIN collections c ON c.id = e.collection_id WHERE c.sensitive = 1 AND e.id IN (${entryIds.join(',')})`,
    ).map((r) => r.id);
    if (nowSensitive.length) sealHistory(ctx.db, nowSensitive);
  }
  return Number(res.lastInsertRowid);
}

export function getActivity(db: DB, id: number): ActivityRow | undefined {
  return get<ActivityRow>(db, 'SELECT * FROM open_activity WHERE id = ?', id);
}

export interface ActivityItem extends ActivityRow {
  user_name: string;
}

/** Recent activity the viewer is allowed to see (section 3.7: every referenced row must be visible). */
export function listActivity(
  ctx: Ctx,
  opts: { limit?: number; beforeId?: number; entryId?: number } = {},
): ActivityItem[] {
  const limit = opts.limit ?? 50;
  const out: ActivityItem[] = [];
  let cursor = opts.beforeId ?? Number.MAX_SAFE_INTEGER;
  const cache = new Map<string, boolean>();
  // Page through in batches so hidden rows don't shrink the page.
  for (let guard = 0; guard < 20 && out.length < limit; guard++) {
    const batch = all<ActivityItem>(
      ctx.db,
      `SELECT a.*, u.display_name AS user_name FROM open_activity a JOIN users u ON u.id = a.user_id
        WHERE a.id < ? ${opts.entryId ? 'AND a.entry_id = ?' : ''}
        ORDER BY a.id DESC LIMIT 100`,
      ...(opts.entryId ? [cursor, opts.entryId] : [cursor]),
    );
    if (batch.length === 0) break;
    for (const row of batch) {
      if (activityVisible(ctx.db, row, ctx.actor.userId, cache)) out.push(row);
      if (out.length >= limit) break;
    }
    cursor = batch[batch.length - 1].id;
  }
  return out;
}

export function parseSnapshot(json: string | null): Snapshot {
  if (!json) return {};
  try {
    return JSON.parse(json) as Snapshot;
  } catch {
    return {};
  }
}
