// Photos outside the server: in "Download everything" and in the off-site backup (a small stand-in for R2 here).
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, test } from 'node:test';
import { crc32 } from 'node:zlib';
import { loadConfig, type Config } from '../src/config.ts';
import { get, run } from '../src/db/sqlite.ts';
import { createCollection } from '../src/domain/collections.ts';
import { createEntry, deleteItem, purgeEntry } from '../src/domain/entries.ts';
import { cleanupFiles, deleteAttachment, KEEP_REMOVED_DAYS, saveAttachment, type AttachmentRow, type FileStore } from '../src/domain/files.ts';
import type { Ctx } from '../src/domain/types.ts';
import { findUserByEmail } from '../src/domain/users.ts';
import { mirrorAtStart, mirrorPhotos } from '../src/jobs/photos.ts';
import { errorFields } from '../src/log.ts';
import { takeSnapshot } from '../src/jobs/snapshot.ts';
import { CookieJar, ALEX, SAM, PUBLIC, signInWeb, startTestApp, type TestApp } from './app-helpers.ts';
import { ok, setupDb } from './helpers.ts';

const jpeg = (size: number) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(size - 4)]);
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), randomBytes(600)]);
const BIG = 260 * 1024;

/** Enough of R2's S3 interface for the photo backup: list (two keys to a page), put, get and delete. */
interface FakeR2 {
  url: string;
  objects: Map<string, Buffer>;
  requests: string[];
  pings: number;
  /** Makes uploads of photos fail, as an expired token would. */
  refusePhotos: boolean;
  /** Takes the night's copy of the database and never answers, as a stalled connection would. */
  stallSnapshots: boolean;
  close(): Promise<void>;
}

