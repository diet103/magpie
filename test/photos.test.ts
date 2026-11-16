// Photos after they are stored: removing one and bringing it back, small previews, and ids that are never reused.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { all, get, migrate, MIGRATIONS, openDb, run } from '../src/db/sqlite.ts';
import { createCollection } from '../src/domain/collections.ts';
import { createEntry } from '../src/domain/entries.ts';
import { cleanupFiles, deleteAttachment, KEEP_REMOVED_DAYS, MAX_PER_ENTRY, saveAttachment, type AttachmentRow, type FileStore } from '../src/domain/files.ts';
import type { Ctx } from '../src/domain/types.ts';
import { undoActivity } from '../src/domain/undo.ts';
import { findUserByEmail } from '../src/domain/users.ts';
import { CookieJar, ALEX, SAM, PUBLIC, signInWeb, startTestApp, type TestApp } from './app-helpers.ts';

const JPEG_START = [0xff, 0xd8, 0xff, 0xe0];
/** Bytes that start like a JPEG. Random filler, so two of them are never alike. */
const jpeg = (size: number) => Buffer.concat([Buffer.from(JPEG_START), randomBytes(size - JPEG_START.length)]);
const BIG = 260 * 1024; // large enough for a preview to be worth having
const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60_000).toISOString();

let t: TestApp;
let store: FileStore;
let jar: CookieJar;
let samJar: CookieJar;
let csrf: string;
let samCsrf: string;
let alex: Ctx;
let passport: number; // an entry in Alex's private collection
let recipe: number; // an entry both can see

async function csrfOf(j: CookieJar) {
  const home = await t.request('/', { jar: j });
  return /<meta name="csrf-token" content="([^"]+)"/.exec(await home.text())![1];
}

/** Posts a form the way the page's script does. */
function post(path: string, parts: Record<string, string | { name: string; bytes: Uint8Array }> = {}, who = { jar, csrf }) {
  const form = new FormData();
  for (const [k, v] of Object.entries(parts)) form.append(k, typeof v === 'string' ? v : new File([v.bytes as Uint8Array<ArrayBuffer>], v.name));
  return t.request(path, { jar: who.jar, method: 'POST', headers: { origin: PUBLIC, 'x-csrf-token': who.csrf, accept: 'application/json' }, body: form });
}

const rowOf = (id: number) => get<AttachmentRow>(t.deps.db, 'SELECT * FROM attachments WHERE id = ?', id);
const newestOn = (entryId: number) => get<AttachmentRow>(t.deps.db, 'SELECT * FROM attachments WHERE entry_id = ? ORDER BY id DESC LIMIT 1', entryId)!;
const stored = () => readdirSync(store.dir);
const page = async (path: string, j = jar) => (await t.request(path, { jar: j })).text();

async function addPhoto(entryId: number, bytes: Uint8Array, preview?: Uint8Array): Promise<AttachmentRow> {
  const res = await post(`/e/${entryId}/photos`, { photo: { name: 'card.jpg', bytes }, ...(preview ? { preview0: { name: 'preview.jpg', bytes: preview } } : {}) });
  assert.equal(res.status, 200);
  return newestOn(entryId);
}

before(async () => {
  t = await startTestApp({ FILES_KEY: randomBytes(32).toString('base64'), ANTHROPIC_API_KEY: 'sk-ant-test-key' });
  // The model stands in with one plain reply; these tests are about what happens to the files.
  t.deps.assistantFetch = (async () => new Response(JSON.stringify({ content: [{ type: 'text', text: 'Got it.' }], stop_reason: 'end_turn' }))) as typeof fetch;
  store = { dir: t.deps.config.filesDir, key: t.deps.config.filesKey };
  jar = await signInWeb(t, ALEX);
  samJar = await signInWeb(t, SAM);
  csrf = await csrfOf(jar);
  samCsrf = await csrfOf(samJar);
  const u = findUserByEmail(t.deps.db, 'alex@example.com')!;
  alex = { db: t.deps.db, tz: t.deps.config.tz, actor: { userId: u.id, name: 'Alex', via: 'web', client: 'test' } };
  assert.ok(createCollection(alex, { name: 'Personal documents', description: 'IDs and policies.', private: true, sensitive: true, confirm_new: true, fields: [] }).ok);
  assert.ok(createCollection(alex, { name: 'Recipes', description: 'Things we cook.', confirm_new: true, fields: [] }).ok);
  const p = createEntry(alex, { collection: 'Personal documents', title: 'Passport', raw_text: 'my passport' });
  const r = createEntry(alex, { collection: 'Recipes', title: 'Green chile stew', raw_text: 'the stew' });
  assert.ok(p.ok && r.ok);
  passport = p.entryId!;
  recipe = r.entryId!;
});
after(() => t.close());

