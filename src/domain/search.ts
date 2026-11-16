import { all, get } from '../db/sqlite.ts';
import { parseCollection, resolveCollection, visibleCollections } from './collections.ts';
import type { LogView } from './entries.ts';
import { UserError } from './errors.ts';
import { FIELD_KEY_RE, nearFieldKey } from './fields.ts';
import { fmtRating, logNoun } from './format.ts';
import { dice, foldText, levenshtein, normalizeFieldKey, normalizeTag } from './normalize.ts';
import { addDays, isRealDate, zonedDayStartUtc } from './time.ts';
import type { Collection, CollectionRow, Ctx, EntryRow } from './types.ts';
import { resolvePerson } from './users.ts';

/** Snippet highlight markers (private-use characters): the web turns them into <mark>, tool output drops them. */
export const MARK_OPEN = '';
export const MARK_CLOSE = '';

const STOPWORDS = new Set(
  'a an the and or of to in on at for we i my our that this it is was with about what did have has place places'.split(' '),
);

export interface FtsTerm {
  text: string;
  phrase: boolean;
}

/** Splits user text into safe FTS terms: quoted phrases stay together, FTS syntax never passes through. */
export function ftsTerms(input: string): FtsTerm[] {
  const out: FtsTerm[] = [];
  for (const m of input.matchAll(/"([^"]+)"|([^\s"]+)/g)) {
    const isPhrase = m[1] !== undefined;
    const cleaned = (m[1] ?? m[2]).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    if (!cleaned) continue;
    out.push({ text: cleaned, phrase: isPhrase || cleaned.includes(' ') });
  }
  const meaningful = out.filter((t) => t.phrase || !STOPWORDS.has(foldText(t.text)));
  return meaningful.length ? meaningful : out;
}

export function buildFtsQuery(terms: FtsTerm[], mode: 'and' | 'or'): string {
  return terms
    .map((t, i) => {
      const q = `"${t.text}"`;
      return i === terms.length - 1 && !t.phrase && t.text.length >= 2 ? `${q}*` : q;
    })
    .join(mode === 'and' ? ' ' : ' OR ');
}

export type FieldFilterValue = string | number | boolean;

export interface EntryQuery {
  query?: string;
  collectionId?: number;
  tags?: string[];
  minRating?: number;
  maxRating?: number;
  fieldEq?: [string, FieldFilterValue][];
  loggedFrom?: string;
  loggedTo?: string;
  addedFromUtc?: string;
  addedToUtc?: string;
  addedBy?: number;
  sort?: { by: string; dir: 'asc' | 'desc' };
  limit: number;
  offset?: number;
  trash?: boolean;
}

export interface EntryHit extends EntryRow {
  coll_row: CollectionRow;
  collection: Collection;
  added_by_name: string;
  snippet: string | null;
  score: number | null;
}

function orderBy(by: string, dir: 'asc' | 'desc', hasFts: boolean, params: Record<string, unknown>): string {
  const d = dir === 'asc' ? 'ASC' : 'DESC';
  switch (by) {
    case 'relevance':
      return hasFts
        ? `score DESC, coalesce(e.last_logged_on, substr(e.created_at, 1, 10)) DESC, e.id DESC`
        : orderBy('last_logged', 'desc', false, params);
    case 'rating':
      return `e.rating IS NULL, e.rating ${d}, coalesce(e.last_logged_on, substr(e.created_at, 1, 10)) DESC, e.id DESC`;
    case 'last_logged':
    case 'last_logged_on':
      return `coalesce(e.last_logged_on, substr(e.created_at, 1, 10)) ${d}, e.id ${d}`;
    case 'first_logged_on':
      return `e.first_logged_on IS NULL, e.first_logged_on ${d}, e.id ${d}`;
    case 'added':
    case 'created_at':
      return `e.created_at ${d}, e.id ${d}`;
    case 'updated_at':
      return `e.updated_at ${d}, e.id ${d}`;
    case 'deleted_at':
      return `e.deleted_at ${d}, e.id ${d}`;
    case 'title':
      return `e.title_key ${d}, e.id`;
    case 'log_count':
      return `e.log_count ${d}, e.id DESC`;
    case 'added_by':
      return `u.display_name ${d}, e.id DESC`;
    case 'tags':
      return `e.tags = '[]', e.tags ${d}, e.id DESC`;
    default: {
      if (!FIELD_KEY_RE.test(by)) return orderBy('last_logged', 'desc', hasFts, params);
      params.sortpath = `$.${by}`;
      return `json_extract(e.fields, :sortpath) IS NULL, json_extract(e.fields, :sortpath) ${d}, e.id DESC`;
    }
  }
}

