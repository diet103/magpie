import { all, get, run, tx } from '../db/sqlite.ts';
import { recordActivity, snapshot } from './activity.ts';
import { NotFoundError, UserError } from './errors.ts';
import {
  cleanOptions,
  describeDef,
  enumMatches,
  FIELD_KEY_RE,
  normalizeDisplay,
  validateFieldDefs,
  type FieldDefInput,
} from './fields.ts';
import { joinAnd } from './format.ts';
import { closest, collectionKey, dice, foldText, normalizeFieldKey, slugify } from './normalize.ts';
import { allEntryIdsIn, notSolelyMine, visibleTo } from './privacy.ts';
import { DONE_FIELD, DONE_KEY } from './checklist.ts';
import { ENTRY_TEXT_SET, entryText, fitCollection, fitEntry, type EntryText } from './sealed.ts';
import { nowIso } from './time.ts';
import { otherNames } from './users.ts';
import type {
  Collection,
  CollectionRow,
  Ctx,
  Display,
  EntryRow,
  FieldDef,
  Fields,
  Refusal,
  WriteResult,
} from './types.ts';

export function parseCollection(row: CollectionRow): Collection {
  const { scope_id: _scope, ...rest } = row as CollectionRow & { scope_id?: number };
  return { ...rest, fields: JSON.parse(row.fields) as FieldDef[], display: JSON.parse(row.display) as Display };
}

export function getCollection(ctx: Ctx, id: number): Collection | undefined {
  const row = get<CollectionRow>(ctx.db, 'SELECT * FROM collections WHERE id = ?', id);
  return row ? parseCollection(row) : undefined;
}

export function visibleCollections(ctx: Ctx, opts: { includeArchived?: boolean } = {}): Collection[] {
  return all<CollectionRow>(
    ctx.db,
    `SELECT * FROM collections WHERE (visibility = 'shared' OR owner_id = ?)
       ${opts.includeArchived ? '' : 'AND archived_at IS NULL'} ORDER BY name COLLATE NOCASE, id`,
    ctx.actor.userId,
  ).map(parseCollection);
}

export function getVisibleCollection(ctx: Ctx, id: number, opts: { includeArchived?: boolean } = {}): Collection {
  const c = getCollection(ctx, id);
  if (!c || !visibleTo(c, ctx.actor.userId) || (c.archived_at && !opts.includeArchived)) {
    throw new NotFoundError(`No collection #${id}.`);
  }
  return c;
}

