import { html, raw } from 'hono/html';
import type { ActivityItem } from '../domain/activity.ts';
import type { ChecklistItem } from '../domain/checklist.ts';
import type { CollectionOverview } from '../domain/collections.ts';
import type { EntryDetail, LogView } from '../domain/entries.ts';
import { BUILTIN_COLUMNS, fieldLabel, formatValue as rawValue, summaryKeys } from '../domain/fields.ts';
import { KEEP_REMOVED_DAYS, PREVIEW_WORTH_BYTES } from '../domain/files.ts';
import { capitalize, countOf, joinAnd, logNoun, plural } from '../domain/format.ts';
import { MARK_CLOSE, MARK_OPEN, type EntryHit, type NameHit } from '../domain/search.ts';
import { localDateOf as isoDateOf, usDate } from '../domain/time.ts';
import type { Collection, FieldDef, FieldValue, Fields } from '../domain/types.ts';
import { looksFormatted, markdown } from './markdown.ts';
import type { PinnedEntry } from '../domain/pins.ts';
import { slowestPhase, type Phase, type SlowLoad } from '../domain/slowloads.ts';
import type { Upcoming } from '../domain/upcoming.ts';
import type { AppDeps } from '../types.ts';
import { APP_NAME } from '../brand.ts';
import { icon, type Html } from './layout.ts';

export const collUrl = (c: Pick<Collection, 'id' | 'slug'>) => `/c/${c.id}-${c.slug}`;
export const entryUrl = (id: number) => `/e/${id}`;

export function stars(r: number | null | undefined): Html | string {
  if (r === null || r === undefined) return '';
  return html`<span class="rating" title="${r} out of 5">★ ${Number.isInteger(r) ? r : r.toFixed(1)}</span>`;
}

export function csrfField(csrf: string): Html {
  return html`<input type="hidden" name="_csrf" value="${csrf}" />`;
}

/** The Undo button for one change. back is the page it sits on, which is where pressing it returns to. */
function undoForm(activityId: number, csrf: string, back?: string): Html {
  return html`<form method="post" action="/activity/${activityId}/undo" class="inline">${csrfField(csrf)}${back ? html`<input type="hidden" name="back" value="${back}" />` : ''}<button class="link">Undo</button></form>`;
}

export function flashBox(flash: { msg: string; error?: boolean; undo?: number } | undefined, csrf: string, back?: string): Html | string {
  if (!flash) return '';
  return html`<div class="flash ${flash.error ? 'error' : ''}" role="status">
    <span>${flash.msg}</span>
    ${flash.undo ? undoForm(flash.undo, csrf, back) : ''}
  </div>`;
}

/** Search snippets come with private-use markers around matches; escape first, then mark. */
export function snippetHtml(s: string): Html {
  const escaped = s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
  return html`${raw(escaped.replaceAll(MARK_OPEN, '<mark>').replaceAll(MARK_CLOSE, '</mark>'))}`;
}

