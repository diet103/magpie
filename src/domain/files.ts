// Photo attachments. Bytes are encrypted with AES-256-GCM under FILES_KEY (a Fly secret, so it is not on the
// disk or in any database backup) and stored as DATA_DIR/files/<id>.enc = iv (12) + tag (16) + ciphertext.
// A photo may have a small preview beside it, made by the browser and stored the same way as <id>.small.enc.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { all, get, run, tx } from '../db/sqlite.ts';
import { recordActivity, snapshot } from './activity.ts';
import { resolveEntry } from './entries.ts';
import { NotFoundError, UserError } from './errors.ts';
import { nowIso } from './time.ts';
import type { AttachmentRow, Ctx } from './types.ts';

export type { AttachmentRow } from './types.ts';

export interface FileStore {
  dir: string;
  key: Buffer | undefined;
}

export const MAX_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_PER_ENTRY = 20;
/** A removed photo can be brought back for this long. After that the row and the file are cleared out. */
export const KEEP_REMOVED_DAYS = 30;
/** A photo this small is shown as it is: a preview of it would save nothing worth having. */
export const PREVIEW_WORTH_BYTES = 200 * 1024;
const MAX_PREVIEW_BYTES = 300 * 1024;
/** The names this module gives its files: 12.enc is a photo and 12.small.enc is its preview. */
export const STORED_FILE = /^(\d+)(\.small)?\.enc$/;

/** Decides the type from the bytes themselves, never from what the browser claims. */
export function sniffMime(b: Uint8Array): string | undefined {
  const starts = (...sig: number[]) => sig.every((v, i) => b[i] === v);
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (starts(0x52, 0x49, 0x46, 0x46) && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  if (starts(0x25, 0x50, 0x44, 0x46, 0x2d)) return 'application/pdf';
  return undefined;
}

function pathFor(store: FileStore, id: number, preview = false) {
  return join(store.dir, `${id}${preview ? '.small' : ''}.enc`);
}

function requireKey(store: FileStore): Buffer {
  if (!store.key) throw new UserError("Photo storage isn't set up on this server yet. Run setup again; it adds the missing key.");
  return store.key;
}

function seal(key: Buffer, bytes: Uint8Array): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const sealed = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), sealed]);
}

/**
 * The bytes of a stored photo or its preview. It checks nothing about who is asking: use readAttachment unless
 * the caller has already worked out what the reader may see, as the data download has.
 */
export function readStored(store: FileStore, id: number, preview = false): Buffer {
  const key = requireKey(store);
  let blob: Buffer;
  try {
    blob = readFileSync(pathFor(store, id, preview));
  } catch {
    throw new NotFoundError('That photo is missing from the server.');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12));
  decipher.setAuthTag(blob.subarray(12, 28));
  try {
    return Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]);
  } catch {
    throw new UserError("That photo can't be decrypted. The server's photo key has changed since it was saved.");
  }
}

function cleanName(name: string, mime: string): string {
  const base = name.replace(/[^\w.\- ]+/g, '_').replace(/^\.+/, '').slice(0, 80).trim();
  return base || `photo.${mime.split('/')[1]}`;
}

/** A preview is kept only when it is a picture and clearly smaller than the photo it stands in for. */
function usablePreview(mime: string, size: number, preview: Uint8Array | undefined): preview is Uint8Array {
  if (!preview || !mime.startsWith('image/') || size <= PREVIEW_WORTH_BYTES) return false;
  if (preview.byteLength === 0 || preview.byteLength > MAX_PREVIEW_BYTES || preview.byteLength >= size) return false;
  return (sniffMime(preview) ?? '').startsWith('image/');
}

/**
 * Stores a file. With entryId it is attached to that entry; without, it waits to be attached (assistant uploads).
 * A preview that is no use is left out without a word: it must never stop the photo itself from being saved.
 */