describe('removing a photo', () => {
  test('it leaves the entry at once, and Undo puts it back as it was', async () => {
    const bytes = jpeg(4000);
    const photo = await addPhoto(passport, bytes);

    const removed = await post(`/files/${photo.id}/delete`);
    assert.equal(removed.status, 303);
    assert.equal(removed.headers.get('location'), `/e/${passport}`);
    assert.ok(rowOf(photo.id)!.deleted_at, 'the row is marked, not deleted');
    assert.ok(stored().includes(`${photo.id}.enc`), 'the file stays on the disk so the removal can be undone');

    // The page it lands on says so and offers Undo. The picture itself is no longer served or listed.
    const landed = await page(`/e/${passport}`);
    assert.match(landed, /Photo removed\./);
    const undoPath = /action="(\/activity\/\d+\/undo)"/.exec(landed)?.[1];
    assert.ok(undoPath, 'the message carries an Undo button');
    assert.ok(!landed.includes(`/files/${photo.id}"`));
    assert.equal((await t.request(`/files/${photo.id}`, { jar })).status, 404);

    // Undo comes back to the page it was pressed on, which the button's form names.
    assert.match(landed, new RegExp(`action="${undoPath}" class="inline"><input type="hidden" name="_csrf" value="[^"]+" /><input type="hidden" name="back" value="/e/${passport}" />`));
    const undone = await post(undoPath, { back: `/e/${passport}` });
    assert.equal(undone.status, 303);
    assert.equal(undone.headers.get('location'), `/e/${passport}`);
    assert.equal(rowOf(photo.id)!.deleted_at, null);
    const back = await t.request(`/files/${photo.id}`, { jar });
    assert.equal(back.status, 200);
    assert.deepEqual(Buffer.from(await back.arrayBuffer()), bytes);
    const after = await page(`/e/${passport}`);
    assert.match(after, /Undid: Removed a photo from &quot;Passport&quot; \(photo restored\)\./);
    assert.match(after, new RegExp(`<img src="/files/${photo.id}"`));
    // Undoing it a second time is refused like any other change that was already undone. And "back" is only
    // ever a page of this app: anything else is ignored.
    const again = await post(undoPath, { back: '//evil.example/x' });
    assert.equal(again.headers.get('location'), '/activity');
    assert.match(await page(`/e/${passport}`), /already undone/);
    assert.equal((await post(undoPath, { back: 'https://evil.example/' })).headers.get('location'), '/activity');
  });

  test('Activity offers Undo for it, and only to someone who can see the entry', async () => {
    const photo = await addPhoto(passport, jpeg(3000));
    const { activityId } = deleteAttachment(alex, store, photo.id);
    assert.ok(activityId);
    assert.match(await page('/activity'), new RegExp(`action="/activity/${activityId}/undo"`));
    // Passport is in Alex's private collection: for Sam the change does not exist.
    assert.ok(!(await page('/activity', samJar)).includes(`/activity/${activityId}/undo`));
    await post(`/activity/${activityId}/undo`, {}, { jar: samJar, csrf: samCsrf });
    assert.ok(rowOf(photo.id)!.deleted_at, 'Sam could not undo it');
    // On a shared entry either person can.
    const shared = await addPhoto(recipe, jpeg(3000));
    const second = deleteAttachment(alex, store, shared.id);
    await post(`/activity/${second.activityId}/undo`, {}, { jar: samJar, csrf: samCsrf });
    assert.equal(rowOf(shared.id)!.deleted_at, null);
  });

  test(`a removed photo is cleared out after ${KEEP_REMOVED_DAYS} days, and Undo then says why it cannot`, async () => {
    const kept = await addPhoto(recipe, jpeg(BIG), jpeg(9000));
    const gone = await addPhoto(recipe, jpeg(BIG), jpeg(9000));
    const keptRemoval = deleteAttachment(alex, store, kept.id);
    const goneRemoval = deleteAttachment(alex, store, gone.id);
    const removedAt = rowOf(kept.id)!.deleted_at;
    run(t.deps.db, 'UPDATE attachments SET deleted_at = ? WHERE id = ?', daysAgo(KEEP_REMOVED_DAYS - 1), kept.id);
    run(t.deps.db, 'UPDATE attachments SET deleted_at = ? WHERE id = ?', daysAgo(KEEP_REMOVED_DAYS + 1), gone.id);
    cleanupFiles({ db: t.deps.db }, store);

    assert.ok(rowOf(kept.id), 'still inside the 30 days');
    assert.ok(stored().includes(`${kept.id}.enc`) && stored().includes(`${kept.id}.small.enc`));
    assert.equal(rowOf(gone.id), undefined);
    assert.ok(!stored().includes(`${gone.id}.enc`) && !stored().includes(`${gone.id}.small.enc`), 'the photo and its preview are off the disk');
    // The off-site backup is told through this table (see test/photo-backup.test.ts).
    assert.ok(get(t.deps.db, 'SELECT 1 FROM removed_attachments WHERE id = ?', gone.id));

    assert.throws(() => undoActivity(alex, goneRemoval.activityId!), /cleared out\. A removed photo is kept for 30 days/);
    // Put back the real time of the removal, which this test moved into the past, and undo it.
    run(t.deps.db, 'UPDATE attachments SET deleted_at = ? WHERE id = ?', removedAt, kept.id);
    assert.ok(undoActivity(alex, keptRemoval.activityId!).ok);
    assert.equal(rowOf(kept.id)!.deleted_at, null);
  });

  test('Undo will not put a photo back on an entry that is full', () => {
    const e = createEntry(alex, { collection: 'Recipes', title: 'Posole', raw_text: 'posole' });
    assert.ok(e.ok);
    const first = saveAttachment(alex, store, { entryId: e.entryId!, filename: 'a.jpg', bytes: jpeg(500) });
    const removal = deleteAttachment(alex, store, first.id);
    for (let i = 0; i < MAX_PER_ENTRY; i++) saveAttachment(alex, store, { entryId: e.entryId!, filename: `${i}.jpg`, bytes: jpeg(500) });
    assert.throws(() => undoActivity(alex, removal.activityId!), /already has 20 photos/);
  });

  test('an id is never handed out twice, even after its photo is gone for good', () => {
    const first = saveAttachment(alex, store, { entryId: null, filename: 'a.jpg', bytes: jpeg(500) });
    deleteAttachment(alex, store, first.id); // never attached, so it is dropped at once
    assert.equal(rowOf(first.id), undefined);
    assert.ok(!stored().includes(`${first.id}.enc`));
    const second = saveAttachment(alex, store, { entryId: null, filename: 'b.jpg', bytes: jpeg(500) });
    assert.ok(second.id > first.id, `${second.id} must not reuse ${first.id}: a phone may still hold the old picture under that id`);
  });
});

