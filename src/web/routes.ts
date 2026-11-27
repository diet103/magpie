import { Hono, type Context } from 'hono';
import { csrf } from 'hono/csrf';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { html } from 'hono/html';
import { stream } from 'hono/streaming';
import { requireCsrf, requireUser, safeReturnTo } from '../auth/session.ts';
import { clientDisplayName } from '../auth/cimd.ts';
import { sha256 } from '../auth/crypto.ts';
import { RateLimiter, rateLimit } from '../auth/ratelimit.ts';
import { all, get } from '../db/sqlite.ts';
import { listActivity } from '../domain/activity.ts';
import {
  collectionsOverview,
  createCollection,
  getVisibleCollection,
  moveAllEntries,
  setArchived,
  updateCollection,
  visibleCollections,
  type UpdateCollectionInput,
  type UpdateFieldInput,
} from '../domain/collections.ts';
import { ask, webResearchState, type Upload } from '../assistant/chat.ts';
import { CHAT_IDLE_MS, addMessage, attachmentsOf, clearChat, contextTurns, finishReply, parseLinks, parseSources, recentMessages, type ChatRow } from '../assistant/history.ts';
import { findDuplicates } from '../domain/dedupe.ts';
import { deleteAttachment, getAttachment, readAttachment, readPreview, saveAttachment, savePreview, type FileStore } from '../domain/files.ts';
import {
  addChecklistItems,
  addLog,
  createEntry,
  deleteItem,
  getEntryDetail,
  mergeEntries,
  purgeEntry,
  resolveEntry,
  resolveLog,
  restoreEntry,
  updateEntry,
  updateLog,
  type UpdateEntryInput,
} from '../domain/entries.ts';
import { NotFoundError, UserError } from '../domain/errors.ts';
import { logNoun } from '../domain/format.ts';
import { normalizeTag } from '../domain/normalize.ts';
import { isCollectionPinned, isPinned, listPinned, pinnedCollectionIds, setCollectionPinned, setPinned } from '../domain/pins.ts';
import { notSolelyMine, allEntryIdsIn } from '../domain/privacy.ts';
import { otherNames } from '../domain/users.ts';
import { applyFill, entriesMissing, missingCounts } from '../domain/fill.ts';
import { checklistItems, checklistStamp, clearDone, isChecklist, leftToDo, setDone } from '../domain/checklist.ts';
import { readValues } from '../assistant/fill.ts';
import { closestTitles, likelyCollections, queryEntries, relatedEntries, type FieldFilterValue } from '../domain/search.ts';
import { recentSlowLoads, recordSlowLoad } from '../domain/slowloads.ts';
import { tagCounts } from '../domain/tags.ts';
import { hiddenDates, homeDates, setDateHidden } from '../domain/upcoming.ts';
import { localDateOf, todayIn } from '../domain/time.ts';
import type { Collection, Ctx, Display, Refusal, WriteResult } from '../domain/types.ts';
import { undoActivity } from '../domain/undo.ts';
import { errorFields, log } from '../log.ts';
import { formatEntry } from '../mcp/format.ts';
import { SERVER_VERSION } from '../mcp/server.ts';
import type { AppDeps, AppEnv } from '../types.ts';
import { askPage, chatMessage, type ChatView, type Suggestion } from './chat.ts';
import { exportJson, exportSqlite, exportZip } from './export.ts';
import { layout, messagePage, type Html } from './layout.ts';
import { bulletItems } from './markdown.ts';
import * as v from './views.ts';

type C = Context<AppEnv>;
interface Flash {
  msg: string;
  error?: boolean;
  undo?: number;
}