export function saveAttachment(
  ctx: Ctx,
  store: FileStore,
  f: { entryId: number | null; filename: string; bytes: Uint8Array; preview?: Uint8Array },
): AttachmentRow {
  const key = requireKey(store);
  if (f.bytes.byteLength === 0) throw new UserError('That file is empty.');
  if (f.bytes.byteLength > MAX_FILE_BYTES) throw new UserError('That file is larger than 8 MB.');
  const mime = sniffMime(f.bytes);
  if (!mime) throw new UserError('Only JPEG, PNG and WebP photos and PDFs can be attached.');
  const blob = seal(key, f.bytes);
  const small = usablePreview(mime, f.bytes.byteLength, f.preview) ? f.preview : undefined;
  mkdirSync(store.dir, { recursive: true });
  return tx(ctx.db, () => {
    let title: string | undefined;
    let collectionId: number | undefined;
    if (f.entryId !== null) {
      const { entry, collection } = resolveEntry(ctx, f.entryId);
      f = { ...f, entryId: entry.id };
      title = entry.title;
      collectionId = collection.id;
      const n = get<{ n: number }>(ctx.db, 'SELECT count(*) AS n FROM attachments WHERE entry_id = ? AND deleted_at IS NULL', entry.id)!.n;
      if (n >= MAX_PER_ENTRY) throw new UserError(`An entry can have at most ${MAX_PER_ENTRY} photos.`);
    }
    const res = run(
      ctx.db,
      'INSERT INTO attachments (entry_id, filename, mime, size, created_by, created_at, preview_size) VALUES (?, ?, ?, ?, ?, ?, ?)',
      f.entryId,
      cleanName(f.filename, mime),
      mime,
      f.bytes.byteLength,
      ctx.actor.userId,
      nowIso(),
      small ? small.byteLength : null,
    );
    const id = Number(res.lastInsertRowid);
    writeFileSync(pathFor(store, id), blob, { mode: 0o600 });
    if (small) writeFileSync(pathFor(store, id, true), seal(key, small), { mode: 0o600 });
    if (f.entryId !== null) {
      recordActivity(ctx, { action: 'add_photo', collectionId, entryId: f.entryId, summary: `Added a photo to "${title}".` });
    }
    return get<AttachmentRow>(ctx.db, 'SELECT * FROM attachments WHERE id = ?', id)!;
  });
}

/** Loads a row the actor may see: through its entry's visibility, or their own unattached upload. */
export function getAttachment(ctx: Ctx, id: number): AttachmentRow {
  const row = get<AttachmentRow>(ctx.db, 'SELECT * FROM attachments WHERE id = ? AND deleted_at IS NULL', id);
  if (!row) throw new NotFoundError('No such photo.');
  if (row.entry_id === null) {
    if (row.created_by !== ctx.actor.userId) throw new NotFoundError('No such photo.');
  } else {
    try {
      resolveEntry(ctx, row.entry_id, { allowDeleted: true });
    } catch {
      throw new NotFoundError('No such photo.');
    }
  }
  return row;
}

export function readAttachment(ctx: Ctx, store: FileStore, id: number): { row: AttachmentRow; bytes: Buffer } {
  const row = getAttachment(ctx, id);
  return { row, bytes: readStored(store, id) };
}

/** The small preview of a photo, for anyone who may see the photo. */
export function readPreview(ctx: Ctx, store: FileStore, id: number): { row: AttachmentRow; bytes: Buffer; mime: string } {
  const row = getAttachment(ctx, id);
  if (row.preview_size === null) throw new NotFoundError('That photo has no preview.');
  let bytes: Buffer;
  try {
    bytes = readStored(store, id, true);
  } catch (err) {
    // The preview's file is gone (a disk restored without it, say). Forget it, so pages show the photo itself
    // again and the next one to open the entry makes a new preview.
    if (err instanceof NotFoundError) run(ctx.db, 'UPDATE attachments SET preview_size = NULL WHERE id = ?', id);
    throw err;
  }
  return { row, bytes, mime: sniffMime(bytes) ?? 'image/jpeg' };
}

