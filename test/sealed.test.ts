// Sensitive collections are encrypted in the database file. These tests read the file's own bytes, because
// "the app shows it correctly" and "it is not on the disk" are different claims.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { addMessage, recentMessages } from '../src/assistant/history.ts';
import { all, get, MIGRATIONS, onCommit, openTrackerDb, run, type DB } from '../src/db/sqlite.ts';
import { listActivity } from '../src/domain/activity.ts';
import { checklistItems, setDone } from '../src/domain/checklist.ts';
import { createCollection, moveAllEntries, updateCollection } from '../src/domain/collections.ts';
import { addChecklistItems, addLog, createEntry, getEntryDetail, mergeEntries, updateEntry, updateLog } from '../src/domain/entries.ts';
import { UserError } from '../src/domain/errors.ts';
import { applyFill, entriesMissing } from '../src/domain/fill.ts';
import { queryEntries, searchEntries } from '../src/domain/search.ts';
import { rewriteAfterChanges, sealPending, tidy } from '../src/domain/sealed.ts';
import { addDays, nowIso, todayIn } from '../src/domain/time.ts';
import type { Ctx } from '../src/domain/types.ts';
import { undoActivity } from '../src/domain/undo.ts';
import { comingUp } from '../src/domain/upcoming.ts';
import { syncUsers } from '../src/domain/users.ts';
import { runQuerySql } from '../src/sql/run.ts';
import { exportJson, exportSqlite } from '../src/web/export.ts';
import { ok, seedRestaurants, setupDb, TEST_FILES_KEY, TZ, type TestEnv } from './helpers.ts';

let env: TestEnv;
let rewriteErrors: unknown[];
beforeEach(() => {
  env = setupDb();
  // As on the server: once a change that sealed existing text has committed, the file is rewritten.
  rewriteErrors = [];
  rewriteAfterChanges(env.db, true, (err) => {
    if (err) rewriteErrors.push(err);
  });
});
afterEach(() => {
  env.cleanup();
  assert.deepEqual(rewriteErrors, []);
});

/** Whether the words are anywhere in the database file or its write-ahead log, in any letter case. */
function inFile(db: DB, path: string, words: string): boolean {
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const needle = words.toLowerCase();
  return ['', '-wal'].some((suffix) => existsSync(path + suffix) && readFileSync(path + suffix).toString('latin1').toLowerCase().includes(needle));
}
const onDisk = (words: string) => inFile(env.db, env.dbPath, words);

function documents(ctx: Ctx = env.alex) {
  return ok(
    createCollection(ctx, {
      name: 'Personal documents',
      description: 'IDs and their numbers.',
      sensitive: true,
      fields: [
        { key: 'number', type: 'text' },
        { key: 'issued_by', type: 'text' },
        { key: 'expires_on', type: 'date' },
      ],
      raw_text: 'a place for IDs',
    }),
  ).collectionId!;
}

/** A license with a different made-up word in every place text can be kept. */
function license(collection = 'personal-documents') {
  const made = ok(
    createEntry(env.alex, {
      collection,
      title: 'Driver license',
      fields: { number: 'QUOKKA1111', expires_on: addDays(todayIn(TZ), 5) },
      notes: 'Kept in the WOMBAT2222 drawer',
      tags: ['id'],
      log: { occurred_on: '2026-11-01', note: 'renewed at the NUMBAT3333 office' },
      raw_text: 'my license number is QUOKKA1111, said at BILBY4444',
    }),
  );
  ok(updateEntry(env.alex, { entry_id: made.entryId!, fields: { number: 'POTOROO5555' }, raw_text: 'the new one is POTOROO5555, GLIDER6666' }));
  const logged = ok(addLog(env.alex, { entry_id: made.entryId!, occurred_on: '2026-11-02', note: 'photo taken, BANDICOOT7777', raw_text: 'took its photo BANDICOOT7777' }));
  ok(updateLog(env.alex, { log_id: logged.logId!, note: 'photo retaken, DUNNART8888' }));
  return made.entryId!;
}
const EVERY_WORD = ['QUOKKA1111', 'WOMBAT2222', 'NUMBAT3333', 'BILBY4444', 'POTOROO5555', 'GLIDER6666', 'BANDICOOT7777', 'DUNNART8888'];

