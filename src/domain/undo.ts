import { all, get, run, tx } from '../db/sqlite.ts';
import { getActivity, parseSnapshot, recordActivity, snapshot } from './activity.ts';
import { UserError } from './errors.ts';
import { KEEP_REMOVED_DAYS, MAX_PER_ENTRY } from './files.ts';
import { activityVisible, notSolelyMine, visibleTo } from './privacy.ts';
import { entryText, fitCollection, fitEntry, isSensitive, logText, openEntry, openLog } from './sealed.ts';
import { minutesAgoIso, nowIso } from './time.ts';
import type { ActivityRow, AttachmentRow, CollectionRow, Ctx, EntryRow, LogRow, WriteResult } from './types.ts';

const ENTRY_COLS = ['collection_id', 'title', 'title_key', 'fields', 'tags', 'rating_override', 'notes', 'source_text', 'deleted_at', 'merged_into_id'] as const;
const LOG_COLS = ['entry_id', 'occurred_on', 'note', 'rating', 'raw_text', 'deleted_at'] as const;
// What a restore writes: the same columns, with the text in the form the row's collection stores now.
const ENTRY_RESTORE = [...ENTRY_COLS, 'sealed'] as const;
const LOG_RESTORE = [...LOG_COLS, 'sealed'] as const;
const COLL_COLS = ['slug', 'name', 'description', 'icon', 'fields', 'display', 'visibility', 'owner_id', 'archived_at', 'sensitive'] as const;

const NOT_UNDOABLE = new Set(['undo', 'purge_entry']);
// Content that matters for conflicts: the editable columns plus what the log triggers maintain.
const ENTRY_COMPARE = [...ENTRY_COLS, 'rating', 'log_count', 'first_logged_on', 'last_logged_on'] as const;

function sameColumns(a: object, b: object, cols: readonly string[]): boolean {
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  // 'sensitive' is missing from snapshots taken before it existed; it was 0 then.
  const v = (o: Record<string, unknown>, c: string) => o[c] ?? (c === 'sensitive' ? 0 : null);
  return cols.every((c) => v(x, c) === v(y, c));
}

