import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { addMessage, clearChat, contextTurns, recentMessages } from '../src/assistant/history.ts';
import { all, get } from '../src/db/sqlite.ts';
import { createCollection } from '../src/domain/collections.ts';
import { createEntry, purgeEntry, deleteItem } from '../src/domain/entries.ts';
import { cleanupFiles, readAttachment, sniffMime } from '../src/domain/files.ts';
import { todayIn } from '../src/domain/time.ts';
import { comingUp } from '../src/domain/upcoming.ts';
import type { Ctx } from '../src/domain/types.ts';
import { findUserByEmail } from '../src/domain/users.ts';
import { CookieJar, ALEX, SAM, PUBLIC, signInWeb, startTestApp, type TestApp } from './app-helpers.ts';
import { ok } from './helpers.ts';

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('not really a photo, but it starts like one')]);
const LICENSE_NUMBER = '94-221-7716';

let t: TestApp;
let jar: CookieJar;
let samJar: CookieJar;
let csrf: string;
let samCsrf: string;
let alex: Ctx;
let docs: number;
let license: number;
const apiCalls: { body: any; key: string | null }[] = [];
let script: ((body: any) => unknown)[] = [];

function ctxFor(email: string, name: string): Ctx {
  const u = findUserByEmail(t.deps.db, email)!;
  return { db: t.deps.db, tz: t.deps.config.tz, actor: { userId: u.id, name, via: 'mcp', client: 'test' } };
}

async function csrfOf(j: CookieJar) {
  const home = await t.request('/', { jar: j });
  return /<meta name="csrf-token" content="([^"]+)"/.exec(await home.text())![1];
}

function upload(path: string, fields: Record<string, string>, file?: { name: string; bytes: Uint8Array; field?: string }, who = { jar, csrf }) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  if (file) form.set(file.field ?? 'photo', new File([file.bytes as Uint8Array<ArrayBuffer>], file.name));
  return t.request(path, { jar: who.jar, method: 'POST', headers: { origin: PUBLIC, 'x-csrf-token': who.csrf, accept: 'application/json' }, body: form });
}

async function mcpClient(email: string) {
  const u = findUserByEmail(t.deps.db, email)!;
  const authInfo = { token: 't', clientId: 'https://claude.ai/test', scopes: ['tracker'], extra: { userId: u.id, clientName: 'test' } };
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL('http://tracker.test/mcp'), { fetch: (url, init) => t.deps.mcpFetch!(new Request(url, init), authInfo) }));
  return client;
}
const textOf = (r: unknown) => (r as { content: { text: string }[] }).content.map((x) => x.text).join('\n');

before(async () => {
  t = await startTestApp({ FILES_KEY: randomBytes(32).toString('base64'), ANTHROPIC_API_KEY: 'sk-ant-test-key' });
  t.deps.assistantFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init!.body));
    apiCalls.push({ body, key: new Headers(init!.headers).get('x-api-key') });
    const next = script.shift();
    if (!next) return new Response(JSON.stringify({ content: [{ type: 'text', text: 'Nothing scripted.' }], stop_reason: 'end_turn' }));
    const out = next(body);
    return out instanceof Response ? out : new Response(JSON.stringify(out));
  }) as typeof fetch;
  jar = await signInWeb(t, ALEX);
  samJar = await signInWeb(t, SAM);
  csrf = await csrfOf(jar);
  samCsrf = await csrfOf(samJar);
  alex = ctxFor('alex@example.com', 'Alex');
  const c = createCollection(alex, { name: 'Personal documents', description: 'IDs, licenses, policy and account numbers.', private: true, sensitive: true, confirm_new: true, fields: [{ key: 'number', type: 'text' }] });
  assert.ok(c.ok);
  docs = c.collectionId!;
  const e = createEntry(alex, { collection: 'Personal documents', title: "Driver's license", fields: { number: LICENSE_NUMBER }, notes: 'Ohio, expires 2030.', raw_text: 'my license' });
  assert.ok(e.ok, JSON.stringify(e));
  license = e.entryId!;
});
after(() => t.close());