/** Finds a collection by slug, id, or name among those the user can see, with "did you mean" on a miss. */
export function resolveCollection(ctx: Ctx, ref: string | number): Collection {
  const visible = visibleCollections(ctx);
  const r = String(ref).trim();
  if (/^#?\d+$/.test(r)) {
    const c = visible.find((x) => x.id === Number(r.replace('#', '')));
    if (c) return c;
  }
  const tries: ((c: Collection) => boolean)[] = [
    (c) => c.slug === r.toLowerCase(),
    (c) => c.slug === slugify(r),
    (c) => foldText(c.name) === foldText(r),
    (c) => collectionKey(c.name) === collectionKey(r) || collectionKey(c.slug.replace(/-/g, ' ')) === collectionKey(r),
  ];
  for (const test of tries) {
    const hits = visible.filter(test);
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) {
      throw new UserError(
        `More than one collection matches "${r}": ${hits
          .map((c) => `#${c.id} ${c.name} (${c.visibility})`)
          .join(', ')}. Pass the collection id instead.`,
      );
    }
  }
  const guess = closest(r, visible.flatMap((c) => [c.slug, c.name]));
  const guessColl = guess ? visible.find((c) => c.slug === guess || c.name === guess) : undefined;
  throw new UserError(
    `No collection "${r}".` +
      (guessColl ? ` Did you mean "${guessColl.slug}"?` : '') +
      ` Collections: ${visible.map((c) => c.slug).join(', ') || '(none yet)'}. If nothing fits, create_collection first.`,
  );
}

export interface CollectionOverview {
  collection: Collection;
  entryCount: number;
  topTags: { tag: string; n: number }[];
}

export function collectionsOverview(ctx: Ctx): CollectionOverview[] {
  const colls = visibleCollections(ctx);
  const counts = new Map(
    all<{ cid: number; n: number }>(
      ctx.db,
      `SELECT collection_id AS cid, count(*) AS n FROM entries
        WHERE deleted_at IS NULL AND merged_into_id IS NULL GROUP BY collection_id`,
    ).map((r) => [r.cid, r.n]),
  );
  const tagRows = all<{ cid: number; tag: string; n: number }>(
    ctx.db,
    `SELECT e.collection_id AS cid, j.value AS tag, count(*) AS n
       FROM entries e, json_each(e.tags) j
      WHERE e.deleted_at IS NULL AND e.merged_into_id IS NULL
      GROUP BY e.collection_id, j.value ORDER BY n DESC, j.value`,
  );
  const tags = new Map<number, { tag: string; n: number }[]>();
  for (const t of tagRows) {
    const list = tags.get(t.cid) ?? [];
    if (list.length < 10) list.push({ tag: t.tag, n: t.n });
    tags.set(t.cid, list);
  }
  return colls.map((c) => ({ collection: c, entryCount: counts.get(c.id) ?? 0, topTags: tags.get(c.id) ?? [] }));
}

/** Persists field definitions that a write added implicitly (a clearly new key). */
export function saveAddedDefs(ctx: Ctx, coll: Collection, defs: FieldDef[]) {
  if (defs.length === 0) return;
  coll.fields = [...coll.fields, ...defs];
  run(ctx.db, 'UPDATE collections SET fields = ?, updated_at = ? WHERE id = ?', JSON.stringify(coll.fields), nowIso(), coll.id);
}

function lookalike(name: string, slug: string, visible: Collection[]): Collection | undefined {
  const mine = [collectionKey(name), collectionKey(slug.replace(/-/g, ' '))].filter(Boolean);
  for (const c of visible) {
    const theirs = [collectionKey(c.name), collectionKey(c.slug.replace(/-/g, ' '))];
    for (const a of mine) {
      for (const b of theirs) {
        if (a === b) return c;
        if ((a.length >= 4 && b.includes(a)) || (b.length >= 4 && a.includes(b))) return c;
        if (dice(a, b) >= 0.6) return c;
      }
    }
  }
  return undefined;
}

function slugTaken(ctx: Ctx, slug: string, visibility: 'shared' | 'private', exceptId?: number): CollectionRow | undefined {
  return get<CollectionRow>(
    ctx.db,
    `SELECT * FROM collections WHERE slug = ? AND id != ? AND ${
      visibility === 'shared' ? "visibility = 'shared'" : "visibility = 'private' AND owner_id = ?"
    }`,
    ...(visibility === 'shared' ? [slug, exceptId ?? 0] : [slug, exceptId ?? 0, ctx.actor.userId]),
  );
}

export interface CreateCollectionInput {
  name: string;
  description: string;
  fields?: FieldDefInput[];
  display?: Display;
  icon?: string;
  private?: boolean;
  sensitive?: boolean;
  /** A list to tick off (shopping, packing, chores). */
  checklist?: boolean;
  slug?: string;
  confirm_new?: boolean;
  raw_text?: string | null;
}

export function createCollection(ctx: Ctx, input: CreateCollectionInput): WriteResult | Refusal {
  return tx(ctx.db, () => {
    const name = input.name.trim().replace(/\s+/g, ' ');
    const description = input.description.trim();
    if (!name) throw new UserError('A collection needs a name.');
    if (!description) throw new UserError('A collection needs a one-sentence description of what belongs in it.');
    const slug = slugify(input.slug?.trim() || name);
    const visibility = input.private ? 'private' : 'shared';
    const visible = visibleCollections(ctx, { includeArchived: true });
    const clash = visible.find((c) => c.slug === slug);
    if (clash) {
      throw new UserError(
        clash.archived_at
          ? `The archived collection ${clash.name} already uses the slug "${slug}". Unarchive it in the web app, or pass a different slug.`
          : `A collection with the slug "${slug}" already exists: ${clash.name} ("${clash.description}"). Use it, or pass a different slug.`,
      );
    }
    if (slugTaken(ctx, slug, visibility)) throw new UserError(`The slug "${slug}" is taken. Pass a different slug.`);
    if (!input.confirm_new) {
      const like = lookalike(name, slug, visible.filter((c) => !c.archived_at));
      if (like) {
        return {
          ok: false,
          text:
            `NOT CREATED: "${name}" looks like the existing collection ${like.slug} ("${like.description}"). ` +
            `Use it, or call create_collection again with confirm_new: true if the user wants a separate collection.`,
        };
      }
    }
    let defs = validateFieldDefs(input.fields ?? [], []);
    if (input.checklist) defs = withDoneField(defs, name);
    const { display, ignored } = normalizeDisplay(input.checklist ? { ...input.display, checklist: true } : input.display, defs, {}, !input.checklist);
    const now = nowIso();
    const res = run(
      ctx.db,
      `INSERT INTO collections (slug, name, description, icon, fields, display, visibility, owner_id, created_by, created_at, updated_at, sensitive)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      slug,
      name.slice(0, 60),
      description.slice(0, 300),
      input.icon?.trim().slice(0, 8) || null,
      JSON.stringify(defs),
      JSON.stringify(display),
      visibility,
      ctx.actor.userId,
      ctx.actor.userId,
      now,
      now,
      input.sensitive ? 1 : 0,
    );
    const id = Number(res.lastInsertRowid);
    const fieldText = defs.length ? `: ${defs.map(describeDef).join(', ')}` : ', no fields yet';
    const summary = `Created collection ${name} (${visibility === 'private' ? 'private, only you can see it' : 'shared'}${input.sensitive ? ', sensitive' : ''}${input.checklist ? ', a checklist' : ''})${input.checklist && defs.length === 1 ? '' : fieldText}.`;
    const extra: string[] = [];
    if (slug !== slugify(name)) extra.push(`Slug: ${slug}`);
    if (ignored.length) extra.push(`Ignored unknown display columns: ${ignored.join(', ')}.`);
    const activityId = recordActivity(ctx, {
      action: 'create_collection',
      collectionId: id,
      summary,
      rawText: input.raw_text,
      before: {},
      after: snapshot(ctx.db, { collections: [id] }),
    });
    return { ok: true, summary, extra, collectionId: id, activityId };
  });
}

