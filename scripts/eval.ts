// Claude-in-the-loop evals for the tool design (plan 10.5).
// Sends each fixture's user messages to the Anthropic Messages API with the server's real tool definitions and
// instructions, runs the tool calls against a fresh seeded database, and scores what happened.
//
//   ANTHROPIC_API_KEY=... npm run eval                       all fixtures, default model
//   npm run eval -- --model claude-opus-5-5 --runs 3          repeat each fixture to see variance
//   npm run eval -- --filter repeat --verbose                 one fixture, print the transcript
//   npm run eval -- --no-instructions                        as if the client ignored server instructions
//   npm run eval -- --ask                                     as the app's own Ask chat: its prompt, low effort
//   npm run eval -- --ask --effort medium                     the same at another effort, to compare
//   npm run eval -- --check                                   validate fixtures and seeds without calling the API
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { collectionsNote, MAX_TOKENS, systemPrompt } from '../src/assistant/chat.ts';
import { APP_NAME } from '../src/brand.ts';
import { all, openTrackerDb, type DB } from '../src/db/sqlite.ts';
import { createCollection } from '../src/domain/collections.ts';
import { addLog, createEntry } from '../src/domain/entries.ts';
import { addDays, todayIn } from '../src/domain/time.ts';
import type { Ctx } from '../src/domain/types.ts';
import { findUserByEmail, syncUsers } from '../src/domain/users.ts';
import { createMcpEndpoint } from '../src/mcp/server.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const TZ = process.env.HOUSEHOLD_TZ ?? 'UTC';

export interface Fixture {
  name: string;
  user?: 'alex' | 'sam';
  seed?: 'standard' | 'empty';
  messages: string[];
  expect: {
    calls?: string[];
    not_calls?: string[];
    sql?: { q: string; eq: unknown }[];
    raw_text_contains?: string[];
    reply_max_chars?: number;
    reply_contains?: string[];
    reply_not_contains?: string[];
    asks_question?: boolean;
    no_writes?: boolean;
  };
}

export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
  result: string;
  isError: boolean;
}

export interface Transcript {
  calls: ToolCall[];
  replies: string[];
  /** How many times the model was called: what a person waits through. */
  requests: number;
}

