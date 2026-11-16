import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { AuthInfo } from '@modelcontextprotocol/server';
import { createMcpEndpoint, instructions } from '../src/mcp/server.ts';
import { setupDb, TZ, type TestEnv } from './helpers.ts';

let env: TestEnv;
let handler: ReturnType<typeof createMcpEndpoint>;

before(() => {
  env = setupDb();
  handler = createMcpEndpoint({ db: env.db, dbPath: env.dbPath, tz: TZ, householdNames: () => ['Alex', 'Sam'] });
});
after(async () => {
  await handler.close();
  env.cleanup();
});

function authFor(who: 'alex' | 'sam'): AuthInfo {
  return { token: `test-${who}`, clientId: 'https://claude.ai/test', scopes: ['tracker'], extra: { userId: env[who].actor.userId, clientName: 'test' } };
}

async function connect(who: 'alex' | 'sam', mode: 'legacy' | 'auto' = 'legacy') {
  const authInfo = authFor(who);
  const transport = new StreamableHTTPClientTransport(new URL('http://tracker.test/mcp'), {
    fetch: (url, init) => handler.fetch(new Request(url, init), { authInfo }),
  });
  const client = new Client({ name: 'test', version: '1' }, { versionNegotiation: { mode } });
  await client.connect(transport);
  return client;
}

function textOf(r: Awaited<ReturnType<Client['callTool']>>): string {
  const c = (r as { content: { type: string; text: string }[] }).content;
  return c.map((x) => x.text).join('\n');
}

describe('MCP server', () => {
  test('tools, annotations and instructions (legacy era)', async () => {
    const client = await connect('alex');
    const { tools } = await client.listTools();
    assert.equal(tools.length, 13);
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const name of ['list_collections', 'search_entries', 'create_entry', 'add_log']) {
      assert.equal((byName.get(name)!._meta as Record<string, unknown>)['anthropic/alwaysLoad'], true, name);
    }
    assert.equal(byName.get('get_entry')!._meta?.['anthropic/alwaysLoad'], undefined);
    assert.equal(byName.get('search_entries')!.annotations?.readOnlyHint, true);
    assert.equal(byName.get('create_entry')!.annotations?.destructiveHint, false);
    assert.equal(byName.get('delete_item')!.annotations?.destructiveHint, true);
    for (const t of tools) assert.equal(t.annotations?.openWorldHint, false);
    const schema = byName.get('create_entry')!.inputSchema as { required?: string[] };
    assert.deepEqual(schema.required?.sort(), ['collection', 'raw_text', 'title']);
    const instr = client.getInstructions() ?? '';
    assert.match(instr, /shared household memory for Alex and Sam/);
    for (const t of tools) assert.ok((t.description ?? '').length < 4096, t.name);
    await client.close();
  });

  test('the full save and recall flow, modern era', async () => {
    const client = await connect('alex', 'auto');
    const list0 = textOf(await client.callTool({ name: 'list_collections', arguments: {} }));
    assert.match(list0, /^Today: \d{4}-\d{2}-\d{2} \(America\/Denver\)\. Acting for: Alex\.\nNo collections yet\./);

    const created = textOf(
      await client.callTool({
        name: 'create_collection',
        arguments: {
          name: 'Restaurants',
          description: "Places we've eaten or want to try.",
          fields: [
            { key: 'cuisine', type: 'text' },
            { key: 'status', type: 'enum', options: ['want_to_try', 'been'] },
          ],
          display: { log_noun: 'visit' },
          raw_text: 'we went to that new pho place tonight',
        },
      }),
    );
    assert.match(created, /^Created collection Restaurants \(shared\)/);

    const saved = await client.callTool({
      name: 'create_entry',
      arguments: {
        collection: 'restaurants',
        title: 'Pho 54',
        fields: { cuisine: 'Vietnamese', status: 'been' },
        log: { note: 'Loved the brisket pho; service was slow.', rating: 4 },
        raw_text: 'we went to that new pho place tonight, loved the brisket pho, service was slow, 4 out of 5',
      },
    });
    assert.equal(saved.isError, undefined);
    assert.match(textOf(saved), /^Saved "Pho 54" to Restaurants: 4\/5, visit on .+\. \(#1\)$/);

    const dup = await client.callTool({ name: 'create_entry', arguments: { collection: 'restaurants', title: 'Pho 54', raw_text: 'pho 54 again' } });
    assert.notEqual(dup.isError, true);
    assert.match(textOf(dup), /^NOT SAVED: possible duplicate in Restaurants\./);

    const bad = await client.callTool({ name: 'create_entry', arguments: { collection: 'resturants', title: 'X', raw_text: 'x' } });
    assert.equal(bad.isError, true);
    assert.match(textOf(bad), /Did you mean "restaurants"\?/);

    const missingRaw = await client.callTool({ name: 'create_entry', arguments: { collection: 'restaurants', title: 'X' } });
    assert.equal(missingRaw.isError, true);

    const found = textOf(await client.callTool({ name: 'search_entries', arguments: { query: 'pho' } }));
    assert.match(found, /^1 match for "pho":\n#1 Pho 54 \| Restaurants \| 4\/5 \| Vietnamese, been \| 1 visit, last \d{4}-\d{2}-\d{2}/);

    const detail = textOf(await client.callTool({ name: 'get_entry', arguments: { entry_id: 1 } }));
    assert.match(detail, /^#1 Pho 54 \| Restaurants \| overall 4\/5/m);
    assert.match(detail, /Originally said: "we went to that new pho place tonight/);
    assert.match(detail, /Visits \(1, newest first\):\n  \[log 1\] .+, 4\/5, Alex: Loved the brisket pho; service was slow\./);

    const sql = textOf(await client.callTool({ name: 'query_sql', arguments: { sql: 'SELECT title, rating FROM entries' } }));
    assert.equal(sql, 'title | rating\nPho 54 | 4');
    await client.close();
  });

  test('Sam logs a visit; undo is per person', async () => {
    const sam = await connect('sam');
    const logged = textOf(await sam.callTool({ name: 'add_log', arguments: { entry_id: 1, rating: 3, note: 'broth was bland', raw_text: 'pho 54 was meh this time, 3' } }));
    assert.match(logged, /^Logged a visit to "Pho 54" on .+: 3\/5 \(overall now 3\/5, was 4\/5\)\. \(#1\)$/);
    const list = textOf(await sam.callTool({ name: 'list_collections', arguments: {} }));
    assert.match(list, /Acting for: Sam\./);
    assert.match(list, /restaurants \| Restaurants \| 1 entry, logs are visits \| Places we've eaten or want to try\./);
    const undo = textOf(await sam.callTool({ name: 'undo_last_change', arguments: { raw_text: 'undo that' } }));
    assert.match(undo, /^Undid: Logged a visit to "Pho 54"/);
    const none = textOf(await sam.callTool({ name: 'undo_last_change', arguments: { raw_text: 'undo' } }));
    assert.match(none, /^Nothing to undo/);
    await sam.close();
  });
});

test('the instructions Claude reads stay under 3,000 characters', () => {
  assert.ok(instructions(['Alex', 'Sam']).length < 3000);
});
