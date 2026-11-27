// A data folder that a newer version of the code has used. Older code must not run on it: the code that opens
// a database, the admin commands and the server itself all have to stop and say why. (This is what would happen
// if a forgotten copy of the project were deployed over a server that has since moved on.)
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { openAuthDb, openTrackerDb } from '../src/db/sqlite.ts';
import { TEST_FILES_KEY, TZ } from './helpers.ts';

const SERVER = fileURLToPath(new URL('../src/server.ts', import.meta.url));
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const PORT = '18987';

/** Moves a database's step counter, as a newer release's migration would have left it. Returns the new step. */
function moveStep(path: string, by: number): number {
  const raw = new DatabaseSync(path);
  try {
    const step = Number((raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version) + by;
    raw.exec(`PRAGMA user_version = ${step}`);
    raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    return step;
  } finally {
    raw.close();
  }
}

const refusal = (name: string, step: number) =>
  `${name} was last used by a newer version of Magpie: it is at step ${step}, and this code only knows up to step ${step - 1}. Get the newer code. An older version must not run on this database.`;

describe('a database that newer code has used', () => {
  let dir: string;
  const databases = () =>
    [
      { name: 'tracker.db', path: join(dir, 'tracker.db'), open: () => openTrackerDb(join(dir, 'tracker.db'), false, TEST_FILES_KEY) },
      { name: 'auth.db', path: join(dir, 'auth.db'), open: () => openAuthDb(join(dir, 'auth.db')) },
    ] as const;
  /** Runs one of the two programs as its own process on the data folder, the way the server runs them. */
  const start = (script: string, ...args: string[]) => {
    const r = spawnSync(process.execPath, [script, ...args], {
      env: {
        PATH: process.env.PATH ?? '',
        NODE_ENV: 'test',
        TEST_LOGS: '1',
        DATA_DIR: dir,
        PORT,
        PUBLIC_URL: `http://localhost:${PORT}`,
        HOUSEHOLD_TZ: TZ,
        ALLOWED_USERS: 'alex@example.com=Alex',
        FILES_KEY: TEST_FILES_KEY.toString('base64'),
      },
      encoding: 'utf8',
      // Without the refusal the server would start and keep running; this is what ends such a run.
      timeout: 20_000,
    });
    return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
  };

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'tracker-newer-'));
    openTrackerDb(join(dir, 'tracker.db'), true, TEST_FILES_KEY).close();
    openAuthDb(join(dir, 'auth.db')).close();
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test('is refused when it is opened, and is left exactly as it was', () => {
    for (const { name, path, open } of databases()) {
      open().close();
      const step = moveStep(path, +1);
      try {
        const before = readFileSync(path);
        assert.throws(open, { message: refusal(name, step) });
        assert.ok(readFileSync(path).equals(before), `${name} was changed by the refused open`);
      } finally {
        moveStep(path, -1);
      }
      // Once the code is no older than the database, it opens again.
      open().close();
    }
  });

  test('stops an admin command with the reason on one line, not a stack trace', () => {
    const step = moveStep(join(dir, 'tracker.db'), +1);
    try {
      const r = start(CLI, 'users');
      assert.equal(r.code, 1);
      assert.equal(r.err, refusal('tracker.db', step));
      assert.equal(r.out, '');
    } finally {
      moveStep(join(dir, 'tracker.db'), -1);
    }
    const again = start(CLI, 'users');
    assert.equal(again.code, 0, again.err);
    assert.match(again.out, /Alex\talex@example\.com/);
  });

  test('stops the server before it listens, with the reason in its log', () => {
    for (const { name, path } of databases()) {
      const step = moveStep(path, +1);
      try {
        const r = start(SERVER);
        assert.equal(r.code, 1, `the server did not stop on a newer ${name}: ${r.err.slice(0, 300)}`);
        const lines = r.err.split('\n').map((line) => JSON.parse(line) as { level: string; msg: string; error?: string });
        assert.deepEqual(
          lines.filter((l) => l.level === 'error').map((l) => [l.msg, l.error]),
          [[`cannot open ${name}`, refusal(name, step)]],
        );
        assert.doesNotMatch(r.out, /"msg":"listening"/);
      } finally {
        moveStep(path, -1);
      }
    }
  });
});
