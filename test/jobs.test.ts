import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { loadConfig } from '../src/config.ts';
import { createEntry } from '../src/domain/entries.ts';
import { msUntil, takeSnapshot } from '../src/jobs/snapshot.ts';
import { ok, seedRestaurants, setupDb } from './helpers.ts';

const env = setupDb();
after(() => env.cleanup());

test('nightly snapshot: plain SQLite copy, integrity-checked, gzipped', async () => {
  seedRestaurants(env.alex);
  ok(createEntry(env.alex, { collection: 'restaurants', title: 'Pho 54', raw_text: 'x' }));
  const cfg = loadConfig({ NODE_ENV: 'test', DATA_DIR: env.dir, PUBLIC_URL: 'http://localhost:8787' });
  const r = await takeSnapshot(cfg, env.db);
  assert.equal(r.uploaded.length, 0);
  const file = join(env.dir, 'restored.db');
  writeFileSync(file, gunzipSync(readFileSync(r.file)));
  const copy = new DatabaseSync(file, { readOnly: true });
  assert.equal((copy.prepare('SELECT title FROM entries').get() as { title: string }).title, 'Pho 54');
  assert.equal((copy.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
  copy.close();
});

test('nightly snapshot leaves only the .db.gz in its folder', async (t) => {
  const fresh = setupDb();
  t.after(() => fresh.cleanup());
  // The copy is in WAL mode like the database it came from, so checking it makes SQLite create
  // tracker-DATE.db-wal and tracker-DATE.db-shm beside it.
  assert.equal((fresh.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode, 'wal');
  const cfg = loadConfig({ NODE_ENV: 'test', DATA_DIR: fresh.dir, PUBLIC_URL: 'http://localhost:8787' });
  const r = await takeSnapshot(cfg, fresh.db);
  assert.deepEqual(readdirSync(cfg.snapshotDir), [basename(r.file)]);
});

test('nightly snapshot cleanup keeps the last 7 copies and clears -wal and -shm files from earlier runs', async (t) => {
  const fresh = setupDb();
  t.after(() => fresh.cleanup());
  const cfg = loadConfig({ NODE_ENV: 'test', DATA_DIR: fresh.dir, PUBLIC_URL: 'http://localhost:8787' });
  mkdirSync(cfg.snapshotDir);
  const earlier = [1, 2, 3, 4, 5, 6, 7, 8].map((d) => `tracker-2001-01-0${d}.db`);
  for (const f of ['notes.txt', ...earlier.flatMap((raw) => [`${raw}.gz`, `${raw}-wal`, `${raw}-shm`])]) writeFileSync(join(cfg.snapshotDir, f), '');
  const r = await takeSnapshot(cfg, fresh.db);
  // Tonight's copy and the six before it stay, and so does a file the job did not make.
  assert.deepEqual(readdirSync(cfg.snapshotDir).sort(), ['notes.txt', ...earlier.slice(2).map((raw) => `${raw}.gz`), basename(r.file)].sort());
});

test('snapshot scheduling picks the next 03:30 in the household time zone', () => {
  // 2026-11-08 20:00 Denver (03:00 UTC on the 9th): next 03:30 Denver is 7.5 hours away.
  const now = Date.parse('2026-11-09T03:00:00Z');
  assert.equal(msUntil('03:30', 'America/Denver', now), 7.5 * 3_600_000);
  // 02:00 Denver: 1.5 hours.
  assert.equal(msUntil('03:30', 'America/Denver', Date.parse('2026-11-09T09:00:00Z')), 1.5 * 3_600_000);
});
