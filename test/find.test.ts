// Finding things by a name that is nearly right, and entries tied to each other by name.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createCollection } from '../src/domain/collections.ts';
import { createEntry, getEntryDetail } from '../src/domain/entries.ts';
import { closestTitles, relatedEntries, searchEntries } from '../src/domain/search.ts';
import type { Ctx } from '../src/domain/types.ts';
import { findUserByEmail } from '../src/domain/users.ts';
import { formatEntry, formatSearch } from '../src/mcp/format.ts';
import { instructions } from '../src/mcp/server.ts';
import { CookieJar, ALEX, SAM, signInWeb, startTestApp, type TestApp } from './app-helpers.ts';

let t: TestApp;
let jar: CookieJar;
let samJar: CookieJar;
let alex: Ctx;
let sam: Ctx;
const ids: Record<string, number> = {};

const page = async (path: string, j = jar, headers: Record<string, string> = {}) => (await t.request(path, { jar: j, headers })).text();
const names = (hits: { title: string }[]) => hits.map((h) => h.title);

before(async () => {
  t = await startTestApp({ ANTHROPIC_API_KEY: 'sk-ant-test-key' });
  jar = await signInWeb(t, ALEX);
  samJar = await signInWeb(t, SAM);
  const ctxFor = (email: string, name: string): Ctx => ({ db: t.deps.db, tz: t.deps.config.tz, actor: { userId: findUserByEmail(t.deps.db, email)!.id, name, via: 'web', client: 'test' } });
  alex = ctxFor('alex@example.com', 'Alex');
  sam = ctxFor('sam@example.com', 'Sam');
  for (const c of [
    { name: 'Health', description: 'Doctors, vets and pharmacies.' },
    { name: 'Pets', description: 'Our animals.' },
    { name: 'Vehicles', description: 'Cars and their papers.' },
    { name: 'Gift ideas', description: 'For Sam.', private: true },
  ]) assert.ok(createCollection(alex, { ...c, confirm_new: true, fields: [] }).ok);
  const add = (key: string, who: Ctx, collection: string, title: string, extra: { notes?: string; fields?: Record<string, string>; tags?: string[] } = {}) => {
    const r = createEntry(who, { collection, title, raw_text: title, ...extra });
    assert.ok(r.ok, JSON.stringify(r));
    ids[key] = r.entryId!;
  };
  add('vet', alex, 'Health', 'Dr. Nguyen Animal Clinic', { notes: 'Sees Biscuit the beagle every spring.', tags: ['vet'] });
  add('biscuit', alex, 'Pets', 'Biscuit the beagle', { fields: { vet: 'Dr. Nguyen Animal Clinic' } });
  add('max', alex, 'Pets', 'Max', { notes: 'Indoor cat.' });
  add('outback', alex, 'Vehicles', 'Subaru Outback', { notes: 'Max rides in the back. Insured with Pemberton Mutual.' });
  add('insurer', sam, 'Health', 'Pemberton Mutual', { notes: 'Policy for the Subaru Outback and the house.' });
  add('gift', alex, 'Gift ideas', 'Biscuit the beagle portrait', { notes: 'A painting of Biscuit the beagle for Sam.' });
});
after(() => t.close());