export interface UpdateFieldInput {
  key: string;
  label?: string;
  options?: string[];
  remap?: Record<string, string>;
  description?: string;
  hidden?: boolean;
}

export interface UpdateCollectionInput {
  collection: string | number;
  name?: string;
  description?: string;
  icon?: string;
  add_fields?: FieldDefInput[];
  update_fields?: UpdateFieldInput[];
  rename_fields?: { from: string; to: string }[];
  display?: Display;
  private?: boolean;
  sensitive?: boolean;
  checklist?: boolean;
  raw_text?: string | null;
}

/** A checklist keeps each item's tick in a hidden yes/no field. */
function withDoneField(defs: FieldDef[], collName: string): FieldDef[] {
  const have = defs.find((d) => d.key === DONE_KEY);
  if (!have) return [...defs, { ...DONE_FIELD }];
  if (have.type !== 'boolean') throw new UserError(`${collName} already has a field \`${DONE_KEY}\` that is not yes/no. Rename it first.`);
  return defs;
}

export function updateCollection(ctx: Ctx, input: UpdateCollectionInput): WriteResult {
  return tx(ctx.db, () => {
    const coll = resolveCollection(ctx, input.collection);
    const beforeSnap = snapshot(ctx.db, { collections: [coll.id] });
    const changes: string[] = [];
    const extra: string[] = [];
    let name = coll.name;
    let description = coll.description;
    let icon = coll.icon;
    let visibility = coll.visibility;
    let defs: FieldDef[] = coll.fields.map((d) => ({ ...d, options: d.options ? [...d.options] : undefined }));
    let display: Display = structuredClone(coll.display);

    if (input.name !== undefined && input.name.trim() && input.name.trim() !== coll.name) {
      name = input.name.trim().slice(0, 60);
      changes.push(`renamed to ${name}`);
    }
    if (input.description !== undefined && input.description.trim() && input.description.trim() !== coll.description) {
      description = input.description.trim().slice(0, 300);
      changes.push('description updated');
    }
    if (input.icon !== undefined && (input.icon.trim() || null) !== coll.icon) {
      icon = input.icon.trim().slice(0, 8) || null;
      changes.push(icon ? `icon ${icon}` : 'icon removed');
    }

    // Entries whose fields JSON gets rewritten (renames, remaps), keyed by id.
    const rewritten = new Map<number, Fields>();
    const liveAndAll = () =>
      all<Pick<EntryRow, 'id' | 'fields'>>(ctx.db, 'SELECT id, fields FROM open_entries WHERE collection_id = ?', coll.id);
    const fieldsOf = (row: Pick<EntryRow, 'id' | 'fields'>): Fields =>
      rewritten.get(row.id) ?? (JSON.parse(row.fields) as Fields);

    if (input.add_fields?.length) {
      const added = validateFieldDefs(input.add_fields, defs);
      defs = [...defs, ...added];
      changes.push(`added ${added.length > 1 ? 'fields' : 'field'} ${added.map(describeDef).join(', ')}`);
      const n = get<{ n: number }>(ctx.db, 'SELECT count(*) AS n FROM entries WHERE collection_id = ? AND deleted_at IS NULL AND merged_into_id IS NULL', coll.id)!.n;
      if (n) {
        extra.push(
          `${n} existing ${n === 1 ? 'entry has' : 'entries have'} no value for ${added.map((d) => `\`${d.key}\``).join(', ')} yet. Where what was already said about one states it, fill it in with update_entry; do not guess.`,
        );
      }
    }

    for (const r of input.rename_fields ?? []) {
      const from = normalizeFieldKey(r.from);
      const to = normalizeFieldKey(r.to);
      const def = defs.find((d) => d.key === from);
      if (!def) throw new UserError(`${coll.name} has no field \`${r.from}\`. Its fields: ${defs.map((d) => d.key).join(', ')}.`);
      if (!FIELD_KEY_RE.test(to)) throw new UserError(`"${r.to}" isn't a usable field key (snake_case, starting with a letter).`);
      if (from === to) continue;
      if (defs.some((d) => d.key === to)) {
        throw new UserError(`${coll.name} already has a field \`${to}\`; a rename can't merge two fields.`);
      }
      def.key = to;
      let n = 0;
      for (const row of liveAndAll()) {
        const f = fieldsOf(row);
        if (from in f && !(to in f)) {
          const next: Fields = {};
          for (const [k, v] of Object.entries(f)) next[k === from ? to : k] = v;
          rewritten.set(row.id, next);
          n++;
        }
      }
      const swap = (k: string) => (k === from ? to : k);
      if (display.list_columns) display.list_columns = display.list_columns.map(swap);
      if (display.default_sort) display.default_sort = { ...display.default_sort, by: swap(display.default_sort.by) };
      if (display.subtitle) display.subtitle = swap(display.subtitle);
      if (display.filters) display.filters = display.filters.map(swap);
      changes.push(`renamed field ${from} to ${to}${n ? ` (${n} ${n === 1 ? 'entry' : 'entries'} updated)` : ''}`);
    }

    for (const u of input.update_fields ?? []) {
      const key = normalizeFieldKey(u.key);
      const def = defs.find((d) => d.key === key);
      if (!def) throw new UserError(`${coll.name} has no field \`${u.key}\`. Its fields: ${defs.map((d) => d.key).join(', ')}.`);
      const what: string[] = [];
      if (u.label !== undefined) {
        if (u.label.trim()) def.label = u.label.trim().slice(0, 60);
        else delete def.label;
        what.push('label');
      }
      if (u.description !== undefined) {
        if (u.description.trim()) def.description = u.description.trim().slice(0, 200);
        else delete def.description;
        what.push('description');
      }
      if (u.hidden !== undefined) {
        if (u.hidden) def.hidden = true;
        else delete def.hidden;
        what.push(u.hidden ? 'hidden' : 'shown');
      }
      if (u.options !== undefined) {
        if (def.type !== 'enum') throw new UserError(`\`${key}\` is a ${def.type} field; only enum fields have options.`);
        const next = cleanOptions(u.options);
        if (next.length === 0) throw new UserError(`\`${key}\` needs at least one option.`);
        const removed = (def.options ?? []).filter((o) => !next.some((n) => enumMatches(n, o)));
        const remap = new Map(Object.entries(u.remap ?? {}).map(([k, v]) => [k, v]));
        for (const [, target] of remap) {
          if (!next.some((n) => enumMatches(n, target))) {
            throw new UserError(`remap target "${target}" isn't one of the new options for \`${key}\`: ${next.join(', ')}.`);
          }
        }
        let n = 0;
        for (const old of removed) {
          const mapping = [...remap.entries()].find(([k]) => enumMatches(k, old));
          const users = liveAndAll().filter((row) => {
            const v = fieldsOf(row)[key];
            return typeof v === 'string' && enumMatches(v, old);
          });
          if (users.length && !mapping) {
            throw new UserError(
              `${users.length} ${users.length === 1 ? 'entry uses' : 'entries use'} "${old}" for \`${key}\`. ` +
                `Pass remap: {"${old}": "<new option>"} to change them, or keep "${old}" in options.`,
            );
          }
          if (mapping) {
            const target = next.find((x) => enumMatches(x, mapping[1]))!;
            for (const row of users) {
              rewritten.set(row.id, { ...fieldsOf(row), [key]: target });
              n++;
            }
          }
        }
        def.options = next;
        what.push(`options ${next.join(' ')}${n ? ` (${n} ${n === 1 ? 'entry' : 'entries'} remapped)` : ''}`);
      }
      if (what.length) changes.push(`${key}: ${what.join(', ')}`);
    }

    if (input.display) {
      const res = normalizeDisplay(input.display, defs, display, false);
      if (JSON.stringify(res.display) !== JSON.stringify(display)) changes.push('display hints updated');
      display = res.display;
      if (res.ignored.length) extra.push(`Ignored unknown display columns: ${res.ignored.join(', ')}.`);
    } else if (input.rename_fields?.length) {
      display = normalizeDisplay(undefined, defs, display, false).display;
    }

    if (input.private !== undefined) {
      const want = input.private ? 'private' : 'shared';
      if (want !== coll.visibility) {
        if (want === 'private') {
          if (coll.created_by !== ctx.actor.userId) {
            const creator = get<{ display_name: string }>(ctx.db, 'SELECT display_name FROM users WHERE id = ?', coll.created_by);
            throw new UserError(`Only ${creator?.display_name ?? 'its creator'}, who created ${coll.name}, can make it private.`);
          }
          const reason = notSolelyMine(ctx.db, allEntryIdsIn(ctx.db, coll.id), ctx.actor.userId);
          if (reason) throw new UserError(`Can't make ${coll.name} private: ${reason}. Move those entries elsewhere first.`);
          if (slugTaken(ctx, coll.slug, 'private', coll.id)) {
            throw new UserError(`You already have a private collection with the slug "${coll.slug}".`);
          }
          changes.push('now private (only you can see it)');
        } else {
          if (slugTaken(ctx, coll.slug, 'shared', coll.id)) {
            throw new UserError(`A shared collection already uses the slug "${coll.slug}". Rename one of them first.`);
          }
          const others = otherNames(ctx.db, ctx.actor.userId);
          changes.push('now shared');
          if (others.length) extra.push(`Now visible to ${joinAnd(others)}.`);
        }
        visibility = want;
      }
    }

    if (input.checklist !== undefined && input.checklist !== (display.checklist === true)) {
      if (input.checklist) {
        defs = withDoneField(defs, coll.name);
        display.checklist = true;
        changes.push('now a checklist');
      } else {
        delete display.checklist;
        changes.push('no longer a checklist');
      }
    }

    let sensitive = coll.sensitive;
    if (input.sensitive !== undefined && (input.sensitive ? 1 : 0) !== coll.sensitive) {
      sensitive = input.sensitive ? 1 : 0;
      changes.push(sensitive ? 'now sensitive (details only shown when an entry is opened)' : 'no longer sensitive');
    }

    if (changes.length === 0) {
      throw new UserError(
        'Nothing to change. Pass name, description, icon, add_fields, update_fields, rename_fields, display, checklist or private.',
      );
    }

    const entryIds = [...rewritten.keys()];
    const beforeEntries = snapshot(ctx.db, { entries: entryIds });
    const now = nowIso();
    run(
      ctx.db,
      `UPDATE collections SET name = ?, description = ?, icon = ?, fields = ?, display = ?, visibility = ?, owner_id = ?, sensitive = ?, updated_at = ?
        WHERE id = ?`,
      name,
      description,
      icon,
      JSON.stringify(defs.map(cleanDef)),
      JSON.stringify(display),
      visibility,
      visibility === 'private' && coll.visibility !== 'private' ? ctx.actor.userId : (coll.owner_id ?? ctx.actor.userId),
      sensitive,
      now,
      coll.id,
    );
    // Sealing follows the setting: everything the collection holds is sealed, or opened again, with this change.
    if (sensitive !== coll.sensitive) fitCollection(ctx.db, coll.id);
    for (const [id, f] of rewritten) {
      const text = get<EntryText>(ctx.db, 'SELECT fields, notes, source_text FROM open_entries WHERE id = ?', id)!;
      run(
        ctx.db,
        `UPDATE entries SET ${ENTRY_TEXT_SET}, updated_by = ?, updated_at = ? WHERE id = ?`,
        ...entryText(ctx.db, sensitive, { ...text, fields: JSON.stringify(f) }),
        ctx.actor.userId,
        now,
        id,
      );
    }
    const summary = `Updated collection ${name}: ${changes.join('; ')}.`;
    const activityId = recordActivity(ctx, {
      action: 'update_collection',
      collectionId: coll.id,
      summary,
      rawText: input.raw_text,
      before: { ...beforeSnap, ...beforeEntries },
      after: snapshot(ctx.db, { collections: [coll.id], entries: entryIds }),
    });
    return { ok: true, summary, extra, collectionId: coll.id, activityId };
  });
}