describe('photos', () => {
  test('types are decided from the bytes', () => {
    assert.equal(sniffMime(JPEG), 'image/jpeg');
    assert.equal(sniffMime(Buffer.from('%PDF-1.7 ...')), 'application/pdf');
    assert.equal(sniffMime(Buffer.from('<html><script>alert(1)</script>')), undefined);
  });

  test('upload, encrypted at rest, served back only to people who can see the entry', async () => {
    const res = await upload(`/e/${license}/photos`, {}, { name: 'license front.jpg', bytes: JPEG });
    assert.equal(res.status, 200);
    const row = get<{ id: number; mime: string; filename: string }>(t.deps.db, 'SELECT * FROM attachments WHERE entry_id = ?', license)!;
    assert.equal(row.mime, 'image/jpeg');
    const onDisk = readFileSync(`${t.deps.config.filesDir}/${row.id}.enc`);
    assert.ok(!onDisk.includes(Buffer.from('not really a photo')), 'stored bytes must be encrypted');
    assert.equal(onDisk.length, JPEG.length + 28);

    const mine = await t.request(`/files/${row.id}`, { jar });
    assert.equal(mine.status, 200);
    assert.equal(mine.headers.get('content-type'), 'image/jpeg');
    assert.match(mine.headers.get('content-security-policy') ?? '', /default-src 'none'/);
    assert.equal(mine.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(Buffer.from(await mine.arrayBuffer()), JPEG);

    // The collection is private to Alex: Sam gets nothing, signed-out visitors get the sign-in page.
    assert.equal((await t.request(`/files/${row.id}`, { jar: samJar })).status, 404);
    assert.equal((await t.request(`/files/${row.id}`)).status, 302);
    const samDelete = await t.request(`/files/${row.id}/delete`, { jar: samJar, method: 'POST', headers: { origin: PUBLIC, 'x-csrf-token': samCsrf } });
    assert.equal(samDelete.status, 404);

    const page = await (await t.request(`/e/${license}`, { jar })).text();
    assert.match(page, new RegExp(`<img src="/files/${row.id}"`));
  });

  test('refuses things that are not photos, and uploads without the form token', async () => {
    await upload(`/e/${license}/photos`, {}, { name: 'page.jpg', bytes: Buffer.from('<html><script>alert(1)</script></html>') });
    assert.equal(get<{ n: number }>(t.deps.db, 'SELECT count(*) AS n FROM attachments WHERE entry_id = ?', license)!.n, 1);
    const form = new FormData();
    form.set('photo', new File([JPEG], 'x.jpg'));
    const res = await t.request(`/e/${license}/photos`, { jar, method: 'POST', headers: { origin: PUBLIC }, body: form });
    assert.equal(res.status, 403);
    const big = await upload(`/e/${license}/photos`, {}, { name: 'big.jpg', bytes: Buffer.concat([JPEG, Buffer.alloc(13 * 1024 * 1024)]) });
    assert.equal(big.status, 413);
  });

  test('a wrong key cannot open stored photos', () => {
    const row = get<{ id: number }>(t.deps.db, 'SELECT id FROM attachments WHERE entry_id = ?', license)!;
    assert.throws(() => readAttachment(alex, { dir: t.deps.config.filesDir, key: randomBytes(32) }, row.id), /can't be decrypted/);
  });

  test('deleting an entry forever removes its photos from the disk', async () => {
    const e = createEntry(alex, { collection: 'Personal documents', title: 'Old passport card', raw_text: 'old card' });
    assert.ok(e.ok);
    await upload(`/e/${e.entryId}/photos`, {}, { name: 'card.png', bytes: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png body')]) });
    const row = get<{ id: number }>(t.deps.db, 'SELECT id FROM attachments WHERE entry_id = ?', e.entryId!)!;
    assert.ok(readdirSync(t.deps.config.filesDir).includes(`${row.id}.enc`));
    ok(deleteItem(alex, { entry_id: e.entryId! }));
    ok(purgeEntry({ ...alex, actor: { ...alex.actor, via: 'web' } }, e.entryId!));
    cleanupFiles({ db: t.deps.db }, { dir: t.deps.config.filesDir, key: t.deps.config.filesKey });
    assert.ok(!readdirSync(t.deps.config.filesDir).includes(`${row.id}.enc`));
  });
});

describe('sensitive collections', () => {
  test('search finds the entry by any word but shows only its title; get_entry shows everything', async () => {
    const client = await mcpClient('alex@example.com');
    for (const q of ['license', 'ohio', LICENSE_NUMBER]) {
      const found = textOf(await client.callTool({ name: 'search_entries', arguments: { query: q } }));
      assert.match(found, new RegExp(`#${license} Driver's license`), q);
      assert.match(found, /get_entry/);
      assert.ok(!found.includes('expires 2030'), `details leaked for ${q}: ${found}`);
      if (q !== LICENSE_NUMBER) assert.ok(!found.includes(LICENSE_NUMBER), `number leaked for ${q}: ${found}`);
    }
    const full = textOf(await client.callTool({ name: 'get_entry', arguments: { entry_id: license } }));
    assert.match(full, new RegExp(LICENSE_NUMBER));
    assert.match(full, /Photos: 1/);
    assert.match(textOf(await client.callTool({ name: 'list_collections', arguments: {} })), /Personal documents.*sensitive/s);
    const sql = textOf(await client.callTool({ name: 'query_sql', arguments: { sql: 'SELECT title, fields FROM entries' } }));
    assert.ok(!sql.includes(LICENSE_NUMBER) && !sql.includes("Driver's license"), sql);
    await client.close();

    const sam = await mcpClient('sam@example.com');
    assert.ok(!textOf(await sam.callTool({ name: 'search_entries', arguments: { query: 'license' } })).includes("Driver's license"));
    await sam.close();
  });

  test('the web search shows it normally, and the setting can be changed in the web app', async () => {
    const html = await (await t.request('/search?q=license', { jar })).text();
    assert.match(html, /Driver&#39;s license|Driver's license/);
    const settings = await (await t.request(`/c/${docs}/settings`, { jar })).text();
    assert.match(settings, /name="sensitive" value="1" checked/);
  });
});

/** Sends a chat message the way the page's script does and returns the stream's lines. */
async function chat(text: string, file?: { name: string; bytes: Uint8Array } | { name: string; bytes: Uint8Array }[], who = { jar, csrf }) {
  const form = new FormData();
  form.set('text', text);
  for (const f of file ? [file].flat() : []) form.append('photo', new File([f.bytes as Uint8Array<ArrayBuffer>], f.name));
  const res = await t.request('/ask', { jar: who.jar, method: 'POST', headers: { origin: PUBLIC, 'x-csrf-token': who.csrf, accept: 'application/x-ndjson' }, body: form });
  const raw = await res.text();
  assert.match(res.headers.get('content-type') ?? '', /ndjson/, raw.slice(0, 200));
  const lines = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { step?: string; html?: string; error?: string });
  return { status: res.status, lines, last: lines.at(-1)!, steps: lines.flatMap((l) => (l.step ? [l.step] : [])) };
}
const textReply = (text: string) => () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });

describe('the Ask box', () => {
  test('runs the tools as the signed-in person, on the household key, and attaches a photo', async () => {
    const sam = { jar: samJar, csrf: samCsrf };
    script = [
      (body) => {
        assert.equal(body.model, 'claude-sonnet-5-5');
        assert.ok(body.tools.some((x: { name: string }) => x.name === 'create_entry'));
        assert.ok(body.tools.some((x: { name: string }) => x.name === 'attach_photo'));
        assert.match(body.system[0].text, /Magpie/);
        const first = body.messages.at(-1).content;
        assert.equal(first[0].type, 'image');
        assert.equal(first[1].text, 'keep this receipt for the tires', "the person's words stay free of app notes");
        const uploadId = Number(/upload_id is (\d+)/.exec(first[2].text)![1]);
        // The collection list comes with the message, so the model need not spend a round trip asking for it.
        assert.match(first[3].text, /^App note, not the user's words: this is what list_collections returns right now\.\nToday: \d{4}-\d{2}-\d{2} .*Acting for: Sam\./);
        assert.ok(!first[3].text.includes('Personal documents'), "Sam's list leaves out Alex's private collection");
        return {
          stop_reason: 'tool_use',
          content: [
            { type: 'tool_use', id: 'a', name: 'create_collection', input: { name: 'Receipts', description: 'Receipts worth keeping.', confirm_new: true, fields: [], raw_text: 'keep this receipt for the tires' } },
            { type: 'tool_use', id: 'b', name: 'search_entries', input: { query: 'license' } },
            { type: 'tool_use', id: 'c', name: 'attach_photo', input: { upload_id: uploadId, entry_id: 999999 } },
          ],
        };
      },
      (body) => {
        const results = body.messages.at(-1).content;
        assert.equal(results.length, 3);
        assert.match(results[0].content, /Receipts/);
        assert.ok(!results[1].content.includes("Driver's license"), 'Sam must not see Alex\'s private collection');
        assert.equal(results[2].is_error, true);
        return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'd', name: 'create_entry', input: { collection: 'Receipts', title: 'Costco tires', raw_text: 'keep this receipt for the tires' } }] };
      },
      (body) => {
        const id = Number(/#(\d+)/.exec(body.messages.at(-1).content[0].content)![1]);
        const uploadId = Number(/upload_id is (\d+)/.exec(JSON.stringify(body.messages))![1]);
        return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'e', name: 'attach_photo', input: { upload_id: uploadId, entry_id: id } }] };
      },
      textReply('Saved the Costco tires receipt with its photo.'),
    ];
    const r = await chat('keep this receipt for the tires', { name: 'receipt.jpg', bytes: JPEG }, sam);
    assert.equal(r.status, 200);
    assert.deepEqual(r.steps, ['Making a new collection', 'Searching', 'Attaching the photo', 'Saving', 'Attaching the photo']);
    assert.equal(apiCalls.length, 4);
    assert.ok(apiCalls.every((c) => c.key === 'sk-ant-test-key'));
    const entry = get<{ id: number; created_by: number }>(t.deps.db, "SELECT id, created_by FROM entries WHERE title = 'Costco tires'")!;
    assert.equal(entry.created_by, findUserByEmail(t.deps.db, 'sam@example.com')!.id);
    assert.equal(get<{ n: number }>(t.deps.db, 'SELECT count(*) AS n FROM attachments WHERE entry_id = ?', entry.id)!.n, 1);
    const acts = all<{ via: string; client: string | null; action: string }>(t.deps.db, 'SELECT via, client, action FROM activity WHERE entry_id = ? ORDER BY id', entry.id);
    assert.deepEqual(acts.map((a) => a.action), ['create_entry', 'add_photo']);
    assert.equal(acts[0].via, 'mcp');
    assert.equal(acts[0].client, 'Magpie app');

    // The reply arrives as a ready-made bubble with a card for what it saved.
    assert.match(r.last.html!, /Saved the Costco tires receipt with its photo\./);
    assert.match(r.last.html!, new RegExp(`<a href="/e/${entry.id}">[\\s\\S]*Costco tires[\\s\\S]*Saved in Receipts`));

    // The conversation is kept, per person, with the photo that was sent.
    script = [(body) => {
      assert.equal(body.messages.length, 3);
      assert.equal(body.messages[0].content, 'keep this receipt for the tires');
      assert.equal(body.messages[1].content, 'Saved the Costco tires receipt with its photo.');
      assert.ok(!body.tools.some((x: { name: string }) => x.name === 'attach_photo'));
      return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Yes.' }] };
    }];
    assert.match((await chat('did that work?', undefined, sam)).last.html!, /Yes\./);
    const hers = await (await t.request('/ask', { jar: samJar })).text();
    assert.match(hers, /class="chat-page"/);
    assert.match(hers, /keep this receipt for the tires[\s\S]*Saved the Costco tires receipt[\s\S]*did that work\?/);
    assert.match(hers, /<img src="\/files\/\d+"/);
    assert.match(hers, /id="chat-empty" hidden/);
    const his = await (await t.request('/ask', { jar })).text();
    assert.ok(!his.includes('keep this receipt') && !his.includes('did that work'), 'chats are per person');
    assert.match(his, /id="chat-empty"\s*>/);
    assert.match(his, /data-suggest="Tell me about Costco tires" data-send/, 'suggestions come from what is shared, never from private or sensitive entries');
    assert.ok(!/data-suggest="[^"]*license/i.test(his));
  });

  test('links entries the answer mentions, only for people who can see them, and never trusts the reply as HTML', async () => {
    script = [textReply(`Your license is on file (#${license}). <img src=x onerror=alert(1)>\n- **Class D**\n- expires 2030`)];
    const mine = await chat('do I have my license saved?');
    assert.ok(!mine.last.html!.includes('(#'), mine.last.html!);
    assert.match(mine.last.html!, new RegExp(`<a href="/e/${license}">[\\s\\S]*Driver&#39;s license[\\s\\S]*Personal documents`));
    assert.match(mine.last.html!, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.match(mine.last.html!, /<ul><li><strong>Class D<\/strong><\/li><li>expires 2030<\/li><\/ul>/);

    script = [textReply(`There is something at (#${license}).`)];
    const hers = await chat('what is entry ' + license, undefined, { jar: samJar, csrf: samCsrf });
    assert.ok(!hers.last.html!.includes(`/e/${license}`) && !hers.last.html!.includes('license'), hers.last.html!);
  });

  test('explains problems in plain words, keeps failed turns out of the history, and needs the form token', async () => {
    const before = get<{ n: number }>(t.deps.db, 'SELECT count(*) AS n FROM chat_messages')!.n;
    script = [() => new Response('{"error":{"message":"invalid x-api-key"}}', { status: 401 })];
    const r = await chat('hello');
    assert.match(r.last.error!, /API key was rejected/);
    assert.equal(get<{ n: number }>(t.deps.db, 'SELECT count(*) AS n FROM chat_messages')!.n, before);
    assert.match((await chat('   ')).last.error!, /Type something/);
    const form = new FormData();
    form.set('text', 'hello');
    assert.equal((await t.request('/ask', { jar, method: 'POST', headers: { origin: PUBLIC }, body: form })).status, 403);
    assert.equal((await t.request('/ask', { method: 'POST', headers: { origin: PUBLIC }, body: form })).status, 302);
  });

  test('works as a plain form too, and Clear chat empties only your own conversation', async () => {
    script = [textReply('Noted.')];
    const form = new FormData();
    form.set('text', 'plain form message');
    form.set('_csrf', csrf);
    const res = await t.request('/ask', { jar, method: 'POST', headers: { origin: PUBLIC }, body: form });
    assert.equal(res.status, 303);
    assert.match(await (await t.request('/ask', { jar })).text(), /plain form message[\s\S]*Noted\./);

    const reset = await t.request('/ask/reset', { jar, method: 'POST', headers: { origin: PUBLIC, 'x-csrf-token': csrf } });
    assert.equal(reset.status, 303);
    assert.ok(!(await (await t.request('/ask', { jar })).text()).includes('plain form message'));
    assert.match(await (await t.request('/ask', { jar: samJar })).text(), /Saved the Costco tires receipt/);
  });

  test('is set up to answer quickly: low effort, cached instructions, room for a long save', async () => {
    script = [textReply('Hello.')];
    await chat('hi');
    const body = apiCalls.at(-1)!.body;
    assert.deepEqual(body.output_config, { effort: 'low' });
    assert.equal(body.max_tokens, 16000);
    assert.deepEqual(body.cache_control, { type: 'ephemeral' });
    assert.deepEqual(body.system.map((b: { cache_control?: unknown }) => b.cache_control), [{ type: 'ephemeral' }]);
    assert.ok(!/\d{4}-\d{2}-\d{2}/.test(body.system[0].text), 'nothing that changes from day to day sits in the cached part');
  });

  test('a reply that is cut off or declined runs none of its tool calls', async () => {
    const entries = () => get<{ n: number }>(t.deps.db, 'SELECT count(*) AS n FROM entries')!.n;
    const before = entries();
    script = [() => ({ stop_reason: 'max_tokens', content: [{ type: 'tool_use', id: 'x', name: 'create_entry', input: { collection: 'Receipts', title: 'Half a rec' } }] })];
    let r = await chat('a very long recipe');
    assert.match(r.last.html!, /too much to handle in one go and nothing was saved/);
    assert.deepEqual(r.steps, []);
    assert.equal(entries(), before);

    script = [() => ({ stop_reason: 'max_tokens', content: [{ type: 'text', text: 'Here is the first part' }] })];
    r = await chat('tell me everything');
    assert.match(r.last.html!, /Here is the first part \(That was as much as fits in one reply\.\)/);

    script = [() => ({ stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'general_harms' }, content: [{ type: 'tool_use', id: 'y', name: 'delete_item', input: { entry_id: license } }] })];
    r = await chat('something the model will not do');
    assert.match(r.last.html!, /I can(&#39;|')t help with that one/);
    assert.deepEqual(r.steps, []);
    assert.equal(get<{ deleted_at: string | null }>(t.deps.db, 'SELECT deleted_at FROM entries WHERE id = ?', license)!.deleted_at, null);
  });

  test('a PDF is handed to the model to read, not just attached', async () => {
    script = [
      (body) => {
        const first = body.messages.at(-1).content;
        assert.deepEqual(first[0], { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from('%PDF-1.7 policy text').toString('base64') } });
        assert.equal(first[1].text, 'file this policy');
        assert.ok(body.tools.some((x: { name: string }) => x.name === 'attach_photo'));
        return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Read it.' }] };
      },
    ];
    assert.match((await chat('file this policy', { name: 'policy.pdf', bytes: Buffer.from('%PDF-1.7 policy text') })).last.html!, /Read it\./);
  });

  test('several files can ride on one message, and each is kept with the entry', async () => {
    const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('the back of the card')]);
    const uploadIds = (body: any) => /upload_ids are ([\d, ]+)\./.exec(JSON.stringify(body.messages))![1].split(', ').map(Number);
    script = [
      (body) => {
        const first = body.messages.at(-1).content;
        assert.deepEqual(first.slice(0, 3).map((b: { type: string }) => b.type), ['image', 'image', 'text']);
        assert.deepEqual(first.slice(0, 2).map((b: { source: { media_type: string } }) => b.source.media_type), ['image/jpeg', 'image/png']);
        assert.equal(first[2].text, 'front and back of my library card');
        assert.match(first[3].text, /^App note, not the user's words: 2 files came with this message, in the order shown\./);
        assert.equal(uploadIds(body).length, 2);
        return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'm1', name: 'create_entry', input: { collection: 'Receipts', title: 'Library card', raw_text: 'front and back of my library card' } }] };
      },
      (body) => {
        const id = Number(/#(\d+)/.exec(body.messages.at(-1).content[0].content)![1]);
        return { stop_reason: 'tool_use', content: uploadIds(body).map((u, i) => ({ type: 'tool_use', id: `a${i}`, name: 'attach_photo', input: { upload_id: u, entry_id: id } })) };
      },
      textReply('Saved your library card with both sides.'),
    ];
    const r = await chat('front and back of my library card', [
      { name: 'front.jpg', bytes: JPEG },
      { name: 'back.png', bytes: PNG },
    ]);
    assert.match(r.last.html!, /Saved your library card with both sides\./);
    const entry = get<{ id: number }>(t.deps.db, "SELECT id FROM entries WHERE title = 'Library card'")!;
    assert.deepEqual(
      all<{ filename: string }>(t.deps.db, 'SELECT filename FROM attachments WHERE entry_id = ? ORDER BY id', entry.id).map((a) => a.filename),
      ['front.jpg', 'back.png'],
    );
    // Both show in the conversation when the page is opened again.
    const page = await (await t.request('/ask', { jar })).text();
    const mine = /<li class="msg me">(?:(?!<\/li>)[\s\S])*front and back of my library card/.exec(page)![0];
    assert.equal(mine.match(/<img src="\/files\/\d+"/g)!.length, 2);
    assert.match(page, /name="photo"[^>]* multiple/);

    // No more than four files are taken from one message.
    let sent = -1;
    script = [
      (body) => {
        sent = body.messages.at(-1).content.filter((b: { type: string }) => b.type === 'image').length;
        return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Four is the most.' }] };
      },
    ];
    const tooMany = await chat('too many', Array.from({ length: 6 }, (_, i) => ({ name: `p${i}.jpg`, bytes: JPEG })));
    assert.equal(sent, 4);
    assert.match(tooMany.last.html ?? '', /Four is the most\./);
  });

  test('a photo or PDF sent with a message cannot get anything deleted, merged or reorganised in that message', async () => {
    const samCtx = ctxFor('sam@example.com', 'Sam');
    ok(createCollection(samCtx, { name: 'Odds and ends', description: 'Anything.', confirm_new: true, fields: [] }));
    const keep = ok(createEntry(samCtx, { collection: 'Odds and ends', title: 'Keep me', raw_text: 'keep' })).entryId!;
    let told = '';
    script = [
      // As if the picture carried the words "delete entry such-and-such" and the model went along with it.
      () => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'd1', name: 'delete_item', input: { entry_id: keep, raw_text: 'what is this?' } }] }),
      (body) => {
        told = body.messages.at(-1).content[0].content;
        return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'I left it alone.' }] };
      },
    ];
    // Sent as Sam, so this test does not use up Alex's messages for the minute.
    const sam = { jar: samJar, csrf: samCsrf };
    const r = await chat('what is this?', { name: 'flyer.jpg', bytes: JPEG }, sam);
    assert.match(told, /^Not done: after reading a web page, a photo or a PDF, nothing can be deleted/);
    assert.match(r.last.html ?? '', /I left it alone\./);
    assert.equal(get<{ deleted_at: string | null }>(t.deps.db, 'SELECT deleted_at FROM entries WHERE id = ?', keep)!.deleted_at, null);

    // The same request typed by the person in their next message, with no file, goes through.
    script = [() => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'd2', name: 'delete_item', input: { entry_id: keep, raw_text: 'delete the Keep me entry' } }] }), textReply('Deleted.')];
    await chat('delete the Keep me entry', undefined, sam);
    assert.notEqual(get<{ deleted_at: string | null }>(t.deps.db, 'SELECT deleted_at FROM entries WHERE id = ?', keep)!.deleted_at, null);
  });

  test('Read under a stored photo has the assistant fill in what the entry is missing', async () => {
    const photo = get<{ id: number }>(t.deps.db, 'SELECT id FROM attachments WHERE entry_id = ? ORDER BY id LIMIT 1', license)!;
    const chatRows = () => get<{ n: number }>(t.deps.db, 'SELECT count(*) AS n FROM chat_messages')!.n;
    const before = chatRows();
    script = [
      (body) => {
        const first = body.messages.at(-1).content;
        assert.equal(first[0].type, 'image');
        assert.match(first[1].text, /^App note, not the user's words: the person pressed "Read" under a photo on entry #\d+ in Personal documents\./);
        assert.match(first[1].text, /For raw_text use exactly: Read from the photo "license front\.jpg"\./);
        assert.match(first[1].text, new RegExp(`This is the entry as it stands:\\n#${license} Driver's license`));
        assert.equal(body.messages.length, 1, 'the chat so far has no part in it');
        assert.deepEqual(body.tools.map((x: { name: string }) => x.name).sort(), ['get_entry', 'update_entry'], 'only what the job needs: no web lookups, nothing that deletes or creates');
        return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'r1', name: 'update_entry', input: { entry_id: license, append_note: 'Class D. Organ donor.', raw_text: 'Read from the photo "license front.jpg".' } }] };
      },
      textReply('Added the class and donor status from the card.'),
    ];
    const res = await upload(`/files/${photo.id}/read`, {});
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), `/e/${license}`);
    const page = await (await t.request(`/e/${license}`, { jar })).text();
    assert.match(page, /Added the class and donor status from the card\./);
    assert.match(page, /Class D\. Organ donor\./);
    assert.match(page, new RegExp(`action="/files/${photo.id}/read"`));
    assert.match(page, /Updated (&quot;|")Driver(&#39;|')s license(&quot;|"): note added/, 'the change is in the entry history, where it can be undone');
    assert.equal(chatRows(), before, 'it is not a chat message');

    // Someone who cannot see the entry cannot have its photo read.
    const hers = await t.request(`/files/${photo.id}/read`, { jar: samJar, method: 'POST', headers: { origin: PUBLIC, 'x-csrf-token': samCsrf } });
    assert.equal(hers.status, 404);
  });

  test('looks things up on the web, carries on after a paused turn, and shows where facts came from', async () => {
    script = [
      (body) => {
        const types = body.tools.map((x: { type?: string }) => x.type).filter(Boolean);
        assert.deepEqual(types, ['web_search_20260209', 'web_fetch_20260209']);
        assert.match(body.system[0].text, /never put ID numbers/);
        assert.match(body.system[0].text, /MM-DD-YYYY/);
        return { stop_reason: 'pause_turn', content: [{ type: 'text', text: 'Let me check.' }, { type: 'server_tool_use', id: 'srv1', name: 'web_search', input: { query: 'Luna Trattoria Riverton' } }] };
      },
      (body) => {
        assert.equal(body.messages.at(-1).role, 'assistant', 'a paused turn is sent straight back');
        return {
          stop_reason: 'end_turn',
          content: [
            { type: 'web_search_tool_result', tool_use_id: 'srv1', content: [] },
            { type: 'text', text: 'Luna Trattoria is a ' },
            { type: 'text', text: 'family-run regional chain', citations: [{ type: 'web_search_result_location', url: 'https://www.lunatrattoria.example/about', title: 'About Luna' }, { url: 'javascript:alert(1)', title: 'bad' }] },
            { type: 'text', text: ' with a Riverton location.' },
          ],
        };
      },
    ];
    const r = await chat('what is Luna?');
    assert.match(r.last.html!, /Luna Trattoria is a family-run regional chain with a Riverton location\./);
    assert.ok(!r.last.html!.includes('Let me check'));
    assert.match(r.last.html!, /From the web: <a href="https:\/\/www\.lunatrattoria\.example\/about"[^>]*rel="noopener noreferrer"[^>]*>lunatrattoria\.example<\/a>/);
    assert.ok(!r.last.html!.includes('javascript:'));
    assert.match(await (await t.request('/ask', { jar })).text(), /From the web: <a href="https:\/\/www\.lunatrattoria\.example\/about"/);

    assert.match(await (await t.request('/settings', { jar })).text(), /Ask uses claude-sonnet-5-5\. Web research is on\./);

    // A model or key that does not take the current web tools gets the earlier ones, and that is remembered.
    script = [
      () => new Response('{"error":{"message":"tools.13: unknown tool type web_search_20260209"}}', { status: 400 }),
      (body) => {
        assert.deepEqual(body.tools.map((x: { type?: string }) => x.type).filter(Boolean), ['web_search_20250305', 'web_fetch_20250910']);
        return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Using the earlier ones.' }] };
      },
      (body) => {
        assert.deepEqual(body.tools.map((x: { type?: string }) => x.type).filter(Boolean), ['web_search_20250305', 'web_fetch_20250910']);
        return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Remembered.' }] };
      },
    ];
    assert.match((await chat('hello')).last.html!, /Using the earlier ones\./);
    assert.match((await chat('hello once more')).last.html!, /Remembered\./);

    // If the organization has web tools switched off altogether, the chat keeps working without them and says so.
    script = [
      () => new Response('{"error":{"message":"web_search is not enabled for this organization"}}', { status: 400 }),
      (body) => {
        assert.ok(!body.tools.some((x: { type?: string }) => x.type));
        assert.match(body.system[0].text, /cannot look anything up/);
        return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Still here.' }] };
      },
    ];
    assert.match((await chat('hello again')).last.html!, /Still here\./);
    assert.match(await (await t.request('/settings', { jar })).text(), /Web research is off: the Anthropic API turned it down/);
  });

  test('a model that does not take the effort setting still answers', async () => {
    const other = await startTestApp({ ANTHROPIC_API_KEY: 'sk-ant-test-key', ASSISTANT_MODEL: 'an-older-model', ASSISTANT_EFFORT: 'medium', ASSISTANT_WEB: '0' });
    try {
      const bodies: any[] = [];
      other.deps.assistantFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init!.body));
        bodies.push(body);
        if (body.output_config) return new Response('{"error":{"message":"output_config.effort: this model does not support effort"}}', { status: 400 });
        return new Response(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Fine without it.' }] }));
      }) as typeof fetch;
      const j = await signInWeb(other, ALEX);
      const token = /<meta name="csrf-token" content="([^"]+)"/.exec(await (await other.request('/', { jar: j })).text())![1];
      const send = async (text: string) => {
        const form = new FormData();
        form.set('text', text);
        return (await other.request('/ask', { jar: j, method: 'POST', headers: { origin: PUBLIC, 'x-csrf-token': token, accept: 'application/x-ndjson' }, body: form })).text();
      };
      assert.match(await send('hello'), /Fine without it\./);
      assert.match(await send('and again'), /Fine without it\./);
      assert.deepEqual(bodies.map((b) => b.output_config?.effort), ['medium', undefined, undefined], 'asked once, then remembered');
      assert.match(await (await other.request('/settings', { jar: j })).text(), /Ask uses an-older-model\. Web research is switched off\./);
    } finally {
      await other.close();
    }
  });

  test('a chat that has gone quiet for an hour is over, and New chat is always on the page', async () => {
    const me = findUserByEmail(t.deps.db, 'alex@example.com')!.id;
    clearChat(t.deps.db, me);
    addMessage(t.deps.db, me, { role: 'user', text: 'old question' });
    addMessage(t.deps.db, me, { role: 'assistant', text: 'old answer' });
    assert.equal(contextTurns(t.deps.db, me).length, 2, 'a chat in progress is kept');
    const live = await (await t.request('/ask', { jar })).text();
    assert.match(live, /old question[\s\S]*old answer/);
    assert.match(live, /<form method="post" action="\/ask\/reset" class="chat-new" id="chat-new" >[\s\S]*New chat<\/button>/);

    t.deps.db.prepare("UPDATE chat_messages SET created_at = ? WHERE user_id = ?").run(new Date(Date.now() - 61 * 60_000).toISOString(), me);
    const later = await (await t.request('/ask', { jar })).text();
    assert.ok(!later.includes('old question') && later.includes('id="chat-new" hidden'), 'the next visit starts fresh');
    assert.deepEqual(contextTurns(t.deps.db, me), []);
    assert.equal(recentMessages(t.deps.db, me).length, 0);

    // The model is never shown a reply with nothing before it.
    addMessage(t.deps.db, me, { role: 'assistant', text: 'a reply with nothing before it' });
    addMessage(t.deps.db, me, { role: 'user', text: 'recent question' });
    assert.deepEqual(contextTurns(t.deps.db, me), [{ role: 'user', text: 'recent question' }]);
    clearChat(t.deps.db, me);
  });

  test('says how to switch it on when there is no key', async () => {
    const off = await startTestApp();
    try {
      const j = await signInWeb(off, ALEX);
      const page = await (await off.request('/ask', { jar: j })).text();
      assert.match(page, /isn't switched on yet|isn&#39;t switched on yet/);
      // Whichever way the copy was installed: the page once named only the Windows file.
      assert.match(page, /<code>\.\/setup\.sh --assistant<\/code>/, 'macOS and Linux');
      assert.match(page, /<code>turn-on-ask\.cmd<\/code>/, 'Windows');
      assert.match(page, /<code>ANTHROPIC_API_KEY<\/code> to <code>\.env<\/code>/, 'Docker');
    } finally {
      await off.close();
    }
  });
});