/**
 * Gives a photo that has no preview the one a browser made from it. The first one sent is kept and later ones
 * are ignored, so the preview a phone has stored never changes under it. Only the person who added the photo may
 * supply it: a preview is what everyone sees in lists, and it must not be someone else's choice of picture.
 * Says whether this one was kept.
 */
export function savePreview(ctx: Ctx, store: FileStore, id: number, preview: Uint8Array): boolean {
  const key = requireKey(store);
  const row = getAttachment(ctx, id);
  if (row.created_by !== ctx.actor.userId || row.preview_size !== null || !usablePreview(row.mime, row.size, preview)) return false;
  writeFileSync(pathFor(store, id, true), seal(key, preview), { mode: 0o600 });
  run(ctx.db, 'UPDATE attachments SET preview_size = ? WHERE id = ? AND preview_size IS NULL', preview.byteLength, id);
  return true;
}

/** Attaches one of the actor's own waiting uploads to an entry they can see. */
export function attachUpload(ctx: Ctx, uploadId: number, entryId: number): string {
  return tx(ctx.db, () => {
    const row = getAttachment(ctx, uploadId);
    if (row.entry_id !== null) throw new UserError('That photo is already attached to an entry.');
    const { entry, collection } = resolveEntry(ctx, entryId);
    run(ctx.db, 'UPDATE attachments SET entry_id = ? WHERE id = ?', entry.id, uploadId);
    const summary = `Added a photo to "${entry.title}".`;
    recordActivity(ctx, { action: 'add_photo', collectionId: collection.id, entryId: entry.id, summary });
    return `${summary} (#${entry.id})`;
  });
}

/**
 * Removes a photo from its entry. The row is only marked and the file stays where it is, so the removal can be
 * undone (see undoActivity) until cleanupFiles clears it out. An upload that was never attached to an entry has
 * nothing to go back to and is dropped at once.
 */
export function deleteAttachment(ctx: Ctx, store: FileStore, id: number): { entryId: number | null; activityId?: number } {
  const row = getAttachment(ctx, id);
  if (row.entry_id === null) {
    run(ctx.db, 'DELETE FROM attachments WHERE id = ?', id);
    for (const preview of [false, true]) rmSync(pathFor(store, id, preview), { force: true });
    return { entryId: null };
  }
  const entryId = row.entry_id;
  return tx(ctx.db, () => {
    const { entry, collection } = resolveEntry(ctx, entryId, { allowDeleted: true });
    const before = snapshot(ctx.db, { attachments: [id] });
    run(ctx.db, 'UPDATE attachments SET deleted_at = ? WHERE id = ?', nowIso(), id);
    const activityId = recordActivity(ctx, {
      action: 'delete_photo',
      collectionId: collection.id,
      entryId: entry.id,
      summary: `Removed a photo from "${entry.title}".`,
      before,
      after: snapshot(ctx.db, { attachments: [id] }),
    });
    return { entryId, activityId };
  });
}

/**
 * Housekeeping. Uploads sent to the assistant and never attached are dropped after a day. Photos removed more
 * than KEEP_REMOVED_DAYS ago are dropped for good. Then every file whose row is gone (those two, and the photos
 * of entries deleted forever) is removed from the disk, previews included.
 */
export function cleanupFiles(ctx: Pick<Ctx, 'db'>, store: FileStore) {
  const before = (ms: number) => new Date(Date.now() - ms).toISOString();
  run(ctx.db, 'DELETE FROM attachments WHERE entry_id IS NULL AND created_at < ?', before(24 * 60 * 60_000));
  run(ctx.db, 'DELETE FROM attachments WHERE deleted_at IS NOT NULL AND deleted_at < ?', before(KEEP_REMOVED_DAYS * 24 * 60 * 60_000));
  const live = new Set(all<{ id: number }>(ctx.db, 'SELECT id FROM attachments').map((r) => r.id));
  let names: string[] = [];
  try {
    names = readdirSync(store.dir);
  } catch {
    return;
  }
  for (const name of names) {
    const m = STORED_FILE.exec(name);
    if (m && !live.has(Number(m[1]))) rmSync(join(store.dir, name), { force: true });
  }
}