describe('what a sensitive collection holds is not readable in the database file', () => {
  test('fields, notes, logs, the words said and the history are sealed; the title is not', () => {
    documents();
    license();
    for (const word of EVERY_WORD) assert.equal(onDisk(word), false, `${word} is in the file`);
    assert.equal(onDisk('Driver license'), true, 'titles stay readable');
  });

  test('the same entry in an ordinary collection is in the file, so the check above can fail', () => {
    ok(createCollection(env.alex, { name: 'Things', description: 'Ordinary things.', fields: [{ key: 'number', type: 'text' }, { key: 'expires_on', type: 'date' }], raw_text: 'x' }));
    license('things');
    for (const word of EVERY_WORD) assert.equal(onDisk(word), true, `${word} should be in the file`);
  });

  test('it reads back whole, and is found, filtered, sorted and dated as before', () => {
    const cid = documents();
    const id = license();
    const d = getEntryDetail(env.alex, id);
    assert.equal(d.fields.number, 'POTOROO5555');
    assert.equal(d.entry.notes, 'Kept in the WOMBAT2222 drawer');
    assert.equal(d.entry.source_text, 'my license number is QUOKKA1111, said at BILBY4444');
    assert.deepEqual(d.logs.map((l) => l.note), ['photo retaken, DUNNART8888', 'renewed at the NUMBAT3333 office']);
    assert.equal(d.logs[0].raw_text, 'took its photo BANDICOOT7777');

    // Sam sees it too: the key is the server's, not a person's.
    assert.equal(getEntryDetail(env.sam, id).fields.number, 'POTOROO5555');

    for (const word of ['potoroo5555', 'wombat2222', 'dunnart8888', 'bilby4444']) {
      assert.deepEqual(searchEntries(env.alex, { query: word }).hits.map((h) => h.id), [id], `search for ${word}`);
    }
    assert.equal(queryEntries(env.alex, { collectionId: cid, fieldEq: [['number', 'potoroo5555']], limit: 10 }).total, 1);
    assert.equal(queryEntries(env.alex, { collectionId: cid, fieldEq: [['number', 'QUOKKA1111']], limit: 10 }).total, 0);
    ok(createEntry(env.alex, { collection: 'personal-documents', title: 'Passport', fields: { number: 'AAA' }, raw_text: 'passport' }));
    assert.deepEqual(queryEntries(env.alex, { collectionId: cid, sort: { by: 'number', dir: 'asc' }, limit: 10 }).hits.map((h) => h.title), ['Passport', 'Driver license']);
    assert.deepEqual(comingUp(env.alex, todayIn(TZ)).map((u) => [u.title, u.field, u.days]), [['Driver license', 'expires_on', 5]]);

    const history = listActivity(env.alex, { entryId: id });
    assert.match(history.find((a) => a.action === 'update_entry')!.summary, /number POTOROO5555 \(was QUOKKA1111\)/);
    assert.equal(history.find((a) => a.action === 'update_entry')!.raw_text, 'the new one is POTOROO5555, GLIDER6666');
  });

  test('the search index kept in the file has only the title and tags of a sealed entry', () => {
    documents();
    const id = license();
    const disk = (word: string) => all<{ rowid: number }>(env.db, 'SELECT rowid FROM entries_fts WHERE entries_fts MATCH ?', word).map((r) => r.rowid);
    assert.deepEqual(disk('license'), [id]);
    assert.deepEqual(disk('wombat2222'), []);
    assert.deepEqual(disk('potoroo5555'), []);
  });

  test('the database refuses text that arrives in the wrong form, whoever writes it', () => {
    const cid = documents();
    const id = license();
    const uid = env.alex.actor.userId;
    assert.throws(() => run(env.db, "UPDATE entries SET notes = 'left in the clear' WHERE id = ?", id), /sealed in a sensitive collection/);
    assert.throws(
      () => run(env.db, `INSERT INTO entries (collection_id, title, title_key, fields, created_by) VALUES (?, 'Card', 'card', '{"number":"1"}', ?)`, cid, uid),
      /sealed in a sensitive collection/,
    );
    assert.throws(() => run(env.db, "UPDATE entry_logs SET note = 'left in the clear' WHERE entry_id = ?", id), /sealed in a sensitive collection/);
    assert.throws(
      () => run(env.db, `INSERT INTO entry_logs (entry_id, occurred_on, note, created_by) VALUES (?, '2026-11-03', 'left in the clear', ?)`, id, uid),
      /sealed in a sensitive collection/,
    );
    // And the other way: an ordinary collection is read by query_sql and by a GUI, so nothing in it may be sealed.
    seedRestaurants(env.alex);
    const pho = ok(createEntry(env.alex, { collection: 'restaurants', title: 'Pho 54', raw_text: 'pho' })).entryId!;
    const sealed = get<{ sealed: string }>(env.db, 'SELECT sealed FROM entries WHERE id = ?', id)!.sealed;
    assert.throws(() => run(env.db, 'UPDATE entries SET sealed = ? WHERE id = ?', sealed, pho), /plain in any other/);
  });

  test('filling a field and ticking a list work in a sensitive collection', () => {
    const cid = documents();
    const id = license();
    assert.deepEqual(entriesMissing(env.alex, cid, 'issued_by').map((m) => [m.id, /WOMBAT2222/.test(m.words), /NUMBAT3333/.test(m.words)]), [[id, true, true]]);
    assert.equal(applyFill(env.alex, cid, 'issued_by', [{ id, value: 'State of ECHIDNA9999' }], 1).filled, 1);
    assert.equal(getEntryDetail(env.alex, id).fields.issued_by, 'State of ECHIDNA9999');
    assert.equal(getEntryDetail(env.alex, id).fields.number, 'POTOROO5555', 'the rest of the entry is still there');
    assert.equal(onDisk('ECHIDNA9999'), false);

    const list = ok(createCollection(env.alex, { name: 'Accounts to close', description: 'Old accounts.', checklist: true, sensitive: true, raw_text: 'x' })).collectionId!;
    const item = ok(createEntry(env.alex, { collection: list, title: 'Old bank', raw_text: 'close the GOANNA1010 account' })).entryId!;
    ok(setDone(env.alex, item, true));
    assert.deepEqual(checklistItems(env.alex, list).done.map((i) => i.title), ['Old bank']);
    const added = addChecklistItems(env.alex, list, ['Old bank', 'Old phone plan']);
    assert.deepEqual([added.added, added.back], [1, 1]);
    assert.deepEqual(checklistItems(env.alex, list).todo.map((i) => i.title), ['Old bank', 'Old phone plan']);
    assert.equal(getEntryDetail(env.alex, item).entry.source_text, 'close the GOANNA1010 account', 'unticking keeps what the item said');
    assert.equal(onDisk('GOANNA1010'), false);
  });
});