async function startFakeR2(bucket: string): Promise<FakeR2> {
  const fake: FakeR2 = { url: '', objects: new Map(), requests: [], pings: 0, refusePhotos: false, stallSnapshots: false, close: async () => {} };
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', fake.url);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const reply = (status: number, body: string | Buffer = '') => {
      res.writeHead(status);
      res.end(body);
    };
    if (url.pathname === '/ping') {
      fake.pings++;
      return reply(200);
    }
    fake.requests.push(`${req.method} ${url.pathname}`);
    if (!(req.headers.authorization ?? '').startsWith('AWS4-HMAC-SHA256')) return reply(403);
    if (url.pathname === `/${bucket}` && req.method === 'GET') {
      const keys = [...fake.objects.keys()].filter((k) => k.startsWith(url.searchParams.get('prefix') ?? '')).sort();
      const from = Number(url.searchParams.get('continuation-token') ?? 0);
      const more = from + 2 < keys.length;
      const rows = keys.slice(from, from + 2).map((k) => `<Contents><Key>${k}</Key><LastModified>2026-11-13T00:00:00.000Z</LastModified><ETag>&quot;abc&quot;</ETag><Size>${fake.objects.get(k)!.length}</Size></Contents>`);
      return reply(200, `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${bucket}</Name>${rows.join('')}<IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${from + 2}</NextContinuationToken>` : ''}</ListBucketResult>`);
    }
    const key = decodeURIComponent(url.pathname.slice(bucket.length + 2));
    if (req.method === 'PUT') {
      if (fake.refusePhotos && key.startsWith('photos/')) return reply(403);
      if (fake.stallSnapshots && key.startsWith('snapshots/')) return;
      fake.objects.set(key, Buffer.concat(chunks));
      return reply(200);
    }
    if (req.method === 'GET') return fake.objects.has(key) ? reply(200, fake.objects.get(key)!) : reply(404);
    if (req.method === 'DELETE') {
      fake.objects.delete(key);
      return reply(204);
    }
    reply(405);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.close = () => new Promise<void>((r) => server.close(() => r()));
  return fake;
}

/** Reads a zip the plain way: the directory at the end, then each file it points to. Checks each checksum. */
function unzip(zip: Buffer): Map<string, Buffer> {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, 'the archive has an end record');
  const files = new Map<string, Buffer>();
  let at = zip.readUInt32LE(end + 16);
  for (let i = 0; i < zip.readUInt16LE(end + 10); i++) {
    assert.equal(zip.readUInt32LE(at), 0x02014b50);
    const size = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const name = zip.toString('utf8', at + 46, at + 46 + nameLength);
    const local = zip.readUInt32LE(at + 42);
    assert.equal(zip.readUInt32LE(local), 0x04034b50);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const bytes = zip.subarray(start, start + size);
    assert.equal(crc32(bytes), zip.readUInt32LE(at + 16), `checksum of ${name}`);
    files.set(name, bytes);
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  assert.equal(at, end, 'the directory ends where the end record starts');
  return files;
}

let t: TestApp;
let r2: FakeR2;
let cfg: Config; // the same data folder as the app, with off-site backups switched on
let store: FileStore;
let jar: CookieJar;
let samJar: CookieJar;
let alex: Ctx;
let passport: number;
let recipe: number;

const rowOf = (id: number) => get<AttachmentRow>(t.deps.db, 'SELECT * FROM attachments WHERE id = ?', id);
const sealed = (name: string) => readFileSync(join(store.dir, name));
const add = (entryId: number | null, bytes: Uint8Array, preview?: Uint8Array, filename = 'card.jpg') => saveAttachment(alex, store, { entryId, filename, bytes, preview });
const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60_000).toISOString();

before(async () => {
  const filesKey = randomBytes(32).toString('base64');
  t = await startTestApp({ FILES_KEY: filesKey });
  r2 = await startFakeR2('backups');
  cfg = loadConfig({
    NODE_ENV: 'test',
    PUBLIC_URL: PUBLIC,
    DATA_DIR: t.deps.config.dataDir,
    FILES_KEY: filesKey,
    R2_ENDPOINT: r2.url,
    R2_BUCKET: 'backups',
    LITESTREAM_ACCESS_KEY_ID: 'key-id',
    LITESTREAM_SECRET_ACCESS_KEY: 'key-secret',
    HEALTHCHECKS_URL: `${r2.url}/ping`,
  });
  store = { dir: t.deps.config.filesDir, key: t.deps.config.filesKey };
  jar = await signInWeb(t, ALEX);
  samJar = await signInWeb(t, SAM);
  const u = findUserByEmail(t.deps.db, 'alex@example.com')!;
  alex = { db: t.deps.db, tz: t.deps.config.tz, actor: { userId: u.id, name: 'Alex', via: 'web', client: 'test' } };
  assert.ok(createCollection(alex, { name: 'Personal documents', description: 'IDs and policies.', private: true, sensitive: true, confirm_new: true, fields: [] }).ok);
  assert.ok(createCollection(alex, { name: 'Recipes: "family" ones', description: 'Things we cook.', confirm_new: true, fields: [] }).ok);
  const p = createEntry(alex, { collection: 'Personal documents', title: 'Passport', raw_text: 'my passport' });
  const r = createEntry(alex, { collection: 'recipes-family-ones', title: 'Green chile stew / posole?', raw_text: 'the stew' });
  assert.ok(p.ok && r.ok, JSON.stringify([p, r]));
  passport = p.entryId!;
  recipe = r.entryId!;
});
after(async () => {
  await r2.close();
  await t.close();
});

describe('download everything', () => {
  test('the zip holds the database and each photo you can see, and nothing you cannot', async () => {
    const mine = jpeg(BIG);
    const ours = jpeg(3000);
    const private_ = add(passport, mine, jpeg(8000), 'passport page.jpg');
    const shared = add(recipe, ours, undefined, 'stew.jpg');
    const scan = add(recipe, PDF, undefined, 'recipe card.pdf');
    const removed = add(recipe, jpeg(2000), undefined, 'blurry.jpg');
    deleteAttachment(alex, store, removed.id);

    const res = await t.request('/export/magpie.zip', { jar });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/zip');
    assert.match(res.headers.get('content-disposition') ?? '', /attachment; filename="magpie-\d{4}-\d{2}-\d{2}\.zip"/);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    const files = unzip(Buffer.from(await res.arrayBuffer()));

    // Photos come out as they went in, not as they are stored. Names that cannot be folder names are tidied.
    const stewFolder = `photos/Recipes family ones/Green chile stew posole (#${recipe})`;
    assert.deepEqual(files.get(`photos/Personal documents/Passport (#${passport})/${private_.id} passport page.jpg`), mine);
    assert.deepEqual(files.get(`${stewFolder}/${shared.id} stew.jpg`), ours);
    assert.deepEqual(files.get(`${stewFolder}/${scan.id} recipe card.pdf`), PDF);
    assert.deepEqual([...files.keys()].filter((n) => n.includes('blurry') || n.includes('.small') || n.endsWith('.enc')), [], 'no removed photos, previews or stored files');
    assert.match(files.get('READ ME.txt')!.toString(), /photos holds your photos and PDFs/);

    // tracker.db is the same SQLite copy the other download gives.
    const dbFile = join(t.deps.config.dataDir, 'from-zip.db');
    writeFileSync(dbFile, files.get('tracker.db')!);
    const db = new DatabaseSync(dbFile, { readOnly: true });
    assert.equal((db.prepare('SELECT count(*) AS n FROM entries').get() as { n: number }).n, 2);
    assert.equal((db.prepare('SELECT count(*) AS n FROM attachments').get() as { n: number }).n, 4);
    db.close();
    rmSync(dbFile, { force: true });

    // Sam cannot see Alex's private collection: its photo is not in her archive, by name or by content.
    const hers = unzip(Buffer.from(await (await t.request('/export/magpie.zip', { jar: samJar })).arrayBuffer()));
    assert.deepEqual([...hers.keys()].sort(), ['READ ME.txt', `${stewFolder}/${scan.id} recipe card.pdf`, `${stewFolder}/${shared.id} stew.jpg`, 'tracker.db'].sort());
    assert.equal((await t.request('/export/magpie.zip')).status, 302, 'signed out, there is no download');
  });

  test('a photo that cannot be read is left out and named, and the rest still arrives', async () => {
    const lost = add(recipe, jpeg(2500), undefined, 'lost.jpg');
    rmSync(join(store.dir, `${lost.id}.enc`));
    const files = unzip(Buffer.from(await (await t.request('/export/magpie.zip', { jar })).arrayBuffer()));
    assert.ok(files.has('tracker.db'));
    assert.ok(![...files.keys()].some((n) => n.includes('lost.jpg')));
    assert.match(files.get('READ ME.txt')!.toString(), new RegExp(`These could not be included:\\r\\n.*${lost.id} lost\\.jpg: That photo is missing from the server\\.`));
    deleteAttachment(alex, store, lost.id);
  });

  test('Settings offers it and says where the photos are safe', async () => {
    const html = await (await t.request('/settings', { jar })).text();
    assert.match(html, /<a href="\/export\/magpie\.zip">Download everything, photos included \(zip\)<\/a>/);
    assert.match(html, /Off-site backups are not switched on, so the database and the photos exist only on the server\./);
  });
});

