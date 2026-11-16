import { all, get, run, tx } from '../db/sqlite.ts';
import { recordActivity, snapshot } from './activity.ts';
import { getCollection, resolveCollection, saveAddedDefs } from './collections.ts';
import { findDuplicates, type DupCandidate } from './dedupe.ts';
import { DONE_KEY, isChecklist, writeDone } from './checklist.ts';
import { NotFoundError, UserError } from './errors.ts';
import { applyFields, coerceValue } from './fields.ts';
import { countOf, fmtRating, hasLogNoun, joinAnd, logNoun, logPhrase, plural } from './format.ts';
import { normalizeTag, roundHalf, titleKey } from './normalize.ts';
import { notSolelyMine, visibleTo } from './privacy.ts';
import { ENTRY_TEXT_SET, entryText, fitEntry, LOG_TEXT_SET, logText } from './sealed.ts';
import { resolveTags, tagNotes } from './tags.ts';
import { checkOccurredOn, minutesAgoIso, nowIso, shortDate } from './time.ts';
import type { Collection, Ctx, EntryRow, FieldValue, Fields, LogRow, Refusal, WriteResult } from './types.ts';
import { otherNames } from './users.ts';

const REPLAY_MINUTES = 10;

export function loadEntry(ctx: Ctx, id: number): EntryRow | undefined {
  return get<EntryRow>(ctx.db, 'SELECT * FROM open_entries WHERE id = ?', id);
}

export function loadLog(ctx: Ctx, id: number): LogRow | undefined {
  return get<LogRow>(ctx.db, 'SELECT * FROM open_logs WHERE id = ?', id);
}

export const entryFields = (e: Pick<EntryRow, 'fields'>): Fields => JSON.parse(e.fields) as Fields;
export const entryTags = (e: Pick<EntryRow, 'tags'>): string[] => JSON.parse(e.tags) as string[];

export interface ResolvedEntry {
  entry: EntryRow;
  collection: Collection;
  followedFrom?: number;
  note?: string;
}

/**
 * Loads an entry the actor can see. Hidden entries behave exactly like missing ones. Merged entries are followed
 * to the entry they were merged into (and the caller is told); deleted ones are refused unless allowDeleted.
 */
export function resolveEntry(ctx: Ctx, id: number, opts: { follow?: boolean; allowDeleted?: boolean } = {}): ResolvedEntry {
  const follow = opts.follow ?? true;
  const visibleColl = (e: EntryRow): Collection => {
    const c = getCollection(ctx, e.collection_id);
    if (!c || !visibleTo(c, ctx.actor.userId) || c.archived_at) throw new NotFoundError(`No entry #${id}.`);
    return c;
  };
  const first = loadEntry(ctx, id);
  if (!first) throw new NotFoundError(`No entry #${id}.`);
  // Walk the whole merge chain first: every hop must be visible before anything about it is revealed.
  let cur: EntryRow = first;
  let coll = visibleColl(cur);
  for (let hops = 0; cur.merged_into_id !== null; hops++) {
    if (hops >= 10) throw new UserError(`Entry #${id} has a broken merge chain.`);
    const next = loadEntry(ctx, cur.merged_into_id);
    if (!next) throw new NotFoundError(`No entry #${id}.`);
    cur = next;
    coll = visibleColl(cur);
  }
  if (!follow && first.merged_into_id !== null) {
    throw new UserError(`Entry #${first.id} was merged into #${cur.id}. Use #${cur.id}.`);
  }
  if (cur.deleted_at && !opts.allowDeleted) {
    throw new NotFoundError(
      `Entry #${cur.id} ("${cur.title}") is deleted. Bring it back with undo_last_change or from the web app's Trash.`,
    );
  }
  if (cur.id !== id) {
    return { entry: cur, collection: coll, followedFrom: id, note: `#${id} was merged into #${cur.id}, so this used #${cur.id}.` };
  }
  return { entry: cur, collection: coll };
}

function roundRating(r: number | null | undefined, notes: string[]): number | null | undefined {
  if (r === undefined || r === null) return r;
  if (typeof r !== 'number' || !Number.isFinite(r) || r < 0 || r > 5) {
    throw new UserError(`Ratings are 0 to 5 in half steps (got ${r}). Convert other scales first: 7/10 = 3.5, 8/10 = 4.`);
  }
  const x = roundHalf(r);
  if (x !== r) notes.push(`Rating ${r} rounded to ${x} (ratings use half steps).`);
  return x;
}

function cleanTitle(title: string): string {
  const t = title.trim().replace(/\s+/g, ' ');
  if (!t) throw new UserError('The title is empty. Use the thing\'s name, like "Pho 54".');
  if (t.length > 200) throw new UserError('Titles are limited to 200 characters. Use the name and put the rest in notes.');
  return t;
}

function keyFor(title: string): string {
  return titleKey(title) || title.trim().toLowerCase();
}

function textOrNull(s: string | null | undefined): string | null {
  const t = s?.trim();
  return t ? t : null;
}

function logHead(coll: Collection, title: string, date: string, tz: string): string {
  const d = shortDate(date, tz);
  return hasLogNoun(coll) ? `${logPhrase(logNoun(coll))} "${title}" on ${d}` : `"${title}" on ${d}`;
}

