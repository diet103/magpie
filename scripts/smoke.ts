// End-to-end smoke test against a running tracker, without Claude (plan 10.4).
//   npm run smoke -- --url http://localhost:8787/mcp --token $PAT [--token2 $SAM_PAT] [--purge local]
//   npm run smoke -- --url https://tracker.example.com/mcp --token $PAT --token2 $PAT2 --purge fly
//   npm run smoke -- --url https://tracker.example.com/mcp --oauth      (browser sign-in, like Claude Code)
// Everything goes into a private scratch collection zz-smoke-<timestamp>; --purge removes it at the end.
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseArgs } from 'node:util';
import { Client, StreamableHTTPClientTransport, UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/client';

const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    token: { type: 'string' },
    token2: { type: 'string' },
    oauth: { type: 'boolean' },
    purge: { type: 'string' },
    json: { type: 'boolean' },
    tz: { type: 'string', default: process.env.HOUSEHOLD_TZ ?? 'UTC' },
  },
});
if (!values.url || (!values.token && !values.oauth)) {
  console.error('Usage: npm run smoke -- --url <https://host/mcp> (--token <PAT> | --oauth) [--token2 <other PAT>] [--purge local|fly] [--tz <HOUSEHOLD_TZ of the server, default UTC>] [--json]');
  process.exit(2);
}
const url = new URL(values.url);
const results: { step: string; ok: boolean; ms: number; detail?: string }[] = [];
const stamp = Date.now().toString(36);
const slug = `zz-smoke-${stamp}`;

async function step(name: string, fn: () => Promise<string | void>) {
  const t = Date.now();
  try {
    const detail = (await fn()) ?? undefined;
    results.push({ step: name, ok: true, ms: Date.now() - t, detail });
    if (!values.json) console.log(`PASS ${name} (${Date.now() - t} ms)${detail ? ` ${detail}` : ''}`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    results.push({ step: name, ok: false, ms: Date.now() - t, detail });
    if (!values.json) console.log(`FAIL ${name} (${Date.now() - t} ms): ${detail}`);
  }
}

function check(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

type CallResult = { text: string; isError: boolean };
function wrap(client: Client) {
  return async (name: string, args: Record<string, unknown>): Promise<CallResult> => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { type: string; text?: string }[]; isError?: boolean };
    return { text: r.content.map((c) => c.text ?? '').join('\n'), isError: Boolean(r.isError) };
  };
}

