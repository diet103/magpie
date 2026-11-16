import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { UserError } from '../domain/errors.ts';

const CHILD = fileURLToPath(new URL('./child.ts', import.meta.url));
const TIMEOUT_MS = 3000;
const OUTPUT_CAP = 200_000;
const WAIT_MS = 2000;

export interface SqlResult {
  columns: string[];
  rows: unknown[][];
  truncated: boolean;
}

/**
 * Rejects anything but a single read statement before it reaches SQLite (node:sqlite's prepare() would
 * silently ignore everything after the first statement).
 */
export function checkSql(sql: string): string {
  let s = sql.trim();
  let inQuote: string | null = null;
  let i = 0;
  let firstWord = '';
  let semicolonAt = -1;
  while (i < s.length) {
    const ch = s[i];
    const next = s[i + 1];
    if (inQuote) {
      if (ch === inQuote) {
        if (next === inQuote && inQuote !== ']') i++;
        else inQuote = null;
      }
      i++;
      continue;
    }
    if (ch === '-' && next === '-') {
      const nl = s.indexOf('\n', i);
      i = nl === -1 ? s.length : nl + 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = s.indexOf('*/', i + 2);
      i = end === -1 ? s.length : end + 2;
      continue;
    }
    if (semicolonAt !== -1) {
      if (!/\s/.test(ch)) throw new UserError('Only one statement at a time.');
      i++;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') inQuote = ch;
    else if (ch === '[') inQuote = ']';
    else if (ch === ';') semicolonAt = i;
    else if (!firstWord && /[A-Za-z]/.test(ch)) {
      firstWord = /^[A-Za-z]+/.exec(s.slice(i))![0].toUpperCase();
    }
    i++;
  }
  if (inQuote) throw new UserError('The SQL has an unclosed quote.');
  if (semicolonAt !== -1) s = s.slice(0, semicolonAt);
  if (!['SELECT', 'WITH', 'VALUES'].includes(firstWord)) {
    throw new UserError('query_sql only runs a single SELECT (or WITH ... SELECT). Use the other tools to change data.');
  }
  return s;
}

let running = false;
const waiters: (() => void)[] = [];

async function acquire(): Promise<() => void> {
  if (running) {
    const got = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        const idx = waiters.indexOf(wake);
        if (idx !== -1) waiters.splice(idx, 1);
        resolve(false);
      }, WAIT_MS);
      const wake = () => {
        clearTimeout(timer);
        resolve(true);
      };
      waiters.push(wake);
    });
    if (!got) throw new UserError('query_sql is busy with another query. Try again in a moment.');
  }
  running = true;
  return () => {
    const next = waiters.shift();
    if (next) next();
    else running = false;
  };
}

/** Runs one SELECT against a fresh snapshot of what userId can see, in a child process with hard limits. */
export async function runQuerySql(opts: { dbPath: string; userId: number; sql: string; maxRows: number }): Promise<SqlResult> {
  const sql = checkSql(opts.sql);
  const release = await acquire();
  try {
    return await new Promise<SqlResult>((resolve, reject) => {
      const child = spawn(process.execPath, ['--max-old-space-size=64', '--no-warnings', CHILD], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { PATH: process.env.PATH ?? '' },
      });
      let out = '';
      let err = '';
      let killedFor: string | null = null;
      const kill = (why: string) => {
        if (!killedFor) {
          killedFor = why;
          child.kill('SIGKILL');
        }
      };
      const timer = setTimeout(() => kill('timeout'), TIMEOUT_MS);
      child.stdout.on('data', (d: Buffer) => {
        out += d.toString('utf8');
        if (out.length > OUTPUT_CAP) kill('output');
      });
      child.stderr.on('data', (d: Buffer) => {
        if (err.length < 4000) err += d.toString('utf8');
      });
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on('close', () => {
        clearTimeout(timer);
        if (killedFor === 'timeout') return reject(new UserError('The query took longer than 3 seconds and was stopped. Simplify it or add a LIMIT.'));
        if (killedFor === 'output') return reject(new UserError('The query returned too much data. Select fewer columns or rows.'));
        let parsed: { ok: boolean; error?: string } & Partial<SqlResult>;
        try {
          parsed = JSON.parse(out);
        } catch {
          return reject(new Error(`query_sql child failed: ${err.slice(0, 500) || 'no output'}`));
        }
        if (!parsed.ok) return reject(new UserError(explain(parsed.error ?? 'unknown error')));
        resolve({ columns: parsed.columns ?? [], rows: parsed.rows ?? [], truncated: Boolean(parsed.truncated) });
      });
      child.stdin.end(JSON.stringify({ dbPath: opts.dbPath, userId: opts.userId, sql, maxRows: opts.maxRows }));
    });
  } finally {
    release();
  }
}

const TABLES =
  'Tables: collections(id, slug, name, description, visibility, fields, created_at); entries(id, collection, collection_id, title, rating, tags, fields, notes, first_logged_on, last_logged_on, log_count, added_by, created_at, updated_at); logs(id, entry_id, entry_title, collection, occurred_on, rating, note, raw_text, logged_by, created_at); entry_tags(entry_id, collection, title, tag); entry_fields(entry_id, collection, title, field, value); users(id, name).';

function explain(error: string): string {
  if (/not authorized/i.test(error)) return `SQL error: ${error}. Only plain SELECTs on the tables below are allowed. ${TABLES}`;
  if (/no such (table|column)/i.test(error)) return `SQL error: ${error}. ${TABLES}`;
  return `SQL error: ${error}`;
}
