// Photos in the off-site backup (R2). The files are already encrypted, so they are copied as they are, to
// photos/<file name>. Each run makes the two sides agree:
//   - a photo here that is not there is uploaded;
//   - a photo the database has, whose file is missing here but is there, is brought back (a new or restored disk);
//   - a photo that has gone for good here (see removed_attachments) has its copies removed there.
// Nothing is ever removed there just because it is missing here: only because the database says it was deleted.
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AwsClient } from 'aws4fetch';
import type { Config } from '../config.ts';
import { all, run, type DB } from '../db/sqlite.ts';
import { STORED_FILE } from '../domain/files.ts';
import { log } from '../log.ts';

const PREFIX = 'photos/';
/** Each stored file is the photo plus the 12-byte iv and 16-byte tag in front of it. */
const SEALED_EXTRA = 28;

export interface PhotoMirror {
  /** Files the backup holds for photos the database has, after this run. */
  held: number;
  uploaded: number;
  restored: number;
  removed: number;
}

/** No request to the backup may hang for good: the nightly job waits on this one before it runs again. */
const within = () => ({ signal: AbortSignal.timeout(120_000) });

async function listRemote(aws: AwsClient, base: string): Promise<Map<string, number>> {
  const found = new Map<string, number>();
  let token: string | undefined;
  do {
    const q = new URLSearchParams({ 'list-type': '2', prefix: PREFIX });
    if (token) q.set('continuation-token', token);
    const res = await aws.fetch(`${base}?${q}`, within());
    if (!res.ok) throw new Error(`Listing the photos in the off-site backup failed: HTTP ${res.status}`);
    const xml = await res.text();
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const key = /<Key>([^<]+)<\/Key>/.exec(m[1])?.[1];
      const size = /<Size>(\d+)<\/Size>/.exec(m[1])?.[1];
      if (key?.startsWith(PREFIX) && size !== undefined) found.set(key.slice(PREFIX.length), Number(size));
    }
    const more = /<IsTruncated>true<\/IsTruncated>/.test(xml);
    token = more ? /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1] : undefined;
    // Half a listing must never be taken for the whole of it.
    if (more && !token) throw new Error('Listing the photos in the off-site backup stopped partway.');
  } while (token);
  return found;
}

/**
 * The copy made when the server starts, tried again a few times if it fails: the network may not be up in the
 * first second, and a failure here would otherwise wait until the night's run. `onFail` hears about each failure.
 */
export async function mirrorAtStart(cfg: Config, db: DB, onFail: (err: unknown) => void, waitMs = 60_000, tries = 4): Promise<PhotoMirror | null> {
  for (let n = 1; ; n++) {
    try {
      return await mirrorPhotos(cfg, db);
    } catch (err) {
      onFail(err);
      if (n >= tries) throw err;
      await new Promise((r) => setTimeout(r, waitMs).unref());
    }
  }
}

let running: Promise<PhotoMirror | null> | undefined;

/** Brings the off-site copies of the photos in step. Returns null when off-site backups are not switched on. */
export function mirrorPhotos(cfg: Config, db: DB): Promise<PhotoMirror | null> {
  // The nightly run and the one at start-up must not work on the same files at once.
  running ??= mirror(cfg, db).finally(() => {
    running = undefined;
  });
  return running;
}

async function mirror(cfg: Config, db: DB): Promise<PhotoMirror | null> {
  const { endpoint, bucket, accessKeyId, secretAccessKey } = cfg.r2;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    // With no off-site copy at all, nothing needs remembering about photos that are gone. With only some of the
    // settings present (a key being replaced, a typo) the list is kept: the copies are still there to remove.
    if (!endpoint && !bucket && !accessKeyId && !secretAccessKey) run(db, 'DELETE FROM removed_attachments');
    return null;
  }
  const aws = new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto' });
  const base = `${endpoint.replace(/\/+$/, '')}/${bucket}`;
  const urlOf = (name: string) => `${base}/${PREFIX}${name}`;
  const remote = await listRemote(aws, base);
  const done: PhotoMirror = { held: 0, uploaded: 0, restored: 0, removed: 0 };

  // Gone for good here, so gone there. Ids are never reused, but a row is checked for all the same.
  for (const { id } of all<{ id: number }>(db, 'SELECT id FROM removed_attachments WHERE id NOT IN (SELECT id FROM attachments)')) {
    for (const name of [`${id}.enc`, `${id}.small.enc`]) {
      if (!remote.has(name)) continue;
      const res = await aws.fetch(urlOf(name), { method: 'DELETE', ...within() });
      if (!res.ok && res.status !== 404) throw new Error(`Removing ${name} from the off-site backup failed: HTTP ${res.status}`);
      remote.delete(name);
      done.removed++;
    }
    run(db, 'DELETE FROM removed_attachments WHERE id = ?', id);
  }

  // What should exist, and how large each file is once sealed. An upload still waiting to be attached to an
  // entry is left out: it is either attached soon or dropped after a day.
  const expected = new Map<string, number>();
  for (const row of all<{ id: number; size: number; preview_size: number | null }>(db, 'SELECT id, size, preview_size FROM attachments WHERE entry_id IS NOT NULL')) {
    expected.set(`${row.id}.enc`, row.size + SEALED_EXTRA);
    if (row.preview_size !== null) expected.set(`${row.id}.small.enc`, row.preview_size + SEALED_EXTRA);
  }
  mkdirSync(cfg.filesDir, { recursive: true });
  const local = new Map<string, number>();
  for (const name of readdirSync(cfg.filesDir)) if (STORED_FILE.test(name)) local.set(name, statSync(join(cfg.filesDir, name)).size);

  for (const [name, size] of expected) {
    // A file of the wrong size is damaged or half written. It is never copied over a good one.
    const hereOk = local.get(name) === size;
    const thereOk = remote.get(name) === size;
    if (hereOk && !thereOk) {
      const res = await aws.fetch(urlOf(name), { method: 'PUT', body: readFileSync(join(cfg.filesDir, name)), headers: { 'Content-Type': 'application/octet-stream' }, ...within() });
      if (!res.ok) throw new Error(`Copying ${name} to the off-site backup failed: HTTP ${res.status}`);
      done.uploaded++;
    } else if (!hereOk && thereOk) {
      const res = await aws.fetch(urlOf(name), within());
      if (!res.ok) throw new Error(`Bringing ${name} back from the off-site backup failed: HTTP ${res.status}`);
      writeFileSync(join(cfg.filesDir, name), new Uint8Array(await res.arrayBuffer()), { mode: 0o600 });
      done.restored++;
    } else if (!hereOk) {
      log.warn('photo file is missing or damaged here and in the off-site backup', { name });
      continue;
    }
    done.held++;
  }
  log.info('photo backup done', { ...done });
  return done;
}
