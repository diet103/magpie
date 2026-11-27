// Admin CLI. Run on the server with: fly ssh console -C "node src/cli.ts <command> ..."
//   users                                         list household members
//   token create --email E --label L [--ttl 2h]   print a personal access token (for /mcp) once
//   token list --email E
//   token revoke --email E (--hash H | --all)
//   signout-all --email E                         end every web session and revoke every token
//   purge-smoke                                   hard-delete smoke-test collections (slug zz-smoke-*)
//   purge-entry --id N --email E                  delete one Trash entry forever
//   fts-rebuild                                   rebuild the search index from the tables
//   export --email E --out file.db|file.json      what that person can see
//   snapshot                                      take a nightly-style snapshot now
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { AuthStore } from './auth/store.ts';
import { loadConfig } from './config.ts';
import { all, openAuthDb, openTrackerDb, run, tx, type DB } from './db/sqlite.ts';
import { purgeEntry } from './domain/entries.ts';
import { UserError } from './domain/errors.ts';
import type { Ctx } from './domain/types.ts';
import { findUserByEmail, listUsers, syncUsers } from './domain/users.ts';
import { photoLine, takeSnapshot } from './jobs/snapshot.ts';
import { exportJson, exportSqlite } from './web/export.ts';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    email: { type: 'string' },
    label: { type: 'string' },
    ttl: { type: 'string' },
    hash: { type: 'string' },
    all: { type: 'boolean' },
    id: { type: 'string' },
    out: { type: 'string' },
  },
});

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const cfg = loadConfig();
let db: DB;
let store: AuthStore;
try {
  db = openTrackerDb(cfg.trackerDbPath, false, cfg.filesKey);
  syncUsers(db, cfg.allowedUsers);
  store = new AuthStore(openAuthDb(cfg.authDbPath));
} catch (err) {
  // A data folder that cannot be used (missing, empty, the wrong key, or last used by newer code): say why, plainly.
  fail(err instanceof Error ? err.message : String(err));
}

function userOf(email: string | undefined) {
  if (!email) fail('--email is required');
  const u = findUserByEmail(db, email);
  if (!u) fail(`No user ${email}. Users: ${listUsers(db).map((x) => x.email).join(', ')}`);
  return u;
}

function ctxFor(email: string | undefined): Ctx {
  const u = userOf(email);
  return { db, tz: cfg.tz, actor: { userId: u.id, name: u.display_name, via: 'cli', client: 'cli' } };
}

function ttlMs(s: string | undefined): number {
  const m = /^(\d+)\s*([mhd])$/.exec(s ?? '2h');
  if (!m) fail('--ttl looks like 30m, 2h or 7d');
  return Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 'm' | 'h' | 'd'];
}

function rebuildFts(d: DB) {
  tx(d, () => {
    run(d, 'DELETE FROM entries_fts');
    run(d, 'INSERT INTO entries_fts(rowid, title, tags, fields, notes, logs, said) SELECT id, title, tags, fields, notes, logs, said FROM entry_search_doc');
  });
}

/** Smoke tests write into private collections named zz-smoke-*; this removes them completely. */
function purgeSmoke(d: DB): number {
  return tx(d, () => {
    const colls = all<{ id: number }>(d, "SELECT id FROM collections WHERE slug LIKE 'zz-smoke-%'").map((r) => r.id);
    if (colls.length === 0) return 0;
    const ph = colls.map(() => '?').join(',');
    const entries = all<{ id: number }>(d, `SELECT id FROM entries WHERE collection_id IN (${ph})`, ...colls).map((r) => r.id);
    const eph = entries.map(() => '?').join(',') || 'NULL';
    run(d, `UPDATE activity SET undone_by = NULL WHERE undone_by IN (SELECT id FROM activity WHERE collection_id IN (${ph}) OR entry_id IN (${eph}))`, ...colls, ...entries);
    run(d, `DELETE FROM activity WHERE collection_id IN (${ph}) OR entry_id IN (${eph})`, ...colls, ...entries);
    run(d, `UPDATE entries SET merged_into_id = NULL WHERE merged_into_id IN (${eph})`, ...entries);
    run(d, `DELETE FROM entry_logs WHERE entry_id IN (${eph})`, ...entries);
    run(d, `DELETE FROM pins WHERE entry_id IN (${eph})`, ...entries);
    run(d, `DELETE FROM hidden_dates WHERE entry_id IN (${eph})`, ...entries);
    run(d, `DELETE FROM entries WHERE id IN (${eph})`, ...entries);
    run(d, `DELETE FROM collection_pins WHERE collection_id IN (${ph})`, ...colls);
    run(d, `DELETE FROM collections WHERE id IN (${ph})`, ...colls);
    return colls.length;
  });
}

const [cmd, sub] = positionals;
switch (cmd) {
  case 'users':
    for (const u of listUsers(db)) {
      const allowed = cfg.allowedUsers.some((a) => a.email === u.email.toLowerCase());
      console.log(`${u.id}\t${u.display_name}\t${u.email}\t${u.google_sub ? 'google linked' : 'not signed in yet'}${allowed ? '' : '\t(not in ALLOWED_USERS)'}`);
    }
    break;
  case 'token': {
    const u = userOf(values.email);
    if (sub === 'create') {
      const { token, expiresAt } = store.createPat(u.id, values.label ?? 'cli', ttlMs(values.ttl));
      console.log(token);
      console.error(`Personal access token for ${u.display_name}, expires ${expiresAt}. Works on /mcp only.`);
    } else if (sub === 'list') {
      for (const p of store.listPats(u.id)) console.log(`${p.token_hash}\t${p.label}\texpires ${p.expires_at}\tlast used ${p.last_used_at ?? 'never'}`);
    } else if (sub === 'revoke') {
      if (values.all) for (const p of store.listPats(u.id)) store.revokePat(u.id, p.token_hash);
      else if (values.hash) store.revokePat(u.id, values.hash);
      else fail('token revoke needs --hash H or --all');
      console.log('revoked');
    } else fail('token create | list | revoke');
    break;
  }
  case 'signout-all':
    store.deleteAllForUser(userOf(values.email).id);
    console.log('All sessions ended and all tokens revoked.');
    break;
  case 'purge-smoke':
    console.log(`Removed ${purgeSmoke(db)} smoke-test collection(s).`);
    break;
  case 'purge-entry': {
    try {
      console.log(purgeEntry(ctxFor(values.email), Number(values.id)).summary);
    } catch (err) {
      // "Delete it first" and "no such entry" are answers, not crashes.
      if (err instanceof UserError) fail(err.message);
      throw err;
    }
    break;
  }
  case 'fts-rebuild':
    rebuildFts(db);
    console.log('Search index rebuilt.');
    break;
  case 'export': {
    if (!values.out) fail('--out file.db or file.json');
    const ctx = ctxFor(values.email);
    writeFileSync(values.out, values.out.endsWith('.json') ? exportJson(ctx) : exportSqlite(ctx));
    console.log(`Wrote ${values.out}`);
    break;
  }
  case 'snapshot': {
    const r = await takeSnapshot(cfg, db);
    console.log(`Snapshot ${r.file} (${r.bytes} bytes)${r.uploaded.length ? `, uploaded ${r.uploaded.join(', ')}` : ''}`);
    console.log(photoLine(r));
    break;
  }
  default:
    console.log('Commands: users, token create|list|revoke, signout-all, purge-smoke, purge-entry, fts-rebuild, export, snapshot');
    if (cmd) process.exit(1);
}