describe('entries that become sensitive, or stop being', () => {
  test('marking a collection sensitive seals what it already holds and its history; unmarking opens it again', async () => {
    const cid = ok(createCollection(env.alex, { name: 'Things', description: 'Ordinary things.', fields: [{ key: 'number', type: 'text' }, { key: 'expires_on', type: 'date' }], raw_text: 'x' })).collectionId!;
    const id = license('things');
    assert.equal(onDisk('QUOKKA1111'), true);

    const marked = ok(updateCollection(env.alex, { collection: cid, sensitive: true }));
    // QUOKKA1111 and GLIDER6666 are only in the history by now: an old value and the words of an old change.
    for (const word of EVERY_WORD) assert.equal(onDisk(word), false, `${word} is still in the file`);
    assert.equal(getEntryDetail(env.alex, id).fields.number, 'POTOROO5555');
    assert.deepEqual(searchEntries(env.alex, { query: 'wombat2222' }).hits.map((h) => h.id), [id]);
    assert.match(listActivity(env.alex, { entryId: id }).find((a) => a.action === 'update_entry')!.summary, /was QUOKKA1111/);

    ok(undoActivity(env.alex, marked.activityId!));
    assert.equal(onDisk('WOMBAT2222'), true, 'undoing the setting opens the entries again');
    assert.equal(getEntryDetail(env.alex, id).fields.number, 'POTOROO5555');
    const viaSql = await runQuerySql({ dbPath: env.dbPath, userId: env.alex.actor.userId, sql: 'SELECT notes FROM entries', maxRows: 10 });
    assert.deepEqual(viaSql.rows, [['Kept in the WOMBAT2222 drawer']], 'and query_sql reads them, as it does any ordinary collection');
  });

  test('moving an entry in seals it, its logs and what was recorded about it; moving it out opens it', () => {
    documents();
    ok(createCollection(env.alex, { name: 'Things', description: 'Ordinary things.', fields: [{ key: 'number', type: 'text' }, { key: 'expires_on', type: 'date' }], raw_text: 'x' }));
    const id = license('things');
    const moved = ok(updateEntry(env.alex, { entry_id: id, move_to_collection: 'personal-documents' }));
    for (const word of EVERY_WORD) assert.equal(onDisk(word), false, `${word} is still in the file`);
    const d = getEntryDetail(env.alex, id);
    assert.equal(d.fields.number, 'POTOROO5555');
    assert.deepEqual(d.logs.map((l) => l.note), ['photo retaken, DUNNART8888', 'renewed at the NUMBAT3333 office']);

    ok(undoActivity(env.alex, moved.activityId!));
    assert.equal(getEntryDetail(env.alex, id).collection.slug, 'things');
    assert.equal(onDisk('NUMBAT3333'), true, 'back in an ordinary collection its logs are plain again');
    assert.equal(getEntryDetail(env.alex, id).logs.length, 2);
  });

  test('an entry that already has others merged into it brings them along, whichever way it becomes sensitive', () => {
    const things = ok(createCollection(env.alex, { name: 'Things', description: 'Ordinary things.', fields: [{ key: 'number', type: 'text' }], raw_text: 'x' })).collectionId!;
    ok(createCollection(env.alex, { name: 'Application info', description: 'Details for forms.', fields: [{ key: 'number', type: 'text' }], raw_text: 'x' }));
    const pair = (word: string) => {
      const keep = ok(createEntry(env.alex, { collection: 'things', title: `Card ${word}`, raw_text: 'a card' })).entryId!;
      const dup = ok(createEntry(env.alex, { collection: 'application-info', title: `Card ${word}`, fields: { number: `${word}5151` }, raw_text: `card number ${word}5151, ${word}6161`, not_duplicate_of: [keep] })).entryId!;
      ok(mergeEntries(env.alex, { keep_id: keep, duplicate_id: dup }));
      return keep;
    };
    const marked = pair('PLATYPUS');
    const moved = pair('PYTHON');
    for (const word of ['PLATYPUS5151', 'PLATYPUS6161', 'PYTHON5151', 'PYTHON6161']) assert.equal(onDisk(word), true);

    documents();
    ok(updateEntry(env.alex, { entry_id: moved, move_to_collection: 'personal-documents' }));
    for (const word of ['PYTHON5151', 'PYTHON6161']) assert.equal(onDisk(word), false, `${word} is still in the file`);
    assert.equal(onDisk('PLATYPUS6161'), true);
    ok(updateCollection(env.alex, { collection: things, sensitive: true }));
    for (const word of ['PLATYPUS5151', 'PLATYPUS6161']) assert.equal(onDisk(word), false, `${word} is still in the file`);
    assert.equal(getEntryDetail(env.alex, marked).fields.number, 'PLATYPUS5151');
    assert.deepEqual(searchEntries(env.alex, { query: 'platypus6161' }).hits.map((h) => h.id), [marked], 'the words it was merged with still find it');
    assert.deepEqual(searchEntries(env.alex, { query: 'python6161' }).hits.map((h) => h.id), [moved]);
  });

  test('moving every entry of a collection into a sensitive one', () => {
    const docs = documents();
    const things = ok(createCollection(env.alex, { name: 'Things', description: 'Ordinary things.', fields: [{ key: 'number', type: 'text' }, { key: 'expires_on', type: 'date' }], raw_text: 'x' })).collectionId!;
    const id = license('things');
    ok(moveAllEntries(env.alex, things, docs));
    for (const word of EVERY_WORD) assert.equal(onDisk(word), false, `${word} is still in the file`);
    assert.equal(getEntryDetail(env.alex, id).fields.number, 'POTOROO5555');
    ok(moveAllEntries(env.alex, docs, things));
    assert.equal(getEntryDetail(env.alex, id).fields.number, 'POTOROO5555');
    assert.equal(onDisk('WOMBAT2222'), true);
  });

  test('what is merged into a sensitive entry is sealed with it, and an undo puts it back as it was', () => {
    documents();
    ok(createCollection(env.alex, { name: 'Application info', description: 'Details for forms.', fields: [{ key: 'number', type: 'text' }], raw_text: 'x' }));
    const keep = ok(createEntry(env.alex, { collection: 'personal-documents', title: 'Passport', fields: { issued_by: 'USA' }, raw_text: 'my passport' })).entryId!;
    const dup = ok(
      createEntry(env.alex, {
        collection: 'application-info',
        title: 'Passport',
        fields: { number: 'TAIPAN1212' },
        notes: 'copy in the SKINK1313 folder',
        log: { occurred_on: '2026-10-01', note: 'used for the GECKO1414 form' },
        raw_text: 'passport number TAIPAN1212',
        not_duplicate_of: [keep],
      }),
    ).entryId!;
    const merged = ok(mergeEntries(env.alex, { keep_id: keep, duplicate_id: dup }));
    for (const word of ['TAIPAN1212', 'SKINK1313', 'GECKO1414']) assert.equal(onDisk(word), false, `${word} is still in the file`);
    const d = getEntryDetail(env.alex, keep);
    assert.equal(d.fields.number, 'TAIPAN1212');
    assert.match(d.entry.notes, /SKINK1313/);
    assert.deepEqual(d.logs.map((l) => l.note), ['used for the GECKO1414 form']);
    assert.deepEqual(searchEntries(env.alex, { query: 'taipan1212' }).hits.map((h) => h.id), [keep]);

    assert.deepEqual(all(env.db, "SELECT rowid FROM entries_fts WHERE entries_fts MATCH 'taipan1212 OR skink1313 OR gecko1414'"), []);

    ok(undoActivity(env.alex, merged.activityId!));
    const back = getEntryDetail(env.alex, dup);
    assert.equal(back.collection.slug, 'application-info');
    assert.equal(back.fields.number, 'TAIPAN1212');
    assert.equal(back.entry.notes, 'copy in the SKINK1313 folder');
    assert.deepEqual(back.logs.map((l) => l.note), ['used for the GECKO1414 form']);
    assert.equal(getEntryDetail(env.alex, keep).fields.number, undefined);
  });
});