describe('small previews', () => {
  test('one sent with a photo is stored encrypted and shown in place of the full picture', async () => {
    const bytes = jpeg(BIG);
    const small = jpeg(9000);
    const photo = await addPhoto(passport, bytes, small);
    assert.equal(photo.preview_size, small.length);
    const onDisk = readFileSync(join(store.dir, `${photo.id}.small.enc`));
    assert.equal(onDisk.length, small.length + 28);
    assert.ok(!onDisk.includes(small.subarray(4, 40)), 'the preview is encrypted like the photo');

    const res = await t.request(`/files/${photo.id}/small`, { jar });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/jpeg');
    assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'none'/);
    assert.match(res.headers.get('content-disposition') ?? '', /^inline/);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), small);
    assert.deepEqual(Buffer.from(await (await t.request(`/files/${photo.id}`, { jar })).arrayBuffer()), bytes);

    // The list shows the small one and the link opens the full one.
    assert.match(await page(`/e/${passport}`), new RegExp(`<a href="/files/${photo.id}" data-photo><img src="/files/${photo.id}/small"`));
    // Same rules as the photo itself: not for someone who cannot see the entry, not for someone signed out.
    assert.equal((await t.request(`/files/${photo.id}/small`, { jar: samJar })).status, 404);
    assert.equal((await t.request(`/files/${photo.id}/small`)).status, 302);
  });

  test('a preview that is no use is left out, and the photo is saved all the same', async () => {
    const notAPicture = await addPhoto(recipe, jpeg(BIG), Buffer.from('<html><script>alert(1)</script></html>'));
    assert.equal(notAPicture.preview_size, null);
    const noSmaller = await addPhoto(recipe, jpeg(BIG), jpeg(BIG + 10));
    assert.equal(noSmaller.preview_size, null);
    const alreadySmall = await addPhoto(recipe, jpeg(50_000), jpeg(9000));
    assert.equal(alreadySmall.preview_size, null, 'a small photo is shown as it is');
    assert.equal((await t.request(`/files/${alreadySmall.id}/small`, { jar })).status, 404);

    const html = await page(`/e/${recipe}`);
    // A large photo with no preview asks the page's script to make one. A small one does not.
    assert.match(html, new RegExp(`<img src="/files/${noSmaller.id}" alt="card.jpg" loading="lazy" data-make-preview />`));
    assert.match(html, new RegExp(`<img src="/files/${alreadySmall.id}" alt="card.jpg" loading="lazy" />`));
    // The other person can see this photo, but its preview is not theirs to choose.
    assert.equal((await post(`/files/${noSmaller.id}/small`, { preview: { name: 'p.jpg', bytes: jpeg(8000) } }, { jar: samJar, csrf: samCsrf })).status, 204);
    assert.equal(rowOf(noSmaller.id)!.preview_size, null);
  });

  test('a page can send the preview for a photo stored without one, once', async () => {
    const photo = await addPhoto(passport, jpeg(BIG));
    assert.equal(photo.preview_size, null);
    const first = jpeg(8000);
    // Not without the form token, and not by someone who cannot see the photo.
    const bare = new FormData();
    bare.set('preview', new File([first], 'p.jpg'));
    assert.equal((await t.request(`/files/${photo.id}/small`, { jar, method: 'POST', headers: { origin: PUBLIC }, body: bare })).status, 403);
    assert.equal((await post(`/files/${photo.id}/small`, { preview: { name: 'p.jpg', bytes: first } }, { jar: samJar, csrf: samCsrf })).status, 404);
    assert.equal(rowOf(photo.id)!.preview_size, null);

    assert.equal((await post(`/files/${photo.id}/small`, { preview: { name: 'p.jpg', bytes: first } })).status, 201);
    assert.equal(rowOf(photo.id)!.preview_size, first.length);
    // A second one changes nothing: a phone may already have stored the first.
    assert.equal((await post(`/files/${photo.id}/small`, { preview: { name: 'p.jpg', bytes: jpeg(7000) } })).status, 204);
    assert.deepEqual(Buffer.from(await (await t.request(`/files/${photo.id}/small`, { jar })).arrayBuffer()), first);
    assert.match(await page(`/e/${passport}`), new RegExp(`<img src="/files/${photo.id}/small"`));
    // If the preview's file is lost, the photo is shown whole again and a new preview can be sent.
    rmSync(join(store.dir, `${photo.id}.small.enc`));
    assert.equal((await t.request(`/files/${photo.id}/small`, { jar })).status, 404);
    assert.equal(rowOf(photo.id)!.preview_size, null);
    assert.match(await page(`/e/${passport}`), new RegExp(`<img src="/files/${photo.id}" alt="card.jpg" loading="lazy" data-make-preview />`));
    assert.equal((await post(`/files/${photo.id}/small`, { preview: { name: 'p.jpg', bytes: first } })).status, 201);
    // Sending one makes no entry in Activity: nothing anyone sees has changed.
    assert.equal(get<{ n: number }>(t.deps.db, "SELECT count(*) AS n FROM activity WHERE summary LIKE '%preview%'")!.n, 0);
  });
});

