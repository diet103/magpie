import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { get } from '../src/db/sqlite.ts';
import { listActivity } from '../src/domain/activity.ts';
import {
  collectionsOverview,
  createCollection,
  moveAllEntries,
  resolveCollection,
  updateCollection,
} from '../src/domain/collections.ts';
import {
  addLog,
  createEntry,
  deleteItem,
  getEntryDetail,
  mergeEntries,
  purgeEntry,
  restoreEntry,
  updateEntry,
  updateLog,
} from '../src/domain/entries.ts';
import { NotFoundError, UserError } from '../src/domain/errors.ts';
import { ftsTerms, buildFtsQuery, queryEntries, searchEntries } from '../src/domain/search.ts';
import { addDays, todayIn, zonedDayStartUtc } from '../src/domain/time.ts';
import { undoActivity, undoLastChange } from '../src/domain/undo.ts';
import { ok, refused, seedMovies, seedRestaurants, setupDb, TZ, type TestEnv } from './helpers.ts';

let env: TestEnv;
beforeEach(() => {
  env = setupDb();
});
afterEach(() => env.cleanup());

const today = () => todayIn(TZ);

describe('collections', () => {
  test('create, look-alike refusal, resolve by name or plural', () => {
    const r = seedRestaurants(env.alex);
    assert.match(r.summary, /^Created collection Restaurants \(shared\): cuisine \(text\), neighborhood \(text\), price \(enum: \$ \$\$ \$\$\$ \$\$\$\$\), status \(enum: want_to_try been\)\.$/);
    const like = refused(createCollection(env.sam, { name: 'Restaurant list', description: 'x', fields: [], raw_text: 'x' }));
    assert.match(like, /^NOT CREATED: "Restaurant list" looks like the existing collection restaurants/);
    assert.match(like, /confirm_new: true/);
    assert.equal(resolveCollection(env.sam, 'Restaurant').slug, 'restaurants');
    assert.equal(resolveCollection(env.sam, 'restaurants').slug, 'restaurants');
    assert.throws(() => resolveCollection(env.sam, 'restarants'), /Did you mean "restaurants"\?/);
    const forced = ok(createCollection(env.sam, { name: 'Restaurant list', description: 'x', fields: [], confirm_new: true, raw_text: 'x' }));
    assert.match(forced.summary, /Created collection Restaurant list/);
  });

  test('display defaults are filled in', () => {
    ok(createCollection(env.alex, { name: 'Books', description: 'Books.', fields: [{ key: 'author', type: 'text' }, { key: 'pages', type: 'number' }], raw_text: 'b' }));
    const c = resolveCollection(env.alex, 'books');
    assert.deepEqual(c.display.list_columns, ['author', 'pages', 'rating', 'last_logged_on']);
    assert.deepEqual(c.display.default_sort, { by: 'created_at', dir: 'desc' });
  });

  test('enum fields need options; bad keys refused', () => {
    assert.throws(() => createCollection(env.alex, { name: 'X', description: 'x', fields: [{ key: 'kind', type: 'enum' }], raw_text: 'x' }), /needs options/);
    assert.throws(() => createCollection(env.alex, { name: 'Y', description: 'x', fields: [{ key: '9lives', type: 'text' }], raw_text: 'x' }), /snake_case/);
  });
});

