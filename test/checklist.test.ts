// Checklists: a collection in checklist mode, ticked off by both people.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { checklistItems, clearDone, setDone } from '../src/domain/checklist.ts';
import { collectionsOverview, createCollection, getCollection, updateCollection } from '../src/domain/collections.ts';
import { addChecklistItems, createEntry, getEntryDetail, updateEntry } from '../src/domain/entries.ts';
import { bulletItems } from '../src/web/markdown.ts';
import type { Ctx } from '../src/domain/types.ts';
import { undoActivity } from '../src/domain/undo.ts';
import { findUserByEmail } from '../src/domain/users.ts';
import { formatCollections } from '../src/mcp/format.ts';
import { CookieJar, ALEX, SAM, PUBLIC, signInWeb, startTestApp, type TestApp } from './app-helpers.ts';

let t: TestApp;
let jar: CookieJar;
let samJar: CookieJar;
let alex: Ctx;
let sam: Ctx;
let shop = 0;
let secret = 0;
const ids: Record<string, number> = {};

const csrfOf = async (j: CookieJar) => /<meta name="csrf-token" content="([^"]+)"/.exec(await (await t.request('/', { jar: j })).text())![1];
const page = async (path: string, j = jar) => (await t.request(path, { jar: j })).text();
async function post(path: string, data: Record<string, string>, j = jar, headers: Record<string, string> = {}) {
  const body = new URLSearchParams({ _csrf: await csrfOf(j), ...data });
  return t.request(path, { jar: j, method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: PUBLIC, ...headers }, body: body.toString() });
}
const titles = (list: { title: string }[]) => list.map((i) => i.title);
const add = (who: Ctx, title: string) => {
  const r = createEntry(who, { collection: String(shop), title, raw_text: title });
  assert.ok(r.ok, JSON.stringify(r));
  return r;
};

before(async () => {
  t = await startTestApp();
  jar = await signInWeb(t, ALEX);
  samJar = await signInWeb(t, SAM);
  const ctxFor = (email: string, name: string): Ctx => ({ db: t.deps.db, tz: t.deps.config.tz, actor: { userId: findUserByEmail(t.deps.db, email)!.id, name, via: 'web', client: 'test' } });
  alex = ctxFor('alex@example.com', 'Alex');
  sam = ctxFor('sam@example.com', 'Sam');
  const a = createCollection(alex, { name: 'Shopping', description: 'Things to buy.', checklist: true });
  assert.ok(a.ok);
  assert.match(a.summary, /^Created collection Shopping \(shared, a checklist\)\.$/);
  shop = a.collectionId!;
  const b = createCollection(alex, { name: 'Surprise party', description: 'For Sam.', checklist: true, private: true, confirm_new: true });
  assert.ok(b.ok);
  secret = b.collectionId!;
  for (const [key, title] of [['milk', 'Milk'], ['oat', 'Oat milk'], ['eggs', 'Eggs']]) ids[key] = add(alex, title).entryId!;
  const hidden = createEntry(alex, { collection: String(secret), title: 'Cake' });
  assert.ok(hidden.ok);
  ids.cake = hidden.entryId!;
});
after(() => t.close());