/** The one search/list query behind search_entries, the web search box, collection lists and the Trash. */
export function queryEntries(ctx: Ctx, q: EntryQuery): { hits: EntryHit[]; total: number; partial: boolean } {
  const params: Record<string, unknown> = { me: ctx.actor.userId };
  const where: string[] = [
    `c.archived_at IS NULL AND (c.visibility = 'shared' OR c.owner_id = :me)`,
    q.trash ? 'e.deleted_at IS NOT NULL AND e.merged_into_id IS NULL' : 'e.deleted_at IS NULL AND e.merged_into_id IS NULL',
  ];
  if (q.collectionId !== undefined) {
    where.push('e.collection_id = :cid');
    params.cid = q.collectionId;
  }
  q.tags?.forEach((t, i) => {
    where.push(`EXISTS (SELECT 1 FROM json_each(e.tags) jt WHERE jt.value = :tag${i})`);
    params[`tag${i}`] = t;
  });
  if (q.minRating !== undefined) {
    where.push('e.rating >= :minr');
    params.minr = q.minRating;
  }
  if (q.maxRating !== undefined) {
    where.push('e.rating <= :maxr');
    params.maxr = q.maxRating;
  }
  q.fieldEq?.forEach(([key, value], i) => {
    if (!FIELD_KEY_RE.test(key)) throw new UserError(`"${key}" isn't a field key.`);
    params[`fp${i}`] = `$.${key}`;
    if (typeof value === 'string') {
      where.push(`EXISTS (SELECT 1 FROM json_each(e.fields, :fp${i}) jf WHERE lower(CAST(jf.value AS TEXT)) = lower(:fv${i}))`);
      params[`fv${i}`] = value.trim();
    } else {
      where.push(`EXISTS (SELECT 1 FROM json_each(e.fields, :fp${i}) jf WHERE jf.value = :fv${i})`);
      params[`fv${i}`] = typeof value === 'boolean' ? (value ? 1 : 0) : value;
    }
  });
  if (q.loggedFrom || q.loggedTo) {
    const conds = ['lg.entry_id = e.id', 'lg.deleted_at IS NULL'];
    if (q.loggedFrom) {
      conds.push('lg.occurred_on >= :lf');
      params.lf = q.loggedFrom;
    }
    if (q.loggedTo) {
      conds.push('lg.occurred_on <= :lt');
      params.lt = q.loggedTo;
    }
    where.push(`EXISTS (SELECT 1 FROM entry_logs lg WHERE ${conds.join(' AND ')})`);
  }
  if (q.addedFromUtc) {
    where.push('e.created_at >= :af');
    params.af = q.addedFromUtc;
  }
  if (q.addedToUtc) {
    where.push('e.created_at < :at');
    params.at = q.addedToUtc;
  }
  if (q.addedBy !== undefined) {
    where.push('e.created_by = :ab');
    params.ab = q.addedBy;
  }

  const terms = q.query ? ftsTerms(q.query) : [];
  const useFts = terms.length > 0 && !q.trash;
  if (terms.length > 0 && q.trash) {
    where.push(`e.title_key LIKE :like`);
    params.like = `%${foldText(q.query!).replace(/[%_]/g, '')}%`;
  }
  const sort = q.sort ?? { by: useFts ? 'relevance' : 'last_logged', dir: 'desc' };
  // Sorting by one of the collection's own fields needs a parameter that only the row query uses; the count
  // query must not be handed it, or SQLite refuses the unknown name.
  const orderParams: Record<string, string | number> = {};
  const order = orderBy(sort.by, sort.dir, useFts, orderParams);
  const from = useFts
    ? 'open_fts JOIN open_entries e ON e.id = open_fts.rowid JOIN collections c ON c.id = e.collection_id JOIN users u ON u.id = e.created_by'
    : 'open_entries e JOIN collections c ON c.id = e.collection_id JOIN users u ON u.id = e.created_by';
  // Relevance uses only the matched entry itself: weighted counts of highlighted hits per column (title, tags,
  // fields, notes, logs, said). bm25() would mix in statistics from every row, including private ones the
  // viewer can't see, which a determined user could probe.
  const marks = (col: number, name: string) =>
    `min((length(highlight(open_fts, ${col}, char(57344), char(57345))) - length(open_fts.${name})) / 2, 3)`;
  const select = useFts
    ? `(10.0 * ${marks(0, 'title')} + 6.0 * ${marks(1, 'tags')} + 4.0 * ${marks(2, 'fields')} + 2.0 * ${marks(3, 'notes')}
        + 2.0 * ${marks(4, 'logs')} + 1.0 * ${marks(5, 'said')}) AS score,
       snippet(open_fts, -1, char(57344), char(57345), '…', 14) AS snippet`
    : 'NULL AS score, NULL AS snippet';

  const run = (mode: 'and' | 'or') => {
    const p = { ...params };
    const w = [...where];
    if (useFts) {
      w.push('open_fts MATCH :match');
      p.match = buildFtsQuery(terms, mode);
    }
    const whereSql = w.join(' AND ');
    const total = get<{ n: number }>(ctx.db, `SELECT count(*) AS n FROM ${from} WHERE ${whereSql}`, p)!.n;
    const rows = total
      ? all<EntryRow & { score: number | null; snippet: string | null; added_by_name: string; c_json: string }>(
          ctx.db,
          `SELECT e.*, ${select}, u.display_name AS added_by_name,
                  json_object('id', c.id, 'slug', c.slug, 'name', c.name, 'description', c.description, 'icon', c.icon,
                              'fields', c.fields, 'display', c.display, 'visibility', c.visibility, 'owner_id', c.owner_id,
                              'created_by', c.created_by, 'created_at', c.created_at, 'updated_at', c.updated_at,
                              'archived_at', c.archived_at, 'sensitive', c.sensitive) AS c_json
             FROM ${from} WHERE ${whereSql} ORDER BY ${order} LIMIT :limit OFFSET :offset`,
          { ...p, ...orderParams, limit: q.limit, offset: q.offset ?? 0 },
        )
      : [];
    return { total, rows };
  };

  let partial = false;
  let res = run('and');
  if (useFts && res.total === 0 && terms.length > 1) {
    res = run('or');
    partial = res.total > 0;
  }
  const hits: EntryHit[] = res.rows.map(({ c_json, ...row }) => {
    const coll_row = JSON.parse(c_json) as CollectionRow;
    return { ...(row as EntryRow & { score: number | null; snippet: string | null; added_by_name: string }), coll_row, collection: parseCollection(coll_row) };
  });
  return { hits, total: res.total, partial };
}