describe('photos sent in Ask', () => {
  test('each one keeps the preview sent with it, and the chat shows that', async () => {
    const form = new FormData();
    form.set('text', 'front and back of my card');
    const front = jpeg(BIG);
    const frontSmall = jpeg(7000);
    const backSmall = jpeg(6000);
    form.append('photo', new File([front], 'front.jpg'));
    form.append('photo', new File([jpeg(BIG)], 'back.jpg'));
    form.append('photo', new File([jpeg(40_000)], 'receipt.jpg')); // small already, and sent without a preview
    form.set('preview0', new File([frontSmall], 'preview.jpg'));
    form.set('preview1', new File([backSmall], 'preview.jpg'));
    const res = await t.request('/ask', { jar, method: 'POST', headers: { origin: PUBLIC, 'x-csrf-token': csrf, accept: 'application/x-ndjson' }, body: form });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Got it\./);

    const sent = all<AttachmentRow>(t.deps.db, 'SELECT * FROM attachments WHERE entry_id IS NULL ORDER BY id DESC LIMIT 3').reverse();
    assert.deepEqual(sent.map((a) => [a.filename, a.preview_size]), [['front.jpg', frontSmall.length], ['back.jpg', backSmall.length], ['receipt.jpg', null]]);
    // Each preview went to its own photo, not its neighbour.
    assert.deepEqual(Buffer.from(await (await t.request(`/files/${sent[0].id}/small`, { jar })).arrayBuffer()), frontSmall);
    assert.deepEqual(Buffer.from(await (await t.request(`/files/${sent[1].id}/small`, { jar })).arrayBuffer()), backSmall);
    const chat = await page('/ask');
    assert.match(chat, new RegExp(`<a class="shot" href="/files/${sent[0].id}" data-photo><img src="/files/${sent[0].id}/small"`));
    assert.match(chat, new RegExp(`<a class="shot" href="/files/${sent[2].id}" data-photo><img src="/files/${sent[2].id}"`));
    // They are the sender's alone until attached to an entry.
    assert.equal((await t.request(`/files/${sent[0].id}/small`, { jar: samJar })).status, 404);
  });
});