describe('no text is left readable when entries become sensitive, move or merge', () => {
  const things = () => ok(createCollection(env.alex, { name: 'Things', description: 'Ordinary things.', fields: [{ key: 'number', type: 'text' }], raw_text: 'x' })).collectionId!;
  const insurance = () => ok(createCollection(env.alex, { name: 'Insurance', description: 'Policies.', sensitive: true, fields: [{ key: 'number', type: 'text' }], raw_text: 'x' })).collectionId!;
  const collectionOf = (id: number) => get<{ collection_id: number }>(env.db, 'SELECT collection_id FROM entries WHERE id = ?', id)!.collection_id;
  const diskIndex = (query: string) => all<{ rowid: number }>(env.db, 'SELECT rowid FROM entries_fts WHERE entries_fts MATCH ?', query).map((r) => r.rowid);

  test('sealing many entries at once leaves none of their text in the unused parts of the file', () => {
    // With a few hundred rows SQLite rearranges pages as it goes, and copies of rows are left behind in the
    // gaps. Wiping deleted rows does not reach those; only the rewrite that sealing asks for does.
    const cid = things();
    const ids: number[] = [];
    for (let i = 0; i < 300; i++) {
      const id = ok(
        createEntry(env.alex, {
          collection: cid,
          title: `Paper ${i} of ${(i * 7919) % 100003}`,
          fields: { number: `SXNUM${i}E` },
          notes: `kept SXNOTE${i}E in the drawer by the door`,
          log: { occurred_on: '2026-07-01', note: `renewed SXLOG${i}E` },
          raw_text: `said SXSAID${i}E about it`,
          not_duplicate_of: ids,
        }),
      ).entryId!;
      ids.push(id);
      if (i % 2 === 0) ok(updateEntry(env.alex, { entry_id: id, append_note: `more SXAPP${i}E`, raw_text: `changed SXRAW${i}E` }));
    }
    const left = () => {
      env.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      return new Set(readFileSync(env.dbPath).toString('latin1').match(/SX(?:NUM|NOTE|LOG|SAID|APP|RAW)\d+E/gi) ?? []).size;
    };
    assert.ok(left() > 1000);
    ok(updateCollection(env.alex, { collection: cid, sensitive: true }));
    assert.equal(left(), 0);
    assert.equal(get(env.db, 'SELECT 1 FROM rewrite_due'), undefined, 'the rewrite that was owed has been done');
    assert.equal(getEntryDetail(env.alex, ids[7]).fields.number, 'SXNUM7E');
    assert.equal(searchEntries(env.alex, { query: 'sxnote123e' }).total, 1);
  });

  test('the same when they are moved in one at a time, with the rewrite left to the next start', () => {
    const cid = things();
    documents();
    const ids: number[] = [];
    for (let i = 0; i < 150; i++) {
      ids.push(ok(createEntry(env.alex, { collection: cid, title: `Paper ${i} of ${(i * 7919) % 100003}`, fields: { number: `SXNUM${i}E` }, notes: `kept SXNOTE${i}E in the drawer by the door`, raw_text: `said SXSAID${i}E about it`, not_duplicate_of: ids })).entryId!);
    }
    // No rewriting after each change this time, as if it kept failing: what is owed must still be owed at a start.
    assert.equal(get(env.db, 'SELECT 1 FROM rewrite_due'), undefined);
    onCommit(env.db, () => {});
    for (const id of ids) ok(updateEntry(env.alex, { entry_id: id, move_to_collection: 'personal-documents' }));
    assert.ok(get(env.db, 'SELECT 1 FROM rewrite_due'), 'a rewrite is owed');
    env.db.close();
    const again = openTrackerDb(env.dbPath, false, TEST_FILES_KEY);
    try {
      assert.deepEqual(tidy(again, true), { sealed: 0, rewritten: true });
      const bytes = readFileSync(env.dbPath).toString('latin1');
      assert.deepEqual(bytes.match(/SX(?:NUM|NOTE|SAID)\d+E/gi) ?? [], []);
    } finally {
      again.close();
    }
  });

  test('a row merged into a sensitive entry stays sealed when its own collection stops being sensitive', () => {
    const docs = documents();
    const ins = insurance();
    const keep = ok(createEntry(env.alex, { collection: docs, title: 'Health card', fields: { number: 'ZQKEEPNUM' }, raw_text: 'ZQKEEPSAID' })).entryId!;
    const dup = ok(createEntry(env.alex, { collection: ins, title: 'Health card', fields: { number: 'ZQDUPNUM' }, notes: 'ZQDUPNOTE', raw_text: 'member id ZQDUPSAID', not_duplicate_of: [keep] })).entryId!;
    ok(mergeEntries(env.alex, { keep_id: keep, duplicate_id: dup }));
    assert.equal(collectionOf(dup), ins, 'both collections are sensitive, so it stays where it was');
    ok(updateCollection(env.alex, { collection: ins, sensitive: false }));
    assert.equal(collectionOf(dup), docs, 'it follows the entry it was merged into');
    for (const word of ['ZQDUPNUM', 'ZQDUPNOTE', 'ZQDUPSAID', 'ZQKEEPNUM']) assert.equal(onDisk(word), false, `${word} is in the file`);
    assert.deepEqual(diskIndex('zqdupsaid OR zqdupnote'), []);
    assert.deepEqual(searchEntries(env.alex, { query: 'zqdupsaid' }).hits.map((h) => h.id), [keep]);
  });

  test('moving everything out of a sensitive collection leaves such a row with its entry', () => {
    const docs = documents();
    const ins = insurance();
    const cid = things();
    const keep = ok(createEntry(env.alex, { collection: docs, title: 'Health card', fields: { number: 'ZQKEEPNUM' }, raw_text: 'x' })).entryId!;
    const dup = ok(createEntry(env.alex, { collection: ins, title: 'Health card', fields: { number: 'ZQDUPNUM' }, notes: 'ZQDUPNOTE', raw_text: 'member id ZQDUPSAID', not_duplicate_of: [keep] })).entryId!;
    const other = ok(createEntry(env.alex, { collection: ins, title: 'Car policy', fields: { number: 'ZQCARNUM' }, raw_text: 'x' })).entryId!;
    ok(mergeEntries(env.alex, { keep_id: keep, duplicate_id: dup }));
    const moved = ok(moveAllEntries(env.alex, ins, cid));
    assert.deepEqual(moved.extra, ['No longer encrypted: Things is not a sensitive collection.']);
    assert.equal(collectionOf(other), cid);
    assert.equal(collectionOf(dup), docs);
    assert.equal(onDisk('ZQCARNUM'), true, 'what was moved out on purpose is ordinary now');
    for (const word of ['ZQDUPNUM', 'ZQDUPNOTE', 'ZQDUPSAID']) assert.equal(onDisk(word), false, `${word} is in the file`);
  });

  test('moving a merged row into a sensitive collection takes its words out of the search index on disk', () => {
    const docs = documents();
    const cid = things();
    ok(createCollection(env.alex, { name: 'Places', description: 'Ordinary places.', raw_text: 'x' }));
    const keep = ok(createEntry(env.alex, { collection: 'places', title: 'Clinic', raw_text: 'the clinic' })).entryId!;
    const dup = ok(createEntry(env.alex, { collection: cid, title: 'Clinic', raw_text: 'member id ZQDUPSAID', not_duplicate_of: [keep] })).entryId!;
    ok(mergeEntries(env.alex, { keep_id: keep, duplicate_id: dup }));
    assert.deepEqual(diskIndex('zqdupsaid'), [keep]);
    ok(moveAllEntries(env.alex, cid, docs));
    assert.deepEqual(diskIndex('zqdupsaid'), []);
    assert.equal(onDisk('ZQDUPSAID'), false);
    assert.deepEqual(searchEntries(env.alex, { query: 'zqdupsaid' }).hits.map((h) => h.id), [keep], 'the app still finds the entry by it');
  });

  test('a sensitive entry merged into an ordinary one by mistake leaves nothing behind once the merge is undone', () => {
    documents();
    const cid = things();
    const passport = ok(createEntry(env.alex, { collection: 'personal-documents', title: 'Passport', fields: { number: 'ZQPASSNUM' }, notes: 'ZQPASSNOTE', log: { occurred_on: '2026-11-01', note: 'ZQPASSLOG' }, raw_text: 'ZQPASSSAID' })).entryId!;
    const wallet = ok(createEntry(env.alex, { collection: cid, title: 'Passport wallet', notes: 'leather', raw_text: 'wallet' })).entryId!;
    const merged = ok(mergeEntries(env.alex, { keep_id: wallet, duplicate_id: passport }));
    assert.deepEqual(merged.extra, ['What was in "Passport" is no longer encrypted: Things is not a sensitive collection.']);
    assert.equal(onDisk('ZQPASSNUM'), true, 'the wallet is an ordinary entry and now holds the number');
    ok(undoActivity(env.alex, merged.activityId!));
    for (const word of ['ZQPASSNUM', 'ZQPASSNOTE', 'ZQPASSLOG', 'ZQPASSSAID']) assert.equal(onDisk(word), false, `${word} is in the file`);
    const back = getEntryDetail(env.alex, passport);
    assert.equal(back.collection.slug, 'personal-documents');
    assert.equal(back.fields.number, 'ZQPASSNUM');
    assert.deepEqual(back.logs.map((l) => l.note), ['ZQPASSLOG']);
    assert.equal(getEntryDetail(env.alex, wallet).entry.notes, 'leather');
  });

  test('moving one entry out of a sensitive collection says it is no longer encrypted', () => {
    documents();
    things();
    const id = license();
    assert.ok(ok(updateEntry(env.alex, { entry_id: id, move_to_collection: 'things' })).extra.includes('No longer encrypted: Things is not a sensitive collection.'));
    assert.equal(onDisk('WOMBAT2222'), true);
  });
});

