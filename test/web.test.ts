import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { get } from '../src/db/sqlite.ts';
import { createCollection, resolveCollection } from '../src/domain/collections.ts';
import { createEntry, getEntryDetail } from '../src/domain/entries.ts';
import { addDays, todayIn, usDate } from '../src/domain/time.ts';
import type { Ctx } from '../src/domain/types.ts';
import { findUserByEmail } from '../src/domain/users.ts';
import { sweepExports } from '../src/web/export.ts';
import { CookieJar, ALEX, SAM, PUBLIC, signInWeb, startTestApp, type TestApp } from './app-helpers.ts';

let t: TestApp;
let jar: CookieJar;
let csrf: string;
let alex: Ctx;
let sam: Ctx;
let ids: { restaurants: number; pho: number; phoExpress: number; gifts: number; giftEntry: number; movies: number };

function ctxFor(email: string, name: string): Ctx {
  const u = findUserByEmail(t.deps.db, email)!;
  return { db: t.deps.db, tz: t.deps.config.tz, actor: { userId: u.id, name, via: 'mcp', client: 'test' } };
}

async function page(path: string, status = 200): Promise<string> {
  const res = await t.request(path, { jar });
  const body = await res.text();
  assert.equal(res.status, status, `${path}: ${body.slice(0, 300)}`);
  return body;
}

async function post(path: string, data: Record<string, string | string[]>): Promise<Response> {
  const body = new URLSearchParams();
  body.set('_csrf', csrf);
  for (const [k, v] of Object.entries(data)) for (const x of Array.isArray(v) ? v : [v]) body.append(k, x);
  return t.request(path, { jar, method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: PUBLIC }, body: body.toString() });
}

before(async () => {
  t = await startTestApp();
  jar = await signInWeb(t, ALEX);
  const home = await t.request('/', { jar });
  csrf = /<meta name="csrf-token" content="([^"]+)"/.exec(await home.text())![1];
  alex = ctxFor('alex@example.com', 'Alex');
  sam = ctxFor('sam@example.com', 'Sam');
  const r = createCollection(alex, {
    name: 'Restaurants',
    description: "Places we've eaten or want to try.",
    icon: '🍜',
    fields: [
      { key: 'cuisine', type: 'text' },
      { key: 'price', type: 'enum', options: ['$', '$$', '$$$'] },
      { key: 'status', type: 'enum', options: ['want_to_try', 'been'] },
      { key: 'website', type: 'url' },
    ],
    display: { log_noun: 'visit', filters: ['status'], subtitle: 'cuisine' },
  });
  assert.ok(r.ok);
  const m = createCollection(alex, { name: 'Movies', description: 'Films.', fields: [{ key: 'year', type: 'number' }] });
  assert.ok(m.ok);
  const pho = createEntry(alex, { collection: 'restaurants', title: 'Phở 54', fields: { cuisine: 'Vietnamese', price: '$', status: 'been' }, tags: ['pho', 'date-night'], log: { rating: 4, note: 'brisket pho' }, raw_text: 'we went to pho 54 tonight, 4 out of 5' });
  assert.ok(pho.ok);
  const px = createEntry(sam, { collection: 'restaurants', title: 'Pho 54 Express', fields: { price: '$' }, log: { rating: 3, occurred_on: '2026-10-01' }, raw_text: 'the express one', not_duplicate_of: [pho.entryId!] });
  assert.ok(px.ok);
  const g = createCollection(sam, { name: 'Gift ideas', description: 'For Alex.', fields: [], private: true });
  assert.ok(g.ok);
  const ge = createEntry(sam, { collection: 'gift-ideas', title: 'Espresso grinder', raw_text: 'secret grinder' });
  assert.ok(ge.ok);
  ids = { restaurants: r.collectionId!, pho: pho.entryId!, phoExpress: px.entryId!, gifts: g.collectionId!, giftEntry: ge.entryId!, movies: m.collectionId! };
});
after(async () => {
  await t.close();
});

