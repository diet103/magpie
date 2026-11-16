import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createCollection } from '../src/domain/collections.ts';
import { createEntry } from '../src/domain/entries.ts';
import { checkSql, runQuerySql } from '../src/sql/run.ts';
import { ok, seedRestaurants, setupDb, type TestEnv } from './helpers.ts';

let env: TestEnv;
before(() => {
  env = setupDb();
  seedRestaurants(env.alex);
  ok(createEntry(env.alex, { collection: 'restaurants', title: 'Pho 54', fields: { cuisine: 'Vietnamese' }, tags: ['pho'], log: { rating: 4, occurred_on: '2026-10-02' }, raw_text: 'pho 54, 4' }));
  ok(createEntry(env.sam, { collection: 'restaurants', title: 'Thai Basil', fields: { cuisine: 'Thai' }, log: { rating: 5, occurred_on: '2026-10-14' }, raw_text: 'thai basil 5' }));
  ok(createCollection(env.sam, { name: 'Gift ideas', description: 'For Alex.', fields: [], private: true, raw_text: 'x' }));
  ok(createEntry(env.sam, { collection: 'gift-ideas', title: 'Espresso grinder', raw_text: 'secret' }));
});
after(() => env.cleanup());

const q = (who: 'alex' | 'sam', sql: string, maxRows = 100) =>
  runQuerySql({ dbPath: env.dbPath, userId: env[who].actor.userId, sql, maxRows });

describe('query_sql', () => {
  test('counts and joins on the snapshot', async () => {
    const r = await q('alex', "SELECT count(*) AS n FROM entries WHERE rating >= 4");
    assert.deepEqual(r.columns, ['n']);
    assert.deepEqual(r.rows, [[2]]);
    const r2 = await q('alex', "SELECT e.title, l.logged_by FROM entries e JOIN logs l ON l.entry_id = e.id ORDER BY e.title;");
    assert.deepEqual(r2.rows, [['Pho 54', 'Alex'], ['Thai Basil', 'Sam']]);
    const r3 = await q('alex', "SELECT json_extract(fields, '$.cuisine') AS cuisine FROM entries ORDER BY 1");
    assert.deepEqual(r3.rows, [['Thai'], ['Vietnamese']]);
    const r4 = await q('alex', 'SELECT tag, count(*) FROM entry_tags GROUP BY tag');
    assert.deepEqual(r4.rows, [['pho', 1]]);
  });

  test('private rows never reach the snapshot', async () => {
    assert.deepEqual((await q('alex', 'SELECT count(*) FROM entries')).rows, [[2]]);
    assert.deepEqual((await q('alex', "SELECT count(*) FROM collections WHERE visibility = 'private'")).rows, [[0]]);
    assert.deepEqual((await q('sam', 'SELECT count(*) FROM entries')).rows, [[3]]);
    const users = await q('alex', 'SELECT * FROM users');
    assert.deepEqual(users.columns, ['id', 'name']);
  });

  test('only single read statements', async () => {
    assert.throws(() => checkSql('SELECT 1; SELECT 2'), /one statement/);
    assert.throws(() => checkSql('SELECT 1; DROP TABLE entries'), /one statement/);
    assert.throws(() => checkSql("DELETE FROM entries"), /only runs a single SELECT/);
    assert.throws(() => checkSql("ATTACH DATABASE '/data/auth.db' AS a"), /only runs a single SELECT/);
    assert.throws(() => checkSql("SELECT 'unclosed"), /unclosed quote/);
    assert.equal(checkSql("SELECT ';' AS x; -- trailing"), "SELECT ';' AS x");
    assert.deepEqual((await q('alex', "SELECT ';' AS x;")).rows, [[';']]);
    await assert.rejects(q('alex', "SELECT * FROM src.entries"), /no such table|unknown database/);
    await assert.rejects(q('alex', 'SELECT load_extension("x")'), /not authorized/);
    await assert.rejects(q('alex', 'SELECT nope FROM entries'), /no such column: nope\. Tables:/);
  });

  test('row cap and truncation', async () => {
    const r = await q('alex', 'WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n LIMIT 500) SELECT x FROM n', 50);
    assert.equal(r.rows.length, 50);
    assert.equal(r.truncated, true);
  });

  test('runaway queries are killed after 3 seconds', async () => {
    const t = Date.now();
    await assert.rejects(
      q('alex', 'WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n) SELECT count(*) FROM n'),
      /longer than 3 seconds/,
    );
    assert.ok(Date.now() - t < 6000);
  });
});

test('duplicate column names keep both values', async () => {
  const r = await q('alex', 'SELECT 1 AS x, 2 AS x');
  assert.deepEqual(r.columns, ['x', 'x']);
  assert.deepEqual(r.rows, [[1, 2]]);
});