export function webRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const cfg = deps.config;
  app.use('*', requireUser(deps));
  const perSession = new RateLimiter(600);
  app.use('*', rateLimit(perSession, (c) => `web:${sha256((c as C).get('sessionId'))}`));
  app.use('*', csrf({ origin: cfg.publicUrl }));
  app.use('*', requireCsrf());

  const ctxOf = (c: C): Ctx => {
    const u = c.get('user');
    return { db: deps.db, tz: cfg.tz, actor: { userId: u.id, name: u.display_name, via: 'web', client: 'web' } };
  };
  const csrfOf = (c: C) => c.get('session').csrf_secret;
  // Pages the phone's service worker may keep a copy of, so they open at once and without a connection: Home, a
  // collection, an entry, search and Activity. Never a page showing a one-time message (it would show again), and
  // never a form (a kept form would offer old values).
  const KEEPABLE = /^\/(c\/\d+(-[a-z0-9-]*)?|e\/\d+|search|activity)?$/;
  const page = (c: C, title: string, body: Html, active?: 'home' | 'activity' | 'trash' | 'settings' | 'ask', status: 200 | 400 | 404 = 200) => {
    c.header('Cache-Control', 'private, no-store');
    if (status === 200 && c.req.method === 'GET' && !c.get('flashed') && KEEPABLE.test(c.req.path)) c.header('X-Magpie-Keep', '1');
    return c.html(layout({ title, body, userName: c.get('user').display_name, userId: c.get('user').id, csrf: csrfOf(c), active }), status);
  };
  // The two short-lived cookies that change what a page does carry the __Host- prefix over https, so a page on a
  // neighbouring address (another subdomain of a shared parent) cannot plant one.
  const secure = cfg.publicUrl.startsWith('https://');
  const FLASH = secure ? '__Host-tracker_flash' : 'tracker_flash';
  const FIND = secure ? '__Host-tracker_find' : 'tracker_find';
  const setFlash = (c: C, f: Flash) => {
    setCookie(c, FLASH, JSON.stringify(f).slice(0, 1500), { path: '/', httpOnly: true, sameSite: 'Lax', maxAge: 60, secure });
  };
  const takeFlash = (c: C): Html | string => {
    const raw = getCookie(c, FLASH);
    if (!raw) return '';
    c.set('flashed', true);
    deleteCookie(c, FLASH, { path: '/', secure });
    try {
      return v.flashBox(JSON.parse(raw) as Flash, csrfOf(c), c.req.path);
    } catch {
      return '';
    }
  };
  const done = (c: C, r: WriteResult, to: string) => {
    setFlash(c, { msg: r.summary.replace(/\s*\((#\d+(, log \d+)?)\)\s*$/, ''), undo: r.activityId });
    return c.redirect(to, 303);
  };
  const failed = (c: C, err: unknown, to: string) => {
    if (!(err instanceof UserError)) throw err;
    setFlash(c, { msg: err.message, error: true });
    return c.redirect(to, 303);
  };
  const idParam = (c: C, name = 'id') => {
    const n = Number.parseInt(c.req.param(name) ?? '', 10);
    if (!Number.isInteger(n) || n <= 0) throw new NotFoundError('Not found.');
    return n;
  };
  const str = (x: unknown) => (typeof x === 'string' ? x : '');
  const list = (x: unknown): string[] => (Array.isArray(x) ? x.map(str) : typeof x === 'string' ? [x] : []);
  const ratingOf = (x: unknown): number | null => (str(x) === '' ? null : Number(str(x)));

  app.onError((err, c) => {
    if (err instanceof NotFoundError) return c.html(messagePage('Not found', err.message), 404);
    throw err;
  });

  // ---- home and search --------------------------------------------------------------------------
  app.get('/', (c) => {
    const ctx = ctxOf(c);
    // A person's pinned collections come first. The sort is stable, so each group stays in name order.
    const pinnedCollections = pinnedCollectionIds(ctx);
    const overview = collectionsOverview(ctx).sort((a, b) => Number(pinnedCollections.has(b.collection.id)) - Number(pinnedCollections.has(a.collection.id)));
    const lastActive = new Map<number, string>();
    for (const r of all<{ cid: number; logged: string | null; added: string }>(
      deps.db,
      `SELECT collection_id AS cid, max(last_logged_on) AS logged, max(created_at) AS added FROM entries
        WHERE deleted_at IS NULL AND merged_into_id IS NULL GROUP BY collection_id`,
    )) {
      const added = localDateOf(r.added, cfg.tz);
      lastActive.set(r.cid, r.logged && r.logged > added ? r.logged : added);
    }
    const needsDetails = queryEntries(ctx, { tags: ['needs-details'], limit: 10 }).hits;
    const recent = listActivity(ctx, { limit: 40 }).filter((a) => a.via === 'mcp').slice(0, 10);
    const { shown: upcoming, hiddenCount } = homeDates(ctx, todayIn(cfg.tz));
    const left = leftToDo(ctx, overview.map((o) => o.collection));
    return page(
      c,
      'Home',
      v.homePage({ overview, pinnedCollections, lastActive, left, needsDetails, pinned: listPinned(ctx), upcoming, hiddenCount, recent, mcpUrl: cfg.mcpUrl, askOn: Boolean(cfg.assistant.apiKey), csrf: csrfOf(c), tz: cfg.tz, flash: takeFlash(c) }),
      'home',
    );
  });

  // Dates a person has hidden from their own "Coming up". A page with buttons, so the phone does not keep it.
  app.get('/coming-up', (c) => page(c, 'Hidden dates', v.hiddenDatesPage({ items: hiddenDates(ctxOf(c), todayIn(cfg.tz)), csrf: csrfOf(c), flash: takeFlash(c) }), 'home'));

  app.post('/coming-up/hide', async (c) => {
    const b = await c.req.parseBody();
    const hidden = b.hidden !== '0';
    // Hiding happens on Home; showing again happens on the list of hidden dates.
    const back = hidden ? '/' : '/coming-up';
    try {
      const entryId = Number.parseInt(str(b.entry), 10);
      if (!Number.isInteger(entryId) || entryId <= 0) throw new UserError('That date could not be found.');
      setDateHidden(ctxOf(c), { entryId, field: str(b.field), date: str(b.date) }, hidden, todayIn(cfg.tz));
      setFlash(c, { msg: hidden ? 'Hidden from Coming up.' : 'Back in Coming up.' });
      return c.redirect(back, 303);
    } catch (err) {
      return failed(c, err, back);
    }
  });

  app.post('/collections', async (c) => {
    const b = await c.req.parseBody();
    try {
      const r = createCollection(ctxOf(c), { name: str(b.name), description: str(b.description), private: b.private === '1', sensitive: b.sensitive === '1', checklist: b.checklist === '1', confirm_new: true, fields: [] });
      if (!r.ok) throw new UserError(r.text);
      return done(c, r, b.checklist === '1' ? `/c/${r.collectionId}` : `/c/${r.collectionId}/settings`);
    } catch (err) {
      return failed(c, err, '/');
    }
  });

  app.get('/search', (c) => {
    const q = c.req.query('q') ?? '';
    const ctx = ctxOf(c);
    const live = Boolean(c.req.header('hx-request'));
    const res = q.trim() ? queryEntries(ctx, { query: q, limit: live ? 8 : 50 }) : { hits: [], total: 0, partial: false };
    c.header('Cache-Control', 'private, no-store');
    // Nothing found: offer the saved names nearest to what was typed, and the chat for anything looser.
    const empty = Boolean(q.trim()) && res.total === 0;
    const closest = empty ? closestTitles(ctx, q) : [];
    const places = empty ? likelyCollections(ctx, q) : [];
    if (live) return c.html(v.liveResults({ hits: res.hits, total: res.total, q, tz: cfg.tz, closest }));
    return page(c, q ? `Search: ${q}` : 'Search', v.searchPage({ q, hits: res.hits, total: res.total, partial: res.partial, tz: cfg.tz, closest, places, canAsk: Boolean(cfg.assistant.apiKey), csrf: csrfOf(c) }));
  });

  // ---- collections ----------------------------------------------------------------------------------
  const collectionView = (c: C, dupNotice?: Html) => {
    const ctx = ctxOf(c);
    const coll = getVisibleCollection(ctx, idParam(c));
    const pinned = isCollectionPinned(ctx, coll.id);
    if (isChecklist(coll)) return page(c, coll.name, v.checklistPage({ c: coll, pinned, items: checklistItems(ctx, coll.id), stamp: checklistStamp(ctx, coll.id), csrf: csrfOf(c), flash: takeFlash(c) }));
    const q = c.req.query();
    const query: Record<string, string> = {};
    for (const [k, val] of Object.entries(q)) if (['q', 'sort', 'dir', 'min', 'tag'].includes(k) || k.startsWith('f.')) if (val) query[k] = val;
    const fieldEq: [string, FieldFilterValue][] = [];
    for (const [k, val] of Object.entries(query)) {
      if (!k.startsWith('f.')) continue;
      const key = k.slice(2);
      const def = coll.fields.find((f) => f.key === key);
      if (!def) continue;
      fieldEq.push([key, def.type === 'boolean' ? val === 'yes' : val]);
    }
    const offset = Math.max(0, Number(q.offset ?? 0) || 0);
    const limit = 30;
    const sortBy = query.sort ?? coll.display.default_sort?.by ?? 'last_logged_on';
    const dir = (query.dir ?? coll.display.default_sort?.dir ?? (sortBy === 'title' ? 'asc' : 'desc')) === 'asc' ? 'asc' : 'desc';
    const res = queryEntries(ctx, {
      query: query.q,
      collectionId: coll.id,
      tags: query.tag ? [normalizeTag(query.tag)] : [],
      minRating: query.min ? Number(query.min) : undefined,
      fieldEq,
      sort: { by: sortBy, dir },
      limit,
      offset,
    });
    const nextOffset = offset + res.hits.length < res.total ? offset + res.hits.length : null;
    return page(
      c,
      coll.name,
      v.collectionPage({ c: coll, pinned, hits: res.hits, total: res.total, nextOffset, query, tags: tagCounts(ctx, coll.id), csrf: csrfOf(c), tz: cfg.tz, flash: takeFlash(c), dupNotice }),
    );
  };
  app.get('/c/:id', (c) => collectionView(c));

  app.post('/c/:id/pin', async (c) => {
    const id = idParam(c);
    const b = await c.req.parseBody();
    try {
      const r = setCollectionPinned(ctxOf(c), id, b.pinned === '1');
      setFlash(c, { msg: r.pinned ? 'Pinned to the top of Home.' : 'Unpinned.' });
      return c.redirect(`/c/${r.collectionId}`, 303);
    } catch (err) {
      return failed(c, err, `/c/${id}`);
    }
  });

  app.post('/c/:id/entries', async (c) => {
    const ctx = ctxOf(c);
    const coll = getVisibleCollection(ctx, idParam(c));
    const b = await c.req.parseBody();
    const ids = str(b.not_duplicate_of).split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
    const form = { title: str(b.title), rating: str(b.rating), notes: str(b.notes) };
    if (isChecklist(coll)) {
      let note = '';
      let error = false;
      try {
        const added = createEntry(ctx, { collection: String(coll.id), title: form.title });
        if (!added.ok) throw new UserError(added.text);
        if (added.replay || added.summary.includes('is back on')) note = added.summary.replace(/\s*\(#\d+\)$/, '');
      } catch (err) {
        if (!(err instanceof UserError)) throw err;
        note = err.message;
        error = true;
      }
      return checklistReply(c, coll, { note, error, focus: true });
    }
    let r: WriteResult | Refusal;
    try {
      r = createEntry(ctx, { collection: String(coll.id), title: form.title, rating: ratingOf(b.rating) ?? undefined, notes: form.notes || undefined, not_duplicate_of: ids });
    } catch (err) {
      return failed(c, err, v.collUrl(coll));
    }
    if (!r.ok) {
      const candidateIds = r.candidates?.map((x) => x.id) ?? [];
      return collectionView(c, v.dupNoticeHtml(r.text, { ...form, ids: candidateIds }, `${v.collUrl(coll)}/entries`, csrfOf(c)));
    }
    return done(c, r, v.entryUrl(r.entryId!));
  });

  // A tick or a new item changes the list in place when the page's script asks (htmx), and is an ordinary form
  // post followed by the page when it does not.
  const checklistReply = (c: C, coll: Collection, o: { note?: string; error?: boolean; focus?: boolean } = {}) => {
    if (!c.req.header('hx-request')) {
      if (o.note) setFlash(c, { msg: o.note, error: o.error });
      return c.redirect(v.collUrl(coll), 303);
    }
    c.header('Cache-Control', 'private, no-store');
    const part = { c: coll, items: checklistItems(ctxOf(c), coll.id), stamp: checklistStamp(ctxOf(c), coll.id), csrf: csrfOf(c) };
    // A tick asks for the lists alone; adding asks for the add box too, cleared and ready for the next name.
    if (c.req.header('hx-target') === 'checklist-items' && !o.note) return c.html(v.checklistItemsPart(part));
    return c.html(v.checklistBody({ ...part, ...o }));
  };
  // How the other phone keeps up: the page asks for the stamp every few seconds and, when it has changed,
  // for the lists. Both are cheap, and neither is a page the phone keeps.
  app.get('/c/:id/stamp', (c) => {
    c.header('Cache-Control', 'private, no-store');
    return c.text(checklistStamp(ctxOf(c), idParam(c)));
  });
  app.get('/c/:id/items', (c) => {
    const ctx = ctxOf(c);
    const coll = getVisibleCollection(ctx, idParam(c));
    if (!isChecklist(coll)) throw new NotFoundError('Not a checklist.');
    c.header('Cache-Control', 'private, no-store');
    return c.html(v.checklistItemsPart({ c: coll, items: checklistItems(ctx, coll.id), stamp: checklistStamp(ctx, coll.id), csrf: csrfOf(c) }));
  });
  app.post('/e/:id/tick', async (c) => {
    const ctx = ctxOf(c);
    const { collection: coll } = resolveEntry(ctx, idParam(c), { follow: false });
    const b = await c.req.parseBody();
    try {
      setDone(ctx, idParam(c), b.done === '1');
      return checklistReply(c, coll);
    } catch (err) {
      if (!(err instanceof UserError)) throw err;
      return checklistReply(c, coll, { note: err.message, error: true });
    }
  });
  app.post('/c/:id/clear-ticked', (c) => {
    const ctx = ctxOf(c);
    const coll = getVisibleCollection(ctx, idParam(c));
    try {
      return done(c, clearDone(ctx, coll.id), v.collUrl(coll));
    } catch (err) {
      return failed(c, err, v.collUrl(coll));
    }
  });

  app.get('/c/:id/settings', (c) => {
    const ctx = ctxOf(c);
    const coll = getVisibleCollection(ctx, idParam(c), { includeArchived: true });
    const others = visibleCollections(ctx).filter((x) => x.id !== coll.id);
    let privateBlock = '';
    if (coll.created_by !== ctx.actor.userId) {
      const creator = get<{ display_name: string }>(deps.db, 'SELECT display_name FROM users WHERE id = ?', coll.created_by);
      privateBlock = `only ${creator?.display_name ?? 'the person who created it'}, who created it, can do that.`;
    } else {
      const reason = notSolelyMine(deps.db, allEntryIdsIn(deps.db, coll.id), ctx.actor.userId);
      if (reason) privateBlock = `${reason}. Move those entries elsewhere first.`;
    }
    return page(c, `${coll.name} settings`, v.collectionSettingsPage({ c: coll, privateBlock, household: otherNames(deps.db, ctx.actor.userId), missing: missingCounts(ctx, coll), canFill: Boolean(cfg.assistant.apiKey), others, csrf: csrfOf(c), flash: takeFlash(c) }));
  });

  app.post('/c/:id/settings', async (c) => {
    const ctx = ctxOf(c);
    const coll = getVisibleCollection(ctx, idParam(c), { includeArchived: true });
    const back = `${v.collUrl(coll)}/settings`;
    const b = await c.req.parseBody({ all: true });
    const input: UpdateCollectionInput = { collection: String(coll.id) };
    if (str(b.name).trim() && str(b.name).trim() !== coll.name) input.name = str(b.name);
    if (str(b.description).trim() && str(b.description).trim() !== coll.description) input.description = str(b.description);
    if (str(b.icon).trim() !== (coll.icon ?? '')) input.icon = str(b.icon);
    const wantPrivate = b.private === '1';
    if (wantPrivate !== (coll.visibility === 'private')) input.private = wantPrivate;
    if ((b.sensitive === '1') !== (coll.sensitive === 1)) input.sensitive = b.sensitive === '1';
    if ((b.checklist === '1') !== isChecklist(coll)) input.checklist = b.checklist === '1';
    const renames: { from: string; to: string }[] = [];
    const updates: UpdateFieldInput[] = [];
    coll.fields.forEach((f, i) => {
      if (str(b[`field.${i}.key`]) !== f.key) return;
      const to = str(b[`field.${i}.rename`]).trim();
      const key = to && to !== f.key ? to : f.key;
      if (key !== f.key) renames.push({ from: f.key, to: key });
      const u: UpdateFieldInput = { key };
      const label = str(b[`field.${i}.label`]).trim();
      if (label !== (f.label ?? '')) u.label = label;
      const description = str(b[`field.${i}.description`]).trim();
      if (description !== (f.description ?? '')) u.description = description;
      const hidden = b[`field.${i}.hidden`] === '1';
      if (hidden !== Boolean(f.hidden)) u.hidden = hidden;
      if (f.type === 'enum') {
        const options = str(b[`field.${i}.options`]).split(',').map((s) => s.trim()).filter(Boolean);
        if (options.join('\u0000') !== (f.options ?? []).join('\u0000')) {
          u.options = options;
          const remap: Record<string, string> = {};
          for (const pair of str(b[`field.${i}.remap`]).split(',')) {
            const [from, target] = pair.split('=').map((s) => s?.trim());
            if (from && target) remap[from] = target;
          }
          if (Object.keys(remap).length) u.remap = remap;
        }
      }
      if (Object.keys(u).length > 1) updates.push(u);
    });
    if (renames.length) input.rename_fields = renames;
    if (updates.length) input.update_fields = updates;
    const newKey = str(b['new.key']).trim();
    if (newKey) {
      input.add_fields = [{ key: newKey, type: str(b['new.type']) || 'text', options: str(b['new.options']).split(',').map((s) => s.trim()).filter(Boolean) }];
    }
    const display: Display = {
      list_columns: list(b['display.columns']).slice(0, 6),
      default_sort: { by: str(b['display.sort']) || 'last_logged_on', dir: str(b['display.dir']) === 'asc' ? 'asc' : 'desc' },
      subtitle: str(b['display.subtitle']) || undefined,
      log_noun: str(b['display.log_noun']).trim(),
      filters: list(b['display.filters']).slice(0, 4),
    };
    const current = JSON.stringify({ ...coll.display, log_noun: coll.display.log_noun ?? '', subtitle: coll.display.subtitle, filters: coll.display.filters ?? [], list_columns: coll.display.list_columns ?? [] });
    if (JSON.stringify({ ...coll.display, ...display }) !== current) input.display = display;
    try {
      const r = updateCollection(ctx, input);
      // A new field starts empty everywhere; say where the button that fills it is.
      if (input.add_fields && cfg.assistant.apiKey && r.extra.some((x) => x.includes('no value for'))) {
        setFlash(c, { msg: `${r.summary} To fill it in from what you already said, use the button under the field.`, undo: r.activityId });
        return c.redirect(back, 303);
      }
      return done(c, r, back);
    } catch (err) {
      if (err instanceof UserError && err.message.startsWith('Nothing to change')) {
        setFlash(c, { msg: 'No changes.' });
        return c.redirect(back, 303);
      }
      return failed(c, err, back);
    }
  });

  app.post('/c/:id/move-all', async (c) => {
    const ctx = ctxOf(c);
    const coll = getVisibleCollection(ctx, idParam(c), { includeArchived: true });
    const b = await c.req.parseBody();
    try {
      const r = moveAllEntries(ctx, coll.id, Number(str(b.to)));
      return done(c, r, `/c/${r.collectionId}`);
    } catch (err) {
      return failed(c, err, `${v.collUrl(coll)}/settings`);
    }
  });

  app.post('/c/:id/archive', async (c) => {
    const ctx = ctxOf(c);
    const id = idParam(c);
    const b = await c.req.parseBody();
    try {
      const r = setArchived(ctx, id, b.archived === '1');
      return done(c, r, b.archived === '1' ? '/' : `/c/${id}`);
    } catch (err) {
      return failed(c, err, `/c/${id}/settings`);
    }
  });

  // ---- entries ----------------------------------------------------------------------------------
  app.get('/e/:id', (c) => {
    const ctx = ctxOf(c);
    const before = c.req.query('before');
    const d = getEntryDetail(ctx, idParam(c), { allowDeleted: true, beforeLogId: before ? Number(before) : undefined });
    if (d.entry.id !== idParam(c)) return c.redirect(v.entryUrl(d.entry.id), 302);
    const history = listActivity(ctx, { entryId: d.entry.id, limit: 20 });
    return page(
      c,
      d.entry.title,
      v.entryPage({ d, history, related: d.entry.deleted_at ? [] : relatedEntries(ctx, d.entry), listable: listedThings(d).length > 0 && listsFor(ctx, d).length > 0, pinned: isPinned(ctx, d.entry.id), canRead: Boolean(cfg.assistant.apiKey), csrf: csrfOf(c), tz: cfg.tz, today: todayIn(cfg.tz), flash: takeFlash(c) }),
    );
  });

  // "Add to a list" on an entry that lists things (a recipe's ingredients): pick which ones go onto which checklist.
  const listedThings = (d: ReturnType<typeof getEntryDetail>): string[] => {
    const named = d.collection.fields.find((f) => f.type === 'list' && /ingredient|shopping|packing|items/i.test(`${f.key} ${f.label ?? ''}`));
    const fromField = named ? d.fields[named.key] : undefined;
    if (Array.isArray(fromField) && fromField.length) return fromField.map(String);
    const lines = bulletItems(d.entry.notes ?? '', /ingredient|shopping|what you need|to buy|packing/i);
    return lines.length >= 2 ? lines.slice(0, 100) : [];
  };
  const listsFor = (ctx: Ctx, d: ReturnType<typeof getEntryDetail>) => visibleCollections(ctx).filter((x) => isChecklist(x) && x.id !== d.collection.id);
  app.get('/e/:id/to-list', (c) => {
    const ctx = ctxOf(c);
    const d = getEntryDetail(ctx, idParam(c));
    const things = listedThings(d);
    const lists = listsFor(ctx, d);
    if (things.length === 0 || lists.length === 0) throw new NotFoundError('Nothing here to put on a list.');
    return page(c, 'Add to a list', v.toListPage({ d, items: things.map((name) => ({ name, on: true })), lists, csrf: csrfOf(c), flash: takeFlash(c) }));
  });
  app.post('/e/:id/to-list', async (c) => {
    const ctx = ctxOf(c);
    const d = getEntryDetail(ctx, idParam(c));
    const b = await c.req.parseBody({ all: true });
    const target = listsFor(ctx, d).find((x) => x.id === Number(str(b.list)));
    try {
      if (!target) throw new UserError('Pick a list.');
      // Only lines the entry really has: the form cannot be used to add arbitrary text in its name.
      const real = new Set(listedThings(d));
      const r = addChecklistItems(ctx, target.id, list(b.item).filter((x) => real.has(x)), d.entry.title);
      return done(c, r, v.collUrl(target));
    } catch (err) {
      return failed(c, err, `${v.entryUrl(d.entry.id)}/to-list`);
    }
  });

  app.get('/e/:id/edit', (c) => {
    const ctx = ctxOf(c);
    const d = getEntryDetail(ctx, idParam(c));
    const tagSuggestions = tagCounts(ctx).map((t) => t.tag).slice(0, 100);
    return page(c, `Edit ${d.entry.title}`, v.editEntryPage({ d, csrf: csrfOf(c), tagSuggestions }));
  });

  app.post('/e/:id', async (c) => {
    const ctx = ctxOf(c);
    const id = idParam(c);
    const d = getEntryDetail(ctx, id);
    const b = await c.req.parseBody();
    const input: UpdateEntryInput = { entry_id: id };
    if (str(b.title).trim() && str(b.title).trim() !== d.entry.title) input.title = str(b.title);
    const rating = ratingOf(b.rating);
    if (rating !== d.entry.rating_override) input.rating = rating;
    const fields: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(b)) if (k.startsWith('f.')) fields[k.slice(2)] = str(val);
    if (Object.keys(fields).length) input.fields = fields;
    if (str(b.notes).trim() !== d.entry.notes) input.notes = str(b.notes);
    const wanted = str(b.tags).split(',').map(normalizeTag).filter(Boolean);
    const current = d.tags;
    const add = wanted.filter((t) => !current.includes(t));
    const remove = current.filter((t) => !wanted.includes(t));
    if (add.length) input.add_tags = add;
    if (remove.length) input.remove_tags = remove;
    try {
      return done(c, updateEntry(ctx, input), v.entryUrl(id));
    } catch (err) {
      if (err instanceof UserError && /^Nothing to change|already has that rating/.test(err.message)) {
        setFlash(c, { msg: 'No changes.' });
        return c.redirect(v.entryUrl(id), 303);
      }
      if (!(err instanceof UserError)) throw err;
      const tagSuggestions = tagCounts(ctx).map((t) => t.tag).slice(0, 100);
      return page(c, `Edit ${d.entry.title}`, v.editEntryPage({ d, csrf: csrfOf(c), error: err.message, tagSuggestions }), undefined, 400);
    }
  });

  app.post('/e/:id/logs', async (c) => {
    const id = idParam(c);
    const b = await c.req.parseBody();
    try {
      const r = addLog(ctxOf(c), { entry_id: id, occurred_on: str(b.occurred_on) || undefined, rating: ratingOf(b.rating) ?? undefined, note: str(b.note) || undefined });
      return done(c, r, v.entryUrl(r.entryId!));
    } catch (err) {
      return failed(c, err, v.entryUrl(id));
    }
  });

  app.post('/e/:id/pin', async (c) => {
    const id = idParam(c);
    const b = await c.req.parseBody();
    try {
      const r = setPinned(ctxOf(c), id, b.pinned === '1');
      setFlash(c, { msg: r.pinned ? 'Pinned to the top of Home.' : 'Unpinned.' });
      return c.redirect(v.entryUrl(r.entryId), 303);
    } catch (err) {
      return failed(c, err, v.entryUrl(id));
    }
  });

  app.get('/e/:id/move', (c) => {
    const ctx = ctxOf(c);
    const d = getEntryDetail(ctx, idParam(c));
    const targets = visibleCollections(ctx).filter((x) => x.id !== d.collection.id);
    const to = Number(c.req.query('to'));
    const selected = targets.find((t) => t.id === to);
    return page(c, `Move ${d.entry.title}`, html`${takeFlash(c)}${v.movePage({ d, targets, selected, csrf: csrfOf(c), error: undefined })}`);
  });

  app.post('/e/:id/move', async (c) => {
    const id = idParam(c);
    const b = await c.req.parseBody();
    try {
      return done(c, updateEntry(ctxOf(c), { entry_id: id, move_to_collection: str(b.to) }), v.entryUrl(id));
    } catch (err) {
      return failed(c, err, `${v.entryUrl(id)}/move`);
    }
  });

  app.get('/e/:id/merge', (c) => {
    const ctx = ctxOf(c);
    const keep = getEntryDetail(ctx, idParam(c));
    const withId = Number(c.req.query('with'));
    if (withId) {
      const dup = getEntryDetail(ctx, withId, { logLimit: 1 });
      if (dup.entry.id === keep.entry.id) throw new NotFoundError('Pick a different entry.');
      return page(c, 'Merge', html`${takeFlash(c)}${v.mergeComparePage({ keep, dup, csrf: csrfOf(c) })}`);
    }
    const q = c.req.query('q') ?? '';
    let candidates;
    if (q.trim()) {
      candidates = queryEntries(ctx, { query: q, limit: 15 }).hits.filter((h) => h.id !== keep.entry.id);
    } else {
      const ids = findDuplicates(ctx, keep.collection, keep.entry.title, [keep.entry.id]).map((x) => x.id);
      candidates = ids.length
        ? queryEntries(ctx, { collectionId: keep.collection.id, limit: 50 }).hits.filter((h) => ids.includes(h.id))
        : [];
    }
    return page(c, 'Merge', html`${takeFlash(c)}${v.mergePickPage({ d: keep, candidates, q })}`);
  });

  app.post('/e/:id/merge', async (c) => {
    const ctx = ctxOf(c);
    const id = idParam(c);
    const b = await c.req.parseBody();
    const dupId = Number(str(b.with));
    const fields = Object.entries(b)
      .filter(([k, val]) => k.startsWith('pick.') && val === 'dup')
      .map(([k]) => k.slice(5));
    try {
      const r = mergeEntries(ctx, { keep_id: id, duplicate_id: dupId, take_from_duplicate: { title: b.title === 'dup', fields } });
      return done(c, r, v.entryUrl(id));
    } catch (err) {
      return failed(c, err, `${v.entryUrl(id)}/merge?with=${dupId}`);
    }
  });

  app.post('/e/:id/delete', (c) => {
    const ctx = ctxOf(c);
    const id = idParam(c);
    try {
      const d = getEntryDetail(ctx, id, { logLimit: 1 });
      return done(c, deleteItem(ctx, { entry_id: id }), v.collUrl(d.collection));
    } catch (err) {
      return failed(c, err, v.entryUrl(id));
    }
  });

  // ---- logs ---------------------------------------------------------------------------------------
  app.get('/l/:id/edit', (c) => {
    const ctx = ctxOf(c);
    const { log, entry, collection } = resolveLog(ctx, idParam(c));
    const userName = get<{ n: string }>(deps.db, 'SELECT display_name AS n FROM users WHERE id = ?', log.created_by)?.n ?? '';
    return page(
      c,
      'Edit',
      html`${takeFlash(c)}${v.editLogPage({ log: { ...log, user_name: userName }, entryTitle: entry.title, entryId: entry.id, noun: logNoun(collection), csrf: csrfOf(c), today: todayIn(cfg.tz) })}`,
    );
  });

  app.post('/l/:id', async (c) => {
    const ctx = ctxOf(c);
    const id = idParam(c);
    const { log, entry } = resolveLog(ctx, id);
    const b = await c.req.parseBody();
    const rating = ratingOf(b.rating);
    try {
      const r = updateLog(ctx, {
        log_id: id,
        occurred_on: str(b.occurred_on) !== log.occurred_on ? str(b.occurred_on) : undefined,
        rating: rating !== log.rating ? rating : undefined,
        note: str(b.note).trim() !== log.note ? str(b.note) : undefined,
      });
      return done(c, r, v.entryUrl(entry.id));
    } catch (err) {
      if (err instanceof UserError && err.message.startsWith('Nothing to change')) return c.redirect(v.entryUrl(entry.id), 303);
      return failed(c, err, `/l/${id}/edit`);
    }
  });

  app.post('/l/:id/delete', (c) => {
    const ctx = ctxOf(c);
    const id = idParam(c);
    const { entry } = resolveLog(ctx, id);
    try {
      return done(c, deleteItem(ctx, { log_id: id }), v.entryUrl(entry.id));
    } catch (err) {
      return failed(c, err, v.entryUrl(entry.id));
    }
  });

  // ---- activity, trash -----------------------------------------------------------------------------
  app.get('/activity', (c) => {
    const ctx = ctxOf(c);
    const before = Number(c.req.query('before')) || undefined;
    const items = listActivity(ctx, { limit: 50, beforeId: before });
    const nextBefore = items.length === 50 ? items[items.length - 1].id : null;
    return page(c, 'Activity', v.activityPage({ items, csrf: csrfOf(c), tz: cfg.tz, nextBefore, flash: takeFlash(c) }), 'activity');
  });

  // Undo returns to the page it was pressed on, which the form names. (The app sends no Referer header.)
  app.post('/activity/:id/undo', async (c) => {
    const sent = str((await c.req.parseBody()).back);
    const back = sent && safeReturnTo(sent) === sent ? sent : '/activity';
    try {
      const r = undoActivity(ctxOf(c), idParam(c));
      setFlash(c, { msg: r.summary });
      return c.redirect(back, 303);
    } catch (err) {
      return failed(c, err, back);
    }
  });

  app.get('/trash', (c) => {
    const ctx = ctxOf(c);
    const hits = queryEntries(ctx, { trash: true, sort: { by: 'deleted_at', dir: 'desc' }, limit: 200 }).hits;
    return page(c, 'Trash', v.trashPage({ hits, csrf: csrfOf(c), tz: cfg.tz, flash: takeFlash(c) }), 'trash');
  });

  app.post('/trash/:id/restore', (c) => {
    try {
      return done(c, restoreEntry(ctxOf(c), idParam(c)), '/trash');
    } catch (err) {
      return failed(c, err, '/trash');
    }
  });

  app.post('/trash/:id/purge', (c) => {
    try {
      const r = purgeEntry(ctxOf(c), idParam(c));
      setFlash(c, { msg: r.summary });
      return c.redirect('/trash', 303);
    } catch (err) {
      return failed(c, err, '/trash');
    }
  });

  // ---- photos --------------------------------------------------------------------------------------
  const files: FileStore = { dir: cfg.filesDir, key: cfg.filesKey };
  const uploadedFiles = (form: FormData, name: string) => form.getAll(name).filter((f): f is File => f instanceof File && f.size > 0);
  const bytesOf = async (f: File) => new Uint8Array(await f.arrayBuffer());
  /** The small copy the page's script makes of photo number i and sends along as "preview<i>". */
  const previewOf = async (form: FormData, i: number) => {
    const p = form.get(`preview${i}`);
    return p instanceof File && p.size > 0 ? bytesOf(p) : undefined;
  };

  app.post('/e/:id/photos', async (c) => {
    const id = idParam(c);
    const ctx = ctxOf(c);
    const wantsJson = (c.req.header('accept') ?? '').includes('application/json');
    let saved = 0;
    try {
      const form = await c.req.formData();
      const picked = uploadedFiles(form, 'photo').slice(0, 10);
      if (picked.length === 0) throw new UserError('Choose a photo first.');
      for (const [i, f] of picked.entries()) {
        saveAttachment(ctx, files, { entryId: id, filename: f.name, bytes: await bytesOf(f), preview: await previewOf(form, i) });
        saved++;
      }
      setFlash(c, { msg: picked.length === 1 ? 'Photo added.' : `${picked.length} photos added.` });
    } catch (err) {
      if (!(err instanceof UserError)) throw err;
      // The ones before the one that was refused are already saved; say so, or it reads as if none were.
      setFlash(c, { msg: saved ? `${saved} ${saved === 1 ? 'photo was' : 'photos were'} added. The next one was not: ${err.message}` : err.message, error: true });
    }
    return wantsJson ? c.json({ ok: true }) : c.redirect(v.entryUrl(id), 303);
  });

  /** Sends a stored file. The bytes were uploaded by a household member, but they still get no chance to run as a page. */
  const sendFile = (c: C, read: () => { row: { filename: string }; bytes: Uint8Array; mime: string }, download: (mime: string) => boolean) => {
    let found;
    try {
      found = read();
    } catch (err) {
      if (err instanceof UserError && !(err instanceof NotFoundError)) return c.text(err.message, 500);
      throw err;
    }
    const name = found.row.filename.replace(/["\\\r\n]/g, '_');
    return c.body(found.bytes as Uint8Array<ArrayBuffer>, 200, {
      'Content-Type': found.mime,
      'Content-Disposition': `${download(found.mime) ? 'attachment' : 'inline'}; filename="${name}"`,
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    });
  };

  app.get('/files/:id', (c) =>
    sendFile(
      c,
      () => {
        const { row, bytes } = readAttachment(ctxOf(c), files, idParam(c));
        return { row, bytes, mime: row.mime };
      },
      (mime) => mime === 'application/pdf' || Boolean(c.req.query('download')),
    ),
  );

  // The small preview of a photo, shown in lists and in the chat. Tapping one opens the photo itself.
  app.get('/files/:id/small', (c) => sendFile(c, () => readPreview(ctxOf(c), files, idParam(c)), () => false));

  // A photo stored before previews existed gets one from the first page that shows it: the page's script makes
  // it from the picture it has just loaded and sends it here. It is not a change anyone sees, so no Activity.
  app.post('/files/:id/small', async (c) => {
    const sent = (await c.req.formData()).get('preview');
    const kept = sent instanceof File && sent.size > 0 && savePreview(ctxOf(c), files, idParam(c), await bytesOf(sent));
    return c.body(null, kept ? 201 : 204);
  });

  app.post('/files/:id/delete', (c) => {
    try {
      const { entryId, activityId } = deleteAttachment(ctxOf(c), files, idParam(c));
      setFlash(c, { msg: 'Photo removed.', undo: activityId });
      return c.redirect(entryId ? v.entryUrl(entryId) : '/', 303);
    } catch (err) {
      if (err instanceof NotFoundError) throw err;
      return failed(c, err, '/');
    }
  });

  // ---- the Ask box ---------------------------------------------------------------------------------
  const MAX_CHAT_FILES = 4;
  const askLimit = new RateLimiter(15);
  const askDaily = new RateLimiter(400, 24 * 60 * 60_000);
  const busy = new Set<number>();

  const chatView = (ctx: Ctx, m: ChatRow): ChatView => {
    const photos: ChatView['photos'] = attachmentsOf(m).map((id) => {
      try {
        const a = getAttachment(ctx, id);
        return { id: a.id, pdf: a.mime === 'application/pdf', name: a.filename, small: a.preview_size !== null };
      } catch {
        return 'gone';
      }
    });
    const links = parseLinks(m.links).flatMap((l) => {
      try {
        const { entry, collection } = resolveEntry(ctx, l.id, { allowDeleted: true });
        return [{ id: entry.id, title: entry.title, collection: collection.name, icon: collection.icon, verb: l.verb }];
      } catch {
        return [];
      }
    });
    return { role: m.role, text: m.text, at: m.created_at, photos, links, sources: parseSources(m.sources) };
  };

  /** What went wrong with a request to the assistant, in words for the person who made it. */
  const explain = (err: unknown): string => {
    if (err instanceof UserError) return err.message;
    if (err instanceof Error && err.name === 'TimeoutError') return 'The Anthropic API took too long to answer. Try again.';
    log.error('ask failed', { ...errorFields(err) });
    return 'Something went wrong on the server. Check Activity to see whether anything was saved, then try again.';
  };

  const suggestionsFor = (ctx: Ctx): Suggestion[] => {
    const out: Suggestion[] = [{ label: 'What did we save this week?', text: 'What did we save this week?', send: true }];
    const latest = queryEntries(ctx, { sort: { by: 'added', dir: 'desc' }, limit: 5 }).hits.find((h) => !h.collection.sensitive);
    if (latest) out.push({ label: `Tell me about ${latest.title}`, text: `Tell me about ${latest.title}`, send: true });
    out.push({ label: 'We tried a new place...', text: 'We tried a new place: ' });
    if (cfg.filesKey) out.push({ label: 'Save something from a photo', text: '', pick: true });
    return out;
  };

  // "Have Magpie look for it" on a search that found nothing. The chat sends this question by itself when it
  // opens, so it must never be something a link can cause: it is a form post (checked like every other), and
  // the words travel to the chat page in a short-lived cookie that is read once.
  const takeFind = (c: C): string => {
    const what = getCookie(c, FIND);
    if (!what) return '';
    deleteCookie(c, FIND, { path: '/', secure });
    return what.trim().slice(0, 200);
  };
  app.post('/ask/find', async (c) => {
    const b = await c.req.parseBody();
    const what = str(b.q).trim().slice(0, 200);
    if (what) setCookie(c, FIND, what, { path: '/', httpOnly: true, sameSite: 'Strict', maxAge: 60, secure });
    return c.redirect('/ask', 303);
  });

  app.get('/ask', (c) => {
    const ctx = ctxOf(c);
    const enabled = Boolean(cfg.assistant.apiKey);
    const messages = enabled ? recentMessages(deps.db, ctx.actor.userId).map((m) => chatView(ctx, m)) : [];
    const body = askPage({ messages, enabled, photos: Boolean(cfg.filesKey), suggestions: enabled ? suggestionsFor(ctx) : [], csrf: csrfOf(c), tz: cfg.tz, today: todayIn(cfg.tz), idleMinutes: CHAT_IDLE_MS / 60_000, prefill: (c.req.query('q') ?? '').slice(0, 4000), find: takeFind(c), flash: takeFlash(c) });
    c.header('Cache-Control', 'private, no-store');
    return c.html(layout({ title: 'Ask', body, userName: c.get('user').display_name, userId: c.get('user').id, csrf: csrfOf(c), active: 'ask', bodyClass: enabled ? 'chat-page' : undefined }));
  });

  app.post('/ask', async (c) => {
    // The page's script asks for a stream of small JSON lines (progress, then the reply); a plain form post
    // still works and comes back to the page.
    const streaming = (c.req.header('accept') ?? '').includes('application/x-ndjson');
    const ctx = ctxOf(c);
    const userId = ctx.actor.userId;
    const fail = (msg: string, status: 400 | 429 = 400) => {
      if (streaming) return c.body(`${JSON.stringify({ error: msg })}\n`, status, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' });
      setFlash(c, { msg, error: true });
      return c.redirect('/ask', 303);
    };
    const form = await c.req.formData();
    const text = str(form.get('text')).trim().slice(0, 4000);
    // A few files can come with one message: the front and back of a card, a receipt and its warranty.
    const sentFiles = uploadedFiles(form, 'photo').slice(0, MAX_CHAT_FILES);
    const mcpFetch = deps.mcpFetch;
    if (!text && sentFiles.length === 0) return fail('Type something first.');
    if (!cfg.assistant.apiKey || !mcpFetch) return fail('The Ask box is not switched on yet.');
    if (busy.has(userId)) return fail('Still working on your last message.', 429);
    if (askLimit.take(`u:${userId}`) || askDaily.take(`u:${userId}`)) return fail('That is a lot of messages. Give it a minute.', 429);
    busy.add(userId);

    const answer = async (onStep?: (label: string) => Promise<void>): Promise<ChatView> => {
      const sent: Upload[] = [];
      for (const [i, f] of sentFiles.entries()) {
        const bytes = await bytesOf(f);
        const row = saveAttachment(ctx, files, { entryId: null, filename: f.name, bytes, preview: await previewOf(form, i) });
        sent.push({ uploadId: row.id, mime: row.mime, bytes });
      }
      const result = await ask({ ctx, history: contextTurns(deps.db, userId), text, uploads: sent, files, mcpFetch, config: cfg.assistant, fetchImpl: deps.assistantFetch, onStep });
      const reply = finishReply(ctx, result);
      addMessage(deps.db, userId, { role: 'user', text: text || (sent.length > 1 ? '(photos)' : '(photo)'), attachmentIds: sent.map((s) => s.uploadId) });
      return chatView(ctx, addMessage(deps.db, userId, { role: 'assistant', text: reply.text, links: reply.links, sources: result.sources }));
    };

    if (!streaming) {
      try {
        await answer();
        return c.redirect('/ask', 303);
      } catch (err) {
        return fail(explain(err));
      } finally {
        busy.delete(userId);
      }
    }
    c.header('Content-Type', 'application/x-ndjson; charset=utf-8');
    c.header('Cache-Control', 'no-store');
    c.header('X-Accel-Buffering', 'no');
    return stream(c, async (s) => {
      // If the phone goes to sleep mid-answer the turn still finishes and is there when the page is reopened,
      // so a write to a closed connection is not an error. The pings keep a slow answer's connection open.
      const send = (line: unknown) => s.write(`${JSON.stringify(line)}\n`).then(() => undefined, () => undefined);
      const ping = setInterval(() => void send({ ping: 1 }), 15_000);
      try {
        const view = await answer((label) => send({ step: label }));
        await send({ html: String(await chatMessage(view, cfg.tz)) });
      } catch (err) {
        await send({ error: explain(err) });
      } finally {
        clearInterval(ping);
        busy.delete(userId);
      }
    });
  });

  // Sharing into the app from another app is caught by the service worker, which hands it to the chat.
  // These only run when it is not installed yet.
  app.get('/share', (c) => c.redirect('/ask', 302));

  app.post('/ask/reset', (c) => {
    clearChat(deps.db, c.get('user').id);
    return c.redirect('/ask', 303);
  });

  // "Read" under a photo on an entry page: the assistant looks at a photo or PDF that is already stored and
  // fills in what the entry is missing. A photo added with Add photo is otherwise never read by anything. Its
  // changes go through update_entry, so they show in the entry's History and can be undone there. It never looks
  // anything up on the web: what is on an ID or a policy stays out of search engines. And it is given only the
  // two tools the job needs, so nothing written on a photographed page can talk it into deleting or creating.
  const readerConfig = { ...cfg.assistant, web: false };
  app.post('/files/:id/read', async (c) => {
    const ctx = ctxOf(c);
    const userId = ctx.actor.userId;
    const mcpFetch = deps.mcpFetch;
    const found = readAttachment(ctx, files, idParam(c));
    if (found.row.entry_id === null) throw new NotFoundError('No such photo.');
    const { entry, collection } = resolveEntry(ctx, found.row.entry_id);
    const back = v.entryUrl(entry.id);
    const stop = (msg: string) => {
      setFlash(c, { msg, error: true });
      return c.redirect(back, 303);
    };
    if (!cfg.assistant.apiKey || !mcpFetch) return stop('Reading a photo needs the Ask box, which is not switched on yet.');
    if (busy.has(userId)) return stop('Still working on your last request. Try again in a moment.');
    if (askLimit.take(`u:${userId}`) || askDaily.take(`u:${userId}`)) return stop('That is a lot of requests. Give it a minute.');
    busy.add(userId);
    try {
      const what = found.row.mime === 'application/pdf' ? 'file' : 'photo';
      const text = [
        `App note, not the user's words: the person pressed "Read" under a ${what} on entry #${entry.id} in ${collection.name}. The ${what} shown here is already attached to that entry.`,
        `Read it, then use update_entry on #${entry.id} to fill in fields that are empty and that the ${what} answers, and add anything else worth keeping as a short note with append_note. Leave values that are already filled in alone unless the ${what} plainly shows one is wrong, and say so if you change one. Do not create another entry.`,
        `For raw_text use exactly: Read from the ${what} "${found.row.filename}".`,
        `Reply with one line saying what you filled in, or that there was nothing to add. This is the entry as it stands:`,
        formatEntry(getEntryDetail(ctx, entry.id), cfg.tz, true),
      ].join('\n');
      const result = await ask({
        ctx,
        history: [],
        text,
        attached: [{ mime: found.row.mime, bytes: found.bytes }],
        onlyTools: ['get_entry', 'update_entry'],
        onlyEntryId: entry.id,
        files,
        mcpFetch,
        config: readerConfig,
        fetchImpl: deps.assistantFetch,
      });
      const reply = finishReply(ctx, result).text;
      setFlash(c, { msg: reply.length > 500 ? `${reply.slice(0, 500)}…` : reply });
    } catch (err) {
      setFlash(c, { msg: explain(err), error: true });
    } finally {
      busy.delete(userId);
    }
    return c.redirect(back, 303);
  });

  // "Fill it in from what was said" under a field in a collection's settings: the assistant reads the words
  // already saved with each entry that lacks the field and gives a value where they state one. It is one plain
  // request per batch with no tools of the app's, so nothing it reads can make it do anything else, and the
  // answers are checked against the field's type before they are saved as one change with one Undo.
  const FILL_AT_ONCE = 200;
  app.post('/c/:id/fields/:key/fill', async (c) => {
    const ctx = ctxOf(c);
    const userId = ctx.actor.userId;
    const coll = getVisibleCollection(ctx, idParam(c));
    const back = `${v.collUrl(coll)}/settings`;
    const stop = (msg: string) => {
      setFlash(c, { msg, error: true });
      return c.redirect(back, 303);
    };
    const def = coll.fields.find((f) => f.key === c.req.param('key'));
    if (!def) return stop('No such field.');
    if (!cfg.assistant.apiKey) return stop('Filling a field needs the Ask box, which is not switched on yet.');
    if (busy.has(userId)) return stop('Still working on your last request. Try again in a moment.');
    if (askLimit.take(`u:${userId}`) || askDaily.take(`u:${userId}`)) return stop('That is a lot of requests. Give it a minute.');
    busy.add(userId);
    try {
      const missing = entriesMissing(ctx, coll.id, def.key);
      if (missing.length === 0) return stop('Every entry already has a value for that field.');
      const batch = missing.slice(0, FILL_AT_ONCE);
      const values = await readValues({ config: cfg.assistant, fetchImpl: deps.assistantFetch, def, collection: coll.name, entries: batch });
      const r = applyFill(ctx, coll.id, def.key, values, batch.length);
      const more = missing.length - batch.length;
      setFlash(c, { msg: `${r.summary}${more > 0 ? ` ${more} more were not read this time: press the button again for those.` : ''}`, undo: r.activityId });
    } catch (err) {
      setFlash(c, { msg: explain(err), error: true });
    } finally {
      busy.delete(userId);
    }
    return c.redirect(back, 303);
  });

  // ---- settings ------------------------------------------------------------------------------------
  const settingsView = (c: C, shown: { newToken?: string; newCalendarUrl?: string } = {}) => {
    const user = c.get('user');
    const currentHash = sha256(c.get('sessionId'));
    return page(
      c,
      'Settings',
      v.settingsPage({
        user,
        mcpUrl: cfg.mcpUrl,
        grants: deps.store.listGrants(user.id).map((g) => ({ ...g, client: clientDisplayName(g.client_id) })),
        pats: deps.store.listPats(user.id),
        sessions: deps.store.listSessions(user.id).map((s) => ({ ...s, current: s.id_hash === currentHash })),
        newToken: shown.newToken,
        calendar: deps.store.getCalendarFeed(user.id),
        newCalendarUrl: shown.newCalendarUrl,
        backups: deps.backups,
        offsite: Boolean(cfg.r2.endpoint && cfg.r2.bucket && cfg.r2.accessKeyId && cfg.r2.secretAccessKey),
        slowLoads: recentSlowLoads(deps.db),
        ask: { enabled: Boolean(cfg.assistant.apiKey), model: cfg.assistant.model, web: webResearchState(cfg.assistant) },
        version: SERVER_VERSION,
        csrf: csrfOf(c),
        tz: cfg.tz,
        collections: visibleCollections(ctxOf(c)),
        flash: takeFlash(c),
      }),
      'settings',
    );
  };
  app.get('/settings', (c) => settingsView(c));

  app.post('/settings/tokens', async (c) => {
    const b = await c.req.parseBody();
    const days = Math.min(Math.max(Number(str(b.days)) || 1, 1), 30);
    const label = str(b.label).trim() || 'token';
    const { token } = deps.store.createPat(c.get('user').id, label, days * 24 * 60 * 60_000);
    return settingsView(c, { newToken: token });
  });

  // The calendar link. Making one again replaces it, so an old link that got out stops working.
  app.post('/settings/calendar', async (c) => {
    const b = await c.req.parseBody();
    const token = deps.store.createCalendarFeed(c.get('user').id, b.sensitive === '1');
    return settingsView(c, { newCalendarUrl: `${cfg.publicUrl}/cal/${token}.ics` });
  });

  app.post('/settings/calendar/sensitive', async (c) => {
    const b = await c.req.parseBody();
    deps.store.setCalendarFeedSensitive(c.get('user').id, b.sensitive === '1');
    setFlash(c, { msg: b.sensitive === '1' ? 'Sensitive collections now show in your calendar, by title only.' : 'Sensitive collections are left out of your calendar.' });
    return c.redirect('/settings', 303);
  });

  app.post('/settings/calendar/remove', (c) => {
    deps.store.deleteCalendarFeed(c.get('user').id);
    setFlash(c, { msg: 'Calendar link removed. Calendars that used it will stop updating.' });
    return c.redirect('/settings', 303);
  });

  app.post('/settings/tokens/:hash/revoke', (c) => {
    deps.store.revokePat(c.get('user').id, decodeURIComponent(c.req.param('hash')));
    setFlash(c, { msg: 'Token revoked.' });
    return c.redirect('/settings', 303);
  });

  app.post('/settings/grants/:family/revoke', (c) => {
    deps.store.revokeGrant(c.get('user').id, c.req.param('family'));
    setFlash(c, { msg: 'Access revoked. Claude will ask you to connect again.' });
    return c.redirect('/settings', 303);
  });

  app.post('/settings/sessions/revoke-others', (c) => {
    deps.store.deleteOtherSessions(c.get('user').id, sha256(c.get('sessionId')));
    setFlash(c, { msg: 'Signed out of other browsers.' });
    return c.redirect('/settings', 303);
  });

  // A phone reporting a page load that took long, with where the time went. See src/domain/slowloads.ts.
  app.post('/beacon', async (c) => {
    let report: Record<string, unknown>;
    try {
      report = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.body(null, 400);
    }
    const saved = recordSlowLoad(deps.db, c.get('user').id, report && typeof report === 'object' ? report : {});
    if (saved) log.info('slow-load', { page: saved.page, ms: saved.total, mostly: saved.phase });
    return c.body(null, 204);
  });

  // ---- downloads -----------------------------------------------------------------------------------
  app.get('/export/tracker.db', (c) => {
    const bytes = exportSqlite(ctxOf(c));
    c.header('Content-Type', 'application/vnd.sqlite3');
    c.header('Content-Disposition', `attachment; filename="tracker-${todayIn(cfg.tz)}.db"`);
    c.header('Cache-Control', 'private, no-store');
    return c.body(bytes as Uint8Array<ArrayBuffer>);
  });

  app.get('/export/tracker.json', (c) => {
    c.header('Content-Disposition', `attachment; filename="tracker-${todayIn(cfg.tz)}.json"`);
    c.header('Cache-Control', 'private, no-store');
    return c.body(exportJson(ctxOf(c)), 200, { 'Content-Type': 'application/json; charset=utf-8' });
  });

  // The SQLite copy and the photos in one archive, sent as it is put together.
  app.get('/export/magpie.zip', (c) => {
    const archive = exportZip(ctxOf(c), files);
    return c.body(archive, 200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="magpie-${todayIn(cfg.tz)}.zip"`,
      'Cache-Control': 'private, no-store',
    });
  });

  app.notFound((c) => c.html(messagePage('Not found', html`That page doesn't exist. <a href="/">Go home</a>.`), 404));

  return app;
}
