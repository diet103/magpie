// query_sql child process: builds the caller's private snapshot in memory, runs one SELECT, prints JSON, exits.
// The parent kills it with SIGKILL on timeout because node:sqlite has no interrupt or progress handler.
// Input (stdin, JSON): { dbPath, userId, sql, maxRows }. Output (stdout, JSON): { ok, columns, rows, truncated } or { ok: false, error }.
import { constants as C, DatabaseSync } from 'node:sqlite';

const OUTPUT_LIMIT = 100_000;

function snapshotSql(uid: number): string {
  return `
  CREATE TABLE users AS SELECT id, display_name AS name FROM src.users;
  CREATE TABLE collections AS
    SELECT id, slug, name, description, visibility, fields, created_at FROM src.collections
     WHERE archived_at IS NULL AND sensitive = 0 AND (visibility = 'shared' OR owner_id = ${uid});
  CREATE TABLE entries AS
    SELECT e.id, c.slug AS collection, e.collection_id, e.title, e.rating, e.tags, e.fields, e.notes,
           e.first_logged_on, e.last_logged_on, e.log_count,
           (SELECT display_name FROM src.users u WHERE u.id = e.created_by) AS added_by,
           e.created_at, e.updated_at
      FROM src.entries e JOIN collections c ON c.id = e.collection_id
     WHERE e.deleted_at IS NULL AND e.merged_into_id IS NULL;
  CREATE TABLE logs AS
    SELECT l.id, l.entry_id, e.title AS entry_title, e.collection, l.occurred_on, l.rating, l.note, l.raw_text,
           (SELECT display_name FROM src.users u WHERE u.id = l.created_by) AS logged_by, l.created_at
      FROM src.entry_logs l JOIN entries e ON e.id = l.entry_id
     WHERE l.deleted_at IS NULL;
  CREATE TABLE entry_tags AS
    SELECT e.id AS entry_id, e.collection, e.title, t.value AS tag FROM entries e, json_each(e.tags) t;
  CREATE TABLE entry_fields AS
    SELECT e.id AS entry_id, e.collection, e.title, f.key AS field, f.value AS value FROM entries e, json_each(e.fields) f;
`;
}

function fileUri(path: string): string {
  return 'file:' + encodeURI(path).replace(/\?/g, '%3F').replace(/#/g, '%23').replace(/'/g, "''") + '?mode=ro';
}

function plain(v: unknown): unknown {
  if (typeof v === 'bigint') return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString();
  if (v instanceof Uint8Array) return `<blob ${v.byteLength} bytes>`;
  return v;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function main(input: { dbPath: string; userId: number; sql: string; maxRows: number }) {
  if (!Number.isInteger(input.userId)) throw new Error('bad user id');
  const g = new DatabaseSync(':memory:');
  g.exec('PRAGMA hard_heap_limit = 134217728'); // process-wide cap on SQLite memory
  g.close();

  const db = new DatabaseSync(':memory:', { allowExtension: false });
  db.exec(`ATTACH DATABASE '${fileUri(input.dbPath)}' AS src`);
  db.exec('BEGIN');
  db.exec(snapshotSql(input.userId));
  db.exec('COMMIT');
  db.exec('DETACH DATABASE src');
  db.exec('PRAGMA temp_store = MEMORY');
  db.exec('PRAGMA query_only = 1');
  db.setAuthorizer((action: number, _a1: string | null, a2: string | null) => {
    switch (action) {
      case C.SQLITE_SELECT:
      case C.SQLITE_READ:
      case C.SQLITE_RECURSIVE:
        return C.SQLITE_OK;
      case C.SQLITE_FUNCTION:
        return /^(load_extension|readfile|writefile|edit)$/i.test(String(a2)) ? C.SQLITE_DENY : C.SQLITE_OK;
      default:
        return C.SQLITE_DENY;
    }
  });
  db.limits.attach = 0;
  db.limits.length = 1_000_000;
  db.limits.sqlLength = 20_000;

  const stmt = db.prepare(input.sql);
  stmt.setReadBigInts(true);
  // Positional rows, so duplicate column names (SELECT a.id, b.id ...) keep both values.
  stmt.setReturnArrays(true);
  const columns = stmt.columns().map((c) => c.name);
  const rows: unknown[][] = [];
  let size = 0;
  let truncated = false;
  for (const row of stmt.iterate() as unknown as Iterable<unknown[]>) {
    if (rows.length >= input.maxRows) {
      truncated = true;
      break;
    }
    const vals = row.map(plain);
    size += JSON.stringify(vals).length;
    rows.push(vals);
    if (size > OUTPUT_LIMIT) {
      truncated = true;
      break;
    }
  }
  return { ok: true, columns, rows, truncated };
}

try {
  const input = JSON.parse(await readStdin());
  process.stdout.write(JSON.stringify(main(input)));
} catch (err) {
  process.stdout.write(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
}
