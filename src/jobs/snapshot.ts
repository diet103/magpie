// Nightly snapshot (plan section 9): a plain SQLite copy, integrity-checked, gzipped and uploaded to R2,
// independent of Litestream's format. The photos, which are files and not in the database, are copied to R2
// in the same run (see photos.ts). Pings HEALTHCHECKS_URL on success so missing backups get noticed.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { gzipSync } from 'node:zlib';
import { AwsClient } from 'aws4fetch';
import { loadConfig, type Config } from '../config.ts';
import { openTrackerDb, type DB } from '../db/sqlite.ts';
import { todayIn, zonedDayStartUtc } from '../domain/time.ts';
import { errorFields, log } from '../log.ts';
import type { AppDeps } from '../types.ts';
import { mirrorPhotos, type PhotoMirror } from './photos.ts';

/** How long one upload of the night's copy may take. */
const UPLOAD_MS = 120_000;

export interface SnapshotResult {
  file: string;
  bytes: number;
  uploaded: string[];
  /** What was done to the off-site copies of the photos. Null when off-site backups are not switched on. */
  photos: PhotoMirror | null;
  /** Set when the database was saved but the photos could not be copied. */
  photoError?: string;
}

/** The photo half of a run, as Settings shows it. */
export function photoStatus(r: Pick<SnapshotResult, 'photos' | 'photoError'>): AppDeps['backups']['photos'] {
  const at = new Date().toISOString();
  if (r.photoError) return { at, held: 0, error: r.photoError };
  return r.photos ? { at, held: r.photos.held } : null;
}

export async function takeSnapshot(cfg: Config, db: DB, uploadMs = UPLOAD_MS): Promise<SnapshotResult> {
  mkdirSync(cfg.snapshotDir, { recursive: true });
  const day = todayIn(cfg.tz);
  const raw = join(cfg.snapshotDir, `tracker-${day}.db`);
  for (const suffix of ['', '-wal', '-shm']) rmSync(raw + suffix, { force: true });
  await backup(db, raw);
  const check = new DatabaseSync(raw, { readOnly: true });
  try {
    const rows = check.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[];
    if (rows.length !== 1 || rows[0].integrity_check !== 'ok') {
      throw new Error(`snapshot failed integrity_check: ${rows.map((r) => r.integrity_check).join('; ').slice(0, 300)}`);
    }
  } finally {
    check.close();
    // The copy is in WAL mode like the live database, so reading it made SQLite create a -wal and a -shm file
    // beside it, and a read-only connection does not remove them when it closes.
    for (const suffix of ['-wal', '-shm']) rmSync(raw + suffix, { force: true });
  }
  const gz = gzipSync(readFileSync(raw), { level: 9 });
  const file = `${raw}.gz`;
  writeFileSync(file, gz);
  rmSync(raw, { force: true });
  const names = readdirSync(cfg.snapshotDir);
  // Keep the last 7 local copies (the volume is small; R2 holds the long history).
  const local = names.filter((f) => /^tracker-\d{4}-\d{2}-\d{2}\.db\.gz$/.test(f)).sort();
  for (const old of local.slice(0, -7)) rmSync(join(cfg.snapshotDir, old), { force: true });
  // Earlier versions left each day's -wal and -shm files behind. Today's are already gone, so any found here are old.
  const strays = names.filter((f) => /^tracker-\d{4}-\d{2}-\d{2}\.db-(wal|shm)$/.test(f));
  for (const stray of strays) rmSync(join(cfg.snapshotDir, stray), { force: true });

  const uploaded: string[] = [];
  const { endpoint, bucket, accessKeyId, secretAccessKey } = cfg.r2;
  if (endpoint && bucket && accessKeyId && secretAccessKey) {
    const aws = new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto' });
    const keys = [`snapshots/daily/tracker-${day}.db.gz`];
    if (day.endsWith('-01')) keys.push(`snapshots/monthly/tracker-${day.slice(0, 7)}.db.gz`);
    for (const key of keys) {
      const res = await aws.fetch(`${endpoint.replace(/\/+$/, '')}/${bucket}/${key}`, {
        method: 'PUT',
        body: gz,
        headers: { 'Content-Type': 'application/gzip' },
        // Without a limit, one stalled upload would hold the job open and no later night would run.
        signal: AbortSignal.timeout(uploadMs),
      });
      if (!res.ok) throw new Error(`R2 upload of ${key} failed: HTTP ${res.status}`);
      uploaded.push(key);
    }
  } else {
    log.warn('R2 not configured; nightly snapshot kept on the volume only');
  }
  // A failure here is reported, but it does not take back the snapshot of the database that was just made.
  let photos: PhotoMirror | null = null;
  let photoError: string | undefined;
  try {
    photos = await mirrorPhotos(cfg, db);
  } catch (err) {
    photoError = err instanceof Error ? err.message : String(err);
    log.error('photo backup failed', errorFields(err));
  }
  // No ping when the photos were not copied: a backup that is only half there should be noticed too.
  if (cfg.healthchecksUrl && !photoError) {
    await fetch(cfg.healthchecksUrl, { method: 'POST', body: `snapshot ${day} ${gz.byteLength} bytes`, signal: AbortSignal.timeout(10_000) }).catch((err) =>
      log.warn('healthcheck ping failed', errorFields(err)),
    );
  }
  log.info('snapshot done', { day, bytes: gz.byteLength, uploaded: uploaded.length });
  return { file, bytes: gz.byteLength, uploaded, photos, photoError };
}