describe('web app pages', () => {
  test('home, search, collection list with filters', async () => {
    const home = await page('/');
    assert.match(home, /🍜/);
    assert.match(home, /Restaurants/);
    assert.match(home, /Recently saved by Claude/);
    assert.match(home, /<meta name="magpie-user" content="\d+" \/>/, 'the page says whose it is, for the unsent-changes queue');
    assert.doesNotMatch(home, /Gift ideas|grinder/);
    const search = await page('/search?q=pho');
    assert.match(search, /Phở 54/);
    assert.match(search, /Pho 54 Express/);
    const live = await t.request('/search?q=brisket', { jar, headers: { 'hx-request': 'true' } });
    const liveHtml = await live.text();
    assert.doesNotMatch(liveHtml, /<html/);
    assert.match(liveHtml, /<mark>brisket<\/mark>/);
    assert.doesNotMatch(await page('/search?q=grinder'), /Espresso/);

    const list = await page(`/c/${ids.restaurants}-restaurants`);
    assert.match(list, /Phở 54/);
    assert.match(list, /Vietnamese/);
    const filtered = await page(`/c/${ids.restaurants}?f.status=been`);
    assert.match(filtered, /Phở 54/);
    assert.doesNotMatch(filtered, /Pho 54 Express/);
    const byTag = await page(`/c/${ids.restaurants}?tag=date-night`);
    assert.doesNotMatch(byTag, /Pho 54 Express/);
    const minRating = await page(`/c/${ids.restaurants}?min=4&sort=rating&dir=desc`);
    assert.match(minRating, /Phở 54/);
    assert.doesNotMatch(minRating, /Pho 54 Express/);
  });

  test("a new household's Home says how to connect Claude and what to say, until its first collection exists", async () => {
    const fresh = await startTestApp();
    const withAsk = await startTestApp({ ANTHROPIC_API_KEY: 'sk-ant-test-key' });
    try {
      const j = await signInWeb(fresh, ALEX);
      const get = async (path: string) => (await fresh.request(path, { jar: j })).text();
      const address = `${PUBLIC}/mcp`;

      const empty = await get('/');
      assert.match(empty, /<h2>Getting started<\/h2>/);
      assert.ok(empty.includes(`<code>${address}</code>`), 'the address Claude needs is on the page');
      assert.ok(empty.includes(`data-copy="${address}"`), 'with a copy button');
      assert.match(empty, /Add custom connector/);
      assert.match(empty, /we went to that new pho place tonight/);
      assert.match(empty, /Add to Home screen/);
      assert.doesNotMatch(empty, /You can also type it in/, 'Ask is not offered while it is switched off');
      assert.match(await (await withAsk.request('/', { jar: await signInWeb(withAsk, ALEX) })).text(), /You can also type it in <a href="\/ask">Ask<\/a>/);

      const me = findUserByEmail(fresh.deps.db, 'alex@example.com')!;
      const ctx: Ctx = { db: fresh.deps.db, tz: fresh.deps.config.tz, actor: { userId: me.id, name: 'Alex', via: 'mcp', client: 'test' } };
      assert.ok(createCollection(ctx, { name: 'Hikes', description: 'Trails.', fields: [] }).ok);
      const later = await get('/');
      assert.match(later, /Hikes/);
      assert.doesNotMatch(later, /Getting started/);

      // The second person never saw what setup printed, so the address has to be findable afterwards too.
      const settings = await get('/settings');
      assert.match(settings, /None yet\./);
      assert.ok(settings.includes(`<code>${address}</code>`) && settings.includes(`data-copy="${address}"`));
    } finally {
      await fresh.close();
      await withAsk.close();
    }
  });

  // Setup asks for one or two people, but the list of who may sign in can be longer.
  test('a third person can be let in by hand: they see what is shared and nothing private', async () => {
    const three = await startTestApp({ ALLOWED_USERS: 'alex@example.com=Alex,sam@example.com=Sam,kim@example.com=Kim' });
    try {
      const ctxOf3 = (email: string, name: string): Ctx => {
        const u = findUserByEmail(three.deps.db, email)!;
        return { db: three.deps.db, tz: three.deps.config.tz, actor: { userId: u.id, name, via: 'mcp', client: 'test' } };
      };
      assert.ok(createCollection(ctxOf3('alex@example.com', 'Alex'), { name: 'Hikes', description: 'Trails.', fields: [] }).ok);
      assert.ok(createCollection(ctxOf3('sam@example.com', 'Sam'), { name: 'Gift ideas', description: 'For the others.', fields: [], private: true }).ok);
      assert.ok(createEntry(ctxOf3('sam@example.com', 'Sam'), { collection: 'gift-ideas', title: 'Espresso grinder', raw_text: 'secret grinder' }).ok);

      const kim = await signInWeb(three, { sub: 'google-sub-kim', email: 'kim@example.com' });
      const home = await (await three.request('/', { jar: kim })).text();
      assert.match(home, /Hikes/);
      assert.doesNotMatch(home, /Gift ideas/);
      assert.doesNotMatch(await (await three.request('/search?q=grinder', { jar: kim })).text(), /Espresso/);
      assert.match(await (await three.request('/settings', { jar: kim })).text(), /Kim · kim@example\.com/);
      const stranger = await three.request('/auth/google/start?return_to=/', { jar: new CookieJar() });
      assert.equal(stranger.status, 302, 'anyone may start signing in; only the three addresses get through');
    } finally {
      await three.close();
    }
  });

  test("the other person's private things are not found", async () => {
    await page(`/c/${ids.gifts}`, 404);
    await page(`/e/${ids.giftEntry}`, 404);
    await page(`/c/${ids.gifts}/settings`, 404);
    const res = await post(`/e/${ids.giftEntry}/delete`, {});
    assert.equal(res.status, 303);
    assert.equal(getEntryDetail(sam, ids.giftEntry).entry.deleted_at, null);
  });

  test('entry detail, edit, add log, edit log', async () => {
    const detail = await page(`/e/${ids.pho}`);
    assert.match(detail, /Originally said: “we went to pho 54 tonight, 4 out of 5”/);
    assert.match(detail, /Visits \(1\)/);
    const edit = await page(`/e/${ids.pho}/edit`);
    assert.match(edit, /name="f.price"/);
    let res = await post(`/e/${ids.pho}`, { title: 'Phở 54', rating: '4.5', 'f.cuisine': 'Vietnamese', 'f.price': '$$', 'f.status': 'been', 'f.website': 'pho54.example', tags: 'pho, vietnamese', notes: 'Try the bun bo hue.' });
    assert.equal(res.status, 303);
    let d = getEntryDetail(alex, ids.pho);
    assert.equal(d.entry.rating, 4.5);
    assert.equal(d.entry.rating_override, 4.5);
    assert.equal(d.fields.price, '$$');
    assert.equal(d.fields.website, 'https://pho54.example/');
    assert.deepEqual(d.tags, ['pho', 'vietnamese']);
    assert.equal(d.entry.notes, 'Try the bun bo hue.');
    const flashPage = await page(`/e/${ids.pho}`);
    assert.match(flashPage, /Updated &quot;Phở 54&quot;|Updated "Phở 54"/);
    assert.match(flashPage, /action="\/activity\/\d+\/undo"/);
    // invalid enum value re-renders the form with the error
    res = await post(`/e/${ids.pho}`, { title: 'Phở 54', rating: '4.5', 'f.price': 'cheap', tags: 'pho, vietnamese', notes: 'Try the bun bo hue.' });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /must be one of/);
    // no changes
    res = await post(`/e/${ids.pho}`, { title: 'Phở 54', rating: '4.5', 'f.cuisine': 'Vietnamese', 'f.price': '$$', 'f.status': 'been', 'f.website': 'https://pho54.example/', tags: 'pho, vietnamese', notes: 'Try the bun bo hue.' });
    assert.equal(res.status, 303);

    res = await post(`/e/${ids.pho}/logs`, { occurred_on: '2026-11-01', rating: '5', note: 'great again' });
    assert.equal(res.status, 303);
    d = getEntryDetail(alex, ids.pho);
    assert.equal(d.entry.log_count, 2);
    const logId = d.logs.find((l) => l.note === 'great again')!.id;
    await page(`/l/${logId}/edit`);
    res = await post(`/l/${logId}`, { occurred_on: '2026-10-31', rating: '4', note: 'great again' });
    assert.equal(res.status, 303);
    assert.equal(getEntryDetail(alex, ids.pho).logs.find((l) => l.id === logId)!.occurred_on, '2026-10-31');
  });

  test('quick add with duplicate warning, move, merge, delete, trash', async () => {
    let res = await post(`/c/${ids.restaurants}/entries`, { title: 'pho 54', rating: '', notes: '' });
    assert.equal(res.status, 200);
    const warn = await res.text();
    assert.match(warn, /possible duplicate in Restaurants/);
    assert.match(warn, /save anyway/);
    res = await post(`/c/${ids.restaurants}/entries`, { title: 'Taco Star', rating: '3', notes: '' });
    assert.equal(res.status, 303);
    const taco = Number(/\/e\/(\d+)/.exec(res.headers.get('location')!)![1]);

    await page(`/e/${taco}/move?to=${ids.movies}`);
    res = await post(`/e/${taco}/move`, { to: String(ids.movies) });
    assert.equal(res.status, 303);
    assert.equal(getEntryDetail(alex, taco).collection.id, ids.movies);

    const pick = await page(`/e/${ids.pho}/merge`);
    assert.match(pick, /Pho 54 Express/);
    const compare = await page(`/e/${ids.pho}/merge?with=${ids.phoExpress}`);
    assert.match(compare, /name="pick.price"/);
    res = await post(`/e/${ids.pho}/merge`, { with: String(ids.phoExpress), 'pick.price': 'dup', title: 'keep' });
    assert.equal(res.status, 303);
    const merged = getEntryDetail(alex, ids.pho);
    assert.equal(merged.entry.log_count, 3);
    assert.equal(merged.fields.price, '$');
    assert.match(merged.entry.notes, /Previous values before merging #\d+: price: \$\$/);

    res = await post(`/e/${taco}/delete`, {});
    assert.equal(res.status, 303);
    const trash = await page('/trash');
    assert.match(trash, /Taco Star/);
    res = await post(`/trash/${taco}/restore`, {});
    assert.equal(res.status, 303);
    assert.equal(getEntryDetail(alex, taco).entry.deleted_at, null);
    await post(`/e/${taco}/delete`, {});
    res = await post(`/trash/${taco}/purge`, {});
    assert.equal(res.status, 303);
    assert.equal(get(t.deps.db, 'SELECT count(*) AS n FROM entries WHERE id = ?', taco)!.n, 0);
  });

  test('activity and undo from the web', async () => {
    const activity = await page('/activity');
    assert.match(activity, /Merged/);
    const undoId = Number(/action="\/activity\/(\d+)\/undo"/.exec(activity)![1]);
    const res = await post(`/activity/${undoId}/undo`, {});
    assert.equal(res.status, 303);
    assert.match(await page('/activity'), /Undid:/);
  });

  test('collection settings: rename a field, add one, display hints, archive', async () => {
    const s = await page(`/c/${ids.restaurants}/settings`);
    const c = resolveCollection(alex, 'restaurants');
    const i = c.fields.findIndex((f) => f.key === 'cuisine');
    const form: Record<string, string | string[]> = {
      name: 'Restaurants',
      description: c.description,
      icon: '🍜',
      'new.key': 'parking',
      'new.type': 'boolean',
      'display.columns': ['food_type', 'rating', 'last_logged_on'],
      'display.sort': 'rating',
      'display.dir': 'desc',
      'display.subtitle': 'food_type',
      'display.log_noun': 'visit',
      'display.filters': ['status'],
    };
    c.fields.forEach((f, j) => {
      form[`field.${j}.key`] = f.key;
      form[`field.${j}.rename`] = j === i ? 'food_type' : f.key;
      form[`field.${j}.label`] = f.label ?? '';
      form[`field.${j}.description`] = f.description ?? '';
      if (f.type === 'enum') form[`field.${j}.options`] = (f.options ?? []).join(', ');
    });
    assert.match(s, /Move all entries/);
    const res = await post(`/c/${ids.restaurants}/settings`, form);
    assert.equal(res.status, 303);
    const after = resolveCollection(alex, 'restaurants');
    assert.ok(after.fields.some((f) => f.key === 'food_type'));
    assert.ok(after.fields.some((f) => f.key === 'parking' && f.type === 'boolean'));
    assert.equal(after.display.default_sort?.by, 'rating');
    assert.equal(getEntryDetail(alex, ids.pho).fields.food_type, 'Vietnamese');

    const arch = await post(`/c/${ids.movies}/archive`, { archived: '1' });
    assert.equal(arch.status, 303);
    assert.doesNotMatch(await page('/'), new RegExp(`href="/c/${ids.movies}-movies"`));
    await post(`/c/${ids.movies}/archive`, { archived: '0' });
    assert.match(await page('/'), new RegExp(`href="/c/${ids.movies}-movies"`));
  });

  test('settings, tokens, exports contain only visible data', async () => {
    const s = await page('/settings');
    assert.match(s, /alex@example.com/);
    const res = await post('/settings/tokens', { label: 'script', days: '1' });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /tma_pat_[A-Za-z0-9_-]+/);

    const dl = await t.request('/export/tracker.db', { jar });
    assert.equal(dl.status, 200);
    assert.match(dl.headers.get('content-disposition') ?? '', /attachment; filename="tracker-\d{4}-\d{2}-\d{2}\.db"/);
    const file = join(tmpdir(), `export-test-${Date.now()}.db`);
    try {
      writeFileSync(file, new Uint8Array(await dl.arrayBuffer()));
      const x = new DatabaseSync(file, { readOnly: true });
      try {
        const titles = (x.prepare('SELECT title FROM entries').all() as { title: string }[]).map((r) => r.title);
        assert.ok(titles.includes('Phở 54'));
        assert.ok(!titles.includes('Espresso grinder'));
        assert.equal((x.prepare("SELECT count(*) AS n FROM collections WHERE visibility = 'private'").get() as { n: number }).n, 0);
        assert.equal((x.prepare("SELECT count(*) AS n FROM activity WHERE summary LIKE '%grinder%' OR raw_text LIKE '%secret%'").get() as { n: number }).n, 0);
        assert.equal((x.prepare("SELECT count(*) AS n FROM entries_fts WHERE entries_fts MATCH 'pho'").get() as { n: number }).n >= 1, true);
      } finally {
        x.close();
      }
    } finally {
      rmSync(file, { force: true });
    }
    // The readable copy the download is built from does not outlive it, and one left by a stopped server is swept.
    const leftovers = () => readdirSync(tmpdir()).filter((name) => name.startsWith('tracker-export-'));
    assert.deepEqual(leftovers(), []);
    mkdirSync(join(tmpdir(), 'tracker-export-left-behind'));
    assert.equal(sweepExports(), 1);
    assert.deepEqual(leftovers(), []);
    const json = (await (await t.request('/export/tracker.json', { jar })).json()) as { entries: { title: string }[] };
    assert.ok(json.entries.some((e) => e.title === 'Phở 54'));
    assert.ok(!JSON.stringify(json).includes('grinder'));
  });

  test('static assets and PWA files', async () => {
    for (const p of ['/static/app.css', '/static/app.js', '/static/htmx.min.js', '/static/icons/icon-192.png', '/manifest.webmanifest', '/sw.js', '/offline.html']) {
      const res = await t.request(p);
      assert.equal(res.status, 200, p);
    }
    assert.notEqual((await t.request('/static/../config.ts')).status, 200);
    assert.equal((await t.request('/static/nope.css')).status, 404);
  });

  test('a session in use gets its cookie sent again, so the phone stays signed in', async () => {
    const sessionCookies = (res: Response) => res.headers.getSetCookie().filter((c) => c.startsWith('__Host-tracker_session='));
    assert.equal(sessionCookies(await t.request('/', { jar })).length, 0, 'nothing to renew right after sign-in');
    // After an hour of use the server extends the session. The cookie has to follow, or it runs out 30 days after sign-in.
    t.deps.store.db.prepare('UPDATE web_sessions SET last_seen_at = ?').run(new Date(Date.now() - 2 * 60 * 60_000).toISOString());
    const renewed = sessionCookies(await t.request('/', { jar }));
    assert.equal(renewed.length, 1);
    assert.ok(renewed[0].startsWith(`__Host-tracker_session=${jar.get('__Host-tracker_session')};`), 'same session, not a new one');
    assert.match(renewed[0], /Max-Age=2592000/);
    assert.equal(sessionCookies(await t.request('/', { jar })).length, 0, 'at most once an hour');
  });

  test('fields that act: copy buttons, tap to call, map and mail', async () => {
    const c = createCollection(alex, {
      name: 'Health',
      description: 'Doctors and clinics.',
      fields: [
        { key: 'phone', type: 'text' },
        { key: 'fax', type: 'text' },
        { key: 'address', type: 'text' },
        { key: 'email', type: 'text' },
        { key: 'portal', type: 'text' },
        { key: 'member_number', type: 'text' },
        { key: 'since', type: 'date' },
        { key: 'kind', type: 'enum', options: ['provider', 'pharmacy'] },
        { key: 'accepts_walk_ins', type: 'boolean' },
        { key: 'directions', type: 'text' },
      ],
    });
    assert.ok(c.ok);
    const e = createEntry(alex, {
      collection: 'health',
      title: 'Dr. Vega',
      fields: {
        phone: '(555) 555-0142 ext. 7',
        fax: '555-555-0143',
        address: '12 Elm St, Springfield, OH 45500',
        email: 'frontdesk@vega.example',
        portal: 'portal.vega.example/login',
        member_number: 'D123-4567 <A&B>',
        since: '2024-03-09',
        kind: 'provider',
        accepts_walk_ins: true,
        directions: `Park behind the building.\nSecond floor, suite 210.\n${'x'.repeat(320)}`,
      },
      raw_text: 'our doctor',
    });
    assert.ok(e.ok);
    const html = await page(`/e/${e.entryId}`);
    assert.match(html, /<a href="tel:5555550142">\(555\) 555-0142 ext\. 7<\/a>/);
    assert.match(html, /<a href="mailto:frontdesk@vega\.example">/);
    assert.match(html, /<a href="https:\/\/www\.google\.com\/maps\/search\/\?api=1&amp;query=12%20Elm%20St%2C%20Springfield%2C%20OH%2045500"/);
    assert.match(html, /<a href="https:\/\/portal\.vega\.example\/login"/);
    assert.doesNotMatch(html, /href="tel:5555550143"/, 'a fax number is not something to call');
    // Short values get a copy button holding exactly what is shown. Choices, yes/no and long text do not.
    const copies = [...html.matchAll(/data-copy="([^"]*)"/g)].map((m) => m[1]);
    assert.deepEqual(copies, [
      '(555) 555-0142 ext. 7',
      '555-555-0143',
      '12 Elm St, Springfield, OH 45500',
      'frontdesk@vega.example',
      'portal.vega.example/login',
      'D123-4567 &lt;A&amp;B&gt;',
      '03-09-2024',
    ]);
    assert.match(html, /aria-label="Copy Member number"/);
    assert.match(html, /data-share data-share-title="Dr\. Vega"/);
  });

  test('pins: a personal strip at the top of Home', async () => {
    assert.doesNotMatch(await page('/'), /<h2>Pinned<\/h2>/);
    let res = await post(`/e/${ids.pho}/pin`, { pinned: '1' });
    assert.equal(res.status, 303);
    const home = await page('/');
    assert.match(home, /<h2>Pinned<\/h2>/);
    assert.match(home, new RegExp(`<a href="/e/${ids.pho}" data-keep>`));
    assert.match(await page(`/e/${ids.pho}`), /name="pinned" value="0"/);
    // The other person's Home is their own.
    const samJar = await signInWeb(t, SAM);
    assert.doesNotMatch(await (await t.request('/', { jar: samJar })).text(), /<h2>Pinned<\/h2>/);
    // Nobody can pin what they cannot see.
    res = await post(`/e/${ids.giftEntry}/pin`, { pinned: '1' });
    assert.equal(res.status, 303);
    assert.equal(get(t.deps.db, 'SELECT count(*) AS n FROM pins WHERE entry_id = ?', ids.giftEntry)!.n, 0);
    // A pinned entry leaves the strip when it goes to the Trash, and can still be deleted for good.
    const tmp = createEntry(alex, { collection: 'movies', title: 'Pinned then purged', raw_text: 'x' });
    assert.ok(tmp.ok);
    await post(`/e/${tmp.entryId}/pin`, { pinned: '1' });
    await post(`/e/${tmp.entryId}/delete`, {});
    assert.doesNotMatch(await page('/'), new RegExp(`<a href="/e/${tmp.entryId}" data-keep>`));
    res = await post(`/trash/${tmp.entryId}/purge`, {});
    assert.equal(res.status, 303);
    assert.equal(get(t.deps.db, 'SELECT count(*) AS n FROM entries WHERE id = ?', tmp.entryId)!.n, 0);
    res = await post(`/e/${ids.pho}/pin`, { pinned: '0' });
    assert.equal(res.status, 303);
    assert.doesNotMatch(await page('/'), /<h2>Pinned<\/h2>/);
  });

  test('a pinned collection comes first on that person\'s Home', async () => {
    const order = (html: string) => [...html.matchAll(/<span class="name">(Movies|Restaurants)<\/span>/g)].map((m) => m[1]);
    assert.deepEqual(order(await page('/')), ['Movies', 'Restaurants'], 'by name until something is pinned');
    assert.match(await page(`/c/${ids.restaurants}`), /action="\/c\/\d+\/pin"[\s\S]*?name="pinned" value="1"/);

    let res = await post(`/c/${ids.restaurants}/pin`, { pinned: '1' });
    assert.equal(res.status, 303);
    const list = await page(`/c/${ids.restaurants}`);
    assert.match(list, /Pinned to the top of Home\./);
    assert.match(list, /name="pinned" value="0"/);
    const home = await page('/');
    assert.deepEqual(order(home), ['Restaurants', 'Movies']);
    assert.equal(home.match(/<span class="chip muted">Pinned<\/span>/g)?.length, 1);
    // The other person's Home is their own.
    const samJar = await signInWeb(t, SAM);
    const hers = await (await t.request('/', { jar: samJar })).text();
    assert.deepEqual(order(hers), ['Movies', 'Restaurants']);
    assert.doesNotMatch(hers, /<span class="chip muted">Pinned<\/span>/);
    // Nobody can pin a collection they cannot see.
    res = await post(`/c/${ids.gifts}/pin`, { pinned: '1' });
    assert.equal(res.status, 303);
    assert.equal(get(t.deps.db, 'SELECT count(*) AS n FROM collection_pins WHERE collection_id = ?', ids.gifts)!.n, 0);

    res = await post(`/c/${ids.restaurants}/pin`, { pinned: '0' });
    assert.equal(res.status, 303);
    assert.deepEqual(order(await page('/')), ['Movies', 'Restaurants']);
  });

  test('pages say whether the phone may keep a copy', async () => {
    const keep = async (path: string) => (await t.request(path, { jar })).headers.get('x-magpie-keep');
    await t.request('/', { jar });
    for (const path of ['/', `/c/${ids.restaurants}-restaurants`, `/c/${ids.restaurants}?sort=title`, `/e/${ids.pho}`, '/search?q=pho', '/activity']) {
      assert.equal(await keep(path), '1', path);
    }
    for (const path of [`/e/${ids.pho}/edit`, `/c/${ids.restaurants}/settings`, '/settings', '/trash', '/ask', '/e/999999']) {
      assert.equal(await keep(path), null, path);
    }
    // A page that is showing a one-time message is not kept: the message would show again from the copy.
    await post(`/e/${ids.pho}/pin`, { pinned: '1' });
    assert.equal(await keep(`/e/${ids.pho}`), null);
    assert.equal(await keep(`/e/${ids.pho}`), '1');
    await post(`/e/${ids.pho}/pin`, { pinned: '0' });
    await t.request('/', { jar });
    // The service worker's own refresh gets a plain "signed out" instead of a trip to the sign-in page.
    assert.equal((await t.request('/', { headers: { 'x-magpie-refresh': '1' } })).status, 401);
    assert.equal((await t.request('/')).status, 302);
  });

  test('the service worker agrees with the server on versions and on which pages may be kept', async () => {
    const worker = await (await t.request('/sw.js')).text();
    const version = /src="\/static\/app\.js\?v=(\d+)"/.exec(await page('/'))![1];
    assert.match(worker, new RegExp(`const VERSION = 'tracker-shell-${version}';`));
    assert.deepEqual([...worker.matchAll(/\?v=(\d+)'/g)].map((m) => m[1]), [version, version, version], 'every stored file carries the current version');
    const pattern = (source: string) => /const KEEPABLE = (\/.+\/);/.exec(source)![1];
    assert.equal(pattern(worker), pattern(readFileSync(new URL('../src/web/routes.ts', import.meta.url), 'utf8')));
  });

  test('Coming up: hiding a date from your own Home, and bringing it back', async () => {
    const soon = addDays(todayIn(t.deps.config.tz), 5);
    const far = addDays(todayIn(t.deps.config.tz), 45);
    const c = createCollection(alex, { name: 'Renewals', description: 'Things that run out.', fields: [{ key: 'due_date', type: 'date' }] });
    assert.ok(c.ok);
    const near = createEntry(alex, { collection: 'renewals', title: 'Passport renewal', fields: { due_date: soon }, raw_text: 'x' });
    const later = createEntry(alex, { collection: 'renewals', title: 'Lease runs out', fields: { due_date: far }, raw_text: 'x' });
    assert.ok(near.ok && later.ok);
    const coming = (html: string) => /<h2>Coming up<\/h2>([\s\S]*?)<\/section>/.exec(html)?.[1] ?? '';

    let home = await page('/');
    assert.match(coming(home), new RegExp(`Passport renewal[\\s\\S]*Due date ${usDate(soon)}[\\s\\S]*in 5 days`));
    assert.doesNotMatch(coming(home), /Lease runs out/, 'six weeks off is too far for Home');
    assert.match(coming(home), new RegExp(`name="entry" value="${near.entryId}" /><input type="hidden" name="field" value="due_date" />`));
    assert.doesNotMatch(coming(home), /hidden<\/a>/);

    const hide = { entry: String(near.entryId), field: 'due_date', date: soon };
    const noToken = await t.request('/coming-up/hide', { jar, method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: PUBLIC }, body: new URLSearchParams({ ...hide, hidden: '1' }).toString() });
    assert.equal(noToken.status, 403, 'needs the form token like any other post');
    let res = await post('/coming-up/hide', { ...hide, hidden: '1' });
    assert.deepEqual([res.status, res.headers.get('location')], [303, '/']);
    home = await page('/');
    assert.match(home, /Hidden from Coming up\./);
    assert.doesNotMatch(coming(home), /Passport renewal/);
    assert.match(coming(home), /<a href="\/coming-up">1 hidden<\/a>/);
    // The other person's Home is their own.
    const samJar = await signInWeb(t, SAM);
    assert.match(coming(await (await t.request('/', { jar: samJar })).text()), /Passport renewal/);

    const hiddenPage = await t.request('/coming-up', { jar });
    assert.equal(hiddenPage.headers.get('x-magpie-keep'), null, 'a page of buttons is not kept on the phone');
    assert.match(await hiddenPage.text(), /Passport renewal[\s\S]*name="hidden" value="0"[\s\S]*Show again/);
    res = await post('/coming-up/hide', { ...hide, hidden: '0' });
    assert.deepEqual([res.status, res.headers.get('location')], [303, '/coming-up']);
    assert.match(await page('/coming-up'), /Back in Coming up\.[\s\S]*Nothing is hidden\./);
    assert.match(coming(await page('/')), /Passport renewal/);

    // A date on an entry this person cannot see is refused, and nothing is stored.
    res = await post('/coming-up/hide', { entry: String(ids.giftEntry), field: 'due_date', date: soon, hidden: '1' });
    assert.equal(res.status, 303);
    assert.equal(get(t.deps.db, 'SELECT count(*) AS n FROM hidden_dates')!.n, 0);
  });

  test('a slow page load reported by a phone shows on Settings', async () => {
    assert.match(await page('/settings'), /Slow page loads[\s\S]*None noted/);
    const send = (body: unknown, headers: Record<string, string> = { 'x-csrf-token': csrf }) =>
      t.request('/beacon', { jar, method: 'POST', headers: { 'content-type': 'application/json', origin: PUBLIC, ...headers }, body: JSON.stringify(body) });
    assert.equal((await send({ path: '/e/42?before=7', total: 4847, startup: 120, connect: 300, wait: 4200, download: 40, render: 187, kind: 'navigate', network: '4g' })).status, 204);
    assert.equal((await send({ path: '/', total: 300 })).status, 204, 'quick loads are not kept');
    assert.equal((await send({ path: '/', total: 9000 }, {})).status, 403, 'needs the form token like any other post');
    assert.match(await page('/settings'), /Alex · an entry · 4\.8 s, mostly waiting for the server \(4g\)/);
    assert.equal(get(t.deps.db, 'SELECT count(*) AS n FROM slow_loads')!.n, 1);
    assert.equal(get<{ page: string }>(t.deps.db, 'SELECT page FROM slow_loads')!.page, '/e/N', 'which entry it was is not stored');
  });
});