describe('dates and what is coming up', () => {
  test('dates are shown as MM-DD-YYYY and near dates appear on the home page', async () => {
    const today = todayIn(t.deps.config.tz);
    const plus = (days: number) => new Date(Date.parse(`${today}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
    const c = createCollection(alex, { name: 'Paperwork', description: 'Registrations and renewals.', confirm_new: true, fields: [{ key: 'expires_on', type: 'date' }, { key: 'issued_on', type: 'date' }] });
    assert.ok(c.ok);
    const soon = createEntry(alex, { collection: 'Paperwork', title: 'Pilot registration', fields: { expires_on: plus(12), issued_on: plus(-5) }, raw_text: 'registration' });
    ok(createEntry(alex, { collection: 'Paperwork', title: 'Gym membership', fields: { expires_on: plus(-3) }, raw_text: 'gym' }));
    ok(createEntry(alex, { collection: 'Paperwork', title: 'Far away thing', fields: { expires_on: plus(400) }, raw_text: 'far' }));
    assert.ok(soon.ok);
    const up = comingUp({ ...alex, actor: { ...alex.actor, via: 'web' } }, today);
    assert.deepEqual(up.map((u) => [u.title, u.days]), [['Gym membership', -3], ['Pilot registration', 12]]);

    const us = (d: string) => `${d.slice(5, 7)}-${d.slice(8, 10)}-${d.slice(0, 4)}`;
    const home = await (await t.request('/', { jar })).text();
    assert.match(home, /Coming up[\s\S]*Gym membership[\s\S]*3 days ago[\s\S]*Pilot registration[\s\S]*in 12 days/);
    // The Hide button's form carries the stored date in a hidden field; what a person reads never does.
    const shown = home.replace(/<input type="hidden"[^>]*>/g, '');
    assert.ok(shown.includes(us(plus(12))) && !shown.includes(plus(12)), 'no ISO dates on the page');
    const entry = await (await t.request(`/e/${soon.entryId}`, { jar })).text();
    assert.ok(entry.includes(us(plus(12))) && entry.includes(us(plus(-5))) && entry.includes(`Added ${us(today)}`));
    assert.ok(!new RegExp(`>\\s*${plus(12)}\\s*<`).test(entry));
    // Sam cannot see a private collection's dates.
    ok(createCollection(alex, { name: 'Secret dates', description: 'Private.', private: true, confirm_new: true, fields: [{ key: 'due_on', type: 'date' }] }));
    ok(createEntry(alex, { collection: 'Secret dates', title: 'Surprise party', fields: { due_on: plus(2) }, raw_text: 'party' }));
    assert.ok(!(await (await t.request('/', { jar: samJar })).text()).includes('Surprise party'));
    assert.match(await (await t.request('/', { jar })).text(), /Surprise party/);
  });

  test('the app can receive shares from other apps', async () => {
    const m = (await (await t.request('/manifest.webmanifest')).json()) as { share_target: { action: string; method: string; params: { files: { name: string }[] } } };
    assert.equal(m.share_target.action, '/share');
    assert.equal(m.share_target.method, 'POST');
    assert.equal(m.share_target.params.files[0].name, 'photo');
    assert.match(await (await t.request('/sw.js')).text(), /pathname === '\/share'/);
    assert.equal((await t.request('/share', { jar })).headers.get('location'), '/ask');
  });
});

describe('formatted notes', () => {
  test('notes and long fields render Markdown and never raw HTML', async () => {
    const c = createCollection(alex, { name: 'Cookbook', description: 'Dishes with steps.', confirm_new: true, fields: [{ key: 'directions', type: 'text' }, { key: 'ingredients', type: 'list' }] });
    assert.ok(c.ok);
    const e = createEntry(alex, {
      collection: 'Cookbook',
      title: 'Green chile stew',
      notes: '## Tips\n- Use **roasted** chiles\n- See [the source](https://example.com/stew)\n\n<script>alert(1)</script> [x](javascript:alert(1))',
      fields: { directions: '1. Brown the pork.\n2. Simmer two hours.', ingredients: ['pork shoulder', 'green chiles'] },
      raw_text: 'stew',
    });
    assert.ok(e.ok, JSON.stringify(e));
    const page = await (await t.request(`/e/${e.entryId}`, { jar })).text();
    assert.match(page, /<h3>Tips<\/h3><ul><li>Use <strong>roasted<\/strong> chiles<\/li>/);
    assert.match(page, /<a href="https:\/\/example\.com\/stew" target="_blank" rel="noopener noreferrer nofollow">the source<\/a>/);
    assert.match(page, /<ol><li>Brown the pork\.<\/li><li>Simmer two hours\.<\/li><\/ol>/);
    assert.match(page, /<ul class="plain-list"><li>pork shoulder<\/li><li>green chiles<\/li><\/ul>/);
    assert.ok(!page.includes('<script>alert(1)') && !page.includes('href="javascript:'));

    // Line breaks that arrive written out as backslash-n are read as line breaks, on screen and when Claude saves.
    const client = await mcpClient('alex@example.com');
    const saved = textOf(await client.callTool({ name: 'create_entry', arguments: { collection: 'cookbook', title: 'Fruit Dip', notes: '## About\\nA family dip.\\n\\n## To fill in\\n- How many jars', raw_text: 'fruit dip' } }));
    await client.close();
    const dip = Number(/#(\d+)/.exec(saved)![1]);
    assert.equal(get<{ notes: string }>(t.deps.db, 'SELECT notes FROM entries WHERE id = ?', dip)!.notes, '## About\nA family dip.\n\n## To fill in\n- How many jars');
    t.deps.db.prepare('UPDATE entries SET notes = ? WHERE id = ?').run('## About\\nA family dip.\\n\\n## To fill in\\n- How many jars', dip);
    assert.match(await (await t.request(`/e/${dip}`, { jar })).text(), /<h3>About<\/h3><p>A family dip\.<\/p><h3>To fill in<\/h3><ul><li>How many jars<\/li><\/ul>/);
  });
});

describe('collections sorted by one of their own fields', () => {
  test('open in the web app and through search, in both directions', async () => {
    const c = createCollection(alex, { name: 'Important dates', description: 'Birthdays and anniversaries.', confirm_new: true, fields: [{ key: 'date', type: 'date' }, { key: 'who', type: 'text' }], display: { default_sort: { by: 'date', dir: 'asc' } } });
    assert.ok(c.ok, JSON.stringify(c));
    ok(createEntry(alex, { collection: 'Important dates', title: 'Anniversary', fields: { date: '2027-06-12', who: 'Us' }, raw_text: 'anniversary' }));
    ok(createEntry(alex, { collection: 'Important dates', title: 'Mom birthday', fields: { date: '2027-03-02', who: 'Mom' }, raw_text: 'birthday' }));
    ok(createEntry(alex, { collection: 'Important dates', title: 'No date yet', raw_text: 'tbd' }));
    const res = await t.request(`/c/${c.collectionId}-important-dates`, { jar });
    assert.equal(res.status, 200);
    const page = await res.text();
    assert.ok(page.indexOf('Mom birthday') < page.indexOf('Anniversary'), 'earliest date first');
    assert.equal((await t.request(`/c/${c.collectionId}-important-dates?sort=who&dir=desc`, { jar })).status, 200);
    assert.equal((await t.request(`/c/${c.collectionId}-important-dates?sort=date&dir=desc&q=birthday`, { jar })).status, 200);
    const client = await mcpClient('alex@example.com');
    const found = textOf(await client.callTool({ name: 'search_entries', arguments: { collection: 'important-dates', sort: 'title' } }));
    assert.match(found, /Anniversary/);
    await client.close();
  });
});