function dupRefusal(coll: Collection, title: string, cands: DupCandidate[]): Refusal {
  const inThis = cands.some((c) => c.collectionId === coll.id);
  const head = inThis
    ? `NOT SAVED: possible duplicate in ${coll.name}.`
    : `NOT SAVED: "${title}" already exists in another collection.`;
  const lines = cands.map((c) => {
    const parts = [`#${c.id} ${c.title}`];
    if (c.collectionId !== coll.id) parts.push(c.collectionName);
    if (c.rating !== null) parts.push(fmtRating(c.rating));
    if (c.logCount) parts.push(countOf(c.logCount, c.logNoun || 'log') + (c.lastLoggedOn ? `, last ${c.lastLoggedOn}` : ''));
    return `  ${parts.join(' | ')} (${c.why})`;
  });
  const ids = cands.map((c) => c.id).join(', ');
  const tail = inThis
    ? `If one is the same thing, call add_log with its entry_id. If it is different, call create_entry again with not_duplicate_of: [${ids}].`
    : `If it's the same thing, use add_log on it (or update_entry with move_to_collection). If it is different, call create_entry again with not_duplicate_of: [${ids}].`;
  return {
    ok: false,
    text: [head, ...lines, tail].join('\n'),
    candidates: cands.map((c) => ({ id: c.id, title: c.title, why: c.why })),
  };
}

export interface CreateEntryInput {
  collection: string | number;
  title: string;
  fields?: Record<string, unknown>;
  rating?: number | null;
  tags?: string[];
  notes?: string;
  log?: { occurred_on?: string; note?: string; rating?: number | null };
  raw_text?: string | null;
  not_duplicate_of?: number[];
}

export function createEntry(ctx: Ctx, input: CreateEntryInput): WriteResult | Refusal {
  return tx(ctx.db, () => {
    const coll = resolveCollection(ctx, input.collection);
    const title = cleanTitle(input.title);
    const key = keyFor(title);
    const rawText = textOrNull(input.raw_text);

    if (rawText) {
      const replay = get<{ id: number }>(
        ctx.db,
        `SELECT id FROM open_entries WHERE collection_id = ? AND title_key = ? AND created_by = ? AND source_text = ?
           AND created_at >= ? AND deleted_at IS NULL AND merged_into_id IS NULL ORDER BY id DESC LIMIT 1`,
        coll.id,
        key,
        ctx.actor.userId,
        rawText,
        minutesAgoIso(REPLAY_MINUTES),
      );
      if (replay) {
        return { ok: true, replay: true, summary: `Already saved "${title}" to ${coll.name}. (#${replay.id})`, extra: [], entryId: replay.id };
      }
    }

    // On a checklist the same name is the same item: adding it again puts it back on the list. Names that only
    // look alike ("milk", "oat milk") are different things there, so the usual duplicate question is not asked.
    if (isChecklist(coll)) {
      const same = get<EntryRow>(
        ctx.db,
        'SELECT * FROM open_entries WHERE collection_id = ? AND title_key = ? AND deleted_at IS NULL AND merged_into_id IS NULL ORDER BY id LIMIT 1',
        coll.id,
        key,
      );
      if (same) {
        if ((JSON.parse(same.fields) as Fields)[DONE_KEY] !== true) {
          return { ok: true, replay: true, summary: `"${same.title}" is already on the ${coll.name} list. (#${same.id})`, extra: [], entryId: same.id, collectionId: coll.id };
        }
        const summary = `"${same.title}" is back on the ${coll.name} list. (#${same.id})`;
        const activityId = writeDone(ctx, same, coll, false, summary, rawText);
        return { ok: true, summary, extra: [], entryId: same.id, collectionId: coll.id, activityId };
      }
    }
    const cands = isChecklist(coll) ? [] : findDuplicates(ctx, coll, title);
    const confirmed = new Set(input.not_duplicate_of ?? []);
    if (cands.some((c) => !confirmed.has(c.id))) return dupRefusal(coll, title, cands);

    const extra: string[] = [];
    const rating = roundRating(input.rating, extra);
    const fieldRes = applyFields(coll, {}, input.fields, { allowClear: false });
    const tagRes = resolveTags(ctx, input.tags, []);
    let occurred: string | undefined;
    let logRating: number | null | undefined;
    if (input.log) {
      occurred = checkOccurredOn(input.log.occurred_on, ctx.tz);
      logRating = roundRating(input.log.rating, extra);
    }
    saveAddedDefs(ctx, coll, fieldRes.addedDefs);

    const now = nowIso();
    const res = run(
      ctx.db,
      `INSERT INTO entries (collection_id, title, title_key, tags, rating_override, fields, notes, source_text, sealed,
                            created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      coll.id,
      title,
      key,
      JSON.stringify(tagRes.tags),
      rating ?? null,
      ...entryText(ctx.db, coll.sensitive, { fields: JSON.stringify(fieldRes.fields), notes: input.notes?.trim() ?? '', source_text: rawText }),
      ctx.actor.userId,
      ctx.actor.userId,
      now,
      now,
    );
    const id = Number(res.lastInsertRowid);
    let logId: number | undefined;
    if (input.log && occurred) {
      const lr = run(
        ctx.db,
        `INSERT INTO entry_logs (entry_id, occurred_on, rating, note, raw_text, sealed, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        occurred,
        logRating ?? null,
        ...logText(ctx.db, coll.sensitive, { note: input.log.note?.trim() ?? '', raw_text: rawText }),
        ctx.actor.userId,
        now,
        now,
      );
      logId = Number(lr.lastInsertRowid);
    }
    const after = loadEntry(ctx, id)!;
    const parts: string[] = [];
    if (after.rating !== null) parts.push(fmtRating(after.rating));
    if (occurred) {
      const d = shortDate(occurred, ctx.tz);
      let p = hasLogNoun(coll) ? `${logNoun(coll)} on ${d}` : `logged ${d}`;
      if (logRating !== undefined && logRating !== null && logRating !== after.rating) p += ` (${fmtRating(logRating)})`;
      parts.push(p);
    }
    const summary = `Saved "${title}" to ${coll.name}${parts.length ? `: ${parts.join(', ')}` : ''}. (#${id})`;
    extra.push(...tagNotes(tagRes));
    for (const d of fieldRes.addedDefs) extra.push(`New field added to ${coll.name}: \`${d.key}\` (${d.type}).`);
    const activityId = recordActivity(ctx, {
      action: 'create_entry',
      collectionId: coll.id,
      entryId: id,
      summary,
      rawText,
      before: {},
      after: snapshot(ctx.db, { entries: [id], logs: logId ? [logId] : [] }),
    });
    return { ok: true, summary, extra, entryId: id, logId, collectionId: coll.id, activityId };
  });
}