async function connectWithToken(token: string) {
  const client = new Client({ name: 'tracker-smoke', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}

async function connectWithOAuth(): Promise<Client> {
  const callback = createServer();
  await new Promise<void>((r) => callback.listen(0, '127.0.0.1', r));
  const port = (callback.address() as AddressInfo).port;
  const redirect = `http://127.0.0.1:${port}/callback`;
  const saved: { tokens?: unknown; verifier?: string; client?: unknown } = {};
  let authUrl: URL | undefined;
  const provider: OAuthClientProvider = {
    get redirectUrl() {
      return redirect;
    },
    clientMetadataUrl: 'https://claude.ai/oauth/claude-code-client-metadata',
    get clientMetadata() {
      return { client_name: 'Tracker smoke test', redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' };
    },
    clientInformation: () => saved.client as never,
    saveClientInformation: (c) => {
      saved.client = c;
    },
    tokens: () => saved.tokens as never,
    saveTokens: (t) => {
      saved.tokens = t;
    },
    redirectToAuthorization: (u) => {
      authUrl = u;
    },
    saveCodeVerifier: (v) => {
      saved.verifier = v;
    },
    codeVerifier: () => saved.verifier!,
  };
  const transport = new StreamableHTTPClientTransport(url, { authProvider: provider });
  try {
    await new Client({ name: 'tracker-smoke', version: '1' }).connect(transport);
  } catch (err) {
    if (!(err instanceof UnauthorizedError) || !authUrl) throw err;
  }
  console.log(`\nOpen this URL in your browser and sign in:\n\n${authUrl}\n`);
  const params = await new Promise<URLSearchParams>((resolve) => {
    callback.on('request', (req, res) => {
      const u = new URL(req.url ?? '/', redirect);
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('Signed in. You can close this tab and go back to the terminal.');
      if (u.pathname === '/callback') resolve(u.searchParams);
    });
  });
  callback.close();
  if (params.get('error')) throw new Error(`Authorization failed: ${params.get('error')} ${params.get('error_description') ?? ''}`);
  await transport.finishAuth(params);
  const client = new Client({ name: 'tracker-smoke', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(url, { authProvider: provider }));
  return client;
}

const today = new Intl.DateTimeFormat('en-CA', { timeZone: values.tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

await step('401 without a token, and with a bad one', async () => {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  check(res.status === 401, `expected 401, got ${res.status}`);
  check(/resource_metadata="[^"]+\/\.well-known\/oauth-protected-resource\/mcp"/.test(res.headers.get('www-authenticate') ?? ''), 'missing WWW-Authenticate resource_metadata');
  const bad = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer tma_at_bogus' }, body: '{}' });
  check(bad.status === 401, `bad token: expected 401, got ${bad.status}`);
});

let client: Client;
try {
  client = values.oauth ? await connectWithOAuth() : await connectWithToken(values.token!);
} catch (err) {
  console.error(`Couldn't connect: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
const call = wrap(client);
let firstId = 0;
let secondId = 0;

await step('instructions and the 13 tools', async () => {
  const instr = client.getInstructions() ?? '';
  check(instr.length > 200 && instr.length < 3000, `instructions length ${instr.length}`);
  const { tools } = await client.listTools();
  check(tools.length === 13, `expected 13 tools, got ${tools.length}`);
  for (const t of tools) {
    check(t.title && t.annotations && (t.description ?? '').length < 4096, `tool ${t.name} lacks title/annotations or is too long`);
  }
});

await step("list_collections shows today's date", async () => {
  const r = await call('list_collections', {});
  check(r.text.startsWith(`Today: ${today} (${values.tz}).`), r.text.split('\n')[0]);
});

await step('create_collection (private scratch) and the look-alike refusal', async () => {
  const r = await call('create_collection', {
    name: slug,
    slug,
    description: 'Smoke test scratch collection. Safe to delete.',
    fields: [
      { key: 'cuisine', type: 'text' },
      { key: 'status', type: 'enum', options: ['want_to_try', 'been'] },
    ],
    private: true,
    confirm_new: true,
    raw_text: 'smoke test',
  });
  check(!r.isError && r.text.startsWith('Created collection'), r.text);
  const like = await call('create_collection', { name: `${slug} list`, description: 'x', fields: [], private: true, raw_text: 'smoke' });
  check(like.text.startsWith('NOT CREATED') && like.text.includes('zz-smoke-'), like.text);
});

await step('create_entry with a log, one-line confirmation', async () => {
  const r = await call('create_entry', { collection: slug, title: 'Pho Smoke 54', fields: { cuisine: 'Vietnamese' }, log: { rating: 4, note: 'brisket pho' }, raw_text: 'we went to pho smoke 54 tonight, loved the brisket, 4 out of 5' });
  check(!r.isError && /^Saved "Pho Smoke 54" to .+\(#(\d+)\)$/.test(r.text.split('\n')[0]), r.text);
  firstId = Number(/\(#(\d+)\)/.exec(r.text)![1]);
  check(r.text.split('\n')[0].length < 140, 'confirmation longer than 140 chars');
});

await step('duplicate guard answers NOT SAVED with the first id', async () => {
  const r = await call('create_entry', { collection: slug, title: 'pho smoke 54!', raw_text: 'pho smoke 54 again' });
  check(!r.isError && r.text.startsWith('NOT SAVED') && r.text.includes(`#${firstId}`), r.text);
});

await step('add_log updates the overall rating; the replay is recognized', async () => {
  const args = { entry_id: firstId, rating: 3, set_fields: { status: 'been' }, raw_text: 'went back to pho smoke 54, only a 3 this time' };
  const r = await call('add_log', args);
  check(!r.isError && /overall now 3\/5, was 4\/5/.test(r.text), r.text);
  const again = await call('add_log', args);
  check(again.text.startsWith('Already logged'), again.text);
  const d = await call('get_entry', { entry_id: firstId });
  check(/Logs \(2, newest first\)/.test(d.text), d.text);
});

await step('search: keywords, rating filter, date range with original words, accents and stemming', async () => {
  check((await call('search_entries', { query: 'pho smoke', collection: slug })).text.includes(`#${firstId}`), 'keyword search missed');
  check((await call('search_entries', { query: 'smoke', collection: slug, min_rating: 4 })).text.startsWith('No matches'), 'min_rating 4 should find nothing');
  const ranged = await call('search_entries', { collection: slug, logged_from: today, logged_to: today });
  check(ranged.text.includes('only a 3 this time'), ranged.text);
  check((await call('search_entries', { query: 'phở smoked', collection: slug })).text.includes(`#${firstId}`), 'accents/stemming failed');
});

await step('get_entry: two logs, newest first, original words', async () => {
  const d = await call('get_entry', { entry_id: firstId });
  const logs = [...d.text.matchAll(/\[log (\d+)\]/g)].map((m) => Number(m[1]));
  check(logs.length === 2 && logs[0] > logs[1], d.text);
  check(d.text.includes('Originally said: "we went to pho smoke 54 tonight'), d.text);
});

await step('drift guards: field typo refused, tag mapped', async () => {
  const typo = await call('update_entry', { entry_id: firstId, fields: { cuisne: 'Thai' }, raw_text: 'smoke' });
  check(typo.isError && /Did you mean `cuisine`\?/.test(typo.text), typo.text);
  const ok = await call('update_entry', { entry_id: firstId, fields: { cuisine: 'Thai' }, add_tags: ['smoke-tag'], raw_text: 'smoke' });
  check(!ok.isError, ok.text);
  const mapped = await call('update_entry', { entry_id: firstId, add_tags: ['smoketags'], raw_text: 'smoke' });
  check(/saved as the existing tag "smoke-tag"|Nothing to change/.test(mapped.text), mapped.text);
});

await step('query_sql: count, refusals, timeout, still responsive', async () => {
  const count = await call('query_sql', { sql: `SELECT count(*) AS n FROM entries WHERE collection = '${slug}'` });
  check(count.text === 'n\n1', count.text);
  for (const bad of ['DELETE FROM entries', 'PRAGMA database_list', "ATTACH DATABASE '/data/auth.db' AS a", 'SELECT 1; SELECT 2']) {
    const r = await call('query_sql', { sql: bad });
    check(r.isError, `not refused: ${bad}`);
  }
  const t = Date.now();
  const slow = await call('query_sql', { sql: 'WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n) SELECT count(*) FROM n' });
  check(slow.isError && Date.now() - t < 3500, `runaway query: ${Date.now() - t} ms, ${slow.text}`);
  check(!(await call('list_collections', {})).isError, 'server unresponsive after the runaway query');
});

await step('merge_entries moves logs; the duplicate leaves search', async () => {
  const r = await call('create_entry', { collection: slug, title: 'Smoke Noodle Bar', log: { rating: 5 }, raw_text: 'smoke noodle bar was great' });
  secondId = Number(/\(#(\d+)\)/.exec(r.text)?.[1] ?? 0);
  check(secondId > 0, r.text);
  const m = await call('merge_entries', { keep_id: firstId, duplicate_id: secondId, raw_text: 'those are the same place' });
  check(!m.isError && /1 log moved/.test(m.text), m.text);
  const s = await call('search_entries', { query: 'noodle', collection: slug });
  check(s.text.includes(`#${firstId}`) && !s.text.includes(`#${secondId} `), s.text);
});

await step('delete a log, undo, then undo the merge', async () => {
  const d = await call('get_entry', { entry_id: firstId });
  const logId = Number(/\[log (\d+)\]/.exec(d.text)![1]);
  check(!(await call('delete_item', { log_id: logId, raw_text: 'remove that' })).isError, 'delete failed');
  const u1 = await call('undo_last_change', { raw_text: 'undo that' });
  check(u1.text.startsWith('Undid: Deleted the'), u1.text);
  const u2 = await call('undo_last_change', { raw_text: 'undo' });
  check(u2.text.startsWith('Undid: Merged'), u2.text);
});

if (values.token2) {
  await step("privacy: the other person can't see the scratch collection", async () => {
    const other = await connectWithToken(values.token2!);
    const c2 = wrap(other);
    check(!(await c2('list_collections', {})).text.includes(slug), 'list_collections leaks');
    check((await c2('search_entries', { query: 'pho smoke' })).text.startsWith('No matches'), 'search leaks');
    check((await c2('query_sql', { sql: `SELECT count(*) AS n FROM entries WHERE title LIKE '%Smoke%'` })).text === 'n\n0', 'query_sql leaks');
    const g = await c2('get_entry', { entry_id: firstId });
    check(g.isError && g.text === `No entry #${firstId}.`, g.text);
    await other.close();
  });
}

await step('cleanup', async () => {
  for (const id of [firstId, secondId]) if (id) await call('delete_item', { entry_id: id, raw_text: 'smoke cleanup' });
  if (!values.purge) return `left ${slug} (private, empty) behind; remove it with: node src/cli.ts purge-smoke`;
  const cmd =
    values.purge === 'fly'
      ? spawnSync('fly', ['ssh', 'console', '-C', 'node src/cli.ts purge-smoke'], { encoding: 'utf8' })
      : spawnSync(process.execPath, ['--env-file-if-exists=.env', 'src/cli.ts', 'purge-smoke'], { encoding: 'utf8' });
  check(cmd.status === 0, `purge failed: ${cmd.stderr || cmd.stdout}`);
  const left = await call('list_collections', {});
  check(!left.text.includes('zz-smoke-'), 'scratch collection still listed');
});

await client.close();
const failed = results.filter((r) => !r.ok);
if (values.json) console.log(JSON.stringify({ ok: failed.length === 0, results }, null, 2));
else console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
