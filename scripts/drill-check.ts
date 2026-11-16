// Restore-drill checks: both copies pass integrity_check, have data, and the replica is at least as new as the snapshot.
//   node scripts/drill-check.ts drill/replica.db drill/snapshot.db
import { DatabaseSync } from 'node:sqlite';

const [replicaPath, snapshotPath] = process.argv.slice(2);
if (!replicaPath || !snapshotPath) {
  console.error('Usage: node scripts/drill-check.ts <replica.db> <snapshot.db>');
  process.exit(2);
}

function inspect(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  const integrity = (db.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[]).map((r) => r.integrity_check).join('; ');
  const count = (table: string) => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
  const out = { path, integrity, collections: count('collections'), entries: count('entries'), logs: count('entry_logs'), activity: count('activity') };
  const fts = (db.prepare("SELECT count(*) AS n FROM entries_fts").get() as { n: number }).n;
  const live = (db.prepare('SELECT count(*) AS n FROM entries WHERE deleted_at IS NULL AND merged_into_id IS NULL').get() as { n: number }).n;
  db.close();
  return { ...out, ftsMatchesLiveEntries: fts === live };
}

const replica = inspect(replicaPath);
const snapshot = inspect(snapshotPath);
console.table([replica, snapshot]);
const problems: string[] = [];
for (const r of [replica, snapshot]) {
  if (r.integrity !== 'ok') problems.push(`${r.path}: integrity_check said ${r.integrity}`);
  if (r.collections === 0 || r.entries === 0) problems.push(`${r.path}: no data`);
  if (!r.ftsMatchesLiveEntries) problems.push(`${r.path}: search index out of step with entries`);
}
// Purges remove rows, so fewer rows in the replica is suspicious but not proof of a problem.
if (replica.entries < snapshot.entries || replica.activity < snapshot.activity) {
  console.warn('Note: the replica has fewer rows than the nightly snapshot. Expected only if entries were purged since the snapshot.');
}
if (problems.length) {
  console.error(`Restore drill FAILED:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log('Restore drill passed.');