/** Every date a person sees in the web app is MM-DD-YYYY. */
const localDateOf = (iso: string, tz: string) => usDate(isoDateOf(iso, tz));
const formatValue = (v: FieldValue | undefined) => rawValue(v).replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, '$2-$3-$1');
/** Stored option values like want_to_try read as "Want to try" on screen. The stored value is unchanged. */
export function optionLabel(v: string): string {
  if (!/^[a-z0-9]+([_-][a-z0-9]+)*$/.test(v)) return v;
  const words = v.replace(/[_-]/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
function shown(def: FieldDef | undefined, v: FieldValue | undefined): string {
  return def?.type === 'enum' && typeof v === 'string' ? optionLabel(v) : formatValue(v);
}
function linkText(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/$/, '');
    return u.hostname.replace(/^www\./, '') + (path.length > 24 ? `${path.slice(0, 24)}…` : path);
  } catch {
    return url;
  }
}
/** "Chrome on Android" instead of the browser's full identification string. */
function browserName(ua: string | null): string {
  if (!ua) return 'Unknown browser';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iPhone or iPad' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}
function when(iso: string, tz: string): string {
  return localDateOf(iso, tz);
}

function viaLabel(a: Pick<ActivityItem, 'via' | 'client'>): string {
  if (a.via === 'mcp') return a.client && a.client !== 'Claude' ? `via ${a.client}` : 'via Claude';
  if (a.via === 'cli') return 'from the CLI';
  return 'in the web app';
}

function entryLine(h: EntryHit, opts: { showCollection: boolean; tz: string }): Html {
  const c = h.collection;
  const fields = JSON.parse(h.fields) as Fields;
  const subtitleKey = c.display.subtitle;
  const keys = summaryKeys(c, 3).filter((k) => k !== subtitleKey);
  const def = (k: string) => c.fields.find((f) => f.key === k);
  const vals = keys.map((k) => shown(def(k), fields[k])).filter(Boolean);
  const tags = JSON.parse(h.tags) as string[];
  return html`<li class="entry">
    <a href="${entryUrl(h.id)}" class="entry-link">
      <span class="title">${h.title}</span>
      ${subtitleKey && fields[subtitleKey] !== undefined ? html`<span class="subtitle">${shown(def(subtitleKey), fields[subtitleKey])}</span>` : ''}
    </a>
    <span class="meta">
      ${stars(h.rating)}
      ${opts.showCollection ? html`<a class="chip muted" href="${collUrl(c)}">${c.icon ? `${c.icon} ` : ''}${c.name}</a>` : ''}
      ${vals.length ? html`<span>${vals.join(' · ')}</span>` : ''}
      ${h.log_count ? html`<span class="muted">${countOf(h.log_count, logNoun(c))}, last ${usDate(h.last_logged_on)}</span>` : html`<span class="muted">added ${when(h.created_at, opts.tz)}</span>`}
      ${tags.map((t) => html`<span class="tag">${t}</span>`)}
    </span>
    ${h.snippet && h.snippet.replaceAll(MARK_OPEN, '').replaceAll(MARK_CLOSE, '') !== h.title ? html`<span class="snippet">${snippetHtml(h.snippet)}</span>` : ''}
  </li>`;
}

export function entryList(hits: EntryHit[], opts: { showCollection: boolean; tz: string }): Html {
  return html`${hits.map((h) => entryLine(h, opts))}`;
}

export function activityList(items: ActivityItem[], csrf: string, tz: string, opts: { undo: boolean; open?: boolean; back?: string }): Html {
  if (items.length === 0) return html`<p class="muted">Nothing yet.</p>`;
  // A run of ticks by one person on one list is one line, or a trip round the shop would fill the page.
  const TICKS = ['tick_item', 'untick_item'];
  const rows: (ActivityItem | { run: ActivityItem[] })[] = [];
  for (const a of items) {
    const last = rows.at(-1);
    const tail = last && 'run' in last ? last.run[0] : last;
    const joins = tail && TICKS.includes(a.action) && TICKS.includes(tail.action) && tail.user_id === a.user_id && tail.collection_id === a.collection_id;
    if (joins && last && 'run' in last) last.run.push(a);
    else if (joins && last) rows[rows.length - 1] = { run: [last as ActivityItem, a] };
    else rows.push(a);
  }
  return html`<ul class="activity">
    ${rows.map((a) =>
      'run' in a
        ? html`<li>
            <div><strong>${a.run[0].user_name}</strong> <span class="muted">${viaLabel(a.run[0])} · ${when(a.run[0].at, tz)}</span></div>
            <div>Ticked or unticked ${a.run.length} items${/ in (.+?)\. \(#\d+\)$/.exec(a.run[0].summary)?.[1] ? ` in ${/ in (.+?)\. \(#\d+\)$/.exec(a.run[0].summary)![1]}` : ''}.</div>
            ${a.run[0].collection_id ? html`<div class="row small textlinks"><a href="/c/${a.run[0].collection_id}">Open the list</a></div>` : ''}
          </li>`
        : html`<li>
        <div><strong>${a.user_name}</strong> <span class="muted">${viaLabel(a)} · ${when(a.at, tz)}</span></div>
        <div>${a.summary.replace(/\s*\((#\d+(, log \d+)?)\)\s*$/, '')}${a.undone_by ? html` <span class="tag">undone</span>` : ''}</div>
        ${a.raw_text ? html`<div class="said">“${a.raw_text.length > 300 ? a.raw_text.slice(0, 300) + '…' : a.raw_text}”</div>` : ''}
        <div class="row small textlinks">
          ${a.entry_id && opts.open !== false ? html`<a href="${entryUrl(a.entry_id)}">Open</a>` : ''}
          ${opts.undo && !a.undone_by && !['undo', 'purge_entry'].includes(a.action) && (a.before_json || a.after_json) ? undoForm(a.id, csrf, opts.back) : ''}
        </div>
      </li>`,
    )}
  </ul>`;
}

/** "in 12 days", "tomorrow", "3 days ago"; a trip that has started and not ended is "now". */
function howSoon(u: Upcoming): string {
  if (u.days === 0) return 'today';
  if (u.days === 1) return 'tomorrow';
  if (u.days > 0) return `in ${u.days} days`;
  if (u.until) return 'now';
  return `${-u.days} ${u.days === -1 ? 'day' : 'days'} ago`;
}

/** One "Coming up" row. `action` is the button the row carries: Hide on Home, Show again on the hidden list. */
function dateRow(u: Upcoming, csrf: string, action: 'hide' | 'show'): Html {
  return html`<li class="entry dated">
    <a href="${entryUrl(u.entryId)}" class="entry-link"><span class="title">${u.title}</span></a>
    <span class="meta">
      ${u.until
        ? html`<span>${usDate(u.date)} to ${usDate(u.until)}</span>`
        : html`<span class="${u.days < 0 ? 'warn' : ''}">${u.label} ${usDate(u.date)}</span>`}
      <span class="muted">${howSoon(u)}${u.note ? `, ${u.note}` : ''}</span>
      <span class="chip muted">${u.icon ? `${u.icon} ` : ''}${u.collection}</span>
    </span>
    <form method="post" action="/coming-up/hide" class="hide-date">
      ${csrfField(csrf)}<input type="hidden" name="entry" value="${u.entryId}" /><input type="hidden" name="field" value="${u.field}" />
      <input type="hidden" name="date" value="${u.date}" /><input type="hidden" name="hidden" value="${action === 'hide' ? '1' : '0'}" />
      <button class="secondary small" title="${action === 'hide' ? 'Take this date off your Home page' : 'Put this date back on your Home page'}">${action === 'hide' ? 'Hide' : 'Show again'}</button>
    </form>
  </li>`;
}

/** The dates a person has hidden from their own Home, each with a way back. */
export function hiddenDatesPage(o: { items: Upcoming[]; csrf: string; flash?: Html | string }): Html {
  return html`${o.flash ?? ''}
  <section>
    <h1>Hidden dates</h1>
    <p class="muted">Dates you have hidden from Coming up. Only your Home page is affected; the calendar link still has them.</p>
    ${o.items.length ? html`<ul class="entries">${o.items.map((u) => dateRow(u, o.csrf, 'show'))}</ul>` : html`<p>Nothing is hidden.</p>`}
    <p><a href="/">Back to Home</a></p>
  </section>`;
}

export function homePage(o: {
  overview: CollectionOverview[];
  /** Collections this person has pinned; they are already first in `overview`. */
  pinnedCollections: Set<number>;
  lastActive: Map<number, string>;
  /** Items still to do, for each checklist. */
  left: Map<number, number>;
  needsDetails: EntryHit[];
  pinned: PinnedEntry[];
  upcoming: Upcoming[];
  /** Dates in the same stretch that this person has hidden. */
  hiddenCount: number;
  recent: ActivityItem[];
  csrf: string;
  tz: string;
  flash?: Html | string;
}): Html {
  return html`${o.flash ?? ''}
  <section>
    <form action="/search" method="get" role="search" class="bigsearch">
      <input type="search" name="q" placeholder="Search everything" aria-label="Search everything" autocomplete="off"
        hx-get="/search" hx-trigger="input changed delay:250ms, search" hx-target="#live-results" hx-swap="innerHTML" />
    </form>
    <ul id="live-results" class="entries"></ul>
  </section>
  ${o.pinned.length
    ? html`<section>
        <h2>Pinned</h2>
        <ul class="cards pins">
          ${o.pinned.map(
            (p) => html`<li class="card">
              <a href="${entryUrl(p.id)}" data-keep>
                <span class="name">${p.title}</span>
                <span class="muted">${p.icon ? `${p.icon} ` : ''}${p.collection}</span>
              </a>
            </li>`,
          )}
        </ul>
      </section>`
    : ''}
  ${o.upcoming.length || o.hiddenCount
    ? html`<section>
        <h2>Coming up</h2>
        ${o.upcoming.length ? html`<ul class="entries">${o.upcoming.map((u) => dateRow(u, o.csrf, 'hide'))}</ul>` : ''}
        ${o.hiddenCount ? html`<p class="small"><a href="/coming-up">${o.hiddenCount} hidden</a></p>` : ''}
      </section>`
    : ''}
  <section>
    <h2>Collections</h2>
    ${o.overview.length === 0 ? html`<p class="muted">No collections yet. Tell Claude about something you did, or create one below.</p>` : ''}
    <ul class="cards">
      ${o.overview.map(
        ({ collection: c, entryCount }) => html`<li class="card">
          <a href="${collUrl(c)}">
            <span class="icon">${c.icon ?? '📁'}</span>
            <span class="name">${c.name}</span>
            <span>${sharingChip(c)}${o.pinnedCollections.has(c.id) ? html` <span class="chip muted">Pinned</span>` : ''}</span>
            <span class="muted">${o.left.has(c.id) ? (o.left.get(c.id) ? `${o.left.get(c.id)} left` : entryCount ? 'All done' : 'Nothing yet') : countOf(entryCount, 'entry')}${o.lastActive.get(c.id) ? ` · ${usDate(o.lastActive.get(c.id))}` : ''}</span>
          </a>
        </li>`,
      )}
    </ul>
    <details class="new-collection">
      <summary>New collection</summary>
      <form method="post" action="/collections" class="stack">
        ${csrfField(o.csrf)}
        <label>Name <input name="name" required maxlength="60" placeholder="Hikes" /></label>
        <label>What belongs here <input name="description" required maxlength="300" placeholder="Trails we've done or want to do." /></label>
        <label class="check"><input type="checkbox" name="checklist" value="1" /> Checklist (a list you both tick off: shopping, packing, chores)</label>
        <label class="check"><input type="checkbox" name="private" value="1" /> Private (only you can see it)</label>
        <label class="check"><input type="checkbox" name="sensitive" value="1" /> Sensitive (IDs and documents: encrypted on the server, and Claude finds these by search but only shows the details when you ask for that entry)</label>
        <button>Create</button>
      </form>
    </details>
  </section>
  ${o.needsDetails.length
    ? html`<section><h2>Needs details</h2><ul class="entries">${entryList(o.needsDetails, { showCollection: true, tz: o.tz })}</ul></section>`
    : ''}
  <section>
    <h2>Recently saved by Claude</h2>
    ${activityList(o.recent, o.csrf, o.tz, { undo: true })}
    <p><a href="/activity">All activity</a> · <a href="/trash">Trash</a></p>
  </section>`;
}

function collectionHead(c: Collection, count: string, pin: { pinned: boolean; csrf: string }): Html {
  return html`<section class="collection-head">
    <h1>${c.icon ? `${c.icon} ` : ''}${c.name}</h1>
    <p class="muted">${c.description}</p>
    <div class="row wrap head-tools">
      <span class="muted small">${count}</span>
      <a class="chip muted" href="${collUrl(c)}/settings#sharing" title="Change who can see it">${sharingWord(c)}</a>
      <a class="button secondary small" href="${collUrl(c)}/settings">Collection settings</a>
      <form method="post" action="/c/${c.id}/pin" class="inline">
        ${csrfField(pin.csrf)}<input type="hidden" name="pinned" value="${pin.pinned ? '0' : '1'}" />
        <button class="secondary small" title="${pin.pinned ? 'Stop keeping it first on Home' : 'Keep it first in the list on your Home page'}">${pin.pinned ? 'Unpin' : 'Pin'}</button>
      </form>
    </div>
  </section>`;
}

/** The two lists of a checklist page. `stamp` is what the page compares to learn that the list has changed. */
export function checklistItemsPart(o: { c: Collection; items: { todo: ChecklistItem[]; done: ChecklistItem[] }; csrf: string; stamp: string }): Html {
  const { c } = o;
  // A tick swaps only the lists, so a name half-typed in the add box is not lost.
  const swap = raw('hx-target="#checklist-items" hx-swap="outerHTML"');
  const item = (i: ChecklistItem) => html`<li data-item="${i.id}">
    <form method="post" action="/e/${i.id}/tick" hx-post="/e/${i.id}/tick" ${swap}>
      ${csrfField(o.csrf)}<input type="hidden" name="done" value="${i.done ? '0' : '1'}" />
      <button class="tick ${i.done ? 'on' : ''}" aria-label="${i.done ? 'Untick' : 'Tick'} ${i.title}" aria-pressed="${i.done ? 'true' : 'false'}">${i.done ? '✓' : ''}</button>
    </form>
    <a href="${entryUrl(i.id)}">${i.title}</a>
  </li>`;
  return html`<div id="checklist-items" data-list="${c.id}" data-stamp="${o.stamp}">
    <p class="muted small left">${o.items.todo.length ? `${o.items.todo.length} left` : o.items.done.length ? 'Everything is ticked.' : 'Nothing on the list yet.'}</p>
    <ul class="checklist todo">${o.items.todo.map(item)}</ul>
    <h2 ${o.items.done.length ? '' : raw('hidden')}>Ticked</h2>
    <ul class="checklist ticked">${o.items.done.map(item)}</ul>
    ${o.items.done.length ? html`<form method="post" action="${collUrl(c)}/clear-ticked">${csrfField(o.csrf)}<button class="secondary">Clear ticked</button></form>` : ''}
  </div>`;
}

/**
 * The part of a checklist page that changes: the add box and the lists. Adding swaps all of it in place, a tick
 * swaps the lists alone (the forms carry hx-post), and both work as plain forms without the script.
 */
export function checklistBody(o: { c: Collection; items: { todo: ChecklistItem[]; done: ChecklistItem[] }; csrf: string; stamp: string; note?: string; error?: boolean; focus?: boolean }): Html {
  const { c } = o;
  return html`<div id="checklist">
    <form method="post" action="${collUrl(c)}/entries" hx-post="${collUrl(c)}/entries" hx-target="#checklist" hx-swap="outerHTML" class="row add-item">
      ${csrfField(o.csrf)}
      <input name="title" required maxlength="200" placeholder="Add an item" aria-label="Add an item" autocomplete="off" enterkeyhint="done" ${o.focus ? raw('autofocus') : ''} />
      <button>Add</button>
    </form>
    ${o.note ? html`<p class="small ${o.error ? 'warn' : 'muted'}" role="status">${o.note}</p>` : ''}
    <p class="small muted" id="checklist-waiting" role="status" hidden></p>
    ${checklistItemsPart(o)}
  </div>`;
}

/** Picking which of an entry's listed things (a recipe's ingredients) go onto which checklist. */
export function toListPage(o: { d: EntryDetail; items: { name: string; on: boolean }[]; lists: Collection[]; csrf: string; flash?: Html | string }): Html {
  const e = o.d.entry;
  return html`${o.flash ?? ''}<section>
    <p class="crumbs"><a href="${entryUrl(e.id)}">← ${e.title}</a></p>
    <h1>Add to a list</h1>
    <form method="post" action="${entryUrl(e.id)}/to-list" class="stack">
      ${csrfField(o.csrf)}
      <label>List <select name="list">${o.lists.map((c) => html`<option value="${c.id}">${c.name}</option>`)}</select></label>
      <fieldset class="pick-items"><legend>What to add</legend>
        ${o.items.map((i) => html`<label class="check"><input type="checkbox" name="item" value="${i.name}" ${i.on ? raw('checked') : ''} /> ${i.name}</label>`)}
      </fieldset>
      <p class="muted small">Anything already waiting on the list is left as it is, and a ticked one comes back. Each line is added as written.</p>
      <button>Add to the list</button>
    </form>
  </section>`;
}

export function checklistPage(o: { c: Collection; pinned: boolean; items: { todo: ChecklistItem[]; done: ChecklistItem[] }; csrf: string; stamp: string; flash?: Html | string }): Html {
  return html`${o.flash ?? ''}
  ${collectionHead(o.c, 'Checklist', o)}
  <section>${checklistBody(o)}</section>`;
}

const SORTABLE_BUILTINS: Record<string, string> = {
  last_logged_on: 'Last logged',
  rating: 'Rating',
  title: 'Title',
  created_at: 'Added',
  updated_at: 'Updated',
  log_count: 'Times logged',
  first_logged_on: 'First logged',
};

export function collectionPage(o: {
  c: Collection;
  pinned: boolean;
  hits: EntryHit[];
  total: number;
  nextOffset: number | null;
  query: Record<string, string>;
  tags: { tag: string; n: number }[];
  csrf: string;
  tz: string;
  flash?: Html | string;
  dupNotice?: Html | string;
}): Html {
  const { c, query } = o;
  const sort = query.sort ?? c.display.default_sort?.by ?? 'last_logged_on';
  const dir = query.dir ?? c.display.default_sort?.dir ?? 'desc';
  const keep = (extra: Record<string, string | null>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...query, ...extra })) if (v !== null && v !== undefined && v !== '' && k !== 'offset') p.set(k, v);
    const s = p.toString();
    return `${collUrl(c)}${s ? `?${s}` : ''}`;
  };
  const filterDefs = (c.display.filters ?? []).map((k) => c.fields.find((f) => f.key === k)).filter((f): f is FieldDef => Boolean(f));
  // What is narrowing the list right now, each shown as a chip that removes it.
  const active: { label: string; clear: string }[] = [];
  if (query.tag) active.push({ label: query.tag, clear: keep({ tag: null }) });
  for (const f of filterDefs) {
    const cur = query[`f.${f.key}`];
    if (cur) active.push({ label: `${fieldLabel(f)}: ${optionLabel(cur)}`, clear: keep({ [`f.${f.key}`]: null }) });
  }
  if (query.min) active.push({ label: `★ ${query.min} and up`, clear: keep({ min: null }) });
  const sortType = ['last_logged_on', 'first_logged_on', 'created_at', 'updated_at'].includes(sort) ? 'date' : sort === 'title' ? 'text' : (c.fields.find((f) => f.key === sort)?.type ?? 'number');
  const order =
    sortType === 'date' ? { desc: 'Newest first', asc: 'Oldest first' } : sortType === 'text' || sortType === 'enum' ? { desc: 'Z to A', asc: 'A to Z' } : { desc: 'Highest first', asc: 'Lowest first' };
  return html`${o.flash ?? ''}
  ${collectionHead(c, countOf(o.total, 'entry'), o)}
  <section class="controls">
    <form method="get" action="${collUrl(c)}" data-autosubmit>
      <input type="search" name="q" value="${query.q ?? ''}" placeholder="Search ${c.name}" aria-label="Search ${c.name}" enterkeyhint="search" />
      ${active.length
        ? html`<div class="chips active-filters">
            ${active.map((f) => html`<a class="chip on" href="${f.clear}">${f.label} <span aria-hidden="true">✕</span><span class="visually-hidden">remove</span></a>`)}
          </div>`
        : ''}
      <details class="filters">
        <summary>Sort and filter</summary>
        <div class="row wrap">
          <label>Sort by
            <select name="sort">
              ${Object.entries(SORTABLE_BUILTINS).map(([k, label]) => html`<option value="${k}" ${k === sort ? raw('selected') : ''}>${label}</option>`)}
              ${c.fields.filter((f) => !f.hidden && ['text', 'number', 'date', 'enum'].includes(f.type)).map(
                (f) => html`<option value="${f.key}" ${f.key === sort ? raw('selected') : ''}>${fieldLabel(f)}</option>`,
              )}
            </select>
          </label>
          <label>Order
            <select name="dir">
              <option value="desc" ${dir === 'desc' ? raw('selected') : ''}>${order.desc}</option>
              <option value="asc" ${dir === 'asc' ? raw('selected') : ''}>${order.asc}</option>
            </select>
          </label>
          <label>Rating
            <select name="min">
              <option value="">Any rating</option>
              ${[5, 4.5, 4, 3.5, 3, 2].map((r) => html`<option value="${r}" ${query.min === String(r) ? raw('selected') : ''}>★ ${r} and up</option>`)}
            </select>
          </label>
        </div>
        ${query.tag ? html`<input type="hidden" name="tag" value="${query.tag}" />` : ''}
        ${Object.entries(query)
          .filter(([k]) => k.startsWith('f.'))
          .map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}" />`)}
        <noscript><button>Apply</button></noscript>
        ${filterDefs.map((f) => {
          const opts = f.type === 'boolean' ? ['yes', 'no'] : (f.options ?? []);
          const cur = query[`f.${f.key}`];
          return html`<div class="chips"><span class="muted chip-label">${fieldLabel(f)}</span>
            ${opts.map((v) =>
              cur === v
                ? html`<a class="chip on" href="${keep({ [`f.${f.key}`]: null })}">${optionLabel(v)}</a>`
                : html`<a class="chip" href="${keep({ [`f.${f.key}`]: v })}">${optionLabel(v)}</a>`,
            )}</div>`;
        })}
        ${o.tags.length
          ? html`<div class="chips"><span class="muted chip-label">Tags</span>
              ${o.tags.slice(0, 16).map((t) =>
                query.tag === t.tag
                  ? html`<a class="chip on" href="${keep({ tag: null })}">${t.tag}</a>`
                  : html`<a class="chip" href="${keep({ tag: t.tag })}">${t.tag} <span class="muted">${t.n}</span></a>`,
              )}</div>`
          : ''}
      </details>
    </form>
  </section>
  <ul class="entries" id="entries">
    ${entryList(o.hits, { showCollection: false, tz: o.tz })}
    ${o.nextOffset !== null ? loadMore(keep({}), o.nextOffset) : ''}
  </ul>
  ${o.hits.length === 0 ? html`<p class="muted">Nothing here${Object.keys(query).length ? ' with these filters' : ' yet'}.</p>` : ''}
  <details class="quick-add" ${o.dupNotice ? raw('open') : ''}>
    <summary>Add an entry</summary>
    ${o.dupNotice ?? ''}
    <form method="post" action="${collUrl(c)}/entries" class="stack">
      ${csrfField(o.csrf)}
      <label>Name <input name="title" required maxlength="200" /></label>
      <label>Rating ${ratingSelect('rating', null, 'No rating')}</label>
      <label>Notes <textarea name="notes" rows="2"></textarea></label>
      <button>Save</button>
    </form>
  </details>`;
}

export function loadMore(baseUrl: string, offset: number): Html {
  const url = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}offset=${offset}`;
  return html`<li class="more"><a href="${url}" hx-get="${url}" hx-target="closest li" hx-swap="outerHTML" hx-select="#entries > li">Load more</a></li>`;
}

export function ratingSelect(name: string, value: number | null, emptyLabel: string): Html {
  const opts = [5, 4.5, 4, 3.5, 3, 2.5, 2, 1.5, 1, 0.5, 0];
  return html`<select name="${name}">
    <option value="">${emptyLabel}</option>
    ${opts.map((r) => html`<option value="${r}" ${value === r ? raw('selected') : ''}>★ ${r}</option>`)}
  </select>`;
}

// There are no phone, email or address field types, so what a value can do is read from its key and its shape.
const PHONE_KEY = /(^|_)(phone|mobile|cell|tel|telephone)(_|$)/;
const ADDRESS_KEY = /(^|_)address(_|$)/;
const LINK_KEY = /(^|_)(website|url|link|portal|site)(_|$)/;
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const PHONE = /^\+?[\d\s().-]{7,24}(\s*(x|ext\.?)\s*\d{1,6})?$/i;
const BARE_DOMAIN = /^[\w-]+(\.[\w-]+)+(\/\S*)?$/;
const COPY_MAX = 300;

/** A text value that can be acted on with a tap: a web link, an email, a phone number to call, an address to map. */
function actionLink(key: string, value: string): Html | null {
  const s = value.trim();
  if (!s || s.includes('\n')) return null;
  if (/^https?:\/\/\S+$/i.test(s)) return html`<a href="${s}" rel="noopener noreferrer nofollow" target="_blank">${linkText(s)}</a>`;
  if (EMAIL.test(s)) return html`<a href="mailto:${s}">${s}</a>`;
  if (PHONE_KEY.test(key) && PHONE.test(s)) {
    const number = s.replace(/\s*(x|ext\.?)\s*\d+$/i, '').replace(/(?!^\+)[^\d]/g, '');
    if (number.replace(/\D/g, '').length >= 7) return html`<a href="tel:${number}">${s}</a>`;
  }
  if (ADDRESS_KEY.test(key) && s.length <= COPY_MAX) {
    return html`<a href="https://www.google.com/maps/search/?api=1&amp;query=${encodeURIComponent(s)}" rel="noopener noreferrer" target="_blank">${s}</a>`;
  }
  if (LINK_KEY.test(key) && BARE_DOMAIN.test(s)) return html`<a href="https://${s}" rel="noopener noreferrer nofollow" target="_blank">${s}</a>`;
  return null;
}

function fieldValueHtml(def: FieldDef | undefined, key: string, v: FieldValue): Html | string {
  if (def?.type === 'url' && typeof v === 'string' && /^https?:\/\//i.test(v)) {
    return html`<a href="${v}" rel="noopener noreferrer nofollow" target="_blank">${linkText(v)}</a>`;
  }
  if (def?.type === 'enum' && typeof v === 'string') return optionLabel(v);
  if (Array.isArray(v) && v.length > 1) return html`<ul class="plain-list">${v.map((item) => html`<li>${String(item)}</li>`)}</ul>`;
  if (typeof v === 'string' && (def === undefined || def.type === 'text')) {
    const link = actionLink(key, v);
    if (link) return link;
  }
  if (typeof v === 'string' && def?.type !== 'date' && looksFormatted(v)) return html`<div class="md">${markdown(v)}</div>`;
  return formatValue(v);
}

/** What a copy button next to this value puts on the clipboard, or null when the value isn't one to copy. */
function copyValue(def: FieldDef | undefined, v: FieldValue): string | null {
  if (typeof v === 'boolean' || Array.isArray(v)) return null;
  if (def?.type === 'enum' || def?.type === 'boolean' || def?.type === 'list') return null;
  // What is copied is what is shown, except a link, which is copied whole rather than as its short label.
  const typed = String(v).trim();
  const s = def?.type === 'url' || /^https?:\/\//i.test(typed) ? typed : formatValue(v).trim();
  return s && s.length <= COPY_MAX ? s : null;
}

export function copyButton(text: string, what: string): Html {
  return html`<button type="button" class="copy" data-copy="${text}" aria-label="Copy ${what}" title="Copy">
    <span class="todo">${icon('copy')}</span><span class="done">${icon('check')}</span>
  </button>`;
}

/** One field on the entry page: its label, its value (tappable when it can be), and a copy button for short values. */
function fieldRow(label: string, def: FieldDef | undefined, key: string, v: FieldValue): Html {
  const copy = copyValue(def, v);
  return html`<dt ${def ? '' : raw('class="muted"')}>${label}</dt>
    <dd><span class="val">${fieldValueHtml(def, key, v)}</span>${copy === null ? '' : copyButton(copy, label)}</dd>`;
}

/** What the Share button hands to another app: the name and the short facts, as plain text. */
function shareText(d: EntryDetail): string {
  const lines = [d.entry.title];
  for (const f of d.collection.fields) {
    const v = d.fields[f.key];
    if (v === undefined || f.hidden) continue;
    const s = Array.isArray(v) ? v.join(', ') : shown(f, v);
    if (s && s.length <= COPY_MAX) lines.push(`${fieldLabel(f)}: ${s}`);
  }
  return lines.join('\n');
}

/**
 * A photo as it shows in a list: its small preview when it has one. A large photo without one is shown whole and
 * marked, so the page's script makes the preview from it and sends it in for next time.
 */
function photoThumb(p: EntryDetail['photos'][number]): Html {
  if (p.preview_size !== null) return html`<img src="/files/${p.id}/small" alt="${p.filename}" loading="lazy" />`;
  return p.size > PREVIEW_WORTH_BYTES
    ? html`<img src="/files/${p.id}" alt="${p.filename}" loading="lazy" data-make-preview />`
    : html`<img src="/files/${p.id}" alt="${p.filename}" loading="lazy" />`;
}

export function entryPage(o: {
  d: EntryDetail;
  history: ActivityItem[];
  /** Other entries tied to this one by name. */
  related?: NameHit[];
  pinned: boolean;
  /** Whether it has a list of things (ingredients, say) and there is a checklist to put them on. */
  listable?: boolean;
  /** Whether the assistant is switched on, so a stored photo can be read into the entry. */
  canRead: boolean;
  csrf: string;
  tz: string;
  today: string;
  flash?: Html | string;
}): Html {
  const { d } = o;
  const e = d.entry;
  const c = d.collection;
  const noun = logNoun(c);
  const defined = c.fields.filter((f) => d.fields[f.key] !== undefined);
  const extra = Object.keys(d.fields).filter((k) => !c.fields.some((f) => f.key === k));
  return html`${o.flash ?? ''}
  <article class="entry-detail">
    <p class="crumbs"><a href="${collUrl(c)}">${c.icon ? `${c.icon} ` : ''}${c.name}</a></p>
    <h1>${e.title} ${stars(e.rating)}</h1>
    ${e.deleted_at ? html`<p class="flash error">This entry is in the Trash.</p>` : ''}
    ${d.tags.length ? html`<p>${d.tags.map((t) => html`<a class="tag" href="${collUrl(c)}?tag=${encodeURIComponent(t)}">${t}</a> `)}</p>` : ''}
    ${defined.length || extra.length
      ? html`<dl class="fields">
          ${defined.map((f) => fieldRow(fieldLabel(f), f, f.key, d.fields[f.key]))}
          ${extra.length ? html`<dt class="muted">Other fields</dt><dd></dd>` : ''}
          ${extra.map((k) => fieldRow(k, undefined, k, d.fields[k]))}
        </dl>`
      : ''}
    ${e.notes ? html`<div class="notes md">${markdown(e.notes)}</div>` : ''}
    <p class="muted small">Added ${when(e.created_at, o.tz)} by ${d.addedBy}${d.addedVia ? ` ${d.addedVia}` : ''}.${e.rating_override !== null ? ' Overall rating set manually.' : ''}</p>
    ${e.source_text ? html`<p class="said">Originally said: “${e.source_text}”</p>` : ''}
    ${d.mergedFrom.length ? html`<p class="muted small">Merged from ${d.mergedFrom.map((m) => `#${m.id} ${m.title}`).join(', ')}</p>` : ''}
    <nav class="row wrap actions">
      <a class="button" href="${entryUrl(e.id)}/edit">Edit</a>
      ${e.deleted_at
        ? ''
        : html`<form method="post" action="${entryUrl(e.id)}/pin" class="inline">${csrfField(o.csrf)}<input type="hidden" name="pinned" value="${o.pinned ? '0' : '1'}" />
            <button class="secondary" title="${o.pinned ? 'Take it off the top of Home' : 'Keep it at the top of Home'}">${o.pinned ? 'Unpin' : 'Pin'}</button></form>`}
      ${c.sensitive ? '' : html`<button type="button" class="secondary" data-share data-share-title="${e.title}" data-share-text="${shareText(d)}" hidden>Share</button>`}
      ${o.listable && !e.deleted_at ? html`<a class="button secondary" href="${entryUrl(e.id)}/to-list">Add to a list</a>` : ''}
      <a class="button secondary" href="${entryUrl(e.id)}/move">Move</a>
      <a class="button secondary" href="${entryUrl(e.id)}/merge">Merge</a>
      <form method="post" action="${entryUrl(e.id)}/delete" class="inline">${csrfField(o.csrf)}<button class="secondary danger">Delete</button></form>
    </nav>
  </article>
  ${o.related?.length ? html`<section><h2>Related</h2>${nameList(o.related)}</section>` : ''}
  <section>
    <h2>Photos${d.photos.length ? ` (${d.photos.length})` : ''}</h2>
    ${d.photos.length
      ? html`<ul class="photos">
          ${d.photos.map(
            (p) => html`<li>
              <a href="/files/${p.id}" ${p.mime === 'application/pdf' ? '' : raw('data-photo')}>${p.mime === 'application/pdf' ? html`<span class="pdf">PDF<br />${p.filename}</span>` : photoThumb(p)}</a>
              <div class="row">
                ${o.canRead && !e.deleted_at
                  ? html`<form method="post" action="/files/${p.id}/read" class="inline">${csrfField(o.csrf)}<button class="secondary small" title="The assistant reads it and fills in what this entry is missing">Read</button></form>`
                  : ''}
                <form method="post" action="/files/${p.id}/delete" class="inline">${csrfField(o.csrf)}<button class="secondary danger small" title="You can undo this for ${KEEP_REMOVED_DAYS} days">Remove</button></form>
              </div>
            </li>`,
          )}
        </ul>`
      : ''}
    ${e.deleted_at
      ? ''
      : html`<form method="post" action="${entryUrl(e.id)}/photos" enctype="multipart/form-data" class="row wrap" data-photo-form>
          ${csrfField(o.csrf)}
          <input type="file" name="photo" accept="image/jpeg,image/png,image/webp,application/pdf" multiple required aria-label="Photo or PDF" />
          <button>Add photo</button>
        </form>
        <p class="muted small">Photos are stored encrypted. Claude can see that an entry has photos, but not the pictures themselves.${
          o.canRead && d.photos.length ? ' Read sends that one picture to the assistant, which fills in what this entry is missing.' : ''
        }${d.photos.length ? ` A photo you remove can be brought back for ${KEEP_REMOVED_DAYS} days with Undo, here or in Activity.` : ''}</p>`}
  </section>
  <section>
    <h2>${capitalize(plural(noun, 2))} (${e.log_count})</h2>
    <details ${e.log_count === 0 ? raw('open') : ''}>
      <summary>Add ${noun === 'log' ? 'a log' : `a ${noun}`}</summary>
      <form method="post" action="${entryUrl(e.id)}/logs" class="stack">
        ${csrfField(o.csrf)}
        <label>Date <input type="date" name="occurred_on" value="${o.today}" max="${o.today}" required /></label>
        <label>Rating ${ratingSelect('rating', null, 'No rating')}</label>
        <label>Note <textarea name="note" rows="2"></textarea></label>
        <button>Add</button>
      </form>
    </details>
    <ol class="logs">
      ${d.logs.map((l) => logItem(l))}
    </ol>
    ${d.hasMore ? html`<p><a href="${entryUrl(e.id)}?before=${d.logs[d.logs.length - 1].id}">Older ${plural(noun, 2)}</a></p>` : ''}
  </section>
  <section>
    <h2>History</h2>
    ${activityList(o.history, o.csrf, o.tz, { undo: true, open: false, back: entryUrl(e.id) })}
  </section>`;
}

function logItem(l: LogView): Html {
  return html`<li>
    <div class="row"><strong>${usDate(l.occurred_on)}</strong> ${stars(l.rating)} <span class="muted">${l.user_name}</span>
      <a class="small" href="/l/${l.id}/edit">Edit</a></div>
    ${l.note ? html`<div class="md">${markdown(l.note)}</div>` : ''}
    ${l.raw_text ? html`<div class="said">“${l.raw_text}”</div>` : ''}
  </li>`;
}

function fieldInput(f: FieldDef, v: FieldValue | undefined): Html {
  const name = `f.${f.key}`;
  const s = v === undefined ? '' : Array.isArray(v) ? v.join(', ') : String(v);
  switch (f.type) {
    case 'number':
      return html`<input type="number" step="any" name="${name}" value="${s}" />`;
    case 'date':
      return html`<input type="date" name="${name}" value="${s}" />`;
    case 'url':
      return html`<input type="url" name="${name}" value="${s}" placeholder="https://" />`;
    case 'enum':
      return html`<select name="${name}"><option value="">(none)</option>${(f.options ?? []).map(
        (o) => html`<option value="${o}" ${o === s ? raw('selected') : ''}>${optionLabel(o)}</option>`,
      )}</select>`;
    case 'boolean':
      return html`<select name="${name}"><option value="">(not set)</option><option value="yes" ${v === true ? raw('selected') : ''}>yes</option><option value="no" ${v === false ? raw('selected') : ''}>no</option></select>`;
    case 'list':
      return html`<input name="${name}" value="${s}" placeholder="Comma-separated" />`;
    default:
      return s.length > 80 ? html`<textarea name="${name}" rows="3">${s}</textarea>` : html`<input name="${name}" value="${s}" />`;
  }
}

export function editEntryPage(o: { d: EntryDetail; csrf: string; error?: string; tagSuggestions: string[] }): Html {
  const { d } = o;
  const c = d.collection;
  const extra = Object.keys(d.fields).filter((k) => !c.fields.some((f) => f.key === k));
  return html`<section>
    <p class="crumbs"><a href="${entryUrl(d.entry.id)}">← ${d.entry.title}</a></p>
    <h1>Edit</h1>
    ${o.error ? html`<p class="flash error">${o.error}</p>` : ''}
    <form method="post" action="${entryUrl(d.entry.id)}" class="stack">
      ${csrfField(o.csrf)}
      <label>Name <input name="title" value="${d.entry.title}" required maxlength="200" /></label>
      <label>Overall rating ${ratingSelect('rating', d.entry.rating_override, `Follow the ${plural(logNoun(c), 2)}${d.entry.rating_override === null && d.entry.rating !== null ? ` (now ${d.entry.rating})` : ''}`)}</label>
      ${c.fields.filter((f) => !f.hidden || d.fields[f.key] !== undefined).map((f) => html`<label>${fieldLabel(f)} ${fieldInput(f, d.fields[f.key])}</label>`)}
      ${extra.map((k) => html`<label class="muted">${k} (other field) ${fieldInput({ key: k, type: 'text' }, d.fields[k])}</label>`)}
      <label>Tags <input name="tags" value="${d.tags.join(', ')}" list="tag-suggestions" placeholder="Comma-separated" /></label>
      <datalist id="tag-suggestions">${o.tagSuggestions.map((t) => html`<option value="${t}"></option>`)}</datalist>
      <label>Notes <textarea name="notes" rows="8">${d.entry.notes}</textarea></label>
      <p class="muted small">Notes can use Markdown: **bold**, *italic*, # headings, - lists, 1. steps, [links](https://...).</p>
      <div class="row savebar"><a class="button secondary" href="${entryUrl(d.entry.id)}">Cancel</a><button>Save</button></div>
    </form>
  </section>`;
}

export function editLogPage(o: { log: LogView; entryTitle: string; entryId: number; noun: string; csrf: string; today: string; error?: string }): Html {
  return html`<section>
    <p class="crumbs"><a href="${entryUrl(o.entryId)}">← ${o.entryTitle}</a></p>
    <h1>Edit ${o.noun}</h1>
    ${o.error ? html`<p class="flash error">${o.error}</p>` : ''}
    <form method="post" action="/l/${o.log.id}" class="stack">
      ${csrfField(o.csrf)}
      <label>Date <input type="date" name="occurred_on" value="${o.log.occurred_on}" max="${o.today}" required /></label>
      <label>Rating ${ratingSelect('rating', o.log.rating, 'No rating')}</label>
      <label>Note <textarea name="note" rows="3">${o.log.note}</textarea></label>
      ${o.log.raw_text ? html`<p class="said">“${o.log.raw_text}”</p>` : ''}
      <div class="row savebar"><a class="button secondary" href="${entryUrl(o.entryId)}">Cancel</a><button>Save</button></div>
    </form>
    <form method="post" action="/l/${o.log.id}/delete">${csrfField(o.csrf)}<button class="secondary danger">Delete this ${o.noun}</button></form>
  </section>`;
}

export function movePage(o: { d: EntryDetail; targets: Collection[]; selected?: Collection; csrf: string; error?: string }): Html {
  const { d } = o;
  const keys = Object.keys(d.fields);
  return html`<section>
    <p class="crumbs"><a href="${entryUrl(d.entry.id)}">← ${d.entry.title}</a></p>
    <h1>Move to another collection</h1>
    ${o.error ? html`<p class="flash error">${o.error}</p>` : ''}
    <form method="get" action="${entryUrl(d.entry.id)}/move" class="row">
      <select name="to" aria-label="Collection">
        ${o.targets.map((t) => html`<option value="${t.id}" ${o.selected?.id === t.id ? raw('selected') : ''}>${t.name}${t.visibility === 'private' ? ' (private)' : ''}</option>`)}
      </select>
      <button class="secondary">Preview</button>
    </form>
    ${o.selected
      ? html`<div class="card">
          <p>Fields that carry over: ${keys.filter((k) => o.selected!.fields.some((f) => f.key === k)).join(', ') || 'none'}</p>
          <p>Kept as "Other fields": ${keys.filter((k) => !o.selected!.fields.some((f) => f.key === k)).join(', ') || 'none'}</p>
          <form method="post" action="${entryUrl(d.entry.id)}/move">
            ${csrfField(o.csrf)}<input type="hidden" name="to" value="${o.selected.id}" />
            <button>Move to ${o.selected.name}</button>
          </form>
        </div>`
      : ''}
  </section>`;
}

export function mergePickPage(o: { d: EntryDetail; candidates: EntryHit[]; q: string }): Html {
  const { d } = o;
  return html`<section>
    <p class="crumbs"><a href="${entryUrl(d.entry.id)}">← ${d.entry.title}</a></p>
    <h1>Merge a duplicate into “${d.entry.title}”</h1>
    <form method="get" action="${entryUrl(d.entry.id)}/merge" class="row">
      <input type="search" name="q" value="${o.q}" placeholder="Find the duplicate" />
      <button class="secondary">Search</button>
    </form>
    <ul class="entries">
      ${o.candidates.map(
        (h) => html`<li class="entry"><a class="entry-link" href="${entryUrl(d.entry.id)}/merge?with=${h.id}"><span class="title">${h.title}</span></a>
          <span class="meta">${stars(h.rating)} <span class="muted">${h.collection.name} · ${countOf(h.log_count, logNoun(h.collection))}</span></span></li>`,
      )}
    </ul>
    ${o.candidates.length === 0 ? html`<p class="muted">No likely duplicates found. Try searching.</p>` : ''}
  </section>`;
}

export function mergeComparePage(o: { keep: EntryDetail; dup: EntryDetail; csrf: string; error?: string }): Html {
  const { keep, dup } = o;
  const keys = [...new Set([...Object.keys(keep.fields), ...Object.keys(dup.fields)])];
  const conflicts = keys.filter((k) => k in keep.fields && k in dup.fields && JSON.stringify(keep.fields[k]) !== JSON.stringify(dup.fields[k]));
  return html`<section>
    <p class="crumbs"><a href="${entryUrl(keep.entry.id)}">← ${keep.entry.title}</a></p>
    <h1>Merge</h1>
    ${o.error ? html`<p class="flash error">${o.error}</p>` : ''}
    <table class="compare">
      <thead><tr><th></th><th>Keep: #${keep.entry.id}</th><th>Duplicate: #${dup.entry.id}</th></tr></thead>
      <tbody>
        <tr><th>Name</th><td>${keep.entry.title}</td><td>${dup.entry.title}</td></tr>
        <tr><th>Collection</th><td>${keep.collection.name}</td><td>${dup.collection.name}</td></tr>
        <tr><th>Rating</th><td>${stars(keep.entry.rating)}</td><td>${stars(dup.entry.rating)}</td></tr>
        <tr><th>${capitalize(plural(logNoun(keep.collection), 2))}</th><td>${keep.entry.log_count}</td><td>${dup.entry.log_count} (will move)</td></tr>
        ${keys.map((k) => html`<tr><th>${k}</th><td>${formatValue(keep.fields[k])}</td><td>${formatValue(dup.fields[k])}</td></tr>`)}
        <tr><th>Tags</th><td>${keep.tags.join(', ')}</td><td>${dup.tags.join(', ')}</td></tr>
      </tbody>
    </table>
    <form method="post" action="${entryUrl(keep.entry.id)}/merge" class="stack">
      ${csrfField(o.csrf)}
      <input type="hidden" name="with" value="${dup.entry.id}" />
      ${keep.entry.title !== dup.entry.title
        ? html`<fieldset><legend>Name to keep</legend>
            <label class="check"><input type="radio" name="title" value="keep" checked /> ${keep.entry.title}</label>
            <label class="check"><input type="radio" name="title" value="dup" /> ${dup.entry.title}</label></fieldset>`
        : ''}
      ${conflicts.map(
        (k) => html`<fieldset><legend>${k}</legend>
          <label class="check"><input type="radio" name="pick.${k}" value="keep" checked /> ${formatValue(keep.fields[k])}</label>
          <label class="check"><input type="radio" name="pick.${k}" value="dup" /> ${formatValue(dup.fields[k])}</label></fieldset>`,
      )}
      <p class="muted small">Values you don't pick are added to the notes, so nothing is lost. Merges can be undone.</p>
      <button>Merge</button>
    </form>
  </section>`;
}

/** Entries listed by name alone: the closest names after an empty search, and an entry's related entries. */
function nameList(names: NameHit[]): Html {
  return html`<ul class="plain names">${names.map((n) => html`<li><a href="${entryUrl(n.id)}">${n.title}</a> <span class="muted small">${n.icon ? `${n.icon} ` : ''}${n.collection}</span></li>`)}</ul>`;
}

export function searchPage(o: { q: string; hits: EntryHit[]; total: number; partial: boolean; tz: string; closest?: NameHit[]; places?: Collection[]; canAsk?: boolean; csrf: string }): Html {
  const groups = new Map<number, EntryHit[]>();
  for (const h of o.hits) groups.set(h.collection.id, [...(groups.get(h.collection.id) ?? []), h]);
  return html`<section>
    <form action="/search" method="get" role="search" class="bigsearch">
      <input type="search" name="q" value="${o.q}" placeholder="Search everything" aria-label="Search everything" />
    </form>
    ${o.q ? html`<p class="muted">${o.partial ? 'No exact matches; showing partial matches. ' : ''}${countOf(o.total, 'match')}</p>` : ''}
    ${o.q && o.total === 0 && o.closest?.length ? html`<h2>Closest names</h2>${nameList(o.closest)}` : ''}
    ${o.q && o.total === 0 && o.places?.length
      ? html`<h2>It may be in</h2><ul class="plain names">${o.places.map((c) => html`<li><a href="${collUrl(c)}">${c.icon ? `${c.icon} ` : ''}${c.name}</a> <span class="muted small">${c.description}</span></li>`)}</ul>`
      : ''}
    ${o.q && o.total === 0 && o.canAsk
      ? html`<form method="post" action="/ask/find">${csrfField(o.csrf)}<input type="hidden" name="q" value="${o.q}" /><button>Have ${APP_NAME} look for it</button></form>
          <p class="muted small">Search matches the words you saved. ${APP_NAME} can work out what else it might be called.</p>`
      : ''}
    ${[...groups.values()].map(
      (hits) => html`<h2><a href="${collUrl(hits[0].collection)}">${hits[0].collection.name}</a></h2>
        <ul class="entries">${entryList(hits, { showCollection: false, tz: o.tz })}</ul>`,
    )}
  </section>`;
}

export function liveResults(o: { hits: EntryHit[]; total: number; q: string; tz: string; closest?: NameHit[] }): Html {
  if (!o.q.trim()) return html``;
  if (o.hits.length === 0) {
    return html`<li class="muted">No matches.${o.closest?.length ? ' Closest names:' : ''}</li>${(o.closest ?? []).map(
      (n) => html`<li><a href="${entryUrl(n.id)}">${n.title}</a> <span class="muted small">${n.collection}</span></li>`,
    )}`;
  }
  return html`${entryList(o.hits, { showCollection: true, tz: o.tz })}${o.total > o.hits.length
    ? html`<li class="more"><a href="/search?q=${encodeURIComponent(o.q)}">All ${o.total} matches</a></li>`
    : ''}`;
}

export function activityPage(o: { items: ActivityItem[]; csrf: string; tz: string; nextBefore: number | null; flash?: Html | string }): Html {
  return html`${o.flash ?? ''}<section>
    <h1>Activity</h1>
    ${activityList(o.items, o.csrf, o.tz, { undo: true })}
    ${o.nextBefore ? html`<p><a href="/activity?before=${o.nextBefore}">Older</a></p>` : ''}
  </section>`;
}

export function trashPage(o: { hits: EntryHit[]; csrf: string; tz: string; flash?: Html | string }): Html {
  return html`${o.flash ?? ''}<section>
    <h1>Trash</h1>
    ${o.hits.length === 0 ? html`<p class="muted">The Trash is empty.</p>` : ''}
    <ul class="entries">
      ${o.hits.map(
        (h) => html`<li class="entry">
          <a class="entry-link" href="${entryUrl(h.id)}"><span class="title">${h.title}</span></a>
          <span class="meta"><span class="muted">${h.collection.name} · deleted ${h.deleted_at ? localDateOf(h.deleted_at, o.tz) : ''}</span></span>
          <div class="row">
            <form method="post" action="/trash/${h.id}/restore" class="inline">${csrfField(o.csrf)}<button class="secondary">Restore</button></form>
            <form method="post" action="/trash/${h.id}/purge" class="inline">${csrfField(o.csrf)}<button class="secondary danger" data-confirm="Delete “${h.title}” forever? This can't be undone.">Delete forever</button></form>
          </div>
        </li>`,
      )}
    </ul>
  </section>`;
}

const sharingWord = (c: Collection) => (c.visibility === 'private' ? 'Private' : 'Shared');
const sharingChip = (c: Collection): Html => html`<span class="chip muted">${sharingWord(c)}</span>`;

const TYPES = ['text', 'number', 'date', 'url', 'enum', 'list', 'boolean'];

export function collectionSettingsPage(o: {
  c: Collection;
  /** Why this person cannot make it private; empty when they can. */
  privateBlock: string;
  /** The other people in the household, who see a shared collection. */
  household: string[];
  /** How many entries lack each field, and whether the Ask box is on to fill them in. */
  missing: Map<string, number>;
  canFill: boolean;
  others: Collection[];
  csrf: string;
  error?: string;
  flash?: Html | string;
}): Html {
  const { c } = o;
  const columns = [...BUILTIN_COLUMNS, ...c.fields.map((f) => f.key)];
  const cols = new Set(c.display.list_columns ?? []);
  const filters = new Set(c.display.filters ?? []);
  return html`${o.flash ?? ''}<section>
    <p class="crumbs"><a href="${collUrl(c)}">← ${c.name}</a></p>
    <h1>Settings</h1>
    ${o.error ? html`<p class="flash error">${o.error}</p>` : ''}
    <form method="post" action="${collUrl(c)}/settings" class="stack">
      ${csrfField(o.csrf)}
      <h2 id="sharing">Sharing</h2>
      ${c.visibility === 'private'
        ? html`<p>Private: only you can see this collection.</p>
            <label class="check"><input type="checkbox" name="private" value="1" checked /> Private (untick and save to share it${o.household.length ? ` with ${joinAnd(o.household)}` : ''})</label>`
        : html`<p>Shared: ${o.household.length ? `you and ${joinAnd(o.household)} can see this collection.` : 'everyone in the household can see this collection.'}</p>
            ${o.privateBlock
              ? html`<p class="muted small">It cannot be made private: ${o.privateBlock}</p>`
              : html`<label class="check"><input type="checkbox" name="private" value="1" /> Private (tick and save so only you can see it)</label>`}`}
      <label class="check"><input type="checkbox" name="sensitive" value="1" ${c.sensitive ? raw('checked') : ''} /> Sensitive (encrypted on the server, and Claude finds these by search but only shows the details when you ask for that entry)</label>
      <h2>About</h2>
      <label>Name <input name="name" value="${c.name}" maxlength="60" required /></label>
      <label>What belongs here <input name="description" value="${c.description}" maxlength="300" required /></label>
      <label>Icon <input name="icon" value="${c.icon ?? ''}" maxlength="8" placeholder="One emoji" /></label>
      <label class="check"><input type="checkbox" name="checklist" value="1" ${c.display.checklist ? raw('checked') : ''} /> Checklist (items get a tick box, and ticked ones can be cleared in one go)</label>
      <h2>Fields</h2>
      ${c.fields.map(
        (f, i) => html`<fieldset class="field-def">
          <legend>${f.key} <span class="muted">(${f.type})</span></legend>
          <input type="hidden" name="field.${i}.key" value="${f.key}" />
          <label>Key <input name="field.${i}.rename" value="${f.key}" pattern="[a-z][a-z0-9_]{0,39}" /></label>
          <label>Label <input name="field.${i}.label" value="${f.label ?? ''}" maxlength="60" /></label>
          <label>Description for Claude <input name="field.${i}.description" value="${f.description ?? ''}" maxlength="200" /></label>
          ${f.type === 'enum'
            ? html`<label>Options <input name="field.${i}.options" value="${(f.options ?? []).join(', ')}" /></label>
                <label>When removing options, map old to new <input name="field.${i}.remap" placeholder="been=visited" /></label>`
            : ''}
          <label class="check"><input type="checkbox" name="field.${i}.hidden" value="1" ${f.hidden ? raw('checked') : ''} /> Hidden</label>
          ${o.canFill && o.missing.get(f.key)
            ? html`<p class="fill"><button class="secondary small" formaction="${collUrl(c)}/fields/${f.key}/fill" formnovalidate>Fill it in from what was said</button>
                <span class="muted small">Empty on ${countOf(o.missing.get(f.key)!, 'entry')}. Magpie reads what you said about each and fills this in where it says. Unsaved changes on this page are not kept.</span></p>`
            : ''}
        </fieldset>`,
      )}
      <fieldset class="field-def">
        <legend>Add a field</legend>
        <label>Key <input name="new.key" pattern="[a-z][a-z0-9_]{0,39}" placeholder="price_level" /></label>
        <label>Type <select name="new.type">${TYPES.map((t) => html`<option>${t}</option>`)}</select></label>
        <label>Options (enum only) <input name="new.options" placeholder="want_to_try, been" /></label>
      </fieldset>
      <h2>Display</h2>
      <fieldset><legend>List columns (up to 6)</legend>
        ${columns.map((k) => html`<label class="check"><input type="checkbox" name="display.columns" value="${k}" ${cols.has(k) ? raw('checked') : ''} /> ${k}</label>`)}
      </fieldset>
      <label>Default sort <select name="display.sort">${columns.map(
        (k) => html`<option ${c.display.default_sort?.by === k ? raw('selected') : ''}>${k}</option>`,
      )}</select></label>
      <label>Direction <select name="display.dir"><option ${c.display.default_sort?.dir === 'desc' ? raw('selected') : ''}>desc</option><option ${c.display.default_sort?.dir === 'asc' ? raw('selected') : ''}>asc</option></select></label>
      <label>Subtitle field <select name="display.subtitle"><option value="">(none)</option>${c.fields.map(
        (f) => html`<option ${c.display.subtitle === f.key ? raw('selected') : ''}>${f.key}</option>`,
      )}</select></label>
      <label>What a log is called <input name="display.log_noun" value="${c.display.log_noun ?? ''}" maxlength="20" placeholder="visit" /></label>
      <fieldset><legend>Filter chips (enum and yes/no fields, up to 4)</legend>
        ${c.fields
          .filter((f) => f.type === 'enum' || f.type === 'boolean')
          .map((f) => html`<label class="check"><input type="checkbox" name="display.filters" value="${f.key}" ${filters.has(f.key) ? raw('checked') : ''} /> ${f.key}</label>`)}
      </fieldset>
      <button>Save settings</button>
    </form>
    <h2>Move all entries</h2>
    <form method="post" action="${collUrl(c)}/move-all" class="row">
      ${csrfField(o.csrf)}
      <select name="to" aria-label="Collection">${o.others.map((x) => html`<option value="${x.id}">${x.name}</option>`)}</select>
      <button class="secondary">Move all</button>
    </form>
    <h2>${c.archived_at ? 'Unarchive' : 'Archive'}</h2>
    <form method="post" action="${collUrl(c)}/archive">
      ${csrfField(o.csrf)}<input type="hidden" name="archived" value="${c.archived_at ? '0' : '1'}" />
      <button class="secondary">${c.archived_at ? 'Unarchive' : 'Archive this collection'}</button>
    </form>
  </section>`;
}

const PAGE_NAMES: Record<string, string> = { '/': 'Home', '/c/N': 'a collection', '/e/N': 'an entry', '/search': 'search', '/activity': 'Activity', '/ask': 'Ask', '/settings': 'Settings', '/trash': 'Trash' };
const PHASE_WORDS: Record<Phase, string> = {
  startup: 'starting the app in the background',
  connect: 'reaching the server',
  wait: 'waiting for the server',
  download: 'downloading the page',
  render: 'drawing the page',
};
const timeOfDay = (iso: string, tz: string) => new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));