describe('the move to version 8 of the database', () => {
  test('photos saved before it are all still there, and new ids start well clear of the old ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tracker-v7-'));
    try {
      // A database as it is on the server today: migrated to version 7, with photos in it.
      const upTo7 = join(dir, 'migrations');
      mkdirSync(upTo7);
      const names = readdirSync(MIGRATIONS.tracker).filter((f) => /^00[1-7]_/.test(f));
      assert.equal(names.length, 7);
      for (const name of names) copyFileSync(join(MIGRATIONS.tracker, name), join(upTo7, name));
      const db = openDb(join(dir, 'tracker.db'));
      migrate(db, upTo7);
      assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 7);
      run(db, "INSERT INTO users (email, display_name) VALUES ('a@example.com', 'A')");
      for (const [id, deleted] of [[3, null], [4, '2026-11-01T00:00:00.000Z'], [9, null]] as const) {
        run(db, 'INSERT INTO attachments (id, entry_id, filename, mime, size, created_by, created_at, deleted_at) VALUES (?, NULL, ?, ?, ?, 1, ?, ?)', id, `photo ${id}.jpg`, 'image/jpeg', 1000 + id, '2026-10-01T00:00:00.000Z', deleted);
      }
      const columns = 'id, entry_id, filename, mime, size, created_by, created_at, deleted_at';
      const before = all(db, `SELECT ${columns} FROM attachments ORDER BY id`);
      assert.equal(before.length, 3);

      migrate(db, MIGRATIONS.tracker);
      assert.deepEqual(all(db, `SELECT ${columns} FROM attachments ORDER BY id`), before);
      assert.deepEqual(all<{ preview_size: number | null }>(db, 'SELECT preview_size FROM attachments').map((r) => r.preview_size), [null, null, null]);
      assert.equal((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      assert.ok(get(db, "SELECT 1 FROM sqlite_schema WHERE type = 'index' AND name = 'attachments_by_entry' AND tbl_name = 'attachments'"));

      // Ids 10 and up may have been used and cleared away before, and nothing records them. New ones start past a gap.
      const add = (name: string) => Number(run(db, "INSERT INTO attachments (entry_id, filename, mime, size, created_by, created_at) VALUES (NULL, ?, 'image/jpeg', 5, 1, '2026-11-13T00:00:00.000Z')", name).lastInsertRowid);
      const next = add('new.jpg');
      assert.equal(next, 1010);
      // Any row that goes for good is noted for the off-site backup, whichever code deleted it.
      run(db, 'DELETE FROM attachments WHERE id IN (3, ?)', next);
      assert.deepEqual(all<{ id: number }>(db, 'SELECT id FROM removed_attachments ORDER BY id').map((r) => r.id), [3, next]);
      assert.equal(add('newer.jpg'), next + 1, 'the id of the row just deleted is not handed out again');
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
