// The sharing setting where people look for it, and filling a field from what was already said.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createCollection, updateCollection } from '../src/domain/collections.ts';
import { createEntry, getEntryDetail, addLog } from '../src/domain/entries.ts';
import { applyFill, entriesMissing } from '../src/domain/fill.ts';
import type { Ctx } from '../src/domain/types.ts';
import { undoActivity } from '../src/domain/undo.ts';
import { findUserByEmail } from '../src/domain/users.ts';
import { CookieJar, ALEX, SAM, PUBLIC, signInWeb, startTestApp, type TestApp } from './app-helpers.ts';

let t: TestApp;
let jar: CookieJar;
let samJar: CookieJar;
let alex: Ctx;
let sam: Ctx;
const coll: Record<string, number> = {};
const ids: Record<string, number> = {};
let script: ((body: { messages: { content: string }[]; system: string; tools: { name: string }[]; tool_choice?: unknown }) => unknown)[] = [];
const apiCalls: { messages: { content: string }[]; system: string; tools: { name: string }[]; tool_choice?: unknown }[] = [];

const csrfOf = async (j: CookieJar) => /<meta name="csrf-token" content="([^"]+)"/.exec(await (await t.request('/', { jar: j })).text())![1];
const page = async (path: string, j = jar) => (await t.request(path, { jar: j })).text();
async function post(path: string, data: Record<string, string>, j = jar) {
  const body = new URLSearchParams({ _csrf: await csrfOf(j), ...data });
  return t.request(path, { jar: j, method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: PUBLIC }, body: body.toString() });
}
const answer = (values: { id: number; value: unknown }[]) => () => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_1', name: 'set_values', input: { values } }] });
const fieldsOf = (id: number) => getEntryDetail(alex, id).entry.fields as unknown as string;

before(async () => {
  t = await startTestApp({ ANTHROPIC_API_KEY: 'sk-ant-test-key' });
  t.deps.assistantFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init!.body));
    apiCalls.push(body);
    const next = script.shift();
    return new Response(JSON.stringify(next ? next(body) : { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Nothing scripted.' }] }));
  }) as typeof fetch;
  jar = await signInWeb(t, ALEX);
  samJar = await signInWeb(t, SAM);
  const ctxFor = (email: string, name: string): Ctx => ({ db: t.deps.db, tz: t.deps.config.tz, actor: { userId: findUserByEmail(t.deps.db, email)!.id, name, via: 'web', client: 'test' } });
  alex = ctxFor('alex@example.com', 'Alex');
  sam = ctxFor('sam@example.com', 'Sam');
  const make = (key: string, who: Ctx, input: { name: string; description: string; private?: boolean }) => {
    const r = createCollection(who, { ...input, confirm_new: true, fields: [] });
    assert.ok(r.ok);
    coll[key] = r.collectionId!;
  };
  make('places', alex, { name: 'Restaurants', description: 'Places to eat.' });
  make('gifts', alex, { name: 'Gift ideas', description: 'For Sam.', private: true });
  make('hers', sam, { name: 'Hikes', description: 'Trails.' });
  const add = (key: string, who: Ctx, collection: string, title: string, notes?: string) => {
    const r = createEntry(who, { collection, title, raw_text: notes ?? title, notes });
    assert.ok(r.ok, JSON.stringify(r));
    ids[key] = r.entryId!;
  };
  add('pho', alex, 'Restaurants', 'Pho 54', 'Great broth. Street parking only, and it fills up by six.');
  add('thai', alex, 'Restaurants', 'Thai Basil');
  add('taco', sam, 'Restaurants', 'Taco Stand', 'Cash only.');
  add('gift', alex, 'Gift ideas', 'Record player');
  assert.ok(addLog(alex, { entry_id: ids.thai, note: 'Parked in their own lot behind the building.', raw_text: 'went to thai basil, parked in their lot' }).ok);
});
after(() => t.close());