describe('undo on sealed entries', () => {
  test('a change is undone, and nothing of either value reaches the file', () => {
    documents();
    const id = ok(createEntry(env.alex, { collection: 'personal-documents', title: 'Passport', fields: { number: 'FIRSTVALUE' }, raw_text: 'x' })).entryId!;
    const change = ok(updateEntry(env.alex, { entry_id: id, fields: { number: 'SECONDVALUE' }, notes: 'second' }));
    const undone = ok(undoActivity(env.alex, change.activityId!));
    assert.match(undone.summary, /^Undid: Updated "Passport": number SECONDVALUE \(was FIRSTVALUE\)/);
    assert.equal(getEntryDetail(env.alex, id).fields.number, 'FIRSTVALUE');
    assert.equal(getEntryDetail(env.alex, id).entry.notes, '');
    assert.equal(onDisk('FIRSTVALUE'), false);
    assert.equal(onDisk('SECONDVALUE'), false);
  });

  test('an earlier change can still be undone once a later one has been, though the text was sealed afresh', () => {
    documents();
    const id = ok(createEntry(env.alex, { collection: 'personal-documents', title: 'Passport', fields: { number: 'ONE' }, raw_text: 'x' })).entryId!;
    const first = ok(updateEntry(env.alex, { entry_id: id, fields: { number: 'TWO' } }));
    const second = ok(updateEntry(env.alex, { entry_id: id, fields: { number: 'THREE' } }));
    ok(undoActivity(env.alex, second.activityId!));
    ok(undoActivity(env.alex, first.activityId!));
    assert.equal(getEntryDetail(env.alex, id).fields.number, 'ONE');
  });

  test('a change someone made since still stops it', () => {
    documents();
    const id = ok(createEntry(env.alex, { collection: 'personal-documents', title: 'Passport', fields: { number: 'ONE' }, raw_text: 'x' })).entryId!;
    const first = ok(updateEntry(env.alex, { entry_id: id, fields: { number: 'TWO' } }));
    ok(updateEntry(env.sam, { entry_id: id, fields: { number: 'THREE' } }));
    assert.throws(() => undoActivity(env.alex, first.activityId!), /Sam changed it since: Updated "Passport": number THREE \(was TWO\)/);
  });

  test('a log is undone', () => {
    documents();
    const id = ok(createEntry(env.alex, { collection: 'personal-documents', title: 'Passport', raw_text: 'x' })).entryId!;
    const logged = ok(addLog(env.alex, { entry_id: id, occurred_on: '2026-11-02', note: 'first note' }));
    const edited = ok(updateLog(env.alex, { log_id: logged.logId!, note: 'second note' }));
    ok(undoActivity(env.alex, edited.activityId!));
    assert.deepEqual(getEntryDetail(env.alex, id).logs.map((l) => l.note), ['first note']);
    ok(undoActivity(env.alex, logged.activityId!));
    assert.deepEqual(getEntryDetail(env.alex, id).logs, []);
  });
});

