// Checklists: a collection switched to checklist mode. Its items are ordinary entries with a hidden yes/no
// field, `done`, so privacy, Activity, Undo, search and saving through Claude all work as they do anywhere else.
import { all, run, tx } from '../db/sqlite.ts';
import { recordActivity, snapshot } from './activity.ts';
import { getVisibleCollection } from './collections.ts';
import { resolveEntry } from './entries.ts';
import { UserError } from './errors.ts';
import { ENTRY_TEXT_SET, entryText } from './sealed.ts';
import { nowIso } from './time.ts';
import type { Collection, Ctx, EntryRow, FieldDef, Fields, WriteResult } from './types.ts';

export const DONE_KEY = 'done';
export const DONE_FIELD: FieldDef = { key: DONE_KEY, type: 'boolean', label: 'Done', hidden: true };

export const isChecklist = (c: Collection): boolean => c.display.checklist === true;
const isDone = (fields: string): boolean => (JSON.parse(fields) as Fields)[DONE_KEY] === true;

export interface ChecklistItem {
  id: number;
  title: string;
  done: boolean;
}

/** What is still to do, in the order it was added, then what is ticked, most recently ticked first. */
export function checklistItems(ctx: Ctx, collectionId: number): { todo: ChecklistItem[]; done: ChecklistItem[] } {
  const coll = getVisibleCollection(ctx, collectionId);
  const rows = all<Pick<EntryRow, 'id' | 'title' | 'fields' | 'updated_at'>>(
    ctx.db,
    'SELECT id, title, fields, updated_at FROM open_entries WHERE collection_id = ? AND deleted_at IS NULL AND merged_into_id IS NULL ORDER BY id',
    coll.id,
  );
  const items = rows.map((r) => ({ id: r.id, title: r.title, done: isDone(r.fields), at: r.updated_at }));
  return {
    todo: items.filter((i) => !i.done).map(({ at: _at, ...i }) => i),
    done: items.filter((i) => i.done).sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : b.id - a.id)).map(({ at: _at, ...i }) => i),
  };
}

/** How many items are still to do in each checklist the person can see. */
export function leftToDo(ctx: Ctx, colls: Collection[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const c of colls.filter(isChecklist)) {
    const rows = all<{ fields: string }>(ctx.db, 'SELECT fields FROM open_entries WHERE collection_id = ? AND deleted_at IS NULL AND merged_into_id IS NULL', c.id);
    out.set(c.id, rows.filter((r) => !isDone(r.fields)).length);
  }
  return out;
}

/**
 * A short value that changes whenever anything on the list does (an item added, ticked, renamed, cleared, or
 * brought back by Undo), however it was done. The page asks for it every few seconds and reloads the list when
 * it differs, which is how a tick on one phone reaches the other.
 */
export function checklistStamp(ctx: Ctx, collectionId: number): string {
  const coll = getVisibleCollection(ctx, collectionId);
  const r = all<{ n: number; top: number; rev: number }>(
    ctx.db,
    'SELECT count(*) AS n, coalesce(max(id), 0) AS top, coalesce(sum(revision), 0) AS rev FROM entries WHERE collection_id = ?',
    coll.id,
  )[0];
  return `${r.n}.${r.top}.${r.rev}`;
}

/** Ticks or unticks a row that the caller has already checked the person may see. Must run inside a transaction. */
export function writeDone(ctx: Ctx, entry: EntryRow, coll: Collection, done: boolean, summary: string, rawText?: string | null): number {
  const before = snapshot(ctx.db, { entries: [entry.id] });
  const fields = { ...(JSON.parse(entry.fields) as Fields), [DONE_KEY]: done };
  const now = nowIso();
  run(
    ctx.db,
    `UPDATE entries SET ${ENTRY_TEXT_SET}, updated_by = ?, updated_at = ? WHERE id = ?`,
    ...entryText(ctx.db, coll.sensitive, { ...entry, fields: JSON.stringify(fields) }),
    ctx.actor.userId,
    now,
    entry.id,
  );
  return recordActivity(ctx, {
    action: done ? 'tick_item' : 'untick_item',
    collectionId: coll.id,
    entryId: entry.id,
    summary,
    rawText,
    before,
    after: snapshot(ctx.db, { entries: [entry.id] }),
  });
}

export function setDone(ctx: Ctx, entryId: number, done: boolean): WriteResult {
  return tx(ctx.db, () => {
    const { entry, collection: coll } = resolveEntry(ctx, entryId, { follow: false });
    if (!isChecklist(coll)) throw new UserError(`${coll.name} is not a checklist.`);
    if (isDone(entry.fields) === done) {
      return { ok: true, replay: true, summary: `"${entry.title}" is already ${done ? 'ticked' : 'on the list'}.`, extra: [], entryId: entry.id, collectionId: coll.id };
    }
    const summary = `${done ? 'Ticked' : 'Unticked'} "${entry.title}" in ${coll.name}. (#${entry.id})`;
    const activityId = writeDone(ctx, entry, coll, done, summary);
    return { ok: true, summary, extra: [], entryId: entry.id, collectionId: coll.id, activityId };
  });
}

/** Clears the ticked items off the list in one step. They go to the Trash, and one Undo brings them all back. */
export function clearDone(ctx: Ctx, collectionId: number): WriteResult {
  return tx(ctx.db, () => {
    const coll = getVisibleCollection(ctx, collectionId);
    if (!isChecklist(coll)) throw new UserError(`${coll.name} is not a checklist.`);
    const ids = checklistItems(ctx, coll.id).done.map((i) => i.id);
    if (ids.length === 0) throw new UserError('Nothing is ticked.');
    const before = snapshot(ctx.db, { entries: ids });
    const now = nowIso();
    run(ctx.db, `UPDATE entries SET deleted_at = ?, updated_by = ?, updated_at = ? WHERE id IN (${ids.map(() => '?').join(',')})`, now, ctx.actor.userId, now, ...ids);
    const summary = `Cleared ${ids.length} ticked ${ids.length === 1 ? 'item' : 'items'} from ${coll.name} (in the Trash).`;
    const activityId = recordActivity(ctx, { action: 'clear_ticked', collectionId: coll.id, summary, before, after: snapshot(ctx.db, { entries: ids }) });
    return { ok: true, summary, extra: [], collectionId: coll.id, activityId };
  });
}