export interface AddLogInput {
  entry_id: number;
  occurred_on?: string;
  note?: string;
  rating?: number | null;
  overall_rating?: number | null;
  set_fields?: Record<string, unknown>;
  add_tags?: string[];
  raw_text?: string | null;
}

export function addLog(ctx: Ctx, input: AddLogInput): WriteResult {
  return tx(ctx.db, () => {
    const { entry, collection: coll, note: followNote } = resolveEntry(ctx, input.entry_id);
    const occurred = checkOccurredOn(input.occurred_on, ctx.tz);
    const rawText = textOrNull(input.raw_text);
    const noun = logNoun(coll);

    if (rawText) {
      const replay = get<{ id: number }>(
        ctx.db,
        `SELECT id FROM open_logs WHERE entry_id = ? AND created_by = ? AND occurred_on = ? AND raw_text = ?
           AND created_at >= ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1`,
        entry.id,
        ctx.actor.userId,
        occurred,
        rawText,
        minutesAgoIso(REPLAY_MINUTES),
      );
      if (replay) {
        return {
          ok: true,
          replay: true,
          summary: `Already logged ${logHead(coll, entry.title, occurred, ctx.tz)}. (#${entry.id}, log ${replay.id})`,
          extra: [],
          entryId: entry.id,
          logId: replay.id,
        };
      }
    }

    const extra: string[] = [];
    if (followNote) extra.push(followNote);
    const logRating = roundRating(input.rating, extra);
    const overall = roundRating(input.overall_rating, extra);
    const fieldRes = applyFields(coll, entryFields(entry), input.set_fields, { allowClear: true });
    const tagRes = resolveTags(ctx, input.add_tags, entryTags(entry));
    saveAddedDefs(ctx, coll, fieldRes.addedDefs);

    const now = nowIso();
    const lr = run(
      ctx.db,
      `INSERT INTO entry_logs (entry_id, occurred_on, rating, note, raw_text, sealed, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      entry.id,
      occurred,
      logRating ?? null,
      ...logText(ctx.db, coll.sensitive, { note: input.note?.trim() ?? '', raw_text: rawText }),
      ctx.actor.userId,
      now,
      now,
    );
    const logId = Number(lr.lastInsertRowid);
    // A rated occasion without an explicit overall rating makes the overall follow the occasions again.
    const override =
      overall !== undefined ? overall : logRating !== undefined && logRating !== null ? null : entry.rating_override;
    run(
      ctx.db,
      `UPDATE entries SET ${ENTRY_TEXT_SET}, tags = ?, rating_override = ?, updated_by = ?, updated_at = ? WHERE id = ?`,
      ...entryText(ctx.db, coll.sensitive, { ...entry, fields: JSON.stringify(fieldRes.fields) }),
      JSON.stringify(tagRes.tags),
      override,
      ctx.actor.userId,
      now,
      entry.id,
    );
    const after = loadEntry(ctx, entry.id)!;
    let summary = `Logged ${logHead(coll, entry.title, occurred, ctx.tz)}`;
    if (logRating !== undefined && logRating !== null) summary += `: ${fmtRating(logRating)}`;
    if (after.rating !== entry.rating) {
      summary +=
        after.rating === null
          ? ' (overall rating cleared)'
          : entry.rating === null
            ? ` (overall now ${fmtRating(after.rating)})`
            : ` (overall now ${fmtRating(after.rating)}, was ${fmtRating(entry.rating)})`;
    } else if (after.rating !== null && logRating !== undefined && logRating !== null && logRating !== after.rating) {
      summary += ` (overall still ${fmtRating(after.rating)}${occurred < (entry.last_logged_on ?? '') ? `, from a later ${noun}` : ''})`;
    }
    summary += `. (#${entry.id})`;
    if (fieldRes.changes.length) extra.push(`Set ${fieldRes.changes.join(', ')}.`);
    extra.push(...tagNotes(tagRes));
    if (tagRes.added.length && !tagRes.newTags.length) extra.push(`Tagged ${tagRes.added.join(', ')}.`);
    for (const d of fieldRes.addedDefs) extra.push(`New field added to ${coll.name}: \`${d.key}\` (${d.type}).`);
    const activityId = recordActivity(ctx, {
      action: 'add_log',
      collectionId: coll.id,
      entryId: entry.id,
      summary,
      rawText,
      before: { entries: [entry] },
      after: snapshot(ctx.db, { entries: [entry.id], logs: [logId] }),
    });
    return { ok: true, summary, extra, entryId: entry.id, logId, collectionId: coll.id, activityId };
  });
}

export interface AddedItems extends WriteResult {
  added: number;
  /** Ticked items that were put back on the list. */
  back: number;
  /** Names that were already on the list, left as they are. */
  already: string[];
}

/**
 * Adds several items to a checklist as one change with one Undo (a recipe's ingredients onto the shopping
 * list). The same name is the same item, as everywhere on a checklist: one that is ticked comes back, one that
 * is already waiting is left alone.
 */
export function addChecklistItems(ctx: Ctx, listId: number, names: string[], from?: string): AddedItems {
  return tx(ctx.db, () => {
    const coll = resolveCollection(ctx, listId);
    if (!isChecklist(coll)) throw new UserError(`${coll.name} is not a checklist.`);
    const wanted = new Map<string, string>();
    for (const n of names) {
      if (!n.trim()) continue;
      const title = cleanTitle(n.slice(0, 200));
      if (!wanted.has(keyFor(title))) wanted.set(keyFor(title), title);
    }
    if (wanted.size === 0) throw new UserError('Pick at least one thing to add.');
    if (wanted.size > 100) throw new UserError('That is more than 100 items at once. Add them in two goes.');
    const already: string[] = [];
    const untick: EntryRow[] = [];
    const fresh: [string, string][] = [];
    for (const [key, title] of wanted) {
      const same = get<EntryRow>(ctx.db, 'SELECT * FROM open_entries WHERE collection_id = ? AND title_key = ? AND deleted_at IS NULL AND merged_into_id IS NULL ORDER BY id LIMIT 1', coll.id, key);
      if (!same) fresh.push([key, title]);
      else if ((JSON.parse(same.fields) as Fields)[DONE_KEY] === true) untick.push(same);
      else already.push(same.title);
    }
    const said = `${already.length} already on the list`;
    if (fresh.length === 0 && untick.length === 0) {
      return { ok: true, replay: true, summary: `Nothing to add: all ${already.length} are already on the ${coll.name} list.`, extra: [], collectionId: coll.id, added: 0, back: 0, already };
    }
    const before = snapshot(ctx.db, { entries: untick.map((e) => e.id) });
    const now = nowIso();
    const ids = untick.map((e) => e.id);
    for (const e of untick) {
      const fields = JSON.stringify({ ...(JSON.parse(e.fields) as Fields), [DONE_KEY]: false });
      run(ctx.db, `UPDATE entries SET ${ENTRY_TEXT_SET}, updated_by = ?, updated_at = ? WHERE id = ?`, ...entryText(ctx.db, coll.sensitive, { ...e, fields }), ctx.actor.userId, now, e.id);
    }
    for (const [key, title] of fresh) {
      const res = run(
        ctx.db,
        `INSERT INTO entries (collection_id, title, title_key, fields, tags, rating_override, notes, source_text, created_by, updated_by, created_at, updated_at)
         VALUES (?, ?, ?, '{}', '[]', NULL, '', NULL, ?, ?, ?, ?)`,
        coll.id,
        title,
        key,
        ctx.actor.userId,
        ctx.actor.userId,
        now,
        now,
      );
      ids.push(Number(res.lastInsertRowid));
    }
    const n = fresh.length + untick.length;
    const summary = `Added ${n} ${n === 1 ? 'item' : 'items'} to ${coll.name}${from ? ` from ${from}` : ''}${already.length ? ` (${said})` : ''}.`;
    const activityId = recordActivity(ctx, { action: 'add_items', collectionId: coll.id, summary, before, after: snapshot(ctx.db, { entries: ids }) });
    return { ok: true, summary, extra: [], collectionId: coll.id, activityId, added: fresh.length, back: untick.length, already };
  });
}

export interface UpdateEntryInput {
  entry_id: number;
  title?: string;
  fields?: Record<string, unknown>;
  rating?: number | null;
  notes?: string;
  append_note?: string;
  add_tags?: string[];
  remove_tags?: string[];
  move_to_collection?: string | number;
  raw_text?: string | null;
}

export function updateEntry(ctx: Ctx, input: UpdateEntryInput): WriteResult {
  return tx(ctx.db, () => {
    const { entry, collection: from, note: followNote } = resolveEntry(ctx, input.entry_id);
    const extra: string[] = [];
    if (followNote) extra.push(followNote);
    const changes: string[] = [];
    let target = from;

    if (input.move_to_collection !== undefined && input.move_to_collection !== '') {
      target = resolveCollection(ctx, input.move_to_collection);
      if (target.id !== from.id) {
        if (target.visibility === 'private' && !(from.visibility === 'private' && from.owner_id === target.owner_id)) {
          const reason = notSolelyMine(ctx.db, [entry.id], ctx.actor.userId);
          if (reason) throw new UserError(`Can't move it into the private collection ${target.name}: ${reason}.`);
        }
        changes.push(`moved from ${from.name} to ${target.name}`);
        if (from.visibility === 'private' && target.visibility === 'shared') {
          const others = otherNames(ctx.db, ctx.actor.userId);
          if (others.length) extra.push(`Now visible to ${joinAnd(others)}.`);
        }
        if (from.sensitive && !target.sensitive) extra.push(`No longer encrypted: ${target.name} is not a sensitive collection.`);
        const kept = Object.keys(entryFields(entry)).filter((k) => !target.fields.some((d) => d.key === k));
        if (kept.length) extra.push(`Kept fields ${target.name} doesn't define: ${kept.join(', ')}.`);
      }
    }

    let title = entry.title;
    if (input.title !== undefined) {
      const t = cleanTitle(input.title);
      if (t !== entry.title) {
        changes.push(`renamed from "${entry.title}"`);
        title = t;
      }
    }

    const fieldRes = applyFields(target, entryFields(entry), input.fields, { allowClear: true });
    changes.push(...fieldRes.changes);
    for (const d of fieldRes.addedDefs) extra.push(`New field added to ${target.name}: \`${d.key}\` (${d.type}).`);

    let override = entry.rating_override;
    if (input.rating !== undefined) {
      const r = roundRating(input.rating, extra);
      override = r ?? null;
    }

    let notes = entry.notes;
    if (input.notes !== undefined && input.notes.trim() !== entry.notes) {
      notes = input.notes.trim();
      changes.push(notes ? 'notes replaced' : 'notes cleared');
    }
    if (input.append_note?.trim()) {
      notes = notes ? `${notes}\n${input.append_note.trim()}` : input.append_note.trim();
      changes.push('note added');
    }

    let tags = entryTags(entry);
    const tagRes = resolveTags(ctx, input.add_tags, tags);
    tags = tagRes.tags;
    const removed: string[] = [];
    const missing: string[] = [];
    for (const raw of input.remove_tags ?? []) {
      const t = normalizeTag(raw);
      if (tags.includes(t)) {
        tags = tags.filter((x) => x !== t);
        removed.push(t);
      } else if (t) missing.push(t);
    }
    if (tagRes.added.length || removed.length) {
      changes.push(`tags ${[...tagRes.added.map((t) => `+${t}`), ...removed.map((t) => `-${t}`)].join(' ')}`);
    }
    if (missing.length) extra.push(`Wasn't tagged: ${missing.join(', ')}.`);
    extra.push(...tagNotes(tagRes));

    const ratingChanged = override !== entry.rating_override;
    if (changes.length === 0 && !ratingChanged && fieldRes.addedDefs.length === 0) {
      if (input.rating !== undefined) throw new UserError(`"${entry.title}" already has that rating. Nothing changed.`);
      throw new UserError(
        'Nothing to change. Pass at least one of title, fields, rating, notes, append_note, add_tags, remove_tags or move_to_collection.',
      );
    }
    saveAddedDefs(ctx, target, fieldRes.addedDefs);
    run(
      ctx.db,
      `UPDATE entries SET collection_id = ?, title = ?, title_key = ?, ${ENTRY_TEXT_SET}, tags = ?, rating_override = ?,
              updated_by = ?, updated_at = ? WHERE id = ?`,
      target.id,
      title,
      keyFor(title),
      ...entryText(ctx.db, target.sensitive, { fields: JSON.stringify(fieldRes.fields), notes, source_text: entry.source_text }),
      JSON.stringify(tags),
      override,
      ctx.actor.userId,
      nowIso(),
      entry.id,
    );
    // Its logs follow it into the form the new collection stores.
    if (target.sensitive !== from.sensitive) fitEntry(ctx.db, entry.id);
    const after = loadEntry(ctx, entry.id)!;
    if (ratingChanged || after.rating !== entry.rating) {
      if (override === null && entry.rating_override !== null) {
        changes.push(
          after.rating === null
            ? 'manual rating cleared'
            : `rating now follows the ${plural(logNoun(target), 2)} (${fmtRating(after.rating)})`,
        );
      } else {
        changes.push(`rating ${entry.rating === null ? 'set to' : `${fmtRating(entry.rating)} to`} ${fmtRating(after.rating)}`);
      }
    }
    const summary = `Updated "${title}": ${changes.join(', ')}. (#${entry.id})`;
    const activityId = recordActivity(ctx, {
      action: 'update_entry',
      collectionId: target.id,
      entryId: entry.id,
      summary,
      rawText: textOrNull(input.raw_text),
      before: { entries: [entry] },
      after: snapshot(ctx.db, { entries: [entry.id] }),
    });
    return { ok: true, summary, extra, entryId: entry.id, collectionId: target.id, activityId };
  });
}

/** Loads a live log on a visible, live entry. */
export function resolveLog(ctx: Ctx, logId: number): { log: LogRow; entry: EntryRow; collection: Collection } {
  const log = loadLog(ctx, logId);
  if (!log) throw new NotFoundError(`No log ${logId}.`);
  let resolved: ResolvedEntry;
  try {
    resolved = resolveEntry(ctx, log.entry_id, { follow: false });
  } catch (err) {
    if (err instanceof NotFoundError) throw new NotFoundError(`No log ${logId}.`);
    throw err;
  }
  if (log.deleted_at) throw new NotFoundError(`Log ${logId} is deleted. Bring it back with undo_last_change or the web app.`);
  return { log, entry: resolved.entry, collection: resolved.collection };
}

export interface UpdateLogInput {
  log_id: number;
  occurred_on?: string;
  note?: string;
  rating?: number | null;
  raw_text?: string | null;
}

export function updateLog(ctx: Ctx, input: UpdateLogInput): WriteResult {
  return tx(ctx.db, () => {
    const { log, entry, collection: coll } = resolveLog(ctx, input.log_id);
    const extra: string[] = [];
    const changes: string[] = [];
    let occurred = log.occurred_on;
    if (input.occurred_on !== undefined && input.occurred_on !== log.occurred_on) {
      occurred = checkOccurredOn(input.occurred_on, ctx.tz);
      changes.push(`date ${shortDate(log.occurred_on, ctx.tz)} to ${shortDate(occurred, ctx.tz)}`);
    }
    let rating = log.rating;
    if (input.rating !== undefined) {
      const r = roundRating(input.rating, extra) ?? null;
      if (r !== log.rating) {
        changes.push(r === null ? 'rating removed' : log.rating === null ? `rating ${fmtRating(r)}` : `rating ${fmtRating(log.rating)} to ${fmtRating(r)}`);
        rating = r;
      }
    }
    let note = log.note;
    if (input.note !== undefined && input.note.trim() !== log.note) {
      note = input.note.trim();
      changes.push(note ? 'note changed' : 'note removed');
    }
    if (changes.length === 0) throw new UserError('Nothing to change. Pass occurred_on, note or rating.');
    run(
      ctx.db,
      `UPDATE entry_logs SET occurred_on = ?, rating = ?, ${LOG_TEXT_SET}, updated_at = ? WHERE id = ?`,
      occurred,
      rating,
      ...logText(ctx.db, coll.sensitive, { note, raw_text: log.raw_text }),
      nowIso(),
      log.id,
    );
    const after = loadEntry(ctx, entry.id)!;
    if (after.rating !== entry.rating) {
      extra.push(after.rating === null ? 'Overall rating cleared.' : `Overall now ${fmtRating(after.rating)}${entry.rating !== null ? ` (was ${fmtRating(entry.rating)})` : ''}.`);
    }
    const noun = logNoun(coll);
    const summary = `Updated the ${noun} on ${shortDate(log.occurred_on, ctx.tz)} for "${entry.title}": ${changes.join(', ')}. (#${entry.id}, log ${log.id})`;
    const activityId = recordActivity(ctx, {
      action: 'update_log',
      collectionId: coll.id,
      entryId: entry.id,
      summary,
      rawText: textOrNull(input.raw_text),
      before: { entries: [entry], logs: [log] },
      after: snapshot(ctx.db, { entries: [entry.id], logs: [log.id] }),
    });
    return { ok: true, summary, extra, entryId: entry.id, logId: log.id, collectionId: coll.id, activityId };
  });
}

export function deleteItem(ctx: Ctx, input: { entry_id?: number; log_id?: number; raw_text?: string | null }): WriteResult {
  if ((input.entry_id === undefined) === (input.log_id === undefined)) {
    throw new UserError('Give exactly one of entry_id or log_id.');
  }
  return tx(ctx.db, () => {
    const now = nowIso();
    if (input.entry_id !== undefined) {
      const { entry, collection: coll } = resolveEntry(ctx, input.entry_id, { follow: false });
      run(ctx.db, 'UPDATE entries SET deleted_at = ?, updated_by = ?, updated_at = ? WHERE id = ?', now, ctx.actor.userId, now, entry.id);
      const summary = `Deleted "${entry.title}" from ${coll.name} (recoverable). (#${entry.id})`;
      const activityId = recordActivity(ctx, {
        action: 'delete_entry',
        collectionId: coll.id,
        entryId: entry.id,
        summary,
        rawText: textOrNull(input.raw_text),
        before: { entries: [entry] },
        after: snapshot(ctx.db, { entries: [entry.id] }),
      });
      return { ok: true, summary, extra: [], entryId: entry.id, collectionId: coll.id, activityId };
    }
    const { log, entry, collection: coll } = resolveLog(ctx, input.log_id!);
    run(ctx.db, 'UPDATE entry_logs SET deleted_at = ?, updated_at = ? WHERE id = ?', now, now, log.id);
    const after = loadEntry(ctx, entry.id)!;
    const extra: string[] = [];
    if (after.rating !== entry.rating) {
      extra.push(after.rating === null ? 'Overall rating cleared.' : `Overall now ${fmtRating(after.rating)}.`);
    }
    const summary = `Deleted the ${logNoun(coll)} on ${shortDate(log.occurred_on, ctx.tz)} from "${entry.title}" (recoverable). (#${entry.id}, log ${log.id})`;
    const activityId = recordActivity(ctx, {
      action: 'delete_log',
      collectionId: coll.id,
      entryId: entry.id,
      summary,
      rawText: textOrNull(input.raw_text),
      before: { entries: [entry], logs: [log] },
      after: snapshot(ctx.db, { entries: [entry.id], logs: [log.id] }),
    });
    return { ok: true, summary, extra, entryId: entry.id, logId: log.id, collectionId: coll.id, activityId };
  });
}

function show(v: unknown): string {
  return Array.isArray(v) ? v.join(', ') : typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v);
}

export interface MergeInput {
  keep_id: number;
  duplicate_id: number;
  raw_text?: string | null;
  /** Web merge screen: values to take from the duplicate instead of the keeper. The losing values go to notes. */
  take_from_duplicate?: { title?: boolean; fields?: string[] };
}

export function mergeEntries(ctx: Ctx, input: MergeInput): WriteResult {
  if (input.keep_id === input.duplicate_id) throw new UserError('keep_id and duplicate_id are the same entry.');
  return tx(ctx.db, () => {
    const keep = resolveEntry(ctx, input.keep_id, { follow: false });
    const dup = resolveEntry(ctx, input.duplicate_id, { follow: false });
    const k = keep.entry;
    const d = dup.entry;
    const extra: string[] = [];
    if (keep.collection.visibility === 'private' && !(dup.collection.visibility === 'private' && dup.collection.owner_id === keep.collection.owner_id)) {
      const reason = notSolelyMine(ctx.db, [d.id], ctx.actor.userId);
      if (reason) throw new UserError(`Can't merge it into an entry in the private collection ${keep.collection.name}: ${reason}.`);
    }
    if (dup.collection.visibility === 'private' && keep.collection.visibility === 'shared') {
      const others = otherNames(ctx.db, ctx.actor.userId);
      if (others.length) extra.push(`What was in "${d.title}" is now visible to ${joinAnd(others)}.`);
    }
    if (dup.collection.sensitive && !keep.collection.sensitive) {
      extra.push(`What was in "${d.title}" is no longer encrypted: ${keep.collection.name} is not a sensitive collection.`);
    }
    const movedLogIds = all<{ id: number }>(ctx.db, 'SELECT id FROM entry_logs WHERE entry_id = ?', d.id).map((r) => r.id);
    const liveMoved = all<{ n: number }>(ctx.db, 'SELECT count(*) AS n FROM entry_logs WHERE entry_id = ? AND deleted_at IS NULL', d.id)[0].n;
    const childIds = all<{ id: number }>(ctx.db, 'SELECT id FROM entries WHERE merged_into_id = ?', d.id).map((r) => r.id);
    const before = snapshot(ctx.db, { entries: [k.id, d.id, ...childIds], logs: movedLogIds });

    const kf = entryFields(k);
    const df = entryFields(d);
    const take = new Set(input.take_from_duplicate?.fields ?? []);
    const conflicts: string[] = [];
    const replaced: string[] = [];
    for (const [key, val] of Object.entries(df)) {
      if (!(key in kf)) {
        kf[key] = val;
        continue;
      }
      if (JSON.stringify(kf[key]) === JSON.stringify(val)) continue;
      const def = keep.collection.fields.find((f) => f.key === key);
      let usable: FieldValue | undefined;
      if (take.has(key)) {
        try {
          usable = def ? coerceValue(def, val, keep.collection.name) : val;
        } catch {
          usable = undefined;
        }
      }
      if (usable !== undefined) {
        replaced.push(`${key}: ${show(kf[key])}`);
        kf[key] = usable;
      } else {
        conflicts.push(`${key}: ${show(val)}`);
      }
    }
    let title = k.title;
    if (input.take_from_duplicate?.title && d.title !== k.title) {
      title = d.title;
      replaced.push(`name: ${k.title}`);
    }
    const tags = [...entryTags(k)];
    const overflow: string[] = [];
    for (const t of entryTags(d)) {
      if (tags.includes(t)) continue;
      if (tags.length < 20) tags.push(t);
      else overflow.push(t);
    }
    let override = k.rating_override;
    if (override === null && d.rating_override !== null) override = d.rating_override;
    else if (override !== null && d.rating_override !== null && override !== d.rating_override) {
      conflicts.push(`overall rating: ${fmtRating(d.rating_override)}`);
    }
    const noteLines: string[] = [];
    if (k.notes) noteLines.push(k.notes);
    if (d.notes) noteLines.push(`From merged #${d.id} (${d.title}): ${d.notes}`);
    if (conflicts.length) noteLines.push(`Values from merged #${d.id} (${d.title}): ${conflicts.join('; ')}`);
    if (replaced.length) noteLines.push(`Previous values before merging #${d.id}: ${replaced.join('; ')}`);
    if (overflow.length) noteLines.push(`Tags from merged #${d.id} that didn't fit (20 max): ${overflow.join(', ')}`);

    const now = nowIso();
    const sensitive = keep.collection.sensitive;
    if (sensitive === dup.collection.sensitive) {
      run(ctx.db, 'UPDATE entry_logs SET entry_id = ?, updated_at = ? WHERE entry_id = ?', k.id, now, d.id);
    } else {
      // Each log arrives on the keeper in the form the keeper's collection stores.
      for (const l of all<LogRow>(ctx.db, 'SELECT * FROM open_logs WHERE entry_id = ?', d.id)) {
        run(ctx.db, `UPDATE entry_logs SET entry_id = ?, ${LOG_TEXT_SET}, updated_at = ? WHERE id = ?`, k.id, ...logText(ctx.db, sensitive, l), now, l.id);
      }
    }
    if (childIds.length) run(ctx.db, 'UPDATE entries SET merged_into_id = ? WHERE merged_into_id = ?', k.id, d.id);
    run(ctx.db, 'UPDATE entries SET merged_into_id = ?, updated_by = ?, updated_at = ? WHERE id = ?', k.id, ctx.actor.userId, now, d.id);
    // What is merged into a sensitive entry is sensitive from then on: fitEntry brings the rows merged away
    // into the keeper's collection, where the text they keep is sealed.
    if (sensitive) fitEntry(ctx.db, k.id);
    // The keeper is updated last so its search index picks up the duplicate's original words.
    run(
      ctx.db,
      `UPDATE entries SET title = ?, title_key = ?, ${ENTRY_TEXT_SET}, tags = ?, rating_override = ?, updated_by = ?, updated_at = ? WHERE id = ?`,
      title,
      keyFor(title),
      ...entryText(ctx.db, sensitive, { fields: JSON.stringify(kf), notes: noteLines.join('\n'), source_text: k.source_text }),
      JSON.stringify(tags),
      override,
      ctx.actor.userId,
      now,
      k.id,
    );
    const noun = logNoun(keep.collection);
    const bits = [`${countOf(liveMoved, noun)} moved`];
    if (conflicts.length) bits.push(`${countOf(conflicts.length, 'conflicting value')} noted`);
    const summary = `Merged "${d.title}" into "${title}": ${bits.join(', ')}. (#${k.id})`;
    const activityId = recordActivity(ctx, {
      action: 'merge_entries',
      collectionId: keep.collection.id,
      entryId: k.id,
      summary,
      rawText: textOrNull(input.raw_text),
      before,
      after: snapshot(ctx.db, { entries: [k.id, d.id, ...childIds], logs: movedLogIds }),
    });
    return { ok: true, summary, extra, entryId: k.id, collectionId: keep.collection.id, activityId };
  });
}

/** Web Trash: bring a deleted entry back. */
export function restoreEntry(ctx: Ctx, id: number): WriteResult {
  return tx(ctx.db, () => {
    const { entry, collection: coll } = resolveEntry(ctx, id, { follow: false, allowDeleted: true });
    if (!entry.deleted_at) throw new UserError(`"${entry.title}" isn't deleted.`);
    run(ctx.db, 'UPDATE entries SET deleted_at = NULL, updated_by = ?, updated_at = ? WHERE id = ?', ctx.actor.userId, nowIso(), id);
    const summary = `Restored "${entry.title}" to ${coll.name}. (#${id})`;
    const activityId = recordActivity(ctx, {
      action: 'restore_entry',
      collectionId: coll.id,
      entryId: id,
      summary,
      before: { entries: [entry] },
      after: snapshot(ctx.db, { entries: [id] }),
    });
    return { ok: true, summary, extra: [], entryId: id, collectionId: coll.id, activityId };
  });
}

/** Web Trash / CLI: delete forever. Strips the entry from activity history too. */
export function purgeEntry(ctx: Ctx, id: number): WriteResult {
  return tx(ctx.db, () => {
    const { entry, collection: coll } = resolveEntry(ctx, id, { follow: false, allowDeleted: true });
    if (!entry.deleted_at) throw new UserError(`Delete "${entry.title}" first; only entries in the Trash can be deleted forever.`);
    const child = get<{ id: number }>(ctx.db, 'SELECT id FROM entries WHERE merged_into_id = ? LIMIT 1', id);
    if (child) throw new UserError(`Other entries were merged into "${entry.title}", so it can't be deleted forever. Restore it instead.`);
    // History about a purged entry becomes an empty tombstone: no snapshots, words, names or references,
    // so nothing that was hidden (say, the private collection it came from) can resurface.
    const mentions = `EXISTS (SELECT 1 FROM json_each(activity.before_json, '$.entries') j WHERE json_extract(j.value, '$.id') = :id)
                   OR EXISTS (SELECT 1 FROM json_each(activity.after_json, '$.entries') j WHERE json_extract(j.value, '$.id') = :id)
                   OR EXISTS (SELECT 1 FROM json_each(activity.before_json, '$.logs') j WHERE json_extract(j.value, '$.entry_id') = :id)
                   OR EXISTS (SELECT 1 FROM json_each(activity.after_json, '$.logs') j WHERE json_extract(j.value, '$.entry_id') = :id)
                   OR EXISTS (SELECT 1 FROM json_each(activity.before_json, '$.attachments') j WHERE json_extract(j.value, '$.entry_id') = :id)
                   OR EXISTS (SELECT 1 FROM json_each(activity.after_json, '$.attachments') j WHERE json_extract(j.value, '$.entry_id') = :id)`;
    run(
      ctx.db,
      `UPDATE activity SET summary = 'A change to an entry that was later deleted forever.', raw_text = NULL,
              before_json = NULL, after_json = NULL, entry_id = NULL, collection_id = NULL, sealed = NULL
        WHERE entry_id = :id OR ${mentions}`,
      { id },
    );
    run(ctx.db, 'DELETE FROM attachments WHERE entry_id = ?', id); // the files are swept by cleanupFiles
    run(ctx.db, 'DELETE FROM pins WHERE entry_id = ?', id);
    run(ctx.db, 'DELETE FROM hidden_dates WHERE entry_id = ?', id);
    run(ctx.db, 'DELETE FROM entry_logs WHERE entry_id = ?', id);
    run(ctx.db, 'DELETE FROM entries WHERE id = ?', id);
    // The history keeps no trace of what it was; the confirmation shown right now can still name it.
    const activityId = recordActivity(ctx, { action: 'purge_entry', collectionId: coll.id, summary: `Deleted an entry from ${coll.name} forever.` });
    return { ok: true, summary: `Deleted "${entry.title}" from ${coll.name} forever.`, extra: [], collectionId: coll.id, activityId };
  });
}

export interface LogView extends LogRow {
  user_name: string;
}

export interface EntryDetail {
  entry: EntryRow;
  collection: Collection;
  fields: Fields;
  tags: string[];
  addedBy: string;
  addedVia: string | null;
  logs: LogView[];
  hasMore: boolean;
  mergedFrom: { id: number; title: string }[];
  /** preview_size is null when the photo has no small preview. */
  photos: { id: number; filename: string; mime: string; size: number; preview_size: number | null }[];
  note?: string;
}

export function getEntryDetail(
  ctx: Ctx,
  id: number,
  opts: { logLimit?: number; beforeLogId?: number; allowDeleted?: boolean } = {},
): EntryDetail {
  const { entry, collection, note } = resolveEntry(ctx, id, { allowDeleted: opts.allowDeleted });
  const limit = opts.logLimit ?? 20;
  let cursorSql = '';
  const params: unknown[] = [entry.id];
  if (opts.beforeLogId !== undefined) {
    const cur = loadLog(ctx, opts.beforeLogId);
    if (!cur || cur.entry_id !== entry.id) throw new UserError(`Log ${opts.beforeLogId} isn't on entry #${entry.id}.`);
    cursorSql = 'AND (l.occurred_on < ? OR (l.occurred_on = ? AND l.id < ?))';
    params.push(cur.occurred_on, cur.occurred_on, cur.id);
  }
  const logs = all<LogView>(
    ctx.db,
    `SELECT l.*, u.display_name AS user_name FROM open_logs l JOIN users u ON u.id = l.created_by
      WHERE l.entry_id = ? AND l.deleted_at IS NULL ${cursorSql}
      ORDER BY l.occurred_on DESC, l.id DESC LIMIT ?`,
    ...params,
    limit + 1,
  );
  const hasMore = logs.length > limit;
  if (hasMore) logs.length = limit;
  const addedBy = get<{ n: string }>(ctx.db, 'SELECT display_name AS n FROM users WHERE id = ?', entry.created_by)?.n ?? 'someone';
  const created = get<{ via: string; client: string | null }>(
    ctx.db,
    `SELECT via, client FROM activity WHERE entry_id = ? AND action = 'create_entry' ORDER BY id LIMIT 1`,
    entry.id,
  );
  const mergedFrom = all<{ id: number; title: string }>(
    ctx.db,
    'SELECT id, title FROM entries WHERE merged_into_id = ? ORDER BY id',
    entry.id,
  );
  return {
    entry,
    collection,
    fields: entryFields(entry),
    tags: entryTags(entry),
    addedBy,
    addedVia: created ? (created.via === 'mcp' ? 'via Claude' : created.via === 'web' ? 'in the web app' : 'from the CLI') : null,
    logs,
    hasMore,
    mergedFrom,
    // Photos on entries that were merged into this one show here too, so undoing the merge needs no bookkeeping.
    photos: all<EntryDetail['photos'][number]>(
      ctx.db,
      `SELECT a.id, a.filename, a.mime, a.size, a.preview_size FROM attachments a
        WHERE a.deleted_at IS NULL AND (a.entry_id = ? OR a.entry_id IN (SELECT id FROM entries WHERE merged_into_id = ?))
        ORDER BY a.id`,
      entry.id,
      entry.id,
    ),
    note,
  };
}
