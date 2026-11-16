// Entries a person keeps at the top of their Home page, and collections they keep first in its list. A pin is a
// personal shortcut, like the chat: it changes nothing about what is pinned, so it is not recorded in Activity
// and there is nothing to undo.
import { all, get, run } from '../db/sqlite.ts';
import { getVisibleCollection } from './collections.ts';
import { resolveEntry } from './entries.ts';
import { UserError } from './errors.ts';
import { nowIso } from './time.ts';
import type { Ctx } from './types.ts';

export const MAX_PINS = 12;

export interface PinnedEntry {
  id: number;
  title: string;
  collection: string;
  icon: string | null;
}

/** The person's pins they can still see, in the order they were pinned. Deleted or hidden entries are skipped. */
export function listPinned(ctx: Ctx): PinnedEntry[] {
  const rows = all<{ entry_id: number }>(ctx.db, 'SELECT entry_id FROM pins WHERE user_id = ? ORDER BY created_at, entry_id', ctx.actor.userId);
  const out: PinnedEntry[] = [];
  for (const r of rows) {
    try {
      // Follows a merge to the entry that was kept.
      const { entry, collection } = resolveEntry(ctx, r.entry_id);
      if (!out.some((p) => p.id === entry.id)) out.push({ id: entry.id, title: entry.title, collection: collection.name, icon: collection.icon });
    } catch (err) {
      if (!(err instanceof UserError)) throw err;
    }
  }
  return out;
}

export function isPinned(ctx: Ctx, entryId: number): boolean {
  return get(ctx.db, 'SELECT 1 AS x FROM pins WHERE user_id = ? AND entry_id = ?', ctx.actor.userId, entryId) !== undefined;
}

/** Pins or unpins an entry the person can see. */
export function setPinned(ctx: Ctx, entryId: number, pinned: boolean): { entryId: number; pinned: boolean } {
  const { entry } = resolveEntry(ctx, entryId);
  if (!pinned) {
    run(ctx.db, 'DELETE FROM pins WHERE user_id = ? AND entry_id IN (?, ?)', ctx.actor.userId, entry.id, entryId);
    return { entryId: entry.id, pinned: false };
  }
  if (!isPinned(ctx, entry.id) && listPinned(ctx).length >= MAX_PINS) {
    throw new UserError(`You can pin up to ${MAX_PINS} entries. Unpin one first.`);
  }
  run(ctx.db, 'INSERT OR IGNORE INTO pins (user_id, entry_id, created_at) VALUES (?, ?, ?)', ctx.actor.userId, entry.id, nowIso());
  return { entryId: entry.id, pinned: true };
}

/** The collections this person has pinned. Home puts them first; nothing else changes order. */
export function pinnedCollectionIds(ctx: Ctx): Set<number> {
  return new Set(all<{ collection_id: number }>(ctx.db, 'SELECT collection_id FROM collection_pins WHERE user_id = ?', ctx.actor.userId).map((r) => r.collection_id));
}

export function isCollectionPinned(ctx: Ctx, collectionId: number): boolean {
  return get(ctx.db, 'SELECT 1 AS x FROM collection_pins WHERE user_id = ? AND collection_id = ?', ctx.actor.userId, collectionId) !== undefined;
}

/** Pins or unpins a collection the person can see. */
export function setCollectionPinned(ctx: Ctx, collectionId: number, pinned: boolean): { collectionId: number; pinned: boolean } {
  const c = getVisibleCollection(ctx, collectionId);
  if (pinned) run(ctx.db, 'INSERT OR IGNORE INTO collection_pins (user_id, collection_id, created_at) VALUES (?, ?, ?)', ctx.actor.userId, c.id, nowIso());
  else run(ctx.db, 'DELETE FROM collection_pins WHERE user_id = ? AND collection_id = ?', ctx.actor.userId, c.id);
  return { collectionId: c.id, pinned };
}
