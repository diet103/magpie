// The admin commands in src/cli.ts, run the way they are run on the server: as their own process, on a data folder.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AuthStore } from '../src/auth/store.ts';
import { get, openAuthDb, openTrackerDb, run } from '../src/db/sqlite.ts';
import { createCollection } from '../src/domain/collections.ts';
import { createEntry, deleteItem } from '../src/domain/entries.ts';
import { setCollectionPinned } from '../src/domain/pins.ts';
import { nowIso } from '../src/domain/time.ts';
import type { Ctx } from '../src/domain/types.ts';
import { findUserByEmail, syncUsers } from '../src/domain/users.ts';
import { ok, TEST_FILES_KEY, TZ } from './helpers.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const PEOPLE = [
  { email: 'alex@example.com', name: 'Alex' },
  { email: 'sam@example.com', name: 'Sam' },
];

describe('the admin commands', () => {
  let dir: string;
  const env = () => ({
    PATH: process.env.PATH ?? '',
    NODE_ENV: 'test',
    DATA_DIR: dir,
    HOUSEHOLD_TZ: TZ,
    ALLOWED_USERS: PEOPLE.map((p) => `${p.email}=${p.name}`).join(','),
    FILES_KEY: TEST_FILES_KEY.toString('base64'),
  });
  const cli = (...args: string[]) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { env: env(), encoding: 'utf8' });
    return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
  };
  /** Opens the data folder the way a test needs to look inside it, and closes it again before the next command. */
  const inside = <T>(fn: (o: { alex: Ctx; store: AuthStore; userId: number }) => T): T => {
    const db = openTrackerDb(join(dir, 'tracker.db'), true, TEST_FILES_KEY);
    const authDb = openAuthDb(join(dir, 'auth.db'));
    try {
      syncUsers(db, PEOPLE);
      const u = findUserByEmail(db, 'alex@example.com')!;
      return fn({ alex: { db, tz: TZ, actor: { userId: u.id, name: u.display_name, via: 'web', client: 'test' } }, store: new AuthStore(authDb), userId: u.id });
    } finally {
      db.close();
      authDb.close();
    }
  };

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'tracker-cli-'));
    inside(() => undefined);
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test('users lists the household', () => {
    const r = cli('users');
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Alex\talex@example\.com/);
    assert.match(r.out, /Sam\tsam@example\.com/);
  });

  test('a token is printed once, listed by its label, and gone after revoke', () => {
    const made = cli('token', 'create', '--email', 'alex@example.com', '--label', 'laptop', '--ttl', '30m');
    assert.equal(made.code, 0, made.err);
    assert.match(made.out, /^tma_pat_\S{20,}$/);
    const listed = cli('token', 'list', '--email', 'alex@example.com');
    assert.match(listed.out, /\tlaptop\texpires /);
    assert.ok(!listed.out.includes(made.out), 'the list shows a fingerprint, never the token');
    assert.equal(inside(({ store }) => store.verifyAccess(made.out) !== undefined), true);

    assert.equal(cli('token', 'revoke', '--email', 'alex@example.com', '--all').out, 'revoked');
    assert.equal(cli('token', 'list', '--email', 'alex@example.com').out, '');
    assert.equal(inside(({ store }) => store.verifyAccess(made.out)), undefined);
  });

  test('signout-all ends every web session and revokes every token of that person only', () => {
    const made = inside(({ store, userId, alex }) => {
      const sam = findUserByEmail(alex.db, 'sam@example.com')!.id;
      return { mine: store.createSession(userId, 'phone').id, pat: store.createPat(userId, 'old', 60_000).token, hers: store.createSession(sam, 'phone').id };
    });
    const r = cli('signout-all', '--email', 'alex@example.com');
    assert.equal(r.code, 0, r.err);
    inside(({ store }) => {
      assert.equal(store.getSession(made.mine), undefined);
      assert.equal(store.verifyAccess(made.pat), undefined);
      assert.notEqual(store.getSession(made.hers), undefined, 'the other person stays signed in');
    });
  });

  test('purge-entry deletes one entry from the Trash forever, and refuses one that is not there', () => {
    const id = inside(({ alex }) => {
      ok(createCollection(alex, { name: 'Movies', description: 'Films.', fields: [] }));
      const e = ok(createEntry(alex, { collection: 'movies', title: 'Seen once', raw_text: 'x' }));
      return e.entryId!;
    });
    const early = cli('purge-entry', '--id', String(id), '--email', 'alex@example.com');
    assert.notEqual(early.code, 0);
    assert.match(early.err, /^Delete "Seen once" first; only entries in the Trash can be deleted forever\.$/, 'one line, no stack');
    inside(({ alex }) => ok(deleteItem(alex, { entry_id: id })));
    const r = cli('purge-entry', '--id', String(id), '--email', 'alex@example.com');
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Deleted "Seen once" from Movies forever\./);
    assert.equal(inside(({ alex }) => get(alex.db, 'SELECT count(*) AS n FROM entries WHERE id = ?', id)!.n), 0);
  });

  test('purge-smoke removes smoke-test collections with everything that points at them', () => {
    inside(({ alex, userId }) => {
      const c = ok(createCollection(alex, { name: 'zz smoke run', description: 'Left by a smoke test.', fields: [{ key: 'due_date', type: 'date' }] }));
      run(alex.db, "UPDATE collections SET slug = 'zz-smoke-run' WHERE id = ?", c.collectionId!);
      const e = ok(createEntry(alex, { collection: c.collectionId!, title: 'Probe', fields: { due_date: '2026-12-01' }, raw_text: 'x' }));
      // A pin and a hidden date would each block the delete if they were left behind.
      setCollectionPinned(alex, c.collectionId!, true);
      run(alex.db, 'INSERT INTO pins (user_id, entry_id, created_at) VALUES (?, ?, ?)', userId, e.entryId!, nowIso());
      run(alex.db, 'INSERT INTO hidden_dates (user_id, entry_id, field, date, created_at) VALUES (?, ?, ?, ?, ?)', userId, e.entryId!, 'due_date', '2026-12-01', nowIso());
    });
    const r = cli('purge-smoke');
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, 'Removed 1 smoke-test collection(s).');
    inside(({ alex }) => {
      assert.equal(get(alex.db, "SELECT count(*) AS n FROM collections WHERE slug LIKE 'zz-smoke-%'")!.n, 0);
      assert.equal(get(alex.db, 'SELECT (SELECT count(*) FROM collection_pins) + (SELECT count(*) FROM hidden_dates) + (SELECT count(*) FROM pins) AS n')!.n, 0);
    });
  });

  test('a mistyped command or a missing email stops with a message, not a stack', () => {
    const unknown = cli('sign-out');
    assert.equal(unknown.code, 1);
    assert.match(unknown.out, /^Commands: users, token/);
    const noEmail = cli('signout-all');
    assert.equal(noEmail.code, 1);
    assert.equal(noEmail.err, '--email is required');
    const stranger = cli('token', 'list', '--email', 'nobody@example.com');
    assert.equal(stranger.code, 1);
    assert.match(stranger.err, /^No user nobody@example\.com\. Users: /);
  });
});