export interface SearchParams {
  query?: string;
  collection?: string | number;
  tags?: string[];
  min_rating?: number;
  max_rating?: number;
  fields?: Record<string, FieldFilterValue>;
  logged_from?: string;
  logged_to?: string;
  added_from?: string;
  added_to?: string;
  added_by?: string;
  sort?: 'relevance' | 'rating' | 'last_logged' | 'added' | 'title';
  limit?: number;
}

export interface SearchOutcome {
  hits: (EntryHit & { rangeLogs?: LogView[] })[];
  total: number;
  partial: boolean;
  description: string;
  collection?: Collection;
  hasDateRange: boolean;
  /** When nothing matched the words: saved names that look like what was asked for. */
  closest?: NameHit[];
}

function checkDate(label: string, s: string | undefined) {
  if (s !== undefined && !isRealDate(s)) throw new UserError(`${label} must be a real date as YYYY-MM-DD (got "${s}").`);
}

/** search_entries: resolves names to ids, validates filters, runs the query, and adds logs in the date range. */
export function searchEntries(ctx: Ctx, p: SearchParams): SearchOutcome {
  const hasFilter =
    Boolean(p.query?.trim()) ||
    p.collection !== undefined ||
    Boolean(p.tags?.length) ||
    p.min_rating !== undefined ||
    p.max_rating !== undefined ||
    Boolean(p.fields && Object.keys(p.fields).length) ||
    Boolean(p.logged_from || p.logged_to || p.added_from || p.added_to || p.added_by);
  if (!hasFilter) throw new UserError('Give keywords or at least one filter (collection, tags, min_rating, a date range...).');
  checkDate('logged_from', p.logged_from);
  checkDate('logged_to', p.logged_to);
  checkDate('added_from', p.added_from);
  checkDate('added_to', p.added_to);
  if (p.logged_from && p.logged_to && p.logged_from > p.logged_to) throw new UserError('logged_from is after logged_to.');
  if (p.added_from && p.added_to && p.added_from > p.added_to) throw new UserError('added_from is after added_to.');
  if (p.min_rating !== undefined && p.max_rating !== undefined && p.min_rating > p.max_rating) {
    throw new UserError('min_rating is higher than max_rating.');
  }

  const coll = p.collection !== undefined && p.collection !== '' ? resolveCollection(ctx, p.collection) : undefined;
  const tags = (p.tags ?? []).map(normalizeTag).filter(Boolean);
  const fieldEq: [string, FieldFilterValue][] = [];
  if (p.fields) {
    const pool = coll ? [coll] : visibleCollections(ctx);
    const defs = pool.flatMap((c) => c.fields);
    for (const [raw, value] of Object.entries(p.fields)) {
      const key = normalizeFieldKey(raw);
      if (!defs.some((d) => d.key === key)) {
        const used = get<{ n: number }>(
          ctx.db,
          `SELECT count(*) AS n FROM open_entries e JOIN collections c ON c.id = e.collection_id
            WHERE (c.visibility = 'shared' OR c.owner_id = ?) AND json_type(e.fields, ?) IS NOT NULL ${coll ? 'AND e.collection_id = ?' : ''}`,
          ...(coll ? [ctx.actor.userId, `$.${key}`, coll.id] : [ctx.actor.userId, `$.${key}`]),
        )!.n;
        if (!used) {
          const near = nearFieldKey(key, defs);
          throw new UserError(
            `${coll ? `${coll.name} has` : 'There is'} no field \`${raw}\`.` +
              (near ? ` Did you mean \`${near}\`?` : '') +
              ` Fields: ${[...new Set(defs.map((d) => d.key))].join(', ') || '(none)'}.`,
          );
        }
      }
      fieldEq.push([key, value]);
    }
  }
  const person = p.added_by ? resolvePerson(ctx.db, p.added_by, ctx.actor.userId) : undefined;
  const limit = Math.min(Math.max(p.limit ?? 10, 1), 50);
  const sortBy = p.sort ?? (p.query?.trim() ? 'relevance' : 'last_logged');
  const dir = sortBy === 'title' ? 'asc' : 'desc';
  const { hits, total, partial } = queryEntries(ctx, {
    query: p.query,
    collectionId: coll?.id,
    tags,
    minRating: p.min_rating,
    maxRating: p.max_rating,
    fieldEq,
    loggedFrom: p.logged_from,
    loggedTo: p.logged_to,
    addedFromUtc: p.added_from ? zonedDayStartUtc(p.added_from, ctx.tz) : undefined,
    addedToUtc: p.added_to ? zonedDayStartUtc(addDays(p.added_to, 1), ctx.tz) : undefined,
    addedBy: person?.id,
    sort: { by: sortBy, dir },
    limit,
  });

  const hasDateRange = Boolean(p.logged_from || p.logged_to);
  const out: SearchOutcome['hits'] = hits;
  if (hasDateRange) {
    for (const h of out) {
      h.rangeLogs = all<LogView>(
        ctx.db,
        `SELECT l.*, u.display_name AS user_name FROM open_logs l JOIN users u ON u.id = l.created_by
          WHERE l.entry_id = ? AND l.deleted_at IS NULL AND l.occurred_on >= ? AND l.occurred_on <= ?
          ORDER BY l.occurred_on DESC, l.id DESC LIMIT 3`,
        h.id,
        p.logged_from ?? '0000-01-01',
        p.logged_to ?? '9999-12-31',
      );
    }
  }

  const noun = coll ? logNoun(coll) : 'log';
  const bits: string[] = [];
  if (p.query?.trim()) bits.push(`for "${p.query.trim()}"`);
  if (coll) bits.push(`in ${coll.name}`);
  if (tags.length) bits.push(`tagged ${tags.join(', ')}`);
  if (p.min_rating !== undefined && p.max_rating !== undefined) bits.push(`rated ${fmtRating(p.min_rating)} to ${fmtRating(p.max_rating)}`);
  else if (p.min_rating !== undefined) bits.push(`rated ${fmtRating(p.min_rating)} or higher`);
  else if (p.max_rating !== undefined) bits.push(`rated ${fmtRating(p.max_rating)} or lower`);
  for (const [k, v] of fieldEq) bits.push(`with ${k} ${String(v)}`);
  if (p.logged_from && p.logged_to) bits.push(`with ${noun === 'log' ? 'a log' : `a ${noun}`} between ${p.logged_from} and ${p.logged_to}`);
  else if (p.logged_from) bits.push(`with ${noun === 'log' ? 'a log' : `a ${noun}`} on or after ${p.logged_from}`);
  else if (p.logged_to) bits.push(`with ${noun === 'log' ? 'a log' : `a ${noun}`} on or before ${p.logged_to}`);
  if (p.added_from && p.added_to) bits.push(`added between ${p.added_from} and ${p.added_to}`);
  else if (p.added_from) bits.push(`added on or after ${p.added_from}`);
  else if (p.added_to) bits.push(`added on or before ${p.added_to}`);
  if (person) bits.push(`added by ${person.display_name}`);
  const description = bits.join(' ');
  const near = total === 0 && p.query?.trim() ? closestTitles(ctx, p.query) : [];
  return { hits: out, total, partial, description, collection: coll, hasDateRange, ...(near.length ? { closest: near } : {}) };
}