function cleanDef(d: FieldDef): FieldDef {
  const out: FieldDef = { key: d.key, type: d.type };
  if (d.label) out.label = d.label;
  if (d.options) out.options = d.options;
  if (d.description) out.description = d.description;
  if (d.hidden) out.hidden = true;
  return out;
}

/** Web app: archive or unarchive a collection (its entries go with it). */
export function setArchived(ctx: Ctx, id: number, archived: boolean): WriteResult {
  return tx(ctx.db, () => {
    const coll = getVisibleCollection(ctx, id, { includeArchived: true });
    if (Boolean(coll.archived_at) === archived) {
      throw new UserError(`${coll.name} is already ${archived ? 'archived' : 'active'}.`);
    }
    if (!archived && slugTaken(ctx, coll.slug, coll.visibility, coll.id)) {
      throw new UserError(`Another collection now uses the slug "${coll.slug}".`);
    }
    const before = snapshot(ctx.db, { collections: [id] });
    run(ctx.db, 'UPDATE collections SET archived_at = ?, updated_at = ? WHERE id = ?', archived ? nowIso() : null, nowIso(), id);
    const summary = `${archived ? 'Archived' : 'Unarchived'} collection ${coll.name}.`;
    const activityId = recordActivity(ctx, {
      action: archived ? 'archive_collection' : 'unarchive_collection',
      collectionId: id,
      summary,
      before,
      after: snapshot(ctx.db, { collections: [id] }),
    });
    return { ok: true, summary, extra: [], collectionId: id, activityId };
  });
}

