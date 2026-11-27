import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { GoogleSignIn } from './auth/google.ts';
import { AuthStore } from './auth/store.ts';
import { loadConfig } from './config.ts';
import { openAuthDb, openTrackerDb, type DB } from './db/sqlite.ts';
import { cleanupFiles } from './domain/files.ts';
import { rewriteAfterChanges, tidy } from './domain/sealed.ts';
import { syncUsers } from './domain/users.ts';
import { mirrorAtStart } from './jobs/photos.ts';
import { photoStatus, scheduleSnapshots } from './jobs/snapshot.ts';
import { errorFields, log, setLogLevel } from './log.ts';
import { closeGracefully } from './shutdown.ts';
import { sweepExports } from './web/export.ts';
import type { AppDeps } from './types.ts';

const cfg = loadConfig();
setLogLevel(cfg.logLevel);

let db: DB;
try {
  db = openTrackerDb(cfg.trackerDbPath, cfg.bootstrapEmptyDb, cfg.filesKey);
} catch (err) {
  log.error('cannot open tracker.db', errorFields(err));
  process.exit(1);
}
let authDb: DB;
try {
  authDb = openAuthDb(cfg.authDbPath);
} catch (err) {
  log.error('cannot open auth.db', errorFields(err));
  process.exit(1);
}
syncUsers(db, cfg.allowedUsers);
sweepExports();
// entrypoint.sh starts Litestream on exactly these four settings. When it has, the write-ahead log is
// Litestream's to reset, and text sealed while the server runs can stay in that file until the next restart.
const replicating = Boolean(cfg.isProd && cfg.r2.bucket && cfg.r2.accountId && cfg.r2.accessKeyId && cfg.r2.secretAccessKey);
const restartNote = 'text sealed just now may still be in the write-ahead log file: restart once to clear it';
// What a sensitive collection held before sealing existed (or holds in a copy restored from then) is sealed
// here, before anything is served. If that fails the server still starts, says so, and tries again each hour.
let tidied = false;
function tidyNow() {
  try {
    const done = tidy(db, !replicating);
    tidied = true;
    if (done.sealed || done.rewritten) log.info('tidied the database', done);
    if (done.sealed && replicating) log.warn(restartNote);
  } catch (err) {
    log.error('could not seal what sensitive collections hold; it is still stored plain', errorFields(err));
  }
}
tidyNow();
rewriteAfterChanges(db, !replicating, (err) => {
  if (err) log.error('could not rewrite the database file after sealing', errorFields(err));
  else {
    log.info('rewrote the database file after sealing');
    if (replicating) log.warn(restartNote);
  }
});
if (!cfg.filesKey) log.warn('FILES_KEY is not set: nothing can be saved to a sensitive collection, and photos are refused');
if (cfg.allowedUsers.length === 0) log.warn('ALLOWED_USERS is empty: nobody can sign in');

const google = new GoogleSignIn({
  issuer: cfg.google.issuer,
  clientId: cfg.google.clientId,
  clientSecret: cfg.google.clientSecret,
  redirectUri: `${cfg.publicUrl}/auth/google/callback`,
  allowInsecure: cfg.google.allowInsecure,
});
if (!google.configured && cfg.passwordDigests.size === 0) {
  log.warn('No sign-in method is configured: set LOGIN_PASSWORDS, or GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET');
} else {
  log.info('sign-in methods', { password: cfg.passwordDigests.size > 0, google: google.configured });
}
const missingPassword = cfg.allowedUsers.filter((u) => !cfg.passwordDigests.has(u.email)).map((u) => u.name);
if (cfg.passwordDigests.size > 0 && !google.configured && missingPassword.length) {
  log.warn('some people have no password and cannot sign in', { names: missingPassword.join(', ') });
}

const store = new AuthStore(authDb);
const deps: AppDeps = { config: cfg, db, store, google, startedAt: new Date(), backups: { lastSnapshotAt: null, lastSnapshotError: null } };
const { app, close } = createApp(deps);

const server = serve({ fetch: app.fetch, port: cfg.port, hostname: '0.0.0.0' }, (info) => {
  log.info('listening', { port: info.port, url: cfg.publicUrl, env: cfg.env });
});

store.cleanup();
cleanupFiles({ db }, { dir: cfg.filesDir, key: cfg.filesKey });
const cleanup = setInterval(() => {
  if (!tidied) tidyNow();
  try {
    store.cleanup();
    cleanupFiles({ db }, { dir: cfg.filesDir, key: cfg.filesKey });
  } catch (err) {
    log.error('auth cleanup failed', errorFields(err));
  }
}, 60 * 60_000);
cleanup.unref();
const backingUp = cfg.isProd || process.env.SNAPSHOTS === '1';
const stopSnapshots = backingUp ? scheduleSnapshots(cfg, db, deps.backups) : () => {};
// Photos added since last night go to the off-site backup now, without waiting for 03:30. And on a new or
// restored disk, this is what brings the photos back from it.
if (backingUp) {
  const failed = (err: unknown) => {
    deps.backups.photos = photoStatus({ photos: null, photoError: err instanceof Error ? err.message : String(err) });
    log.error('photo backup failed', errorFields(err));
  };
  void mirrorAtStart(cfg, db, failed).then(
    (photos) => {
      deps.backups.photos = photoStatus({ photos });
    },
    () => {},
  );
}

let stopping = false;
function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info('shutting down', { signal });
  stopSnapshots();
  clearInterval(cleanup);
  // Replies still open after a second (a chat answer, a client's stream) are cut, so a deploy is not held up.
  void closeGracefully(server).then(async () => {
    await close().catch(() => {});
    try {
      db.close();
      authDb.close();
    } catch {
      // already closed
    }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