describe('the key', () => {
  test('a database with sealed entries will not open with another key, or with none', () => {
    documents();
    const id = license();
    env.db.close();
    assert.throws(() => openTrackerDb(env.dbPath, false, Buffer.alloc(32, 9)), /sensitive entries in this database cannot be opened.*FILES_KEY/s);
    assert.throws(() => openTrackerDb(env.dbPath, false), /sensitive entries in this database cannot be opened.*no FILES_KEY/s);
    const again = openTrackerDb(env.dbPath, false, TEST_FILES_KEY);
    try {
      assert.equal(getEntryDetail({ ...env.alex, db: again }, id).fields.number, 'POTOROO5555');
      assert.deepEqual(searchEntries({ ...env.alex, db: again }, { query: 'wombat2222' }).hits.map((h) => h.id), [id], 'the search index is filled again at start');
    } finally {
      again.close();
    }
  });

  test('a server with no key says so instead of saving to a sensitive collection in the clear', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tracker-nokey-'));
    const db = openTrackerDb(join(dir, 'tracker.db'), true);
    try {
      syncUsers(db, [{ email: 'alex@example.com', name: 'Alex' }]);
      const ctx: Ctx = { db, tz: TZ, actor: { userId: 1, name: 'Alex', via: 'web' } };
      const noKey = (err: unknown) => err instanceof UserError && /no FILES_KEY/.test(err.message);
      assert.throws(() => documents(ctx), noKey);
      // A sensitive collection that is already there (a copy of the real database on a PC, say) takes nothing new.
      ok(createCollection(ctx, { name: 'Personal documents', description: 'IDs.', fields: [{ key: 'number', type: 'text' }], raw_text: 'x' }));
      run(db, "UPDATE collections SET sensitive = 1 WHERE slug = 'personal-documents'");
      assert.throws(() => createEntry(ctx, { collection: 'personal-documents', title: 'Passport', fields: { number: 'X1' }, raw_text: 'x' }), noKey);
      assert.equal(get<{ n: number }>(db, 'SELECT count(*) AS n FROM entries')!.n, 0);
      // Everything else works as it did.
      seedRestaurants(ctx);
      ok(createEntry(ctx, { collection: 'restaurants', title: 'Pho 54', notes: 'great broth', raw_text: 'pho' }));
      assert.equal(searchEntries(ctx, { query: 'broth' }).total, 1);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a database from before sealing existed', () => {
  // `alone` is the server with the database to itself; without it, the server under Litestream, which must
  // leave the write-ahead log for Litestream to reset.
  for (const alone of [true, false]) test(`is sealed when the new version first opens it, and nothing of it is left in the file (${alone ? 'alone' : 'under Litestream'})`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'tracker-old-'));
    const path = join(dir, 'tracker.db');
    try {
      // Version 8, built from the migrations that existed then, holding what a household had saved in the clear.
      const old = new DatabaseSync(path);
      old.exec('PRAGMA journal_mode = WAL');
      for (const f of readdirSync(MIGRATIONS.tracker).filter((f) => /^00[1-8]_/.test(f)).sort()) old.exec(readFileSync(join(MIGRATIONS.tracker, f), 'utf8'));
      old.exec('PRAGMA user_version = 8');
      const passport = () => ({ ...(old.prepare('SELECT * FROM entries WHERE id = 1').get() as Record<string, unknown>) });
      const insert = old.prepare(
        `INSERT INTO activity (user_id, via, action, collection_id, entry_id, summary, raw_text, before_json, after_json) VALUES (1, 'mcp', 'update_entry', 1, 1, ?, ?, ?, ?)`,
      );
      old.exec(`
        INSERT INTO users (id, email, display_name) VALUES (1, 'alex@example.com', 'Alex');
        INSERT INTO collections (id, slug, name, description, fields, created_by, sensitive) VALUES
          (1, 'personal-documents', 'Personal documents', 'IDs.', '[{"key":"number","type":"text"}]', 1, 1),
          (2, 'restaurants', 'Restaurants', 'Places.', '[{"key":"cuisine","type":"text"}]', 1, 0);
        INSERT INTO entries (id, collection_id, title, title_key, fields, notes, source_text, created_by) VALUES
          (1, 1, 'Passport', 'passport', '{"number":"KOALA1515"}', 'first kept in the EMU1616 box', 'passport number KOALA1515', 1),
          (2, 2, 'Pho 54', 'pho 54', '{"cuisine":"Vietnamese"}', 'CASSOWARY1717 broth', 'pho', 1);
        INSERT INTO entry_logs (entry_id, occurred_on, note, raw_text, created_by) VALUES (1, '2026-10-01', 'renewed, GALAH1818', 'renewed it GALAH1818', 1);
      `);
      const before = passport();
      old.exec(`UPDATE entries SET fields = '{"number":"KOOKABURRA1919"}', notes = 'now in the LORIKEET2020 safe' WHERE id = 1`);
      insert.run(
        'Updated "Passport": number KOOKABURRA1919 (was KOALA1515). (#1)',
        'the number is KOOKABURRA1919, IBIS2121',
        JSON.stringify({ entries: [before] }),
        JSON.stringify({ entries: [passport()] }),
      );
      old.prepare(`INSERT INTO chat_messages (user_id, role, text, created_at) VALUES (1, 'user', 'save my passport, number KOOKABURRA1919, MAGPIE2222', ?)`).run(nowIso());
      old.close();

      const db = openTrackerDb(path, false, TEST_FILES_KEY);
      try {
        const words = ['KOALA1515', 'EMU1616', 'GALAH1818', 'KOOKABURRA1919', 'LORIKEET2020', 'IBIS2121', 'MAGPIE2222'];
        assert.equal(inFile(db, path, 'KOOKABURRA1919'), true, 'opening it alone seals nothing');
        const done = tidy(db, alone);
        assert.ok(done.sealed > 0 && done.rewritten);
        for (const word of words) assert.equal(inFile(db, path, word), false, `${word} is still in the file`);
        assert.equal(inFile(db, path, 'CASSOWARY1717'), true, 'an ordinary collection is left as it was');
        assert.deepEqual(tidy(db, alone), { sealed: 0, rewritten: false }, 'a second start finds nothing to do');
        assert.equal(sealPending(db), 0);

        const ctx: Ctx = { db, tz: TZ, actor: { userId: 1, name: 'Alex', via: 'web' } };
        const d = getEntryDetail(ctx, 1);
        assert.equal(d.fields.number, 'KOOKABURRA1919');
        assert.equal(d.entry.notes, 'now in the LORIKEET2020 safe');
        assert.deepEqual(d.logs.map((l) => [l.note, l.raw_text]), [['renewed, GALAH1818', 'renewed it GALAH1818']]);
        assert.deepEqual(searchEntries(ctx, { query: 'lorikeet2020' }).hits.map((h) => h.id), [1]);
        assert.deepEqual(all(db, "SELECT rowid FROM entries_fts WHERE entries_fts MATCH 'lorikeet2020 OR koala1515 OR emu1616'"), []);
        const [change] = listActivity(ctx, { entryId: 1 });
        assert.equal(change.summary, 'Updated "Passport": number KOOKABURRA1919 (was KOALA1515). (#1)');
        assert.equal(change.raw_text, 'the number is KOOKABURRA1919, IBIS2121');
        assert.deepEqual(recentMessages(db, 1).map((m) => m.text), ['save my passport, number KOOKABURRA1919, MAGPIE2222']);
        // A change recorded before sealing can still be undone.
        ok(undoActivity(ctx, change.id));
        assert.equal(getEntryDetail(ctx, 1).fields.number, 'KOALA1515');
        assert.equal(getEntryDetail(ctx, 1).entry.notes, 'first kept in the EMU1616 box');
        assert.equal(inFile(db, path, 'KOALA1515'), false);
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the Ask chat', () => {
  test('what is said to it is sealed, and read back', () => {
    const uid = env.alex.actor.userId;
    addMessage(env.db, uid, { role: 'user', text: 'my social is BROLGA2323' });
    addMessage(env.db, uid, { role: 'assistant', text: 'Saved your number BROLGA2323.', sources: [{ url: 'https://example.com/CURLEW2424', title: 'A page' }] });
    assert.equal(onDisk('BROLGA2323'), false);
    assert.equal(onDisk('CURLEW2424'), false);
    assert.deepEqual(recentMessages(env.db, uid).map((m) => m.text), ['my social is BROLGA2323', 'Saved your number BROLGA2323.']);
    assert.match(recentMessages(env.db, uid)[1].sources, /CURLEW2424/);
  });
});

describe('the data download', () => {
  test('is the person\'s own copy: readable without the server, with the collection still marked sensitive', () => {
    documents();
    const id = license();
    const file = join(env.dir, 'export.db');
    writeFileSync(file, exportSqlite(env.alex));
    const copy = new DatabaseSync(file, { readOnly: true });
    try {
      const row = copy.prepare('SELECT fields, notes, sealed FROM entries WHERE id = ?').get(id) as { fields: string; notes: string; sealed: string | null };
      assert.equal(JSON.parse(row.fields).number, 'POTOROO5555');
      assert.equal(row.notes, 'Kept in the WOMBAT2222 drawer');
      assert.equal(row.sealed, null);
      assert.deepEqual(copy.prepare('SELECT note FROM entry_logs ORDER BY id').all().map((r) => r.note), ['renewed at the NUMBAT3333 office', 'photo retaken, DUNNART8888']);
      assert.equal((copy.prepare("SELECT sensitive FROM collections WHERE slug = 'personal-documents'").get() as { sensitive: number }).sensitive, 1);
      const change = copy.prepare("SELECT summary, before_json FROM activity WHERE action = 'update_entry'").get() as { summary: string; before_json: string };
      assert.match(change.summary, /was QUOKKA1111/);
      assert.equal(JSON.parse(JSON.parse(change.before_json).entries[0].fields).number, 'QUOKKA1111');
      assert.equal((copy.prepare("SELECT count(*) AS n FROM entries_fts WHERE entries_fts MATCH 'wombat2222'").get() as { n: number }).n, 1);
    } finally {
      copy.close();
    }
    const json = JSON.parse(exportJson(env.alex)) as { entries: Record<string, unknown>[]; activity: { summary: string }[] };
    assert.equal((json.entries[0].fields as { number: string }).number, 'POTOROO5555');
    assert.equal('sealed' in json.entries[0], false);
    assert.ok(json.activity.some((a) => /was QUOKKA1111/.test(a.summary)));
  });
});