/** Where the photos are safe, in a sentence. */
function offsiteLine(on: boolean, photos: AppDeps['backups']['photos']): string {
  if (!on) return 'Off-site backups are not switched on, so the database and the photos exist only on the server. The zip above is a copy you can keep somewhere else.';
  if (!photos) return 'Off-site backups are on. Photos are copied there every night and whenever the server starts.';
  if (photos.error) return `Off-site backups are on, but the last copy of the photos failed: ${photos.error}`;
  return `Off-site backups are on and hold ${photos.held} photo ${photos.held === 1 ? 'file' : 'files'}, as of ${photos.at}.`;
}

export function settingsPage(o: {
  user: { display_name: string; email: string };
  grants: { family_id: string; client: string; created_at: string; last_used_at: string | null }[];
  pats: { token_hash: string; label: string | null; expires_at: string; last_used_at: string | null }[];
  sessions: { id_hash: string; current: boolean; user_agent: string | null; last_seen_at: string | null }[];
  newToken?: string;
  calendar?: { include_sensitive: number; created_at: string; last_fetched_at: string | null };
  newCalendarUrl?: string;
  backups: AppDeps['backups'];
  /** Whether the off-site backup (R2) is switched on. */
  offsite: boolean;
  ask: { enabled: boolean; model: string; web: 'on' | 'switched_off' | 'refused' };
  slowLoads: SlowLoad[];
  version: string;
  csrf: string;
  tz: string;
  collections: Collection[];
  flash?: Html | string;
}): Html {
  const webLine = { on: 'Web research is on.', switched_off: 'Web research is switched off.', refused: 'Web research is off: the Anthropic API turned it down. It is tried again after the next restart.' }[o.ask.web];
  return html`${o.flash ?? ''}<section>
    <h1>Settings</h1>
    <p>${o.user.display_name} · ${o.user.email}</p>
    <form method="post" action="/logout">${csrfField(o.csrf)}<button class="secondary">Sign out</button></form>
  </section>
  <section>
    <h2>Collections</h2>
    <p class="muted small">Who can see each collection. Tap one to change it.</p>
    <ul class="plain">
      ${o.collections.map((c) => html`<li class="row wrap"><a href="${collUrl(c)}/settings#sharing">${c.icon ? `${c.icon} ` : ''}${c.name}</a> ${sharingChip(c)}</li>`)}
    </ul>
  </section>
  <section>
    <h2>Connected apps</h2>
    ${o.grants.length === 0 ? html`<p class="muted">None. Connect the tracker in Claude under Customize › Connectors.</p>` : ''}
    <ul class="plain">
      ${o.grants.map(
        (g) => html`<li class="row wrap">
          <span><strong>${g.client}</strong> <span class="muted">connected ${localDateOf(g.created_at, o.tz)}${g.last_used_at ? `, last used ${localDateOf(g.last_used_at, o.tz)}` : ''}</span></span>
          <form method="post" action="/settings/grants/${g.family_id}/revoke" class="inline">${csrfField(o.csrf)}<button class="secondary danger">Revoke</button></form>
        </li>`,
      )}
    </ul>
  </section>
  <section>
    <h2>Personal access tokens</h2>
    <p class="muted small">For scripts that call the MCP endpoint directly. Up to 30 days.</p>
    ${o.newToken
      ? html`<div class="flash once"><p>Copy this token now; it won't be shown again:</p><p class="row"><code class="token">${o.newToken}</code>${copyButton(o.newToken, 'token')}</p></div>`
      : ''}
    <ul class="plain">
      ${o.pats.map(
        (p) => html`<li class="row wrap"><span><strong>${p.label}</strong> <span class="muted">expires ${localDateOf(p.expires_at, o.tz)}${p.last_used_at ? `, last used ${localDateOf(p.last_used_at, o.tz)}` : ''}</span></span>
          <form method="post" action="/settings/tokens/${encodeURIComponent(p.token_hash)}/revoke" class="inline">${csrfField(o.csrf)}<button class="secondary danger">Revoke</button></form></li>`,
      )}
    </ul>
    <form method="post" action="/settings/tokens" class="row wrap">
      ${csrfField(o.csrf)}
      <input name="label" placeholder="Label" required maxlength="60" />
      <select name="days"><option value="1">1 day</option><option value="7">7 days</option><option value="30">30 days</option></select>
      <button class="secondary">Create token</button>
    </form>
  </section>
  <section>
    <h2>Calendar</h2>
    <p class="muted small">A private link that puts your dates (expiring documents, birthdays, trips) in your calendar app, which then does the reminding. Anyone who has the link can see those dates, so treat it like a password.</p>
    ${o.newCalendarUrl
      ? html`<div class="flash once">
          <p>Copy this link now; it won't be shown again:</p>
          <p class="row"><code class="token">${o.newCalendarUrl}</code>${copyButton(o.newCalendarUrl, 'calendar link')}</p>
          <p class="small">In Google Calendar on a computer: next to Other calendars choose +, then From URL, and paste it. Then give that calendar a notification so it reminds you.</p>
        </div>`
      : ''}
    ${o.calendar
      ? html`<p>Link made ${localDateOf(o.calendar.created_at, o.tz)}. ${o.calendar.last_fetched_at ? `A calendar last read it ${localDateOf(o.calendar.last_fetched_at, o.tz)}.` : 'No calendar has read it yet.'}
            Sensitive collections are ${o.calendar.include_sensitive ? 'included, by title only' : 'left out'}.</p>
          <div class="row wrap">
            <form method="post" action="/settings/calendar/sensitive" class="inline">${csrfField(o.csrf)}<input type="hidden" name="sensitive" value="${o.calendar.include_sensitive ? '0' : '1'}" />
              <button class="secondary">${o.calendar.include_sensitive ? 'Leave out sensitive collections' : 'Include sensitive collections'}</button></form>
            <form method="post" action="/settings/calendar" class="inline">${csrfField(o.csrf)}<input type="hidden" name="sensitive" value="${o.calendar.include_sensitive ? '1' : '0'}" />
              <button class="secondary" data-confirm="Make a new link? The old one stops working, and calendars that use it stop updating.">Replace the link</button></form>
            <form method="post" action="/settings/calendar/remove" class="inline">${csrfField(o.csrf)}
              <button class="secondary danger" data-confirm="Remove the link? Calendars that use it stop updating.">Remove the link</button></form>
          </div>`
      : html`<form method="post" action="/settings/calendar" class="stack">
          ${csrfField(o.csrf)}
          <label class="check"><input type="checkbox" name="sensitive" value="1" /> Include sensitive collections (titles only)</label>
          <div><button class="secondary">Create calendar link</button></div>
        </form>`}
  </section>
  <section>
    <h2>Signed-in browsers</h2>
    <ul class="plain">
      ${o.sessions.map(
        (s) => html`<li>${s.current ? html`<strong>This browser</strong>` : 'Other browser'} <span class="muted">${browserName(s.user_agent)}${s.last_seen_at ? ` · ${localDateOf(s.last_seen_at, o.tz)}` : ''}</span></li>`,
      )}
    </ul>
    ${o.sessions.length > 1
      ? html`<form method="post" action="/settings/sessions/revoke-others">${csrfField(o.csrf)}<button class="secondary">Sign out other browsers</button></form>`
      : ''}
  </section>
  <section>
    <h2>Slow page loads</h2>
    ${o.slowLoads.length === 0
      ? html`<p class="muted small">None noted. A page that takes more than a second and a half to open on one of your phones is listed here, with where the time went.</p>`
      : html`<ul class="plain small">
          ${o.slowLoads.map(
            (s) => html`<li>${localDateOf(s.at, o.tz)} ${timeOfDay(s.at, o.tz)} · ${s.user_name} · ${PAGE_NAMES[s.page] ?? s.page} · ${(s.total_ms / 1000).toFixed(1)} s, mostly ${PHASE_WORDS[slowestPhase(s)]}${s.network ? ` (${s.network})` : ''}</li>`,
          )}
        </ul>`}
  </section>
  <section>
    <h2>Your data</h2>
    <p><a href="/export/magpie.zip">Download everything, photos included (zip)</a></p>
    <p><a href="/export/tracker.db">Download a SQLite copy</a> · <a href="/export/tracker.json">Download JSON</a></p>
    <p class="muted small">Downloads include everything you can see, and nothing private to anyone else. The zip holds the SQLite copy and your photos and PDFs, in a folder for each collection and entry.</p>
    <p class="muted small">Last nightly snapshot: ${o.backups.lastSnapshotAt ?? 'not yet'}${o.backups.lastSnapshotError ? ` (last error: ${o.backups.lastSnapshotError})` : ''}. Version ${o.version}.</p>
    <p class="muted small">${offsiteLine(o.offsite, o.backups.photos)}</p>
    <p class="muted small">${o.ask.enabled ? `Ask uses ${o.ask.model}. ${webLine}` : 'Ask is not switched on.'}</p>
  </section>`;
}

export function dupNoticeHtml(text: string, form: { title: string; rating: string; notes: string; ids: number[] }, action: string, csrf: string): Html {
  return html`<div class="flash">
    <p>${text.split('\n')[0].replace('NOT SAVED: ', '')}</p>
    <ul>${text
      .split('\n')
      .slice(1)
      .filter((l) => l.startsWith('  #'))
      .map((l) => {
        const id = Number(/#(\d+)/.exec(l)?.[1]);
        return html`<li><a href="${entryUrl(id)}">${l.trim()}</a></li>`;
      })}</ul>
    <form method="post" action="${action}">
      ${csrfField(csrf)}
      <input type="hidden" name="title" value="${form.title}" />
      <input type="hidden" name="rating" value="${form.rating}" />
      <input type="hidden" name="notes" value="${form.notes}" />
      <input type="hidden" name="not_duplicate_of" value="${form.ids.join(',')}" />
      <button class="secondary">It's different, save anyway</button>
    </form>
  </div>`;
}