/** Web app: move every entry from one collection to another (fixes "Eateries" next to "Restaurants"). */
export function moveAllEntries(ctx: Ctx, fromId: number, toId: number): WriteResult {
  return tx(ctx.db, () => {
    const from = getVisibleCollection(ctx, fromId, { includeArchived: true });
    const to = getVisibleCollection(ctx, toId);
    if (from.id === to.id) throw new UserError('Pick a different collection to move the entries to.');
    const ids = allEntryIdsIn(ctx.db, from.id);
    if (ids.length === 0) throw new UserError(`${from.name} has no entries to move.`);
    if (to.visibility === 'private' && !(from.visibility === 'private' && from.owner_id === to.owner_id)) {
      const reason = notSolelyMine(ctx.db, ids, ctx.actor.userId);
      if (reason) throw new UserError(`Can't move these into the private collection ${to.name}: ${reason}.`);
    }
    const before = snapshot(ctx.db, { entries: ids });
    const now = nowIso();
    if (from.sensitive === to.sensitive) {
      run(ctx.db, `UPDATE entries SET collection_id = ?, updated_by = ?, updated_at = ? WHERE collection_id = ?`, to.id, ctx.actor.userId, now, from.id);
    } else {
      // Each entry arrives in the form the new collection stores, and fitEntry has its logs follow. Rows that
      // were merged away go last, once the entries they went into are where they will be: fitEntry keeps one
      // whose entry is sensitive with that entry, sealed, instead of leaving it in an ordinary collection.
      const rows = all<EntryText & { id: number }>(
        ctx.db,
        'SELECT id, fields, notes, source_text FROM open_entries WHERE collection_id = ? ORDER BY merged_into_id IS NOT NULL, id',
        from.id,
      );
      for (const e of rows) {
        run(
          ctx.db,
          `UPDATE entries SET collection_id = ?, ${ENTRY_TEXT_SET}, updated_by = ?, updated_at = ? WHERE id = ?`,
          to.id,
          ...entryText(ctx.db, to.sensitive, e),
          ctx.actor.userId,
          now,
          e.id,
        );
        fitEntry(ctx.db, e.id);
      }
    }
    const live = get<{ n: number }>(
      ctx.db,
      'SELECT count(*) AS n FROM entries WHERE id IN (' + ids.map(() => '?').join(',') + ') AND deleted_at IS NULL AND merged_into_id IS NULL',
      ...ids,
    )!.n;
    const summary = `Moved ${live} ${live === 1 ? 'entry' : 'entries'} from ${from.name} to ${to.name}.`;
    const extra: string[] = [];
    if (from.visibility === 'private' && to.visibility === 'shared') {
      const others = otherNames(ctx.db, ctx.actor.userId);
      if (others.length) extra.push(`Now visible to ${joinAnd(others)}.`);
    }
    if (from.sensitive && !to.sensitive) extra.push(`No longer encrypted: ${to.name} is not a sensitive collection.`);
    const activityId = recordActivity(ctx, {
      action: 'move_all_entries',
      collectionId: to.id,
      summary,
      before,
      after: snapshot(ctx.db, { entries: ids }),
    });
    return { ok: true, summary, extra, collectionId: to.id, activityId };
  });
}
