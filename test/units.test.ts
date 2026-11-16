import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { safeReturnTo } from '../src/auth/session.ts';
import { openTrackerDb } from '../src/db/sqlite.ts';
import { dice, normalizeTag, titleKey } from '../src/domain/normalize.ts';

test('return_to only allows same-site paths', () => {
  assert.equal(safeReturnTo('/c/12?x=1#y'), '/c/12?x=1#y');
  for (const bad of ['//evil.example', '/\\evil.example', '/\t/evil.example', '/\n/evil', '/.//evil.example', '/x/..//evil.example', 'https://evil.example', 'evil', '', null, undefined]) {
    assert.equal(safeReturnTo(bad as string), '/', String(bad));
  }
});

test('an existing empty database file is refused unless bootstrapping', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-empty-'));
  const path = join(dir, 'tracker.db');
  writeFileSync(path, '');
  assert.throws(() => openTrackerDb(path, false), /exists but is empty/);
  const db = openTrackerDb(path, true);
  db.close();
  const again = openTrackerDb(path, false);
  again.close();
  rmSync(dir, { recursive: true, force: true });
});

test('titles and tags are compared in one plain form: no accents, articles or punctuation', () => {
  assert.equal(titleKey('Phở 54'), 'pho 54');
  assert.equal(titleKey('The Rabbit Hole'), 'rabbit hole');
  assert.equal(titleKey("Joe's Bar & Grill"), 'joes bar and grill');
  assert.equal(normalizeTag('#Date Night'), 'date-night');
  assert.ok(dice('pho 54', 'pho 54 express') > 0.55);
});
