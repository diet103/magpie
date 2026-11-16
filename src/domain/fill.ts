// Filling a field on the entries that lack it, from what was already said about them. The reading is done by
// the assistant (src/assistant/fill.ts); this is the part that gathers the words and writes the answers, as one
// change that one Undo takes back.
import { all, run, tx } from '../db/sqlite.ts';
import { recordActivity, snapshot } from './activity.ts';
import { getVisibleCollection } from './collections.ts';
import { UserError } from './errors.ts';
import { coerceValue, fieldLabel, isEmptyValue } from './fields.ts';
import { ENTRY_TEXT_SET, entryText, type EntryText } from './sealed.ts';
import { nowIso } from './time.ts';
import type { Collection, Ctx, EntryRow, FieldDef, Fields, FieldValue, WriteResult } from './types.ts';

/** How much of one entry's words is read. A long recipe says what it has to say well before this. */
const WORDS_PER_ENTRY = 4000;

export interface MissingEntry {
  id: number;
  title: string;
  /** Everything said about it: its notes, the words it was saved with, its logs, and the fields it has. */
  words: string;
}

function fieldOf(coll: Collection, key: string): FieldDef {
  const def = coll.fields.find((f) => f.key === key);
  if (!def) throw new UserError(`${coll.name} has no field \`${key}\`.`);
  return def;
}

const lacks = (fields: Fields, key: string) => !(key in fields) || fields[key] === null || isEmptyValue(fields[key]);

/** The live entries of a collection that have no value for the field, newest first. */
export function entriesMissing(ctx: Ctx, collectionId: number, key: string): MissingEntry[] {
  const coll = getVisibleCollection(ctx, collectionId);
  fieldOf(coll, key);
  const rows = all<Pick<EntryRow, 'id' | 'title' | 'fields' | 'tags' | 'notes' | 'source_text'>>(
    ctx.db,
    `SELECT id, title, fields, tags, notes, source_text FROM open_entries
      WHERE collection_id = ? AND deleted_at IS NULL AND merged_into_id IS NULL ORDER BY id DESC`,
    coll.id,
  ).filter((r) => lacks(JSON.parse(r.fields) as Fields, key));
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const ph = ids.map(() => '?').join(',');
  const said = new Map<number, string[]>();
  const add = (id: number, text: string | null) => {
    if (!text?.trim()) return;
    const list = said.get(id) ?? [];
    if (!list.includes(text.trim())) list.push(text.trim());
    said.set(id, list);
  };
  for (const l of all<{ entry_id: number; occurred_on: string; note: string | null; raw_text: string | null }>(
    ctx.db,
    `SELECT entry_id, occurred_on, note, raw_text FROM open_logs WHERE entry_id IN (${ph}) AND deleted_at IS NULL ORDER BY occurred_on, id`,
    ...ids,
  )) {
    add(l.entry_id, l.note ? `${l.occurred_on}: ${l.note}` : null);
    add(l.entry_id, l.raw_text);
  }
  for (const m of all<{ id: number; source_text: string | null; notes: string | null }>(
    ctx.db,
    `SELECT merged_into_id AS id, source_text, notes FROM open_entries WHERE merged_into_id IN (${ph})`,
    ...ids,
  )) {
    add(m.id, m.source_text);
    add(m.id, m.notes);
  }
  return rows.map((r) => {
    const parts: string[] = [];
    const fields = Object.entries(JSON.parse(r.fields) as Fields).filter(([, v]) => v !== null && !isEmptyValue(v));
    if (fields.length) parts.push(fields.map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`).join('; '));
    const tags = JSON.parse(r.tags) as string[];
    if (tags.length) parts.push(`tags: ${tags.join(', ')}`);
    if (r.notes?.trim()) parts.push(r.notes.trim());
    if (r.source_text?.trim() && r.source_text.trim() !== r.notes?.trim()) parts.push(r.source_text.trim());
    parts.push(...(said.get(r.id) ?? []));
    return { id: r.id, title: r.title, words: parts.join('\n').slice(0, WORDS_PER_ENTRY) };
  });
}

/** How many live entries lack each field, for the fields where some do. */
export function missingCounts(ctx: Ctx, coll: Collection): Map<string, number> {
  const counts = new Map<string, number>();
  const rows = all<{ fields: string }>(ctx.db, 'SELECT fields FROM open_entries WHERE collection_id = ? AND deleted_at IS NULL AND merged_into_id IS NULL', coll.id);
  for (const r of rows) {
    const f = JSON.parse(r.fields) as Fields;
    for (const d of coll.fields) if (lacks(f, d.key)) counts.set(d.key, (counts.get(d.key) ?? 0) + 1);
  }
  return counts;
}

export interface FillResult extends WriteResult {
  filled: number;
}

/**
 * Writes the values found for a field. A value is kept only if the entry is in this collection, still has
 * nothing for the field, and the value suits the field's type; the rest are dropped without a word. `read` is
 * how many entries were looked at, for the confirmation.
 */
export function applyFill(ctx: Ctx, collectionId: number, key: string, values: { id: number; value: unknown }[], read: number): FillResult {
  return tx(ctx.db, () => {
    const coll = getVisibleCollection(ctx, collectionId);
    const def = fieldOf(coll, key);
    const label = fieldLabel(def);
    const next = new Map<number, Fields>();
    const text = new Map<number, EntryText>();
    for (const { id, value } of values) {
      if (!Number.isInteger(id) || next.has(id) || value === null || value === undefined) continue;
      const row = all<Pick<EntryRow, 'id' | 'fields' | 'notes' | 'source_text'>>(
        ctx.db,
        'SELECT id, fields, notes, source_text FROM open_entries WHERE id = ? AND collection_id = ? AND deleted_at IS NULL AND merged_into_id IS NULL',
        id,
        coll.id,
      )[0];
      if (!row) continue;
      const fields = JSON.parse(row.fields) as Fields;
      if (!lacks(fields, key)) continue;
      let stored: FieldValue;
      try {
        stored = coerceValue(def, value, coll.name);
      } catch (err) {
        if (err instanceof UserError) continue;
        throw err;
      }
      if (stored === null || isEmptyValue(stored)) continue;
      next.set(id, { ...fields, [key]: stored });
      text.set(id, row);
    }
    const of = `${read} ${read === 1 ? 'entry' : 'entries'}`;
    if (next.size === 0) {
      return { ok: true, summary: `Nothing said about the ${of} read gives ${label}. Nothing was changed.`, extra: [], collectionId: coll.id, filled: 0 };
    }
    const ids = [...next.keys()];
    const before = snapshot(ctx.db, { entries: ids });
    const now = nowIso();
    for (const [id, f] of next) {
      run(
        ctx.db,
        `UPDATE entries SET ${ENTRY_TEXT_SET}, updated_by = ?, updated_at = ? WHERE id = ?`,
        ...entryText(ctx.db, coll.sensitive, { ...text.get(id)!, fields: JSON.stringify(f) }),
        ctx.actor.userId,
        now,
        id,
      );
    }
    const summary = `Filled ${label} on ${next.size} of ${of} in ${coll.name}, from what was said about them.`;
    const activityId = recordActivity(ctx, { action: 'fill_field', collectionId: coll.id, summary, before, after: snapshot(ctx.db, { entries: ids }) });
    return { ok: true, summary, extra: [], collectionId: coll.id, activityId, filled: next.size };
  });
}
