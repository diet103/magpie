import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_NAME } from '../brand.ts';
import { openVault } from './vault.ts';

export type DB = DatabaseSync;

const here = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS = {
  tracker: join(here, 'migrations', 'tracker'),
  auth: join(here, 'migrations', 'auth'),
};

export function openDb(path: string, opts: { readOnly?: boolean } = {}): DB {
  if (!opts.readOnly) mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, {
    readOnly: opts.readOnly ?? false,
    enableForeignKeyConstraints: true,
    timeout: 5000,
  });
  if (!opts.readOnly) {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    // The space a deleted row or a dropped page took is wiped. That is not everything: copies left behind when
    // SQLite rearranged a page stay until the file is rewritten (see rewrite_due in migration 009).
    db.exec('PRAGMA secure_delete = ON');
  }
  return db;
}

const afterCommit = new WeakMap<DB, () => void>();

/** Has fn run after every transaction on this connection that commits. It must not throw. */
export function onCommit(db: DB, fn: () => void) {
  afterCommit.set(db, fn);
}

/** Runs fn in a transaction. Re-entrant: nested calls join the outer transaction. */
export function tx<T>(db: DB, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
  let result: T;
  try {
    result = fn();
    db.exec('COMMIT');
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw err;
  }
  afterCommit.get(db)?.();
  return result;
}

/**
 * Applies NNN_name.sql files newer than PRAGMA user_version, each in its own transaction.
 *
 * A database that is already past the newest file here was last used by newer code, and a later step can change
 * what the earlier tables mean (009 moved sensitive text into a sealed column, which older code reads as empty).
 * Older code must not run on it, so that is refused before anything is written. `name` is the file's name, for
 * the message.
 */
export function migrate(db: DB, dir: string, name = 'This database') {
  const current = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  const files = readdirSync(dir)
    .filter((f) => /^\d{3}_.+\.sql$/.test(f))
    .sort();
  const newest = files.length ? Number(files[files.length - 1].slice(0, 3)) : 0;
  if (current > newest) {
    throw new Error(
      `${name} was last used by a newer version of ${APP_NAME}: it is at step ${current}, and this code only knows up to step ${newest}. Get the newer code. An older version must not run on this database.`,
    );
  }
  for (const f of files) {
    const n = Number(f.slice(0, 3));
    if (n <= current) continue;
    const sql = readFileSync(join(dir, f), 'utf8');
    tx(db, () => {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${n}`);
    });
  }
}

/**
 * Opens tracker.db, refusing to create a brand-new database unless explicitly allowed.
 * An unexpectedly empty database usually means a restore went wrong, so production fails closed.
 * filesKey is what opens sealed text (see vault.ts); without it, a database that holds any is refused.
 */
export function openTrackerDb(path: string, allowCreate: boolean, filesKey?: Buffer): DB {
  if (!existsSync(path) && !allowCreate) {
    throw new Error(
      `No database at ${path}. Refusing to create an empty one. Restore from backup, or set BOOTSTRAP_EMPTY_DB=1 for the very first deploy.`,
    );
  }
  const db = openDb(path);
  if (!allowCreate) {
    // An existing but empty (or foreign) file must not be silently turned into a fresh, empty tracker.
    const version = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
    if (version === 0) {
      const tables = (db.prepare('SELECT count(*) AS n FROM sqlite_schema').get() as { n: number }).n;
      db.close();
      throw new Error(
        tables === 0
          ? `${path} exists but is empty. Refusing to start with no data. Restore from backup, or set BOOTSTRAP_EMPTY_DB=1 for the very first deploy.`
          : `${path} is not a tracker database (no schema version).`,
      );
    }
  }
  try {
    migrate(db, MIGRATIONS.tracker, basename(path));
    openVault(db, filesKey);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

export function openAuthDb(path: string): DB {
  const db = openDb(path);
  try {
    migrate(db, MIGRATIONS.auth, basename(path));
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

export type Row = Record<string, unknown>;

export function all<T = Row>(db: DB, sql: string, ...params: unknown[]): T[] {
  return db.prepare(sql).all(...(params as never[])) as T[];
}

export function get<T = Row>(db: DB, sql: string, ...params: unknown[]): T | undefined {
  return db.prepare(sql).get(...(params as never[])) as T | undefined;
}

export function run(db: DB, sql: string, ...params: unknown[]) {
  return db.prepare(sql).run(...(params as never[]));
}