/** An entry by name only: enough to point at it without showing anything from inside it. */
export interface NameHit {
  id: number;
  title: string;
  collection: string;
  icon: string | null;
}

const words = (s: string) => foldText(s).replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);

/** Every live entry the person can see, by name. The visibility rule is the one queryEntries uses. */
function visibleNames(ctx: Ctx): (NameHit & { tags: string })[] {
  return all<NameHit & { tags: string }>(
    ctx.db,
    `SELECT e.id, e.title, e.tags, c.name AS collection, c.icon FROM entries e JOIN collections c ON c.id = e.collection_id
      WHERE c.archived_at IS NULL AND (c.visibility = 'shared' OR c.owner_id = ?) AND e.deleted_at IS NULL AND e.merged_into_id IS NULL`,
    ctx.actor.userId,
  );
}

/** How alike two words are, 0 to 1: the same, a slip of a letter or two, or sharing most of their letters. */
function wordLikeness(a: string, b: string): number {
  if (a === b) return 1;
  if (Math.min(a.length, b.length) >= 4 && (b.startsWith(a) || a.startsWith(b))) return 0.85;
  const slips = levenshtein(a, b);
  if (slips === 1 && Math.min(a.length, b.length) >= 4) return 0.85;
  if (slips === 2 && Math.min(a.length, b.length) >= 7) return 0.75;
  return dice(a, b);
}

