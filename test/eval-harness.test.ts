import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { expandDates, loadFixtures, runFixture, type ModelFn } from '../scripts/eval.ts';
import { addDays, todayIn } from '../src/domain/time.ts';

/** A scripted stand-in for the model: each step is either tool calls or a final reply. */
function scripted(steps: ({ tools: { name: string; input: Record<string, unknown> }[] } | { reply: string })[]): ModelFn & { seen: unknown[] } {
  let i = 0;
  const seen: unknown[] = [];
  const fn = (async (req) => {
    seen.push(req.messages[req.messages.length - 1]);
    const s = steps[i++] ?? { reply: 'done' };
    if ('reply' in s) return { content: [{ type: 'text', text: s.reply }], stop_reason: 'end_turn' };
    return { content: s.tools.map((t, j) => ({ type: 'tool_use', id: `tu_${i}_${j}`, name: t.name, input: t.input })), stop_reason: 'tool_use' };
  }) as ModelFn & { seen: unknown[] };
  fn.seen = seen;
  return fn;
}

describe('eval harness', () => {
  const fixtures = loadFixtures();
  const repeat = fixtures.find((f) => f.name.startsWith('repeat visit'))!;

  test('a correct run scores clean, and tool results flow back to the model', async () => {
    const model = scripted([
      { tools: [{ name: 'list_collections', input: {} }] },
      { tools: [{ name: 'search_entries', input: { query: 'pho 54' } }] },
      { tools: [{ name: 'add_log', input: { entry_id: 1, rating: 4, note: 'Broth was better.', raw_text: 'we went back to pho 54 tonight, broth was better this time, 4 stars' } }] },
      { reply: 'Logged a visit to Pho 54 tonight: 4/5.' },
    ]);
    const { transcript, failures } = await runFixture(repeat, model, { instructions: true, verbose: false });
    assert.deepEqual(failures, []);
    assert.deepEqual(transcript.calls.map((c) => c.name), ['list_collections', 'search_entries', 'add_log']);
    const lastToolResult = model.seen[3] as { content: { type: string; content: string }[] };
    assert.equal(lastToolResult.content[0].type, 'tool_result');
    assert.match(lastToolResult.content[0].content, /^Logged a visit to "Pho 54"/);
  });

  test('a wrong run is caught', async () => {
    const model = scripted([
      { tools: [{ name: 'create_entry', input: { collection: 'restaurants', title: 'Pho 54', raw_text: 'pho again', not_duplicate_of: [1] } }] },
      { reply: 'Saved Pho 54. Anything else you want to add?' },
    ]);
    const { failures } = await runFixture(repeat, model, { instructions: true, verbose: false });
    assert.ok(failures.some((f) => f.includes('expected calls add_log')));
    assert.ok(failures.some((f) => f === 'should not call create_entry'));
    assert.ok(failures.some((f) => f.includes("SQL SELECT count(*) FROM entries WHERE title_key LIKE 'pho 54%'")));
  });

  test('date placeholders', () => {
    const today = todayIn('America/Denver');
    assert.equal(expandDates('{{today}}', today), today);
    assert.equal(expandDates('{{today-1}}', today), addDays(today, -1));
    const fri = expandDates('{{last:fri}}', today);
    assert.equal(new Date(`${fri}T12:00:00Z`).getUTCDay(), 5);
    assert.ok(fri < today && fri >= addDays(today, -7));
  });
});