/** One line about the photos for the commands that take a snapshot by hand. */
export function photoLine(r: Pick<SnapshotResult, 'photos' | 'photoError'>): string {
  if (r.photoError) return `Photos were NOT copied to the off-site backup: ${r.photoError}`;
  if (!r.photos) return 'Photos: off-site backups are not switched on, so they are only on this disk.';
  return `Photos off-site: ${r.photos.held} files held (${r.photos.uploaded} uploaded, ${r.photos.restored} brought back, ${r.photos.removed} removed).`;
}

/** Milliseconds until the next HH:MM in the household time zone. */
export function msUntil(time: string, tz: string, now = Date.now()): number {
  const [h, m] = time.split(':').map(Number);
  const today = todayIn(tz, new Date(now));
  for (const offsetDays of [0, 1, 2]) {
    const d = new Date(`${today}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + offsetDays);
    const at = Date.parse(zonedDayStartUtc(d.toISOString().slice(0, 10), tz)) + (h * 60 + m) * 60_000;
    if (at > now + 1000) return at - now;
  }
  return 24 * 60 * 60_000;
}

export function scheduleSnapshots(cfg: Config, db: DB, status: AppDeps['backups']) {
  let timer: NodeJS.Timeout;
  const arm = () => {
    timer = setTimeout(async () => {
      try {
        const r = await takeSnapshot(cfg, db);
        status.lastSnapshotAt = new Date().toISOString();
        status.lastSnapshotError = null;
        status.photos = photoStatus(r);
      } catch (err) {
        status.lastSnapshotError = err instanceof Error ? err.message : String(err);
        log.error('snapshot failed', errorFields(err));
      }
      arm();
    }, msUntil(cfg.snapshotTime, cfg.tz));
    timer.unref();
  };
  arm();
  return () => clearTimeout(timer);
}

// `npm run snapshot` takes one now and exits.
if (process.argv[1] && import.meta.filename === process.argv[1] && process.argv.includes('--once')) {
  const cfg = loadConfig();
  const db = openTrackerDb(cfg.trackerDbPath, false, cfg.filesKey);
  takeSnapshot(cfg, db)
    .then((r) => {
      console.log(`Snapshot written: ${r.file} (${r.bytes} bytes)${r.uploaded.length ? `, uploaded ${r.uploaded.join(', ')}` : ''}`);
      console.log(photoLine(r));
      db.close();
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