describe('photos in the off-site backup', () => {
  test('new photos are copied as they are stored, previews too, and a second run sends nothing', async () => {
    const withPreview = add(passport, jpeg(BIG), jpeg(8000));
    const plain = add(recipe, PDF, undefined, 'card.pdf');
    const waiting = add(null, jpeg(900)); // sent to Ask and not attached to anything yet
    const first = await mirrorPhotos(cfg, t.deps.db);
    assert.ok(first);
    for (const name of [`${withPreview.id}.enc`, `${withPreview.id}.small.enc`, `${plain.id}.enc`]) {
      assert.deepEqual(r2.objects.get(`photos/${name}`), sealed(name), `${name} is there, still encrypted`);
    }
    assert.ok(!r2.objects.has(`photos/${waiting.id}.enc`), 'an upload not attached to an entry is not copied');
    const expected = readdirSync(store.dir).filter((n) => n !== `${waiting.id}.enc`).length;
    assert.equal(first.held, expected);
    assert.equal(first.uploaded, expected);
    assert.equal(r2.objects.size, expected);

    r2.requests.length = 0;
    const second = await mirrorPhotos(cfg, t.deps.db);
    assert.deepEqual(second, { held: expected, uploaded: 0, restored: 0, removed: 0 });
    assert.ok(r2.requests.every((line) => line.startsWith('GET /backups')), `only the listing was asked for: ${r2.requests.join(', ')}`);
    assert.ok(r2.requests.length > 1, 'the listing came in more than one page');
  });

  test('a photo missing or damaged here comes back from there, and a damaged one is never copied over a good one', async () => {
    const bytes = jpeg(5000);
    const missing = add(recipe, bytes);
    const damaged = add(recipe, jpeg(6000));
    await mirrorPhotos(cfg, t.deps.db);
    const good = Buffer.from(r2.objects.get(`photos/${damaged.id}.enc`)!);

    rmSync(join(store.dir, `${missing.id}.enc`));
    writeFileSync(join(store.dir, `${damaged.id}.enc`), sealed(`${damaged.id}.enc`).subarray(0, 100));
    const run2 = await mirrorPhotos(cfg, t.deps.db);
    assert.equal(run2!.restored, 2);
    assert.equal(run2!.uploaded, 0);
    assert.deepEqual(r2.objects.get(`photos/${damaged.id}.enc`), good, 'the good copy was left alone');
    assert.deepEqual(sealed(`${damaged.id}.enc`), good);
    // And the app serves it again.
    const res = await t.request(`/files/${missing.id}`, { jar });
    assert.equal(res.status, 200);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), bytes);
  });

  test('a removed photo stays there while Undo can still bring it back, and goes once it is gone for good', async () => {
    const removed = add(recipe, jpeg(BIG), jpeg(7000));
    const doomed = createEntry(alex, { collection: 'recipes-family-ones', title: 'Burnt toast', raw_text: 'toast' });
    assert.ok(doomed.ok);
    const purged = add(doomed.entryId!, jpeg(1500));
    await mirrorPhotos(cfg, t.deps.db);

    deleteAttachment(alex, store, removed.id);
    assert.equal((await mirrorPhotos(cfg, t.deps.db))!.removed, 0);
    assert.ok(r2.objects.has(`photos/${removed.id}.enc`) && r2.objects.has(`photos/${removed.id}.small.enc`));

    // Thirty days pass for the removed photo, and the other entry is deleted forever.
    run(t.deps.db, 'UPDATE attachments SET deleted_at = ? WHERE id = ?', daysAgo(KEEP_REMOVED_DAYS + 1), removed.id);
    ok(deleteItem(alex, { entry_id: doomed.entryId! }));
    ok(purgeEntry(alex, doomed.entryId!));
    cleanupFiles({ db: t.deps.db }, store);
    assert.equal(rowOf(removed.id), undefined);
    const kept = r2.objects.size;
    const after = await mirrorPhotos(cfg, t.deps.db);
    assert.equal(after!.removed, 3);
    assert.equal(r2.objects.size, kept - 3);
    for (const name of [`${removed.id}.enc`, `${removed.id}.small.enc`, `${purged.id}.enc`]) assert.ok(!r2.objects.has(`photos/${name}`), name);
    assert.equal(get<{ n: number }>(t.deps.db, 'SELECT count(*) AS n FROM removed_attachments')!.n, 0, 'nothing left to remove next time');
  });

  test('nothing is removed there only because it is missing here', async () => {
    const before = new Map(r2.objects);
    assert.ok(before.size > 0);
    // A server that came up with an empty database and an empty disk, pointed at the same backup.
    const empty = setupDb();
    try {
      const emptyCfg = loadConfig({ NODE_ENV: 'test', PUBLIC_URL: PUBLIC, DATA_DIR: empty.dir, R2_ENDPOINT: r2.url, R2_BUCKET: 'backups', LITESTREAM_ACCESS_KEY_ID: 'key-id', LITESTREAM_SECRET_ACCESS_KEY: 'key-secret' });
      assert.deepEqual(await mirrorPhotos(emptyCfg, empty.db), { held: 0, uploaded: 0, restored: 0, removed: 0 });
    } finally {
      empty.cleanup();
    }
    assert.deepEqual(r2.objects, before);
  });

  test('the nightly job copies the photos after the database, and says so when it cannot', async () => {
    const fresh = add(recipe, jpeg(4000));
    const ok = await takeSnapshot(cfg, t.deps.db);
    assert.equal(ok.uploaded.length >= 1, true);
    assert.equal(ok.photos!.uploaded, 1);
    assert.equal(ok.photoError, undefined);
    assert.ok(r2.objects.has(`photos/${fresh.id}.enc`));
    assert.ok([...r2.objects.keys()].some((k) => /^snapshots\/daily\/tracker-\d{4}-\d{2}-\d{2}\.db\.gz$/.test(k)));
    assert.equal(r2.pings, 1);

    // The token stops working for photos: the database snapshot still counts, and nobody is told all is well.
    const another = add(recipe, jpeg(4100));
    r2.refusePhotos = true;
    const failed = await takeSnapshot(cfg, t.deps.db);
    r2.refusePhotos = false;
    assert.equal(failed.photos, null);
    assert.match(failed.photoError ?? '', new RegExp(`Copying ${another.id}\\.enc to the off-site backup failed: HTTP 403`));
    assert.equal(failed.uploaded.length >= 1, true);
    assert.equal(r2.pings, 1, 'no ping after a run that left the photos behind');
  });

  test('the copy made at start-up is tried again when the backup cannot be reached yet', async () => {
    const waiting = add(recipe, jpeg(3000));
    r2.refusePhotos = true;
    const failures: string[] = [];
    const going = mirrorAtStart(cfg, t.deps.db, (err) => {
      failures.push((err as Error).message);
      r2.refusePhotos = false; // the backup comes good before the next try
    }, 20);
    const done = await going;
    assert.equal(failures.length, 1);
    assert.ok(done!.uploaded >= 1);
    assert.ok(r2.objects.has(`photos/${waiting.id}.enc`));
    // And when it never comes good, it gives up and says so each time.
    r2.refusePhotos = true;
    add(recipe, jpeg(3100));
    let n = 0;
    await assert.rejects(mirrorAtStart(cfg, t.deps.db, () => void n++, 5, 3), /HTTP 403/);
    assert.equal(n, 3);
    r2.refusePhotos = false;
    await mirrorPhotos(cfg, t.deps.db);
    // The log names the reason behind a bare "fetch failed".
    assert.equal((errorFields(new TypeError('fetch failed', { cause: Object.assign(new Error('handshake'), { code: 'ERR_SSL' }) })) as { cause?: string }).cause, 'ERR_SSL');
  });

  test('an upload that stalls is given up on, so the next night still runs', async () => {
    r2.stallSnapshots = true;
    try {
      await assert.rejects(takeSnapshot(cfg, t.deps.db, 300), (err: Error) => err.name === 'TimeoutError');
    } finally {
      r2.stallSnapshots = false;
    }
    assert.equal((await takeSnapshot(cfg, t.deps.db)).uploaded.length >= 1, true);
  });

  test('with only some of the settings present, nothing is sent and the list of photos to remove there is kept', async () => {
    const gone = add(null, jpeg(900));
    deleteAttachment(alex, store, gone.id);
    run(t.deps.db, 'INSERT OR IGNORE INTO removed_attachments (id, removed_at) VALUES (?, ?)', 987654, new Date().toISOString());
    const partial = loadConfig({ NODE_ENV: 'test', PUBLIC_URL: PUBLIC, DATA_DIR: t.deps.config.dataDir, R2_ENDPOINT: r2.url, R2_BUCKET: 'backups', LITESTREAM_ACCESS_KEY_ID: 'key-id' });
    r2.requests.length = 0;
    assert.equal(await mirrorPhotos(partial, t.deps.db), null);
    assert.equal(r2.requests.length, 0);
    assert.ok(get(t.deps.db, 'SELECT 1 FROM removed_attachments WHERE id = ?', 987654), 'a key being replaced must not make the server forget what to remove');
    run(t.deps.db, 'DELETE FROM removed_attachments WHERE id = ?', 987654);
  });

  test('with off-site backups off, nothing is sent and nothing is left waiting', async () => {
    const gone = add(null, jpeg(700));
    deleteAttachment(alex, store, gone.id);
    assert.ok(get(t.deps.db, 'SELECT 1 FROM removed_attachments WHERE id = ?', gone.id));
    r2.requests.length = 0;
    assert.equal(await mirrorPhotos(t.deps.config, t.deps.db), null);
    assert.equal(r2.requests.length, 0);
    assert.equal(get<{ n: number }>(t.deps.db, 'SELECT count(*) AS n FROM removed_attachments')!.n, 0);
  });
});