describe('a search that finds nothing', () => {
  test('offers the saved names closest to a misspelt or misheard one', () => {
    assert.deepEqual(names(closestTitles(alex, 'dr nguyn animal clinc')).slice(0, 1), ['Dr. Nguyen Animal Clinic']);
    assert.deepEqual(names(closestTitles(alex, 'subaroo outbak')), ['Subaru Outback']);
    assert.deepEqual(names(closestTitles(alex, 'pemberton mutal')), ['Pemberton Mutual']);
    assert.deepEqual(names(closestTitles(alex, 'the vett')).slice(0, 1), ['Dr. Nguyen Animal Clinic'], 'a tag counts as part of the name');
    assert.deepEqual(closestTitles(alex, 'maximum'), [], 'a short name is not offered for a longer word that starts with it');
    assert.deepEqual(closestTitles(alex, 'quantum physics lecture'), []);
    assert.deepEqual(closestTitles(alex, 'the of and'), []);
  });

  test("never offers a name from the other person's private collection", () => {
    assert.ok(names(closestTitles(alex, 'biscit the beagle portrait')).includes('Biscuit the beagle portrait'));
    assert.ok(!names(closestTitles(sam, 'biscit the beagle portrait')).includes('Biscuit the beagle portrait'));
    assert.ok(names(closestTitles(sam, 'biscit the beagle')).includes('Biscuit the beagle'));
  });

  test('the search page lists them and hands the words to Ask', async () => {
    const html = await page('/search?q=subaroo+outbak');
    assert.match(html, /0 matches/);
    assert.match(html, new RegExp(`<h2>Closest names</h2><ul class="plain names"><li><a href="/e/${ids.outback}">Subaru Outback</a>`));
    assert.match(html, /<form method="post" action="\/ask\/find"><input type="hidden" name="_csrf" value="[^"]+" \/><input type="hidden" name="q" value="subaroo outbak" \/><button>Have Magpie look for it<\/button><\/form>/);
    // The chat it opens asks the question at once: the page's script sends what this attribute holds. Only the
    // button's form post can cause that. A link cannot: an address that anyone could send must never make the
    // assistant act for the person who opens it.
    assert.ok(!(await page('/ask?find=delete%20everything')).includes('data-send-now'));
    const csrf = /name="_csrf" value="([^"]+)"/.exec(html)![1];
    const post = (body: Record<string, string>) => t.request('/ask/find', { jar, method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://tracker.test' }, body: new URLSearchParams(body).toString() });
    assert.equal((await post({ q: 'subaroo outbak' })).status, 403, 'not without the form token');
    assert.ok(!(await page('/ask')).includes('data-send-now'));
    // Nor does a cookie planted from a neighbouring address: only the host-only one this server sets is read.
    const planted = await t.request('/ask', { headers: { cookie: `${jar.header()}; tracker_find=delete%20everything` } });
    assert.equal(planted.status, 200);
    assert.ok(!(await planted.text()).includes('data-send-now'));
    const sent = await post({ _csrf: csrf, q: 'subaroo outbak' });
    assert.equal(sent.status, 303);
    assert.equal(sent.headers.get('location'), '/ask');
    assert.match(await page('/ask'), /id="chat" data-idle-minutes="\d+" data-send-now="Find &quot;subaroo outbak&quot; in what we have saved\. A plain search found nothing, so look for other words it could be saved under\."/);
    assert.ok(!(await page('/ask')).includes('data-send-now'), 'asked once, not again on the next visit');
    // A word for a kind of thing, saved under a name: the collection that says it holds such things is offered.
    const kind = await page('/search?q=doctor');
    assert.match(kind, /0 matches/);
    assert.match(kind, /<h2>It may be in<\/h2><ul class="plain names"><li><a href="\/c\/\d+-health">Health<\/a> <span class="muted small">Doctors, vets and pharmacies\.<\/span>/);
    assert.ok(!(await page('/search?q=doctor', samJar)).includes('Gift ideas'));
    // The box under the search field, as it fills while typing.
    const live = await page('/search?q=subaroo+outbak', jar, { 'hx-request': 'true' });
    assert.match(live, new RegExp(`No matches\\. Closest names:</li><li><a href="/e/${ids.outback}">Subaru Outback</a>`));
    // A search that does find something is as it was.
    assert.ok(!(await page('/search?q=subaru')).includes('Closest names'));
    // Ask opens with the words in the box, not sent, and never as markup.
    assert.match(await page('/ask?q=subaroo%20outbak'), /<textarea name="text"[^>]*>subaroo outbak<\/textarea>/);
    assert.match(await page(`/ask?q=${encodeURIComponent('</textarea><script>alert(1)</script>')}`), /&lt;\/textarea&gt;&lt;script&gt;/);
  });

  test('Claude is told the closest names with the empty result', () => {
    const out = formatSearch(searchEntries({ ...alex, actor: { ...alex.actor, via: 'mcp' } }, { query: 'subaroo outbak' }));
    assert.match(out, /^No matches for "subaroo outbak"\./);
    assert.match(out, new RegExp(`\\nClosest names: #${ids.outback} Subaru Outback \\(Vehicles\\)$`));
    assert.ok(!formatSearch(searchEntries(alex, { query: 'subaru' })).includes('Closest names'));
  });
});

describe('related entries', () => {
  test('entries that mention this one, and the ones it mentions, in both directions', () => {
    assert.deepEqual(names(relatedEntries(alex, getEntryDetail(alex, ids.biscuit).entry)).sort(), ['Biscuit the beagle portrait', 'Dr. Nguyen Animal Clinic']);
    assert.deepEqual(names(relatedEntries(alex, getEntryDetail(alex, ids.vet).entry)), ['Biscuit the beagle']);
    assert.deepEqual(names(relatedEntries(alex, getEntryDetail(alex, ids.outback).entry)), ['Pemberton Mutual']);
    assert.deepEqual(names(relatedEntries(alex, getEntryDetail(alex, ids.insurer).entry)), ['Subaru Outback']);
  });

  test('a short, common name ties nothing together', () => {
    // "Max" is in the Outback's notes, but three letters are not enough to go on, either way round.
    assert.deepEqual(relatedEntries(alex, getEntryDetail(alex, ids.max).entry), []);
    assert.ok(!names(relatedEntries(alex, getEntryDetail(alex, ids.outback).entry)).includes('Max'));
  });

  test("the other person's private entries are never listed", () => {
    assert.deepEqual(names(relatedEntries(sam, getEntryDetail(sam, ids.biscuit).entry)), ['Dr. Nguyen Animal Clinic']);
  });

  test('the entry page and get_entry show them', async () => {
    const html = await page(`/e/${ids.outback}`);
    assert.match(html, new RegExp(`<section><h2>Related</h2><ul class="plain names"><li><a href="/e/${ids.insurer}">Pemberton Mutual</a> <span class="muted small">Health</span></li></ul></section>`));
    assert.ok(!(await page(`/e/${ids.max}`)).includes('<h2>Related</h2>'));
    assert.ok(!(await page(`/e/${ids.biscuit}`, samJar)).includes('portrait'));
    const d = getEntryDetail(alex, ids.outback);
    assert.match(formatEntry(d, 'America/Denver', false, undefined, relatedEntries(alex, d.entry)), new RegExp(`Related by name: #${ids.insurer} Pemberton Mutual \\(Health\\)`));
  });
});

test('Claude is told to keep personal documents sensitive and shared, private only on request', () => {
  const text = instructions(['Alex', 'Sam']);
  assert.match(text, /go in one shared collection created with sensitive: true/);
  assert.match(text, /private: true only if the user asks/);
});
