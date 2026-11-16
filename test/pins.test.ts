// Pins are each person's own shortcuts on Home (src/domain/pins.ts).
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { run } from '../src/db/sqlite.ts';
import { createCollection } from '../src/domain/collections.ts';
import { createEntry, deleteItem, mergeEntries } from '../src/domain/entries.ts';
import { NotFoundError } from '../src/domain/errors.ts';
import { isCollectionPinned, listPinned, MAX_PINS, pinnedCollectionIds, setCollectionPinned, setPinned } from '../src/domain/pins.ts';
import { ok, setupDb } from './helpers.ts';

describe('pins', () => {
  const env = setupDb();
  after(() => env.cleanup());
  const titles = () => listPinned(env.alex).map((p) => p.title);
  const add = (title: string) => ok(createEntry(env.alex, { collection: 'places', title, raw_text: title })).entryId!;
  const NAMES = ['Harbor', 'Orchard', 'Quarry', 'Lighthouse', 'Meadow', 'Viaduct', 'Glacier', 'Canyon', 'Bakery', 'Summit', 'Wharf', 'Tunnel', 'Pavilion'];

  test('entries are listed in the order they were pinned, and the thirteenth is refused with a way out', () => {
    ok(createCollection(env.alex, { name: 'Places', description: 'Anywhere.', fields: [] }));
    const ids = NAMES.map(add);
    assert.equal(NAMES.length, MAX_PINS + 1);
    // Pinned one after another, a minute apart, newest entry first.
    [...ids.slice(0, MAX_PINS)].reverse().forEach((id, i) => {
      setPinned(env.alex, id, true);
      run(env.db, 'UPDATE pins SET created_at = ? WHERE entry_id = ?', `2026-11-01T10:${String(i).padStart(2, '0')}:00.000Z`, id);
    });
    assert.deepEqual(titles(), [...NAMES.slice(0, MAX_PINS)].reverse());
    assert.throws(() => setPinned(env.alex, ids[MAX_PINS], true), /You can pin up to 12 entries\. Unpin one first\./);
    setPinned(env.alex, ids[0], true);
    assert.equal(titles().length, MAX_PINS, 'pinning what is already pinned changes nothing');
    setPinned(env.alex, ids[0], false);
    setPinned(env.alex, ids[MAX_PINS], true);
    assert.equal(titles().at(-1), 'Pavilion');
    assert.deepEqual(listPinned(env.sam), [], 'the other person has their own');
  });

  test('a pin follows a merge to the entry that was kept, and a deleted entry drops out', () => {
    const [kept] = listPinned(env.alex);
    const twin = add('Old pier');
    setPinned(env.alex, twin, false);
    ok(mergeEntries(env.alex, { keep_id: twin, duplicate_id: kept.id, raw_text: 'same place' }));
    assert.equal(listPinned(env.alex)[0].id, twin);
    ok(deleteItem(env.alex, { entry_id: twin }));
    assert.ok(!listPinned(env.alex).some((p) => p.id === twin));
  });

  test('a collection can be pinned by anyone who can see it, each for themselves', () => {
    const shared = ok(createCollection(env.alex, { name: 'Recipes', description: 'Things we cook.', fields: [] })).collectionId!;
    const hers = ok(createCollection(env.sam, { name: 'Gift ideas', description: 'Private.', private: true, fields: [] })).collectionId!;
    assert.deepEqual(setCollectionPinned(env.alex, shared, true), { collectionId: shared, pinned: true });
    setCollectionPinned(env.alex, shared, true);
    assert.deepEqual([...pinnedCollectionIds(env.alex)], [shared]);
    assert.equal(isCollectionPinned(env.sam, shared), false);
    assert.throws(() => setCollectionPinned(env.alex, hers, true), NotFoundError);
    setCollectionPinned(env.sam, hers, true);
    assert.deepEqual([...pinnedCollectionIds(env.sam)], [hers]);
    setCollectionPinned(env.alex, shared, false);
    assert.equal(pinnedCollectionIds(env.alex).size, 0);
  });
});