describe('the sharing setting', () => {
  test('every collection says Private or Shared, on Home, on its page and in account Settings', async () => {
    const home = await page('/');
    assert.match(home, /<span class="name">Restaurants<\/span>\s*<span><span class="chip muted">Shared<\/span><\/span>/);
    assert.match(home, /<span class="name">Gift ideas<\/span>\s*<span><span class="chip muted">Private<\/span><\/span>/);
    const c = await page(`/c/${coll.gifts}`);
    assert.match(c, new RegExp(`<a class="chip muted" href="/c/${coll.gifts}-gift-ideas/settings#sharing"[^>]*>Private</a>`));
    assert.match(c, new RegExp(`<a class="button secondary small" href="/c/${coll.gifts}-gift-ideas/settings">Collection settings</a>`));
    const settings = await page('/settings');
    assert.match(settings, new RegExp(`<h2>Collections</h2>[\\s\\S]*<a href="/c/${coll.gifts}-gift-ideas/settings#sharing">Gift ideas</a> <span class="chip muted">Private</span>`));
    assert.ok(!(await page('/settings', samJar)).includes('Gift ideas'));
    assert.ok(!(await page('/', samJar)).includes('Gift ideas'));
  });

  test('collection settings say who sees it, and why it cannot be made private when it cannot', async () => {
    const mine = await page(`/c/${coll.gifts}/settings`);
    assert.match(mine, /<h2 id="sharing">Sharing<\/h2>\s*<p>Private: only you can see this collection\.<\/p>/);
    assert.match(mine, /name="private" value="1" checked \/> Private \(untick and save to share it with Sam\)/);
    const shared = await page(`/c/${coll.places}/settings`);
    assert.match(shared, /<p>Shared: you and Sam can see this collection\.<\/p>/);
    assert.match(shared, /It cannot be made private: Sam added &quot;Taco Stand&quot; \(#\d+\)\. Move those entries elsewhere first\./);
    assert.ok(!shared.includes('name="private"'));
    const notMine = await page(`/c/${coll.hers}/settings`);
    assert.match(notMine, /It cannot be made private: only Sam, who created it, can do that\./);
    const hers = await page(`/c/${coll.hers}/settings`, samJar);
    assert.match(hers, /name="private" value="1" \/> Private \(tick and save so only you can see it\)/);
  });
});

describe('filling a field from what was said', () => {
  test('adding a field tells Claude how many entries lack it', () => {
    const r = updateCollection({ ...alex, actor: { ...alex.actor, via: 'mcp' } }, { collection: 'Restaurants', add_fields: [{ key: 'parking', type: 'enum', options: ['street', 'lot', 'garage'] }] });
    assert.match(r.extra.join('\n'), /3 existing entries have no value for `parking` yet\. Where what was already said about one states it, fill it in with update_entry; do not guess\./);
    assert.deepEqual(updateCollection(alex, { collection: 'Hikes', add_fields: [{ key: 'miles', type: 'number' }] }).extra, []);
  });

  test('the words gathered for an entry are its own: notes, what was said, and its logs', () => {
    const missing = entriesMissing(alex, coll.places, 'parking');
    assert.deepEqual(missing.map((m) => m.title).sort(), ['Pho 54', 'Taco Stand', 'Thai Basil']);
    assert.match(missing.find((m) => m.id === ids.thai)!.words, /Parked in their own lot behind the building\.\nwent to thai basil, parked in their lot/);
    assert.match(missing.find((m) => m.id === ids.pho)!.words, /Street parking only/);
    assert.throws(() => entriesMissing(sam, coll.gifts, 'anything'), /No collection/);
  });

  test('the button reads the entries once, saves what suits the field, and one Undo takes it all back', async () => {
    const settings = await page(`/c/${coll.places}/settings`);
    assert.match(settings, new RegExp(`<button class="secondary small" formaction="/c/${coll.places}-restaurants/fields/parking/fill" formnovalidate>Fill it in from what was said</button>\\s*<span class="muted small">Empty on 3 entries\\.`));
    script = [
      answer([
        { id: ids.pho, value: 'Street' },
        { id: ids.thai, value: 'lot' },
        { id: ids.taco, value: 'valet' },
        { id: ids.gift, value: 'lot' },
        { id: 999999, value: 'lot' },
      ]),
    ];
    apiCalls.length = 0;
    const res = await post(`/c/${coll.places}/fields/parking/fill`, {});
    assert.equal(res.status, 303);
    assert.equal(apiCalls.length, 1);
    const sent = apiCalls[0];
    assert.equal(sent.tool_choice, undefined, 'a forced tool is refused by current models');
    assert.deepEqual(sent.tools.map((x) => x.name), ['set_values']);
    assert.match(sent.messages[0].content, /Field: parking[\s\S]*exactly one of: street, lot, garage[\s\S]*Street parking only/);
    assert.ok(!sent.messages[0].content.includes('Record player'), 'nothing from another collection is sent');
    assert.match(String(fieldsOf(ids.pho)), /"parking":"street"/);
    assert.match(String(fieldsOf(ids.thai)), /"parking":"lot"/);
    assert.ok(!String(fieldsOf(ids.taco)).includes('parking'), 'a value that is not one of the options is dropped');
    assert.ok(!String(fieldsOf(ids.gift)).includes('parking'), 'an entry outside the collection is never written');
    const flash = await page(`/c/${coll.places}/settings`);
    assert.match(flash, /Filled Parking on 2 of 3 entries in Restaurants, from what was said about them\./);
    const undo = /name="activity_id" value="(\d+)"/.exec(flash) ?? /\/activity\/(\d+)\/undo/.exec(flash);
    assert.ok(undo, 'the message offers Undo');
    assert.ok(undoActivity(alex, Number(undo[1])).ok);
    assert.ok(!String(fieldsOf(ids.pho)).includes('parking'));
    assert.ok(!String(fieldsOf(ids.thai)).includes('parking'));
  });

  test('a value that is already there is never replaced, and nothing found changes nothing', async () => {
    const first = applyFill(alex, coll.places, 'parking', [{ id: ids.pho, value: 'street' }], 3);
    assert.equal(first.filled, 1);
    const again = applyFill(alex, coll.places, 'parking', [{ id: ids.pho, value: 'garage' }], 2);
    assert.equal(again.filled, 0);
    assert.equal(again.activityId, undefined);
    assert.match(String(fieldsOf(ids.pho)), /"parking":"street"/);
    script = [() => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'I could not tell.' }] })];
    await post(`/c/${coll.places}/fields/parking/fill`, {});
    assert.match(await page(`/c/${coll.places}/settings`), /Nothing said about the 2 entries read gives Parking\. Nothing was changed\./);
  });

  test("it cannot be pointed at the other person's private collection, and needs the Ask box", async () => {
    apiCalls.length = 0;
    const res = await post(`/c/${coll.gifts}/fields/parking/fill`, {}, samJar);
    assert.equal(res.status, 404);
    assert.equal(apiCalls.length, 0);
  });
});