function stripId(summary: string): string {
  return summary.replace(/\s*\((#\d+(, log \d+)?)\)\s*$/, '').replace(/\.$/, '');
}

function effect(action: string): string {
  switch (action) {
    case 'create_entry':
      return 'entry removed';
    case 'add_log':
      return 'that log removed';
    case 'delete_entry':
      return 'entry restored';
    case 'delete_log':
      return 'log restored';
    case 'merge_entries':
      return 'the two entries are separate again';
    case 'create_collection':
      return 'collection removed';
    case 'restore_entry':
      return 'entry deleted again';
    case 'delete_photo':
      return 'photo restored';
    default:
      return 'previous values restored';
  }
}

function changedSince(ctx: Ctx, entryId: number, afterActivityId: number): string {
  const later = all<ActivityRow & { name: string }>(
    ctx.db,
    `SELECT a.*, u.display_name AS name FROM open_activity a JOIN users u ON u.id = a.user_id
      WHERE a.id > :a AND (a.entry_id = :e OR EXISTS (
              SELECT 1 FROM json_each(a.after_json, '$.entries') j WHERE json_extract(j.value, '$.id') = :e))
      ORDER BY a.id DESC LIMIT 5`,
    { e: entryId, a: afterActivityId },
  );
  if (later.length === 0) return 'it was edited outside the app';
  // Only describe a later change the viewer is allowed to see; otherwise say nothing about it.
  const visible = later.find((a) => activityVisible(ctx.db, a, ctx.actor.userId));
  return visible ? `${visible.name} changed it since: ${stripId(visible.summary)}` : 'it was changed since';
}

/** Reverts one activity row (section 3.8). Refuses on conflicts; checks privacy rules; all in one transaction. */
export function undoActivity(ctx: Ctx, activityId: number, rawText?: string | null): WriteResult {
  return tx(ctx.db, () => {
    const act = getActivity(ctx.db, activityId);
    if (!act || !activityVisible(ctx.db, act, ctx.actor.userId)) throw new UserError(`No change #${activityId}.`);
    if (act.undone_by) throw new UserError('That change was already undone.');
    if (NOT_UNDOABLE.has(act.action) || (act.before_json === null && act.after_json === null)) {
      throw new UserError(`"${stripId(act.summary)}" can't be undone.`);
    }
    const before = parseSnapshot(act.before_json);
    const after = parseSnapshot(act.after_json);
    const beforeEntries = new Map((before.entries ?? []).map((e) => [e.id, e]));
    const beforeLogs = new Map((before.logs ?? []).map((l) => [l.id, l]));
    const beforeColls = new Map((before.collections ?? []).map((c) => [c.id, c]));
    const beforePhotos = new Map((before.attachments ?? []).map((p) => [p.id, p]));
    const afterEntries = after.entries ?? [];
    const afterLogs = after.logs ?? [];
    const afterColls = after.collections ?? [];
    const afterPhotos = after.attachments ?? [];

    // 1. Conflict check: everything must still look exactly like it did right after the change.
    // The revision is the fast path. When it differs, the entry may still be exactly as this change left it
    // (a later change that was itself undone), so compare content before refusing; that keeps "undo, undo" working.
    // Content is compared opened: the same text sealed twice does not look the same.
    for (const a of afterEntries) {
      const cur = get<EntryRow>(ctx.db, 'SELECT * FROM open_entries WHERE id = ?', a.id);
      if (!cur) throw new UserError(`Can't undo: "${a.title}" no longer exists.`);
      if (cur.revision !== a.revision && !sameColumns(cur, openEntry(ctx.db, a), ENTRY_COMPARE)) {
        throw new UserError(`Can't undo: "${cur.title}" was changed after that (${changedSince(ctx, a.id, act.id)}). Fix it directly with update_entry or update_log instead.`);
      }
    }
    for (const a of afterLogs) {
      const cur = get<LogRow>(ctx.db, 'SELECT * FROM open_logs WHERE id = ?', a.id);
      if (!cur) throw new UserError("Can't undo: a log it changed no longer exists.");
      if (cur.updated_at !== a.updated_at && !sameColumns(cur, openLog(ctx.db, a), LOG_COLS)) {
        throw new UserError(`Can't undo: the log on ${a.occurred_on} was changed after that. Fix it directly with update_log instead.`);
      }
    }
    for (const a of afterColls) {
      const cur = get<CollectionRow>(ctx.db, 'SELECT * FROM collections WHERE id = ?', a.id);
      if (!cur) throw new UserError(`Can't undo: collection ${a.name} no longer exists.`);
      if (cur.updated_at !== a.updated_at && !sameColumns(cur, a, COLL_COLS)) {
        throw new UserError(`Can't undo: collection ${cur.name} was changed after that.`);
      }
    }
    for (const a of afterColls) {
      if (!beforeColls.has(a.id)) {
        const n = get<{ n: number }>(ctx.db, 'SELECT count(*) AS n FROM entries WHERE collection_id = ? AND deleted_at IS NULL', a.id)!.n;
        if (n > 0) throw new UserError(`Can't undo: ${a.name} has ${n} ${n === 1 ? 'entry' : 'entries'} now. Archive it from the web app instead.`);
      }
    }
    for (const a of afterPhotos) {
      const cur = get<AttachmentRow>(ctx.db, 'SELECT * FROM attachments WHERE id = ?', a.id);
      if (!cur) throw new UserError(`Can't undo: that photo has been cleared out. A removed photo is kept for ${KEEP_REMOVED_DAYS} days.`);
      if (cur.deleted_at !== a.deleted_at || cur.entry_id !== a.entry_id) throw new UserError("Can't undo: that photo was changed after that.");
      const b = beforePhotos.get(a.id);
      if (b && b.deleted_at === null && b.entry_id !== null) {
        const n = get<{ n: number }>(ctx.db, 'SELECT count(*) AS n FROM attachments WHERE entry_id = ? AND deleted_at IS NULL', b.entry_id)!.n;
        if (n >= MAX_PER_ENTRY) throw new UserError(`Can't undo: the entry already has ${MAX_PER_ENTRY} photos, which is the most it can hold.`);
      }
    }

    // A cleared checklist item that has been added again since must not come back beside its replacement:
    // on a checklist one name is one item.
    if (act.action === 'clear_ticked') {
      for (const [id, b] of beforeEntries) {
        const again = get<{ id: number }>(
          ctx.db,
          'SELECT id FROM entries WHERE collection_id = ? AND title_key = ? AND id != ? AND deleted_at IS NULL AND merged_into_id IS NULL',
          b.collection_id,
          b.title_key,
          id,
        );
        if (again) throw new UserError(`Can't undo: "${b.title}" is on the list again. Clear or rename it first.`);
      }
    }

    // 2. Privacy: undo can't put someone else's data into a private collection.
    const collAfterUndo = new Map<number, Pick<CollectionRow, 'visibility' | 'owner_id'>>();
    const collState = (id: number) => {
      if (collAfterUndo.has(id)) return collAfterUndo.get(id)!;
      const restored = beforeColls.get(id);
      const row = restored ?? get<CollectionRow>(ctx.db, 'SELECT * FROM collections WHERE id = ?', id);
      const state = row ? { visibility: row.visibility, owner_id: row.owner_id } : { visibility: 'private' as const, owner_id: -1 };
      collAfterUndo.set(id, state);
      return state;
    };
    const intoPrivate: number[] = [];
    for (const [id, b] of beforeEntries) {
      const target = collState(b.collection_id);
      if (!visibleTo(target, ctx.actor.userId)) throw new UserError("Can't undo: it would put an entry where you can't see it.");
      const cur = get<EntryRow>(ctx.db, 'SELECT collection_id FROM entries WHERE id = ?', id);
      const curColl = cur ? collState(cur.collection_id) : undefined;
      if (target.visibility === 'private' && (curColl?.visibility !== 'private' || cur?.collection_id !== b.collection_id)) intoPrivate.push(id);
    }
    for (const [id, c] of beforeColls) {
      // Putting a collection back to private for someone else would take it, and anything of the actor's in it,
      // out of the actor's sight for good: they could not even undo the undo.
      if (!visibleTo(c, ctx.actor.userId)) throw new UserError("Can't undo: it would put a collection where you can't see it.");
      const cur = get<CollectionRow>(ctx.db, 'SELECT * FROM collections WHERE id = ?', id);
      if (cur && cur.visibility === 'shared' && c.visibility === 'private') {
        intoPrivate.push(...all<{ id: number }>(ctx.db, 'SELECT id FROM entries WHERE collection_id = ?', id).map((r) => r.id));
      }
    }
    if (intoPrivate.length) {
      const reason = notSolelyMine(ctx.db, intoPrivate, ctx.actor.userId);
      if (reason) throw new UserError(`Can't undo: it would make something private that isn't only yours (${reason}).`);
    }

    // 3. Restore.
    const now = nowIso();
    const entryIds = [...new Set([...afterEntries.map((e) => e.id), ...beforeEntries.keys()])];
    const logIds = [...new Set([...afterLogs.map((l) => l.id), ...beforeLogs.keys()])];
    const collIds = [...new Set([...afterColls.map((c) => c.id), ...beforeColls.keys()])];
    const photoIds = [...new Set([...afterPhotos.map((p) => p.id), ...beforePhotos.keys()])];
    const touched = { entries: entryIds, logs: logIds, collections: collIds, attachments: photoIds };
    const preUndo = snapshot(ctx.db, touched);

    for (const a of afterColls) {
      const b = beforeColls.get(a.id);
      if (b) {
        run(
          ctx.db,
          `UPDATE collections SET ${COLL_COLS.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
          ...COLL_COLS.map((c) => (b[c] ?? (c === 'sensitive' ? 0 : null)) as unknown),
          now,
          a.id,
        );
      } else {
        // An undone create: archive it and free the slug so the same name can be created again.
        run(ctx.db, 'UPDATE collections SET archived_at = ?, slug = ?, updated_at = ? WHERE id = ?', now, `${a.slug}-removed-${a.id}`, now, a.id);
      }
    }
    // A collection whose sensitive setting went back takes everything it holds with it.
    for (const a of afterColls) {
      const b = beforeColls.get(a.id);
      if (b && (b.sensitive ?? 0) !== (a.sensitive ?? 0)) fitCollection(ctx.db, a.id);
    }
    // Entries that stop being merged go first so the keeper's search text drops their words when it's rewritten.
    const ordered = [...entryIds].sort((x, y) => {
      const mx = beforeEntries.get(x)?.merged_into_id === null && afterEntries.find((e) => e.id === x)?.merged_into_id !== null ? 0 : 1;
      const my = beforeEntries.get(y)?.merged_into_id === null && afterEntries.find((e) => e.id === y)?.merged_into_id !== null ? 0 : 1;
      return mx - my;
    });
    for (const id of ordered) {
      const b = beforeEntries.get(id);
      if (b) {
        // The snapshot may be from when its collection stored text the other way; it goes back in today's form.
        const [fields, notes, source_text, sealed] = entryText(ctx.db, isSensitive(ctx.db, b.collection_id), openEntry(ctx.db, b));
        const row: Record<string, unknown> = { ...b, fields, notes, source_text, sealed };
        run(
          ctx.db,
          `UPDATE entries SET ${ENTRY_RESTORE.map((c) => `${c} = ?`).join(', ')}, updated_by = ?, updated_at = ? WHERE id = ?`,
          ...ENTRY_RESTORE.map((c) => row[c]),
          ctx.actor.userId,
          now,
          id,
        );
      } else {
        run(ctx.db, 'UPDATE entries SET deleted_at = ?, updated_by = ?, updated_at = ? WHERE id = ?', now, ctx.actor.userId, now, id);
      }
    }
    // Logs go back after their entries, so each is written in the form of the collection its entry is in again.
    for (const id of logIds) {
      const b = beforeLogs.get(id);
      if (b) {
        const on = get<{ collection_id: number }>(ctx.db, 'SELECT collection_id FROM entries WHERE id = ?', b.entry_id);
        const [note, raw_text, sealed] = logText(ctx.db, on ? isSensitive(ctx.db, on.collection_id) : false, openLog(ctx.db, b));
        const row: Record<string, unknown> = { ...b, note, raw_text, sealed };
        run(ctx.db, `UPDATE entry_logs SET ${LOG_RESTORE.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...LOG_RESTORE.map((c) => row[c]), now, id);
      } else {
        run(ctx.db, 'UPDATE entry_logs SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL', now, now, id);
      }
    }
    // An entry that changed collection took all its logs with it, not only the ones this change recorded.
    for (const id of entryIds) fitEntry(ctx.db, id);
    // Re-index every touched entry from its final state, so no entry keeps search text from a merge that was undone.
    if (entryIds.length) {
      run(ctx.db, `UPDATE entries SET updated_at = updated_at WHERE id IN (${entryIds.map(() => '?').join(',')})`, ...entryIds);
    }
    // A removed photo goes back on its entry. Its file never left the disk.
    for (const [id, b] of beforePhotos) run(ctx.db, 'UPDATE attachments SET entry_id = ?, deleted_at = ? WHERE id = ?', b.entry_id, b.deleted_at, id);
    const summary = `Undid: ${stripId(act.summary)} (${effect(act.action)}).`;
    const undoId = recordActivity(ctx, {
      action: 'undo',
      collectionId: act.collection_id,
      entryId: act.entry_id,
      summary,
      rawText: rawText ?? null,
      before: preUndo,
      after: snapshot(ctx.db, touched),
    });
    run(ctx.db, 'UPDATE activity SET undone_by = ? WHERE id = ?', undoId, act.id);
    return { ok: true, summary, extra: [], entryId: act.entry_id ?? undefined, collectionId: act.collection_id ?? undefined, activityId: undoId };
  });
}

/** undo_last_change: the caller's own most recent change made through Claude in the last 24 hours. */
export function undoLastChange(ctx: Ctx, rawText?: string | null): WriteResult | { ok: false; text: string } {
  const candidates = all<ActivityRow>(
    ctx.db,
    `SELECT * FROM activity WHERE user_id = ? AND via = 'mcp' AND undone_by IS NULL AND at >= ?
       AND action NOT IN ('undo', 'purge_entry') ORDER BY id DESC LIMIT 1`,
    ctx.actor.userId,
    minutesAgoIso(24 * 60),
  );
  if (candidates.length === 0) {
    return { ok: false, text: 'Nothing to undo: you have no changes made through Claude in the last 24 hours that are still in place.' };
  }
  return undoActivity(ctx, candidates[0].id, rawText);
}