type Block = { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
type Message = { role: 'user' | 'assistant'; content: string | unknown[] };
export type ModelFn = (req: { system: string; tools: unknown[]; messages: Message[] }) => Promise<{ content: Block[]; stop_reason: string }>;

const WRITE_TOOLS = new Set(['create_entry', 'add_log', 'update_entry', 'update_log', 'delete_item', 'merge_entries', 'undo_last_change', 'create_collection', 'update_collection']);

/** Replaces {{today}}, {{today-3}}, {{last:fri}} with dates in the household time zone. */
export function expandDates(s: string, today = todayIn(TZ)): string {
  return s
    .replace(/\{\{today([+-]\d+)?\}\}/g, (_, off) => addDays(today, off ? Number(off) : 0))
    .replace(/\{\{last:(sun|mon|tue|wed|thu|fri|sat)\}\}/g, (_, d: string) => {
      const target = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(d);
      for (let i = 1; i <= 7; i++) {
        const day = addDays(today, -i);
        if (new Date(`${day}T12:00:00Z`).getUTCDay() === target) return day;
      }
      return today;
    });
}

function seedStandard(db: DB, ctx: (who: 'alex' | 'sam') => Ctx) {
  const d = ctx('alex');
  const e = ctx('sam');
  const today = todayIn(TZ);
  const must = <T extends { ok: boolean }>(r: T) => {
    if (!r.ok) throw new Error(`seed failed: ${JSON.stringify(r)}`);
    return r as T & { entryId?: number };
  };
  must(createCollection(d, {
    name: 'Restaurants',
    description: "Places we've eaten or want to try.",
    icon: '🍜',
    fields: [
      { key: 'cuisine', type: 'text' },
      { key: 'neighborhood', type: 'text' },
      { key: 'price', type: 'enum', options: ['$', '$$', '$$$', '$$$$'] },
      { key: 'status', type: 'enum', options: ['want_to_try', 'been'] },
    ],
    display: { list_columns: ['cuisine', 'neighborhood', 'rating', 'last_logged_on'], default_sort: { by: 'last_logged_on', dir: 'desc' }, log_noun: 'visit' },
  }));
  must(createCollection(d, {
    name: 'Movies',
    description: "Films we've watched or want to watch. Logs are viewings.",
    icon: '🎬',
    fields: [
      { key: 'year', type: 'number' },
      { key: 'director', type: 'text' },
      { key: 'status', type: 'enum', options: ['to_watch', 'watched'] },
    ],
    display: { log_noun: 'viewing' },
  }));
  must(createCollection(d, {
    name: 'Books',
    description: "Books we've read, are reading, or want to read. Logs are reading sessions or finishes.",
    icon: '📚',
    fields: [
      { key: 'author', type: 'text' },
      { key: 'status', type: 'enum', options: ['to_read', 'reading', 'finished'] },
    ],
    display: { log_noun: 'read' },
  }));
  const pho = must(createEntry(e, { collection: 'restaurants', title: 'Pho 54', fields: { cuisine: 'Vietnamese', neighborhood: 'Main Street', price: '$', status: 'been' }, tags: ['pho', 'vietnamese'], log: { rating: 4, occurred_on: addDays(today, -37), note: 'Spring rolls were great.' }, raw_text: 'pho 54 spring rolls amazing, 4 stars' }));
  must(createEntry(e, { collection: 'restaurants', title: 'Tacos El Gordo', fields: { cuisine: 'Mexican', neighborhood: 'Southgate', price: '$', status: 'been' }, tags: ['takeout'], log: { rating: 4, occurred_on: addDays(today, -25), note: 'Al pastor great, too salty' }, raw_text: 'al pastor was great but way too salty, still a 4' }));
  must(createEntry(d, { collection: 'restaurants', title: 'Taco Star', fields: { cuisine: 'Mexican', status: 'been' }, log: { rating: 3, occurred_on: addDays(today, -36) }, raw_text: 'taco star was fine, nothing special, 3 out of 5' }));
  must(createEntry(d, { collection: 'restaurants', title: 'Thai Basil', fields: { cuisine: 'Thai', status: 'been' }, tags: ['date-night'], log: { rating: 4.5, occurred_on: addDays(today, -60), note: 'Green curry' }, raw_text: 'thai basil green curry was incredible, 4.5' }));
  must(createEntry(e, { collection: 'restaurants', title: 'Lemongrass', fields: { cuisine: 'Thai', status: 'been' }, log: { rating: 2.5, occurred_on: addDays(today, -90) }, raw_text: 'lemongrass was disappointing' }));
  must(createEntry(e, { collection: 'restaurants', title: 'Siam Garden', fields: { cuisine: 'Thai', status: 'want_to_try' }, raw_text: 'we should try siam garden sometime' }));
  must(createEntry(e, { collection: 'movies', title: 'Dune: Part Two', fields: { year: 2024, director: 'Denis Villeneuve', status: 'watched' }, log: { rating: 4.5, occurred_on: addDays(today, -20) }, raw_text: 'dune part two was amazing' }));
  must(createEntry(d, { collection: 'books', title: 'Project Hail Mary', fields: { author: 'Andy Weir', status: 'reading' }, raw_text: 'started project hail mary' }));
  void addLog;
  void pho;
}

function seedFor(fx: Fixture, db: DB, ctx: (who: 'alex' | 'sam') => Ctx) {
  if ((fx.seed ?? 'standard') === 'standard') seedStandard(db, ctx);
}

export async function runFixture(fx: Fixture, model: ModelFn, opts: { instructions: boolean; verbose: boolean; ask?: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-eval-'));
  const dbPath = join(dir, 'tracker.db');
  const db = openTrackerDb(dbPath, true, randomBytes(32));
  syncUsers(db, [
    { email: 'alex@example.com', name: 'Alex' },
    { email: 'sam@example.com', name: 'Sam' },
  ]);
  const ctx = (who: 'alex' | 'sam'): Ctx => {
    const u = findUserByEmail(db, `${who}@example.com`)!;
    return { db, tz: TZ, actor: { userId: u.id, name: u.display_name, via: 'mcp', client: 'seed' } };
  };
  const handler = createMcpEndpoint({ db, dbPath, tz: TZ, householdNames: () => ['Alex', 'Sam'] });
  try {
    seedFor(fx, db, ctx);
    const who = fx.user ?? 'alex';
    const userId = ctx(who).actor.userId;
    const authInfo = { token: 'eval', clientId: 'eval', scopes: ['tracker'], extra: { userId, clientName: 'eval' } };
    const client = new Client({ name: 'eval', version: '1' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL('http://tracker.eval/mcp'), { fetch: (u, init) => handler.fetch(new Request(u, init), { authInfo }) }),
    );
    const { tools } = await client.listTools();
    const apiTools = tools.map((t) => ({ name: t.name, description: t.description ?? '', input_schema: t.inputSchema }));
    // --ask runs the fixtures the way the app's own chat does: its prompt, and the collection list handed over
    // with each message instead of being asked for.
    const system = opts.ask
      ? systemPrompt(client.getInstructions() ?? '', false)
      : [
          `You are Claude, talking with a user in the Claude mobile app. They usually speak by voice. A custom connector called ${APP_NAME} is connected.`,
          opts.instructions ? `Instructions from the ${APP_NAME} connector:\n${client.getInstructions() ?? ''}` : '',
        ]
          .filter(Boolean)
          .join('\n\n');
    const transcript: Transcript = { calls: [], replies: [], requests: 0 };
    const messages: Message[] = [];
    for (const raw of fx.messages) {
      if (opts.ask) {
        const listing = (await client.callTool({ name: 'list_collections', arguments: {} })) as { content: { text?: string }[] };
        messages.push({ role: 'user', content: [{ type: 'text', text: expandDates(raw) }, { type: 'text', text: collectionsNote(listing.content.map((c) => c.text ?? '').join('\n')) }] });
      } else {
        messages.push({ role: 'user', content: expandDates(raw) });
      }
      for (let turn = 0; turn < 15; turn++) {
        const res = await model({ system, tools: apiTools, messages });
        transcript.requests++;
        messages.push({ role: 'assistant', content: res.content });
        const uses = res.content.filter((b): b is Extract<Block, { type: 'tool_use' }> => b.type === 'tool_use');
        if (uses.length === 0) {
          transcript.replies.push(res.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n').trim());
          break;
        }
        const results: unknown[] = [];
        for (const u of uses) {
          const r = (await client.callTool({ name: u.name, arguments: u.input })) as { content: { text?: string }[]; isError?: boolean };
          const text = r.content.map((c) => c.text ?? '').join('\n');
          transcript.calls.push({ name: u.name, input: u.input, result: text, isError: Boolean(r.isError) });
          if (opts.verbose) console.log(`  → ${u.name} ${JSON.stringify(u.input)}\n    ${text.split('\n').join('\n    ')}`);
          results.push({ type: 'tool_result', tool_use_id: u.id, content: text, is_error: Boolean(r.isError) });
        }
        messages.push({ role: 'user', content: results });
      }
      if (opts.verbose) console.log(`  Claude: ${transcript.replies[transcript.replies.length - 1] ?? '(no reply)'}`);
    }
    await client.close();
    return { transcript, failures: score(fx, transcript, db) };
  } finally {
    await handler.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function isSubsequence(want: string[], got: string[]): boolean {
  let i = 0;
  for (const g of got) if (g === want[i]) i++;
  return i === want.length;
}

export function score(fx: Fixture, t: Transcript, db: DB): string[] {
  const f: string[] = [];
  const names = t.calls.map((c) => c.name);
  const e = fx.expect;
  if (e.calls && !isSubsequence(e.calls, names)) f.push(`expected calls ${e.calls.join(' > ')} in order, got ${names.join(' > ') || 'none'}`);
  for (const n of e.not_calls ?? []) if (names.includes(n)) f.push(`should not call ${n}`);
  if (e.no_writes && names.some((n) => WRITE_TOOLS.has(n))) f.push(`should not change anything, called ${names.filter((n) => WRITE_TOOLS.has(n)).join(', ')}`);
  for (const check of e.sql ?? []) {
    const q = expandDates(check.q);
    let got: unknown;
    try {
      const row = all<Record<string, unknown>>(db, q)[0];
      got = row ? Object.values(row)[0] : null;
    } catch (err) {
      got = `error: ${err instanceof Error ? err.message : err}`;
    }
    const want = typeof check.eq === 'string' ? expandDates(check.eq) : check.eq;
    if (got !== want) f.push(`SQL ${q} gave ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  }
  for (const phrase of e.raw_text_contains ?? []) {
    const writes = t.calls.filter((c) => WRITE_TOOLS.has(c.name));
    if (!writes.some((c) => String(c.input.raw_text ?? '').toLowerCase().includes(phrase.toLowerCase()))) {
      f.push(`no write passed raw_text containing "${phrase}"`);
    }
  }
  const last = t.replies[t.replies.length - 1] ?? '';
  if (e.reply_max_chars !== undefined && last.length > e.reply_max_chars) f.push(`final reply is ${last.length} chars (max ${e.reply_max_chars})`);
  for (const s of e.reply_contains ?? []) if (!last.toLowerCase().includes(s.toLowerCase())) f.push(`final reply lacks "${s}"`);
  for (const s of e.reply_not_contains ?? []) if (last.toLowerCase().includes(s.toLowerCase())) f.push(`final reply mentions "${s}"`);
  if (e.asks_question === true && !last.includes('?')) f.push('expected a question');
  if (e.asks_question === false && /\?\s*$/.test(last)) f.push('ended with a question');
  return f;
}

export function loadFixtures(dir = join(HERE, 'eval-fixtures')): Fixture[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .flatMap((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Fixture[]);
}

export function anthropicModel(model: string, apiKey: string, effort?: string): ModelFn {
  const base = (process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com').replace(/\/+$/, '');
  return async ({ system, tools, messages }) => {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model,
          max_tokens: MAX_TOKENS,
          cache_control: { type: 'ephemeral' },
          ...(effort ? { output_config: { effort } } : {}),
          system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
          tools,
          messages,
        }),
      });
      if (res.ok) return (await res.json()) as { content: Block[]; stop_reason: string };
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      model: { type: 'string', default: 'claude-sonnet-5-5' },
      runs: { type: 'string', default: '1' },
      filter: { type: 'string' },
      verbose: { type: 'boolean' },
      'no-instructions': { type: 'boolean' },
      ask: { type: 'boolean' },
      effort: { type: 'string' },
      check: { type: 'boolean' },
      out: { type: 'string' },
    },
  });
  let fixtures = loadFixtures();
  if (values.filter) fixtures = fixtures.filter((f) => f.name.toLowerCase().includes(values.filter!.toLowerCase()));
  if (values.check) {
    for (const fx of fixtures) {
      const r = await runFixture(fx, async () => ({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }), { instructions: true, verbose: false });
      void r;
    }
    console.log(`${fixtures.length} fixtures load and seed cleanly.`);
    return;
  }
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    console.error('Set ANTHROPIC_API_KEY (or use --check to validate fixtures without the API).');
    process.exit(2);
  }
  // The app's chat runs at low effort unless told otherwise; Claude's own apps choose theirs.
  const effort = values.effort ?? (values.ask ? 'low' : undefined);
  const model = anthropicModel(values.model!, key, effort);
  const runs = Math.max(1, Number(values.runs) || 1);
  const report: { name: string; run: number; ok: boolean; failures: string[]; calls: string[]; requests: number; reply: string }[] = [];
  for (const fx of fixtures) {
    for (let run = 1; run <= runs; run++) {
      if (values.verbose) console.log(`\n# ${fx.name}${runs > 1 ? ` (run ${run})` : ''}`);
      try {
        const { transcript, failures } = await runFixture(fx, model, { instructions: !values['no-instructions'], verbose: Boolean(values.verbose), ask: Boolean(values.ask) });
        report.push({ name: fx.name, run, ok: failures.length === 0, failures, calls: transcript.calls.map((c) => c.name), requests: transcript.requests, reply: transcript.replies.at(-1) ?? '' });
        console.log(`${failures.length ? 'FAIL' : 'PASS'} ${fx.name}${runs > 1 ? ` #${run}` : ''}${failures.length ? `\n     ${failures.join('\n     ')}` : ''}`);
      } catch (err) {
        report.push({ name: fx.name, run, ok: false, failures: [String(err)], calls: [], requests: 0, reply: '' });
        console.log(`ERROR ${fx.name}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
  const passed = report.filter((r) => r.ok).length;
  const perFixture = (report.reduce((n, r) => n + r.requests, 0) / report.length).toFixed(1);
  console.log(
    `\n${passed}/${report.length} passed (${Math.round((100 * passed) / report.length)}%), model ${values.model}${effort ? `, effort ${effort}` : ''}${values.ask ? ', as the Ask chat' : ''}${values['no-instructions'] ? ', without server instructions' : ''}; ${perFixture} model calls per fixture`,
  );
  if (values.out) writeFileSync(values.out, JSON.stringify(report, null, 2));
  process.exit(passed / report.length >= 0.9 ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