describe('entries', () => {
  beforeEach(() => seedRestaurants(env.alex));

  test('create with a log, then search finds it ignoring accents', () => {
    const r = ok(
      createEntry(env.alex, {
        collection: 'restaurants',
        title: 'Phở 54',
        fields: { cuisine: 'Vietnamese', price: '$' },
        tags: ['Pho', '#Vietnamese'],
        log: { note: 'Loved the brisket pho; service was slow.', rating: 4 },
        raw_text: 'we went to that new pho place tonight, loved the brisket pho, service was slow, 4 out of 5',
      }),
    );
    assert.match(r.summary, /^Saved "Phở 54" to Restaurants: 4\/5, visit on [A-Z][a-z]{2} \d{1,2}\. \(#\d+\)$/);
    assert.ok(r.extra.includes('New tags: pho, vietnamese'));
    const s = searchEntries(env.sam, { query: 'pho' });
    assert.equal(s.total, 1);
    assert.equal(s.hits[0].title, 'Phở 54');
    assert.equal(s.hits[0].rating, 4);
    assert.equal(s.hits[0].log_count, 1);
    // word endings: "loving" finds "loved" (porter)
    assert.equal(searchEntries(env.sam, { query: 'loving brisket' }).total, 1);
    // the user's words are searchable
    assert.equal(searchEntries(env.sam, { query: '"service was slow"' }).total, 1);
  });

  test('duplicate guard, not_duplicate_of, and replay protection', () => {
    const first = ok(createEntry(env.alex, { collection: 'restaurants', title: 'Pho 54', raw_text: 'pho 54 was good' }));
    const text = refused(createEntry(env.sam, { collection: 'restaurants', title: 'Phở 54', raw_text: 'pho 54 again' }));
    assert.match(text, /^NOT SAVED: possible duplicate in Restaurants\./);
    assert.match(text, new RegExp(`#${first.entryId} Pho 54 \\(same name\\)`));
    assert.match(text, /call add_log with its entry_id/);
    const similar = refused(createEntry(env.sam, { collection: 'restaurants', title: 'Pho 54 Express', raw_text: 'x' }));
    assert.match(similar, /similar name/);
    const saved = ok(createEntry(env.sam, { collection: 'restaurants', title: 'Pho 54 Express', raw_text: 'x', not_duplicate_of: [first.entryId!] }));
    assert.match(saved.summary, /^Saved "Pho 54 Express"/);
    // the same create again within 10 minutes is a replay, not a duplicate warning
    const replay = ok(createEntry(env.sam, { collection: 'restaurants', title: 'Pho 54 Express', raw_text: 'x', not_duplicate_of: [first.entryId!] }));
    assert.equal(replay.replay, true);
    assert.equal(replay.summary, `Already saved "Pho 54 Express" to Restaurants. (#${saved.entryId})`);
  });

  test('same name in another collection is flagged', () => {
    seedMovies(env.alex);
    ok(createEntry(env.alex, { collection: 'movies', title: 'Dune', raw_text: 'dune' }));
    const text = refused(createEntry(env.alex, { collection: 'restaurants', title: 'Dune', raw_text: 'dune diner' }));
    assert.match(text, /already exists in another collection/);
    assert.match(text, /same name, in Movies/);
  });

  test('add_log updates the overall rating and handles replays', () => {
    const e = ok(createEntry(env.alex, { collection: 'restaurants', title: 'Pho 54', rating: 4, raw_text: 'pho 54, 4 stars' }));
    const d = addDays(today(), -1);
    const l = ok(addLog(env.sam, { entry_id: e.entryId!, occurred_on: d, rating: 3, note: 'Broth was bland', set_fields: { status: 'BEEN' }, raw_text: 'pho 54 was meh, 3' }));
    assert.match(l.summary, /^Logged a visit to "Pho 54" on .+: 3\/5 \(overall now 3\/5, was 4\/5\)\. \(#\d+\)$/);
    assert.ok(l.extra.some((x) => x === 'Set status been.'));
    const again = ok(addLog(env.sam, { entry_id: e.entryId!, occurred_on: d, rating: 3, raw_text: 'pho 54 was meh, 3' }));
    assert.equal(again.replay, true);
    assert.match(again.summary, /^Already logged a visit to "Pho 54"/);
    // an older rated visit doesn't move the overall
    const old = ok(addLog(env.alex, { entry_id: e.entryId!, occurred_on: addDays(today(), -30), rating: 5, raw_text: 'loved it back then, 5' }));
    assert.match(old.summary, /overall still 3\/5, from a later visit/);
    const detail = getEntryDetail(env.alex, e.entryId!);
    assert.equal(detail.entry.log_count, 2);
    assert.equal(detail.entry.rating, 3);
    assert.equal(detail.fields.status, 'been');
    assert.equal(detail.logs[0].occurred_on, d);
  });

  test('ratings are rounded and validated; future dates refused', () => {
    const r = ok(createEntry(env.alex, { collection: 'restaurants', title: 'Taco Star', rating: 3.7, raw_text: 'x' }));
    assert.ok(r.extra.some((x) => /Rating 3.7 rounded to 3.5/.test(x)));
    assert.throws(() => createEntry(env.alex, { collection: 'restaurants', title: 'Bad', rating: 7, raw_text: 'x' }), /0 to 5/);
    assert.throws(
      () => addLog(env.alex, { entry_id: r.entryId!, occurred_on: addDays(today(), 3), raw_text: 'x' }),
      /in the future/,
    );
    assert.throws(() => addLog(env.alex, { entry_id: r.entryId!, occurred_on: '2026-02-30', raw_text: 'x' }), /isn't a real date/);
  });

  test('field drift guards and enum validation', () => {
    assert.throws(
      () => createEntry(env.alex, { collection: 'restaurants', title: 'A', fields: { cuisine_type: 'Thai' }, raw_text: 'x' }),
      /Restaurants has no field `cuisine_type`\. Did you mean `cuisine`\?/,
    );
    assert.throws(
      () => createEntry(env.alex, { collection: 'restaurants', title: 'A', fields: { price: 'cheap' }, raw_text: 'x' }),
      /must be one of: \$, \$\$, \$\$\$, \$\$\$\$/,
    );
    const r = ok(createEntry(env.alex, { collection: 'restaurants', title: 'A', fields: { Parking: 'street only', 'Cuisine': 'Thai' }, raw_text: 'x' }));
    assert.ok(r.extra.includes('New field added to Restaurants: `parking` (text).'));
    const c = resolveCollection(env.alex, 'restaurants');
    assert.ok(c.fields.some((f) => f.key === 'parking'));
    assert.equal(getEntryDetail(env.alex, r.entryId!).fields.cuisine, 'Thai');
  });

  test('tags map onto existing near-identical tags', () => {
    ok(createEntry(env.alex, { collection: 'restaurants', title: 'A', tags: ['date-night'], raw_text: 'x' }));
    const r = ok(createEntry(env.sam, { collection: 'restaurants', title: 'B', tags: ['datenight', 'Date Nights'], raw_text: 'x' }));
    assert.deepEqual(getEntryDetail(env.sam, r.entryId!).tags, ['date-night']);
    assert.ok(r.extra.some((x) => /saved as the existing tag "date-night"/.test(x)));
  });

  test('update_entry: rating override, follow visits again, notes, tags, move', () => {
    seedMovies(env.alex);
    const e = ok(createEntry(env.alex, { collection: 'restaurants', title: 'Pho 54', log: { rating: 4 }, raw_text: 'x' }));
    const u1 = ok(updateEntry(env.alex, { entry_id: e.entryId!, rating: 3, raw_text: 'actually 3' }));
    assert.match(u1.summary, /^Updated "Pho 54": rating 4\/5 to 3\/5\. \(#\d+\)$/);
    const u2 = ok(updateEntry(env.alex, { entry_id: e.entryId!, rating: null, raw_text: 'use the visits' }));
    assert.match(u2.summary, /rating now follows the visits \(4\/5\)/);
    const u3 = ok(updateEntry(env.alex, { entry_id: e.entryId!, append_note: 'Try the bun bo hue.', add_tags: ['vietnamese'], fields: { cuisine: 'Vietnamese' }, raw_text: 'x' }));
    assert.match(u3.summary, /cuisine Vietnamese, note added, tags \+vietnamese/);
    assert.throws(() => updateEntry(env.alex, { entry_id: e.entryId!, raw_text: 'x' }), /Nothing to change/);
    const mv = ok(updateEntry(env.alex, { entry_id: e.entryId!, move_to_collection: 'movies', raw_text: 'oops' }));
    assert.match(mv.summary, /moved from Restaurants to Movies/);
    assert.ok(mv.extra.some((x) => /Kept fields Movies doesn't define: cuisine/.test(x)));
  });

  test('update_log and delete_item', () => {
    const e = ok(createEntry(env.alex, { collection: 'restaurants', title: 'Pho 54', log: { rating: 4, occurred_on: addDays(today(), -2) }, raw_text: 'x' }));
    const u = ok(updateLog(env.alex, { log_id: e.logId!, rating: 5, occurred_on: addDays(today(), -3), raw_text: 'x' }));
    assert.match(u.summary, /^Updated the visit on .+ for "Pho 54": date .+ to .+, rating 4\/5 to 5\/5\. \(#\d+, log \d+\)$/);
    assert.ok(u.extra.includes('Overall now 5/5 (was 4/5).'));
    const dl = ok(deleteItem(env.alex, { log_id: e.logId!, raw_text: 'remove that visit' }));
    assert.match(dl.summary, /^Deleted the visit on .+ from "Pho 54" \(recoverable\)/);
    assert.equal(getEntryDetail(env.alex, e.entryId!).entry.log_count, 0);
    assert.equal(getEntryDetail(env.alex, e.entryId!).entry.rating, null);
    const de = ok(deleteItem(env.alex, { entry_id: e.entryId!, raw_text: 'delete it' }));
    assert.match(de.summary, /^Deleted "Pho 54" from Restaurants \(recoverable\)/);
    assert.throws(() => getEntryDetail(env.alex, e.entryId!), /is deleted/);
    assert.equal(searchEntries(env.alex, { query: 'pho' }).total, 0);
    ok(restoreEntry(env.as('alex', 'web'), e.entryId!));
    assert.equal(searchEntries(env.alex, { query: 'pho' }).total, 1);
    assert.throws(() => deleteItem(env.alex, { entry_id: 1, log_id: 2, raw_text: 'x' }), /exactly one/);
  });

  test('merge moves logs, unions tags, notes conflicts, and follows merged ids', () => {
    const a = ok(createEntry(env.alex, { collection: 'restaurants', title: 'Pho 54', fields: { price: '$' }, tags: ['pho'], log: { rating: 4 }, raw_text: 'pho 54 good' }));
    const b = ok(createEntry(env.sam, { collection: 'restaurants', title: 'Pho Fifty Four', fields: { price: '$$', cuisine: 'Vietnamese' }, tags: ['takeout'], log: { rating: 5, occurred_on: addDays(today(), -5) }, raw_text: 'spring rolls amazing at pho fifty four', not_duplicate_of: [a.entryId!] }));
    const m = ok(mergeEntries(env.alex, { keep_id: a.entryId!, duplicate_id: b.entryId!, raw_text: 'those are the same' }));
    assert.match(m.summary, /^Merged "Pho Fifty Four" into "Pho 54": 1 visit moved, 1 conflicting value noted\. \(#\d+\)$/);
    const d = getEntryDetail(env.alex, a.entryId!);
    assert.equal(d.entry.log_count, 2);
    assert.deepEqual(d.tags, ['pho', 'takeout']);
    assert.equal(d.fields.price, '$');
    assert.equal(d.fields.cuisine, 'Vietnamese');
    assert.match(d.entry.notes, /price: \$\$/);
    assert.deepEqual(d.mergedFrom.map((x) => x.id), [b.entryId]);
    // the duplicate's original words are searchable on the keeper
    const s = searchEntries(env.alex, { query: 'spring rolls' });
    assert.equal(s.total, 1);
    assert.equal(s.hits[0].id, a.entryId);
    // an old id is followed
    const l = ok(addLog(env.sam, { entry_id: b.entryId!, rating: 4, raw_text: 'went back' }));
    assert.equal(l.entryId, a.entryId);
    assert.ok(l.extra[0].includes('was merged into'));
  });

  test('search filters: rating, tags, fields, dates, added_by, partial matches', () => {
    seedMovies(env.alex);
    ok(createEntry(env.alex, { collection: 'restaurants', title: 'Thai Basil', fields: { cuisine: 'Thai', status: 'been' }, tags: ['date-night'], log: { rating: 4.5, occurred_on: '2026-10-14', note: 'green curry' }, raw_text: 'thai basil green curry was great, 4.5' }));
    ok(createEntry(env.sam, { collection: 'restaurants', title: 'Lemongrass', fields: { cuisine: 'Thai', status: 'been' }, log: { rating: 3, occurred_on: '2026-10-03' }, raw_text: 'lemongrass was ok, 3' }));
    ok(createEntry(env.sam, { collection: 'restaurants', title: 'Siam Garden', fields: { cuisine: 'Thai', status: 'want_to_try' }, raw_text: 'want to try siam garden' }));
    ok(createEntry(env.alex, { collection: 'movies', title: 'Thai Massage Documentary', raw_text: 'x' }));

    assert.equal(searchEntries(env.alex, { query: 'thai', collection: 'restaurants', min_rating: 4 }).total, 1);
    assert.equal(searchEntries(env.alex, { query: 'thai' }).total, 4);
    assert.equal(searchEntries(env.alex, { collection: 'restaurants', fields: { status: 'want_to_try' } }).total, 1);
    assert.equal(searchEntries(env.alex, { collection: 'restaurants', fields: { cuisine: 'thai' } }).total, 3);
    assert.equal(searchEntries(env.alex, { tags: ['date-night'] }).total, 1);
    assert.equal(searchEntries(env.alex, { added_by: 'sam' }).total, 2);
    assert.equal(searchEntries(env.alex, { added_by: 'me', collection: 'restaurants' }).total, 1);
    const ranged = searchEntries(env.alex, { query: 'thai', logged_from: '2026-10-01', logged_to: '2026-10-31' });
    assert.equal(ranged.total, 2);
    assert.match(ranged.description, /^for "thai" with a log between 2026-10-01 and 2026-10-31$/);
    assert.equal(ranged.hits.find((h) => h.title === 'Thai Basil')!.rangeLogs![0].raw_text, 'thai basil green curry was great, 4.5');
    const partial = searchEntries(env.alex, { query: 'curry xylophone' });
    assert.equal(partial.partial, true);
    assert.equal(partial.hits[0].title, 'Thai Basil');
    assert.throws(() => searchEntries(env.alex, {}), /keywords or at least one filter/);
    assert.throws(() => searchEntries(env.alex, { collection: 'restaurants', fields: { cusine: 'Thai' } }), /Did you mean `cuisine`\?/);
    assert.throws(() => searchEntries(env.alex, { added_by: 'bob' }), /No household member called "bob"/);
    const sorted = searchEntries(env.alex, { collection: 'restaurants', sort: 'rating' });
    assert.deepEqual(sorted.hits.map((h) => h.title), ['Thai Basil', 'Lemongrass', 'Siam Garden']);
  });

  test('FTS query building never passes raw syntax through', () => {
    assert.equal(buildFtsQuery(ftsTerms('taco place'), 'and'), '"taco"*');
    assert.equal(buildFtsQuery(ftsTerms('"green curry" thai'), 'and'), '"green curry" "thai"*');
    assert.equal(buildFtsQuery(ftsTerms('NEAR(a b) OR c*'), 'and'), '"NEAR a" "b" "c"');
    assert.equal(buildFtsQuery(ftsTerms("o'brien's pub"), 'or'), '"o brien s" OR "pub"*');
    // garbage doesn't throw
    ok(createEntry(env.alex, { collection: 'restaurants', title: 'X', raw_text: 'x' }));
    for (const q of ['"', '***', 'AND OR NOT', ')(', 'a:b', '^x', '-', '{x}']) {
      assert.doesNotThrow(() => queryEntries(env.alex, { query: q, limit: 5 }));
    }
  });
});

describe('undo', () => {
  beforeEach(() => seedRestaurants(env.alex));

  test('undo create, add_log, delete, merge; conflict when changed since', () => {
    ok(createEntry(env.alex, { collection: 'restaurants', title: 'Pho 54', log: { rating: 4 }, raw_text: 'x' }));
    const u = ok(undoLastChange(env.alex, 'undo that'));
    assert.match(u.summary, /^Undid: Saved "Pho 54" to Restaurants: 4\/5, visit on .+ \(entry removed\)\.$/);
    assert.equal(searchEntries(env.alex, { query: 'pho' }).total, 0);
    // nothing left to undo from Alex via Claude... except the collection creation
    const next = ok(undoLastChange(env.alex, 'undo'));
    assert.match(next.summary, /Created collection Restaurants/);
    const none = undoLastChange(env.alex, 'undo');
    assert.equal(none.ok, false);

    seedRestaurants(env.sam);
    const e2 = ok(createEntry(env.alex, { collection: 'restaurants', title: 'Taco Star', rating: 3, raw_text: 'x' }));
    ok(addLog(env.sam, { entry_id: e2.entryId!, rating: 4, raw_text: 'sam went' }));
    assert.throws(() => undoLastChange(env.alex, 'undo'), /Can't undo: "Taco Star" was changed after that \(Sam changed it since: Logged a visit to "Taco Star"/);
    // Sam can undo her own log
    const ue = ok(undoLastChange(env.sam, 'undo'));
    assert.match(ue.summary, /that log removed/);
    assert.equal(getEntryDetail(env.alex, e2.entryId!).entry.rating, 3);
  });

  test('undo delete and merge restore everything', () => {
    const a = ok(createEntry(env.alex, { collection: 'restaurants', title: 'Pho 54', tags: ['pho'], log: { rating: 4 }, raw_text: 'a' }));
    const b = ok(createEntry(env.alex, { collection: 'restaurants', title: 'Pho Fifty Four', tags: ['x'], log: { rating: 2 }, raw_text: 'unique words zebra', not_duplicate_of: [a.entryId!] }));
    ok(mergeEntries(env.alex, { keep_id: a.entryId!, duplicate_id: b.entryId!, raw_text: 'same' }));
    assert.equal(searchEntries(env.alex, { query: 'zebra' }).hits[0].id, a.entryId);
    const u = ok(undoLastChange(env.alex, 'undo'));
    assert.match(u.summary, /separate again/);
    const da = getEntryDetail(env.alex, a.entryId!);
    const db = getEntryDetail(env.alex, b.entryId!);
    assert.equal(da.entry.log_count, 1);
    assert.equal(db.entry.log_count, 1);
    assert.deepEqual(da.tags, ['pho']);
    assert.equal(db.entry.merged_into_id, null);
    assert.equal(searchEntries(env.alex, { query: 'zebra' }).hits[0].id, b.entryId);

    ok(deleteItem(env.alex, { entry_id: a.entryId!, raw_text: 'delete' }));
    ok(undoLastChange(env.alex, 'undo'));
    assert.equal(getEntryDetail(env.alex, a.entryId!).entry.deleted_at, null);
  });

  test('undo, undo: a later change that was undone does not block the earlier one', () => {
    const a = ok(createEntry(env.alex, { collection: 'restaurants', title: 'Pho 54', log: { rating: 4 }, raw_text: 'a' }));
    const l = ok(addLog(env.alex, { entry_id: a.entryId!, rating: 2, raw_text: 'second visit' }));
    ok(updateEntry(env.alex, { entry_id: a.entryId!, append_note: 'x', raw_text: 'note' }));
    ok(deleteItem(env.alex, { log_id: l.logId!, raw_text: 'remove that' }));
    assert.match(ok(undoLastChange(env.alex, 'undo')).summary, /Deleted the visit/);
    assert.match(ok(undoLastChange(env.alex, 'undo')).summary, /Updated "Pho 54"/);
    assert.match(ok(undoLastChange(env.alex, 'undo')).summary, /Logged a visit/);
    const d = getEntryDetail(env.alex, a.entryId!);
    assert.equal(d.entry.log_count, 1);
    assert.equal(d.entry.rating, 4);
    assert.equal(d.entry.notes, '');
  });

  test('web undo of any visible change, and collection changes', () => {
    const e = ok(createEntry(env.alex, { collection: 'restaurants', title: 'A', fields: { status: 'been' }, raw_text: 'x' }));
    const uc = ok(updateCollection(env.sam, { collection: 'restaurants', rename_fields: [{ from: 'status', to: 'visit_status' }], raw_text: 'rename' }));
    assert.match(uc.summary, /renamed field status to visit_status \(1 entry updated\)/);
    assert.equal(getEntryDetail(env.alex, e.entryId!).fields.visit_status, 'been');
    const webAlex = env.as('alex', 'web');
    ok(undoActivity(webAlex, uc.activityId!));
    assert.equal(getEntryDetail(env.alex, e.entryId!).fields.status, 'been');
    assert.ok(resolveCollection(env.alex, 'restaurants').fields.some((f) => f.key === 'status'));
    assert.throws(() => undoActivity(webAlex, uc.activityId!), /already undone/);
  });
});

describe('collection updates', () => {
  beforeEach(() => seedRestaurants(env.alex));

  test('removing enum options needs remap when in use', () => {
    const e = ok(createEntry(env.alex, { collection: 'restaurants', title: 'A', fields: { status: 'been' }, raw_text: 'x' }));
    assert.throws(
      () => updateCollection(env.alex, { collection: 'restaurants', update_fields: [{ key: 'status', options: ['want_to_try', 'visited'] }], raw_text: 'x' }),
      /1 entry uses "been" for `status`/,
    );
    const r = ok(updateCollection(env.alex, { collection: 'restaurants', update_fields: [{ key: 'status', options: ['want_to_try', 'visited'], remap: { been: 'visited' } }], raw_text: 'x' }));
    assert.match(r.summary, /1 entry remapped/);
    assert.equal(getEntryDetail(env.alex, e.entryId!).fields.status, 'visited');
  });

  test('add fields, display hints, nothing-to-change', () => {
    const r = ok(updateCollection(env.alex, { collection: 'restaurants', add_fields: [{ key: 'parking', type: 'boolean' }], display: { filters: ['status', 'parking', 'cuisine'] }, raw_text: 'x' }));
    assert.match(r.summary, /added field parking \(boolean\)/);
    assert.ok(r.extra.some((x) => /Ignored unknown display columns: cuisine/.test(x)));
    assert.deepEqual(resolveCollection(env.alex, 'restaurants').display.filters, ['status', 'parking']);
    assert.throws(() => updateCollection(env.alex, { collection: 'restaurants', raw_text: 'x' }), /Nothing to change/);
  });

  test('move all entries', () => {
    ok(createCollection(env.alex, { name: 'Eateries', description: 'x', fields: [], confirm_new: true, raw_text: 'x' }));
    ok(createEntry(env.alex, { collection: 'eateries', title: 'A', raw_text: 'x' }));
    ok(createEntry(env.sam, { collection: 'eateries', title: 'B', raw_text: 'x' }));
    const from = resolveCollection(env.alex, 'eateries');
    const to = resolveCollection(env.alex, 'restaurants');
    const r = ok(moveAllEntries(env.as('alex', 'web'), from.id, to.id));
    assert.equal(r.summary, 'Moved 2 entries from Eateries to Restaurants.');
  });
});

describe('privacy', () => {
  beforeEach(() => {
    seedRestaurants(env.alex);
    ok(createCollection(env.sam, { name: 'Gift ideas', description: 'Gift ideas for Alex.', fields: [{ key: 'price', type: 'number' }], private: true, raw_text: 'private gift list' }));
  });

  test('private collections are invisible to the other person everywhere', () => {
    const g = ok(createEntry(env.sam, { collection: 'gift-ideas', title: 'Espresso grinder', fields: { price: 180 }, raw_text: 'he wants a grinder' }));
    assert.equal(collectionsOverview(env.alex).some((o) => o.collection.slug === 'gift-ideas'), false);
    assert.equal(collectionsOverview(env.sam).some((o) => o.collection.slug === 'gift-ideas'), true);
    assert.throws(() => resolveCollection(env.alex, 'gift-ideas'), UserError);
    assert.equal(searchEntries(env.alex, { query: 'grinder' }).total, 0);
    assert.equal(searchEntries(env.sam, { query: 'grinder' }).total, 1);
    assert.throws(() => getEntryDetail(env.alex, g.entryId!), (err: unknown) => err instanceof NotFoundError && err.message === `No entry #${g.entryId}.`);
    assert.throws(() => addLog(env.alex, { entry_id: g.entryId!, raw_text: 'x' }), /No entry/);
    assert.throws(() => deleteItem(env.alex, { entry_id: g.entryId!, raw_text: 'x' }), /No entry/);
    assert.equal(listActivity(env.alex).some((a) => a.entry_id === g.entryId || /Gift/.test(a.summary)), false);
    assert.ok(listActivity(env.sam).some((a) => a.entry_id === g.entryId));
    // Alex can create his own "gift-ideas" without seeing hers
    ok(createCollection(env.alex, { name: 'Gift ideas', description: 'For Sam.', fields: [], private: true, raw_text: 'x' }));
  });

  test("can't move someone else's entry into a private collection, or make a shared one private", () => {
    const r = ok(createEntry(env.alex, { collection: 'restaurants', title: 'Alex place', raw_text: 'x' }));
    assert.throws(() => updateEntry(env.sam, { entry_id: r.entryId!, move_to_collection: 'gift-ideas', raw_text: 'x' }), /Alex added "Alex place"/);
    const mine = ok(createEntry(env.sam, { collection: 'restaurants', title: 'Sam place', raw_text: 'x' }));
    const mv = ok(updateEntry(env.sam, { entry_id: mine.entryId!, move_to_collection: 'gift-ideas', raw_text: 'x' }));
    assert.match(mv.summary, /moved from Restaurants to Gift ideas/);
    assert.throws(() => updateCollection(env.sam, { collection: 'restaurants', private: true, raw_text: 'x' }), /Only Alex/);
    ok(addLog(env.sam, { entry_id: r.entryId!, raw_text: 'sam went there too' }));
    assert.throws(() => updateCollection(env.alex, { collection: 'restaurants', private: true, raw_text: 'x' }), /Can't make Restaurants private: Sam logged something on "Alex place"/);
    const share = ok(updateCollection(env.sam, { collection: 'gift-ideas', private: false, raw_text: 'share it' }));
    assert.ok(share.extra.includes('Now visible to Alex.'));
  });
});

describe('deleting forever, and where a day starts', () => {
  test('purge removes the entry and strips history', () => {
    seedRestaurants(env.alex);
    const e = ok(createEntry(env.alex, { collection: 'restaurants', title: 'Gone', raw_text: 'secret words' }));
    const web = env.as('alex', 'web');
    assert.throws(() => purgeEntry(web, e.entryId!), /Delete "Gone" first/);
    ok(deleteItem(web, { entry_id: e.entryId! }));
    ok(purgeEntry(web, e.entryId!));
    assert.equal(get(env.db, 'SELECT count(*) AS n FROM entries WHERE id = ?', e.entryId)!.n, 0);
    assert.equal(get(env.db, "SELECT count(*) AS n FROM activity WHERE after_json LIKE '%secret words%'")!.n, 0);
  });

  test('a day starts at local midnight in the household time zone, summer and winter', () => {
    assert.equal(zonedDayStartUtc('2026-11-08', 'America/Denver'), '2026-11-08T07:00:00.000Z');
    assert.equal(zonedDayStartUtc('2026-07-01', 'America/Denver'), '2026-07-01T06:00:00.000Z');
  });
});

describe('privacy after merges', () => {
  test('a shared entry merged into a private one disappears from the other person’s history, and undo errors leak nothing', () => {
    seedRestaurants(env.alex);
    ok(createCollection(env.alex, { name: 'Secret spots', description: 'Mine.', fields: [], private: true, raw_text: 'x' }));
    const shared = ok(createEntry(env.alex, { collection: 'restaurants', title: 'Corner Cafe', raw_text: 'corner cafe' }));
    const secret = ok(createEntry(env.alex, { collection: 'secret-spots', title: 'Hidden Speakeasy', raw_text: 'whisper words' }));
    assert.ok(listActivity(env.sam).some((a) => a.entry_id === shared.entryId));
    ok(mergeEntries(env.alex, { keep_id: secret.entryId!, duplicate_id: shared.entryId!, raw_text: 'same' }));
    assert.equal(listActivity(env.sam).some((a) => a.entry_id === shared.entryId || /Speakeasy/.test(a.summary)), false);
    const createAct = get<{ id: number }>(env.db, "SELECT id FROM activity WHERE entry_id = ? AND action = 'create_entry'", shared.entryId)!.id;
    assert.throws(() => undoActivity(env.as('sam', 'web'), createAct), (err: unknown) => err instanceof UserError && !/Speakeasy/.test(err.message));
    assert.equal(searchEntries(env.sam, { query: 'whisper' }).total, 0);
  });

  test('undoing a chained merge leaves no stale words in the search index', () => {
    seedRestaurants(env.alex);
    const a = ok(createEntry(env.alex, { collection: 'restaurants', title: 'Alpha Diner', raw_text: 'aardvark words' }));
    const b = ok(createEntry(env.alex, { collection: 'restaurants', title: 'Beta Bistro', raw_text: 'bistro b' }));
    const c = ok(createEntry(env.alex, { collection: 'restaurants', title: 'Gamma Grill', raw_text: 'grill c' }));
    ok(mergeEntries(env.alex, { keep_id: b.entryId!, duplicate_id: a.entryId!, raw_text: 'm1' }));
    ok(mergeEntries(env.alex, { keep_id: c.entryId!, duplicate_id: b.entryId!, raw_text: 'm2' }));
    assert.deepEqual(searchEntries(env.alex, { query: 'aardvark' }).hits.map((h) => h.id), [c.entryId]);
    ok(undoLastChange(env.alex, 'undo'));
    assert.deepEqual(searchEntries(env.alex, { query: 'aardvark' }).hits.map((h) => h.id), [b.entryId]);
    ok(undoLastChange(env.alex, 'undo'));
    assert.deepEqual(searchEntries(env.alex, { query: 'aardvark' }).hits.map((h) => h.id), [a.entryId]);
    assert.equal(searchEntries(env.alex, { query: 'aardvark', collection: 'restaurants' }).total, 1);
  });
});

describe('merging and purging do not lose tags or reveal private entries', () => {
  test('merge keeps tags past 20 in the notes, and can take values from the duplicate', () => {
    seedRestaurants(env.alex);
    const many = Array.from({ length: 20 }, (_, i) => `t${i}`);
    const a = ok(createEntry(env.alex, { collection: 'restaurants', title: 'Many Tags', tags: many, fields: { price: '$' }, raw_text: 'a' }));
    const b = ok(createEntry(env.alex, { collection: 'restaurants', title: 'Many Tags Two', tags: ['extra-one'], fields: { price: '$$' }, raw_text: 'b', not_duplicate_of: [a.entryId!] }));
    ok(mergeEntries(env.alex, { keep_id: a.entryId!, duplicate_id: b.entryId!, take_from_duplicate: { title: true, fields: ['price'] } }));
    const d = getEntryDetail(env.alex, a.entryId!);
    assert.equal(d.tags.length, 20);
    assert.match(d.entry.notes, /Tags from merged #\d+ that didn't fit \(20 max\): extra-one/);
    assert.equal(d.entry.title, 'Many Tags Two');
    assert.equal(d.fields.price, '$$');
    assert.match(d.entry.notes, /Previous values before merging #\d+: price: \$; name: Many Tags/);
    // one activity, so the merge undoes cleanly
    ok(undoLastChange(env.as('alex', 'mcp'), 'undo'));
    assert.equal(getEntryDetail(env.alex, a.entryId!).entry.title, 'Many Tags');
  });

  test("ids of entries merged into someone else's private entry stay hidden", () => {
    seedRestaurants(env.alex);
    ok(createCollection(env.alex, { name: 'Secret spots', description: 'Mine.', fields: [], private: true, raw_text: 'x' }));
    const shared = ok(createEntry(env.alex, { collection: 'restaurants', title: 'Corner Cafe', raw_text: 'x' }));
    const secret = ok(createEntry(env.alex, { collection: 'secret-spots', title: 'Hidden Speakeasy', raw_text: 'x' }));
    ok(mergeEntries(env.alex, { keep_id: secret.entryId!, duplicate_id: shared.entryId!, raw_text: 'same' }));
    assert.throws(() => deleteItem(env.sam, { entry_id: shared.entryId!, raw_text: 'x' }), (err: unknown) => err instanceof NotFoundError && err.message === `No entry #${shared.entryId}.`);
    assert.throws(() => mergeEntries(env.sam, { keep_id: shared.entryId!, duplicate_id: secret.entryId! }), (err: unknown) => err instanceof NotFoundError && !err.message.includes(`#${secret.entryId}`));
  });

  test('purging an entry that came from a private collection leaves only an empty tombstone', () => {
    seedRestaurants(env.alex);
    ok(createCollection(env.alex, { name: 'Surprise proposal', description: 'Mine.', fields: [], private: true, raw_text: 'x' }));
    const e = ok(createEntry(env.alex, { collection: 'surprise-proposal', title: 'Ring shop', raw_text: 'ring words' }));
    ok(updateEntry(env.alex, { entry_id: e.entryId!, move_to_collection: 'restaurants', raw_text: 'move it' }));
    const web = env.as('alex', 'web');
    ok(deleteItem(web, { entry_id: e.entryId! }));
    ok(purgeEntry(web, e.entryId!));
    const visible = listActivity(env.sam);
    assert.equal(visible.some((a) => /Surprise|Ring|ring words/.test(`${a.summary} ${a.raw_text ?? ''}`)), false);
  });
});