/**
 * For a search that found nothing: the saved names closest to what was typed or dictated ("fo 54", "Dr Nguyn").
 * Names and tags only are compared, so nothing is learned about an entry beyond its title.
 */
export function closestTitles(ctx: Ctx, query: string, limit = 5): NameHit[] {
  const asked = words(query).filter((w) => w.length >= 2 && !STOPWORDS.has(w));
  if (asked.length === 0) return [];
  const scored: { hit: NameHit; score: number }[] = [];
  for (const { tags, ...hit } of visibleNames(ctx)) {
    const name = words(hit.title);
    const have = [...name, ...words((JSON.parse(tags) as string[]).join(' '))];
    if (have.length === 0) continue;
    const perWord = asked.map((w) => Math.max(...have.map((h) => wordLikeness(w, h))));
    const each = perWord.reduce((a, b) => a + b, 0) / perWord.length;
    const whole = dice(asked.join(' '), name.join(' '));
    const score = Math.max(each, whole);
    if (score >= 0.6) scored.push({ hit, score });
  }
  return scored.sort((a, b) => b.score - a.score || a.hit.title.localeCompare(b.hit.title)).slice(0, limit).map((s) => s.hit);
}

/** A name only links entries when it is distinctive: two words, or one of six letters or more. */
function distinctive(name: string[]): boolean {
  return name.length >= 2 || (name.length === 1 && name[0].length >= 6);
}