describe('a checklist', () => {
  test('is a collection with a hidden yes/no field, and names that only look alike are separate items', () => {
    const c = getCollection(alex, shop)!;
    assert.equal(c.display.checklist, true);
    assert.deepEqual(c.fields, [{ key: 'done', type: 'boolean', label: 'Done', hidden: true }]);
    assert.deepEqual(titles(checklistItems(alex, shop).todo), ['Milk', 'Oat milk', 'Eggs']);
  });

  test('either person ticks an item, it lands in Activity under their name, and Undo unticks it', () => {
    const r = setDone(sam, ids.milk, true);
    assert.match(r.summary, /^Ticked "Milk" in Shopping\. \(#\d+\)$/);
    assert.deepEqual(titles(checklistItems(alex, shop).todo), ['Oat milk', 'Eggs']);
    assert.deepEqual(titles(checklistItems(alex, shop).done), ['Milk']);
    assert.equal(setDone(sam, ids.milk, true).activityId, undefined, 'ticking twice changes nothing');
    assert.ok(undoActivity(sam, r.activityId!).ok);
    assert.deepEqual(titles(checklistItems(alex, shop).done), []);
    assert.ok(setDone(alex, ids.milk, true).ok);
  });

  test('adding a ticked item again puts it back, and adding one that is there says so', () => {
    const back = add(sam, 'milk');
    assert.equal(back.entryId, ids.milk);
    assert.match(back.summary, /^"Milk" is back on the Shopping list\./);
    const again = add(sam, 'MILK');
    assert.equal(again.replay, true);
    assert.match(again.summary, /^"Milk" is already on the Shopping list\./);
    assert.equal(checklistItems(alex, shop).todo.length, 3);
  });

  test('Claude ticks with update_entry and is told how in list_collections', () => {
    const mcp = { ...alex, actor: { ...alex.actor, via: 'mcp' as const } };
    assert.ok(updateEntry(mcp, { entry_id: ids.eggs, fields: { done: true } }).ok);
    assert.deepEqual(titles(checklistItems(alex, shop).done), ['Eggs']);
    const listed = formatCollections(collectionsOverview(mcp), '2026-11-13', 'America/Denver', 'Alex');
    assert.match(listed, /shopping \| Shopping \| checklist: add an item with create_entry \(title only\), tick it with update_entry fields \{done: true\}/);
    assert.ok(!listed.includes('fields: done'), 'the hidden field is not listed as something to fill in');
  });

  test('Clear ticked takes the ticked items off in one step, and one Undo brings them back', () => {
    assert.ok(setDone(alex, ids.oat, true).ok);
    const r = clearDone(sam, shop);
    assert.match(r.summary, /^Cleared 2 ticked items from Shopping/);
    assert.deepEqual(checklistItems(alex, shop), { todo: [{ id: ids.milk, title: 'Milk', done: false }], done: [] });
    assert.ok(getEntryDetail(alex, ids.eggs, { allowDeleted: true }).entry.deleted_at);
    assert.throws(() => clearDone(sam, shop), /Nothing is ticked/);
    assert.ok(undoActivity(sam, r.activityId!).ok);
    assert.deepEqual(titles(checklistItems(alex, shop).done).sort(), ['Eggs', 'Oat milk']);
  });

  test("the other person's private checklist cannot be seen, ticked or cleared", () => {
    assert.throws(() => checklistItems(sam, secret), /No collection/);
    assert.throws(() => setDone(sam, ids.cake, true), /No entry/);
    assert.throws(() => clearDone(sam, secret), /No collection/);
  });

  test('an ordinary collection can be switched to a checklist and back, keeping its entries', () => {
    const r = createCollection(alex, { name: 'Chores', description: 'Around the house.', fields: [{ key: 'room', type: 'text' }] });
    assert.ok(r.ok);
    assert.throws(() => setDone(alex, createEntryIn('Chores', 'Sweep'), true), /Chores is not a checklist/);
    assert.match(updateCollection(alex, { collection: 'Chores', checklist: true }).summary, /now a checklist/);
    assert.deepEqual(getCollection(alex, r.collectionId!)!.fields.map((f) => f.key), ['room', 'done']);
    assert.match(updateCollection(alex, { collection: 'Chores', checklist: false }).summary, /no longer a checklist/);
    assert.equal(getCollection(alex, r.collectionId!)!.display.checklist, undefined);
  });
});
function createEntryIn(collection: string, title: string): number {
  const r = createEntry(alex, { collection, title });
  assert.ok(r.ok);
  return r.entryId!;
}

describe('the checklist page', () => {
  test('shows what is left with tick boxes, the ticked items below, and an add box', async () => {
    const html = await page(`/c/${shop}`);
    assert.match(html, /<span class="muted small">Checklist<\/span>/);
    assert.match(html, /<p class="muted small left">1 left<\/p>/);
    assert.match(html, new RegExp(`<li data-item="${ids.milk}">\\s*<form method="post" action="/e/${ids.milk}/tick" hx-post="/e/${ids.milk}/tick" hx-target="#checklist-items" hx-swap="outerHTML">`));
    assert.match(html, /<button class="tick " aria-label="Tick Milk" aria-pressed="false"><\/button>/);
    assert.match(html, /<h2 >Ticked<\/h2>\s*<ul class="checklist ticked">[\s\S]*aria-label="Untick Eggs" aria-pressed="true">✓<\/button>/);
    assert.match(html, /<input name="title" required maxlength="200" placeholder="Add an item"/);
    assert.match(await page('/'), /<span class="name">Shopping<\/span>[\s\S]*?<span class="muted">1 left/);
  });

  test('a tick from the page script swaps the list in place; without the script it is a form post and a redirect', async () => {
    const swapped = await post(`/e/${ids.milk}/tick`, { done: '1' }, samJar, { 'hx-request': 'true' });
    assert.equal(swapped.status, 200);
    // What the page's tick forms ask for: the lists alone, so a name half-typed in the add box survives.
    const lists = await (await post(`/e/${ids.milk}/tick`, { done: '1' }, samJar, { 'hx-request': 'true', 'hx-target': 'checklist-items' })).text();
    assert.match(lists, /^<div id="checklist-items" data-list="\d+" data-stamp="[\d.]+">/);
    assert.ok(!lists.includes('name="title"'));
    const part = await swapped.text();
    assert.match(part, /^<div id="checklist">/);
    assert.ok(!part.includes('<html'), 'only the list comes back');
    assert.match(part, /Everything is ticked\./);
    const plain = await post(`/e/${ids.milk}/tick`, { done: '0' });
    assert.equal(plain.status, 303);
    assert.match(plain.headers.get('location') ?? '', new RegExp(`^/c/${shop}-shopping$`));
    assert.deepEqual(titles(checklistItems(alex, shop).todo), ['Milk']);
  });

  test('adding from the page keeps you on the list, and says when the item was already there', async () => {
    const added = await post(`/c/${shop}/entries`, { title: 'Bread' }, jar, { 'hx-request': 'true' });
    const part = await added.text();
    assert.match(part, /aria-label="Tick Bread"/);
    assert.match(part, /<input name="title"[^>]* autofocus \/>/);
    const twice = await (await post(`/c/${shop}/entries`, { title: 'bread' }, jar, { 'hx-request': 'true' })).text();
    assert.match(twice, /&quot;Bread&quot; is already on the Shopping list\./);
    const back = await (await post(`/c/${shop}/entries`, { title: 'eggs' }, jar, { 'hx-request': 'true' })).text();
    assert.match(back, /&quot;Eggs&quot; is back on the Shopping list\./);
    const plain = await post(`/c/${shop}/entries`, { title: 'Butter' });
    assert.equal(plain.status, 303);
    assert.match(plain.headers.get('location') ?? '', new RegExp(`^/c/${shop}-shopping$`));
  });

  test('Clear ticked from the page offers Undo, and a run of ticks is one line in Activity', async () => {
    const res = await post(`/c/${shop}/clear-ticked`, {});
    assert.equal(res.status, 303);
    assert.match(await page(`/c/${shop}`), /Cleared 1 ticked item from Shopping[\s\S]*?<button class="link">Undo<\/button>/);
    for (const key of ['milk', 'eggs']) assert.ok(setDone(sam, ids[key], true).ok);
    assert.ok(setDone(sam, ids.milk, false).ok);
    const activity = await page('/activity');
    assert.match(activity, /<strong>Sam<\/strong>[\s\S]*?<div>Ticked or unticked 3 items in Shopping\.<\/div>/);
  });

  test('the stamp changes with every change to the list, however it was made, so the other phone can tell', async () => {
    const stamp = async (j = jar) => (await t.request(`/c/${shop}/stamp`, { jar: j })).text();
    const seen = new Set([await stamp()]);
    const changed = async (what: string) => {
      const now = await stamp(samJar);
      assert.ok(!seen.has(now), `${what} did not change the stamp`);
      seen.add(now);
    };
    const tea = add(alex, 'Tea');
    await changed('adding');
    const ticked = setDone(alex, tea.entryId!, true);
    await changed('ticking');
    const cleared = clearDone(alex, shop);
    await changed('clearing');
    assert.ok(undoActivity(alex, cleared.activityId!).ok);
    await changed('undoing the clear');
    assert.ok(undoActivity(alex, ticked.activityId!).ok);
    await changed('undoing the tick');
    assert.equal(await stamp(), await stamp(samJar), 'both people see the same stamp');
    const items = await (await t.request(`/c/${shop}/items`, { jar: samJar })).text();
    assert.match(items, new RegExp(`^<div id="checklist-items" data-list="${shop}" data-stamp="${(await stamp()).replaceAll('.', '\\.')}">`));
    assert.match(items, /aria-label="Tick Tea"/);
    assert.equal((await t.request(`/c/${secret}/stamp`, { jar: samJar })).status, 404);
    assert.equal((await t.request(`/c/${secret}/items`, { jar: samJar })).status, 404);
  });

  test("the other person's private checklist is not reachable from the page", async () => {
    assert.equal((await t.request(`/c/${secret}`, { jar: samJar })).status, 404);
    assert.equal((await post(`/e/${ids.cake}/tick`, { done: '1' }, samJar)).status, 404);
    assert.equal((await post(`/c/${secret}/clear-ticked`, {}, samJar)).status, 404);
  });

  test('New collection on Home can make one, and settings can switch the mode', async () => {
    const res = await post('/collections', { name: 'Packing', description: 'For trips.', checklist: '1' });
    assert.match(res.headers.get('location') ?? '', /^\/c\/\d+$/);
    const id = Number(/\d+/.exec(res.headers.get('location')!)![0]);
    assert.match(await page(`/c/${id}`), /Nothing on the list yet\./);
    assert.match(await page(`/c/${id}/settings`), /name="checklist" value="1" checked \/> Checklist/);
  });
});

describe('a recipe onto the shopping list', () => {
  const NOTES = '## Ingredients\n- 2 lb pork shoulder\n- **Green chiles**, roasted\n- [ ] Milk\n\n## Steps\n1. Brown the pork.\n2. Simmer.\n- Serve with tortillas';
  let recipe = 0;
  let listed = 0;

  test('the lines under Ingredients are the things; numbered steps and other sections are not', () => {
    assert.deepEqual(bulletItems(NOTES, /ingredient/i), ['2 lb pork shoulder', 'Green chiles, roasted', 'Milk']);
    assert.deepEqual(bulletItems('- eggs\n- flour\n1. Mix', /ingredient/i), ['eggs', 'flour'], 'with no such heading, every bullet counts');
    assert.deepEqual(bulletItems('Just a sentence.', /ingredient/i), []);
  });

  test('adding several is one change: new ones are added, a ticked one comes back, one already waiting is left', () => {
    const list = createCollection(alex, { name: 'Groceries', description: 'Food to buy.', checklist: true, confirm_new: true });
    assert.ok(list.ok);
    listed = list.collectionId!;
    const have = (title: string, done: boolean) => {
      const r = createEntry(alex, { collection: String(listed), title });
      assert.ok(r.ok);
      if (done) assert.ok(setDone(alex, r.entryId!, true).ok);
    };
    have('Milk', true);
    have('Green chiles, roasted', false);
    const r = addChecklistItems(sam, listed, ['2 lb pork shoulder', 'green chiles, roasted', 'milk', '  ', 'MILK'], 'Green chile stew');
    assert.equal(r.summary, 'Added 2 items to Groceries from Green chile stew (1 already on the list).');
    assert.deepEqual([r.added, r.back, r.already], [1, 1, ['Green chiles, roasted']]);
    assert.deepEqual(titles(checklistItems(alex, listed).todo).sort(), ['2 lb pork shoulder', 'Green chiles, roasted', 'Milk']);
    assert.ok(undoActivity(sam, r.activityId!).ok);
    assert.deepEqual(titles(checklistItems(alex, listed).todo), ['Green chiles, roasted']);
    assert.deepEqual(titles(checklistItems(alex, listed).done), ['Milk']);
    assert.equal(addChecklistItems(sam, listed, ['green chiles, roasted']).activityId, undefined, 'nothing new is no change');
    assert.throws(() => addChecklistItems(sam, secret, ['Candles']), /No collection/);
  });

  test('an entry with ingredients offers Add to a list, and the page adds the ticked lines with one Undo', async () => {
    assert.ok(createCollection(alex, { name: 'Recipes', description: 'Things we cook.', fields: [] }).ok);
    const e = createEntry(alex, { collection: 'Recipes', title: 'Green chile stew', notes: NOTES });
    assert.ok(e.ok);
    recipe = e.entryId!;
    assert.match(await page(`/e/${recipe}`), new RegExp(`<a class="button secondary" href="/e/${recipe}/to-list">Add to a list</a>`));
    const plain = createEntry(alex, { collection: 'Recipes', title: 'Toast', notes: 'Bread, toasted.' });
    assert.ok(plain.ok && !(await page(`/e/${plain.entryId}`)).includes('to-list'));
    const form = await page(`/e/${recipe}/to-list`);
    assert.match(form, /<option value="\d+">Groceries<\/option>/);
    assert.ok(!(await page(`/e/${recipe}/to-list`, samJar)).includes('Surprise party'), "never the other person's private list");
    assert.match(form, /<input type="checkbox" name="item" value="2 lb pork shoulder" checked \/> 2 lb pork shoulder/);
    const body = new URLSearchParams({ _csrf: await csrfOf(jar), list: String(listed) });
    for (const item of ['2 lb pork shoulder', 'Milk', 'Something the recipe never said']) body.append('item', item);
    const res = await t.request(`/e/${recipe}/to-list`, { jar, method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: PUBLIC }, body: body.toString() });
    assert.equal(res.status, 303);
    assert.match(res.headers.get('location') ?? '', new RegExp(`^/c/${listed}-groceries$`));
    const after = await page(`/c/${listed}`);
    assert.match(after, /Added 2 items to Groceries from Green chile stew\.[\s\S]*?<button class="link">Undo<\/button>/);
    assert.deepEqual(titles(checklistItems(alex, listed).todo).sort(), ['2 lb pork shoulder', 'Green chiles, roasted', 'Milk']);
  });
});
