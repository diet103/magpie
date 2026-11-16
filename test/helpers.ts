import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openTrackerDb, type DB } from '../src/db/sqlite.ts';
import { createCollection } from '../src/domain/collections.ts';
import type { Ctx, Refusal, Via, WriteResult } from '../src/domain/types.ts';
import { findUserByEmail, syncUsers } from '../src/domain/users.ts';

export const TZ = 'America/Denver';
/** Stands in for FILES_KEY, so sensitive collections can be written to in tests. */
export const TEST_FILES_KEY = Buffer.alloc(32, 7);

export interface TestEnv {
  dir: string;
  dbPath: string;
  db: DB;
  alex: Ctx;
  sam: Ctx;
  as: (who: 'alex' | 'sam', via?: Via) => Ctx;
  cleanup: () => void;
}

export function setupDb(): TestEnv {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-test-'));
  const dbPath = join(dir, 'tracker.db');
  const db = openTrackerDb(dbPath, true, TEST_FILES_KEY);
  syncUsers(db, [
    { email: 'alex@example.com', name: 'Alex' },
    { email: 'sam@example.com', name: 'Sam' },
  ]);
  const users = {
    alex: findUserByEmail(db, 'alex@example.com')!,
    sam: findUserByEmail(db, 'sam@example.com')!,
  };
  const as = (who: 'alex' | 'sam', via: Via = 'mcp'): Ctx => ({
    db,
    tz: TZ,
    actor: { userId: users[who].id, name: users[who].display_name, via, client: 'test' },
  });
  return {
    dir,
    dbPath,
    db,
    alex: as('alex'),
    sam: as('sam'),
    as,
    cleanup: () => {
      try {
        db.close();
      } catch {
        // already closed
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function ok(r: WriteResult | Refusal | { ok: false; text: string }): WriteResult {
  if (!r.ok) throw new Error(`expected success, got refusal: ${r.text}`);
  return r;
}

export function refused(r: WriteResult | Refusal | { ok: false; text: string }): string {
  if (r.ok) throw new Error(`expected a refusal, got: ${r.summary}`);
  return r.text;
}

export function seedRestaurants(ctx: Ctx) {
  return ok(
    createCollection(ctx, {
      name: 'Restaurants',
      description: "Places we've eaten or want to try.",
      fields: [
        { key: 'cuisine', type: 'text' },
        { key: 'neighborhood', type: 'text' },
        { key: 'price', type: 'enum', options: ['$', '$$', '$$$', '$$$$'] },
        { key: 'status', type: 'enum', options: ['want_to_try', 'been'] },
      ],
      display: { list_columns: ['cuisine', 'neighborhood', 'rating', 'last_logged_on'], default_sort: { by: 'last_logged_on', dir: 'desc' }, log_noun: 'visit' },
      raw_text: 'make a restaurants list',
    }),
  );
}

export function seedMovies(ctx: Ctx) {
  return ok(
    createCollection(ctx, {
      name: 'Movies',
      description: "Films we've watched or want to watch.",
      fields: [
        { key: 'year', type: 'number' },
        { key: 'director', type: 'text' },
        { key: 'status', type: 'enum', options: ['to_watch', 'watched'] },
      ],
      display: { log_noun: 'viewing' },
      raw_text: 'movies list',
    }),
  );
}