/**
 * Entries tied to this one by name, with no links to keep up: those that mention its title anywhere (fields,
 * notes, logs, what was said), and those whose titles it mentions in its own fields, notes and original words.
 * Only what the person can see, and only names: a pet and its vet, a car and its insurance card.
 */
export function relatedEntries(ctx: Ctx, entry: Pick<EntryRow, 'id' | 'title' | 'fields' | 'notes' | 'source_text'>, limit = 5): NameHit[] {
  const found = new Map<number, NameHit>();
  const mine = words(entry.title);
  if (distinctive(mine)) {
    for (const h of queryEntries(ctx, { query: `"${mine.join(' ')}"`, limit: limit + 1 }).hits) {
      if (h.id !== entry.id) found.set(h.id, { id: h.id, title: h.title, collection: h.collection.name, icon: h.collection.icon });
    }
  }
  let values = '';
  try {
    values = Object.values(JSON.parse(entry.fields) as Record<string, unknown>).flat().join(' ');
  } catch {
    // fields that cannot be read mention nothing
  }
  const text = ` ${words(`${values} ${entry.notes} ${entry.source_text ?? ''}`).join(' ')} `;
  for (const { tags: _tags, ...other } of visibleNames(ctx)) {
    if (other.id === entry.id || found.has(other.id)) continue;
    const name = words(other.title);
    if (distinctive(name) && text.includes(` ${name.join(' ')} `)) found.set(other.id, other);
  }
  return [...found.values()].slice(0, limit);
}

/**
 * For a search that found nothing: collections whose name or description speaks of what was asked for.
 * "doctor" finds nothing when the doctor is saved under a name, but Health says it holds doctors.
 */
export function likelyCollections(ctx: Ctx, query: string, limit = 3): Collection[] {
  const asked = words(query).filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  if (asked.length === 0) return [];
  return visibleCollections(ctx)
    .map((c) => {
      const have = words(`${c.name} ${c.description}`);
      return { c, score: Math.max(...asked.map((w) => Math.max(0, ...have.map((h) => wordLikeness(w, h))))) };
    })
    .filter((x) => x.score >= 0.85)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.c);
}
