// Turns domain results into the compact text Claude reads (section 4.4/4.5 of the plan).
import type { CollectionOverview } from '../domain/collections.ts';
import type { EntryDetail } from '../domain/entries.ts';
import { describeDef, formatValue, summaryKeys } from '../domain/fields.ts';
import { capitalize, countOf, cut, fmtRating, hasLogNoun, logNoun, plural } from '../domain/format.ts';
import { MARK_CLOSE, MARK_OPEN, type NameHit, type SearchOutcome } from '../domain/search.ts';
import { localDateOf } from '../domain/time.ts';
import type { Refusal, WriteResult } from '../domain/types.ts';
import type { SqlResult } from '../sql/run.ts';

export const READ_BUDGET = 8000;
export const SQL_BUDGET = 16000;

export function formatWrite(r: WriteResult | Refusal | { ok: false; text: string }): string {
  if (!r.ok) return r.text;
  return [r.summary, ...r.extra].join('\n');
}

export function formatCollections(list: CollectionOverview[], today: string, tz: string, actorName: string): string {
  const lines = [`Today: ${today} (${tz}). Acting for: ${actorName}.`];
  if (list.length === 0) {
    lines.push(
      'No collections yet. When the user saves their first thing, create_collection with a broad name (Restaurants, Movies, Books, Gift ideas).',
    );
    return lines.join('\n');
  }
  const slugCounts = new Map<string, number>();
  for (const o of list) slugCounts.set(o.collection.slug, (slugCounts.get(o.collection.slug) ?? 0) + 1);
  for (const { collection: c, entryCount, topTags } of list) {
    const head = [slugCounts.get(c.slug)! > 1 ? `${c.slug} (id ${c.id})` : c.slug, c.name];
    if (c.visibility === 'private') head.push('private');
    if (c.display.checklist) head.push('checklist: add an item with create_entry (title only), tick it with update_entry fields {done: true}, adding a ticked item again unticks it');
    if (c.sensitive) head.push('sensitive: search shows titles only, get_entry shows details, not in query_sql');
    head.push(countOf(entryCount, 'entry') + (hasLogNoun(c) ? `, logs are ${plural(logNoun(c), 2)}` : ''));
    head.push(c.description);
    lines.push(head.join(' | '));
    const defs = c.fields.filter((d) => !d.hidden);
    if (defs.length) {
      lines.push(`  fields: ${defs.map((d) => describeDef(d) + (d.description ? ` "${d.description}"` : '')).join(', ')}`);
    }
    if (topTags.length) lines.push(`  tags: ${topTags.map((t) => `${t.tag} ${t.n}`).join(', ')}`);
  }
  return lines.join('\n');
}

function stripMarks(s: string): string {
  return s.replaceAll(MARK_OPEN, '').replaceAll(MARK_CLOSE, '');
}

export function formatSearch(res: SearchOutcome): string {
  const noun = res.total === 1 ? 'match' : 'matches';
  if (res.total === 0) {
    const none = `No matches${res.description ? ` ${res.description}` : ''}.` + (res.description.startsWith('for "') ? ' Nothing saved yet matches those words.' : '');
    // A misheard or misspelt name: say what is saved under a similar one, so no second search is needed.
    return res.closest?.length ? `${none}\nClosest names: ${res.closest.map((n) => `#${n.id} ${n.title} (${n.collection})`).join('; ')}` : none;
  }
  const lines: string[] = [];
  if (res.partial) lines.push('No exact matches; showing partial matches.');
  lines.push(`${res.total} ${noun}${res.description ? ` ${res.description}` : ''}:`);
  let size = lines.join('\n').length;
  let shown = 0;
  for (const h of res.hits) {
    const c = h.collection;
    if (c.sensitive) {
      // Findable by any word in it, but nothing from inside it is shown until the entry is opened on purpose.
      const line = `#${h.id} ${h.title} | ${c.name} | sensitive: call get_entry(${h.id}) for the details`;
      if (size + line.length > READ_BUDGET && shown > 0) break;
      lines.push(line);
      size += line.length + 1;
      shown++;
      continue;
    }
    const parts = [`#${h.id} ${h.title}`, c.name];
    if (h.rating !== null) parts.push(fmtRating(h.rating));
    const fields = JSON.parse(h.fields) as Record<string, unknown>;
    const vals = summaryKeys(c)
      .map((k) => formatValue(fields[k] as never))
      .filter(Boolean);
    if (vals.length) parts.push(vals.join(', '));
    if (h.log_count) parts.push(`${countOf(h.log_count, logNoun(c))}, last ${h.last_logged_on}`);
    const tags = JSON.parse(h.tags) as string[];
    if (tags.length) parts.push(`tags: ${tags.join(', ')}`);
    const block = [parts.join(' | ')];
    if (h.rangeLogs) {
      for (const l of h.rangeLogs) {
        const words = l.raw_text ? `"${cut(l.raw_text, 300)}"` : cut(l.note, 300);
        block.push(`   ${l.occurred_on} (${l.user_name})${l.rating !== null ? ` ${fmtRating(l.rating)}` : ''}${words ? `: ${words}` : ''}`);
      }
    } else if (h.snippet) {
      const snip = stripMarks(h.snippet).trim();
      if (snip && snip !== h.title) block.push(`   match: ${cut(snip, 300)}`);
    }
    const text = block.join('\n');
    if (size + text.length > READ_BUDGET && shown > 0) break;
    lines.push(text);
    size += text.length + 1;
    shown++;
  }
  if (shown < res.total) {
    lines.push(`(showing ${shown} of ${res.total}; narrow the search, or use query_sql for counts and rankings)`);
  }
  return lines.join('\n');
}

export function formatEntry(d: EntryDetail, tz: string, fullText: boolean, webUrl?: string, related: NameHit[] = []): string {
  const max = fullText ? Number.MAX_SAFE_INTEGER : 600;
  const e = d.entry;
  const c = d.collection;
  const lines: string[] = [];
  if (d.note) lines.push(d.note);
  const head = [`#${e.id} ${e.title}`, c.name];
  if (e.rating !== null) head.push(`overall ${fmtRating(e.rating)}${e.rating_override !== null ? ' (set manually)' : ''}`);
  if (d.tags.length) head.push(`tags: ${d.tags.join(', ')}`);
  if (e.deleted_at) head.push('DELETED');
  lines.push(head.join(' | '));
  const known = c.fields.map((f) => f.key);
  const keys = [...known.filter((k) => k in d.fields), ...Object.keys(d.fields).filter((k) => !known.includes(k))];
  if (keys.length) lines.push(`Fields: ${keys.map((k) => `${k} ${formatValue(d.fields[k])}`).join('; ')}`);
  if (e.notes) lines.push(`Notes: ${cut(e.notes, max)}`);
  let added = `Added ${localDateOf(e.created_at, tz)} by ${d.addedBy}${d.addedVia ? ` ${d.addedVia}` : ''}.`;
  if (e.source_text) added += ` Originally said: "${cut(e.source_text, max)}"`;
  lines.push(added);
  if (d.mergedFrom.length) lines.push(`Merged from: ${d.mergedFrom.map((m) => `#${m.id} ${m.title}`).join(', ')}`);
  if (d.photos.length) {
    lines.push(`Photos: ${d.photos.length} attached${webUrl ? `. The user can see them at ${webUrl}/e/${e.id}` : ''} (you can't view them from here).`);
  }
  if (related.length) lines.push(`Related by name: ${related.map((n) => `#${n.id} ${n.title} (${n.collection})`).join('; ')}`);
  if (c.sensitive) lines.push('This is from a sensitive collection: share only what the user asked for.');
  const noun = logNoun(c);
  if (e.log_count === 0) {
    lines.push(`No ${plural(noun, 2)} yet.`);
    return lines.join('\n');
  }
  lines.push(`${capitalize(plural(noun, 2))} (${e.log_count}, newest first):`);
  let size = lines.join('\n').length;
  let lastShown: number | undefined;
  let stoppedEarly = false;
  for (const l of d.logs) {
    const bits = [`[log ${l.id}] ${l.occurred_on}`];
    if (l.rating !== null) bits.push(fmtRating(l.rating));
    bits.push(l.user_name);
    const block = [`  ${bits.join(', ')}${l.note ? `: ${cut(l.note, max)}` : ''}`];
    if (l.raw_text && l.raw_text !== e.source_text) block.push(`     said: "${cut(l.raw_text, max)}"`);
    const text = block.join('\n');
    if (size + text.length > READ_BUDGET && lastShown !== undefined) {
      stoppedEarly = true;
      break;
    }
    lines.push(text);
    size += text.length + 1;
    lastShown = l.id;
  }
  if ((d.hasMore || stoppedEarly) && lastShown !== undefined) {
    lines.push(`Older ${plural(noun, 2)} not shown: call get_entry with before_log_id: ${lastShown}.`);
  }
  return lines.join('\n');
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  const flat = s.replace(/\s*\n\s*/g, ' / ').replace(/\|/g, '/');
  return flat.length > 300 ? flat.slice(0, 300) + '…' : flat;
}

export function formatSql(r: SqlResult): string {
  if (r.columns.length === 0) return '(no columns)';
  const lines = [r.columns.join(' | ')];
  let size = lines[0].length;
  let shown = 0;
  for (const row of r.rows) {
    const line = row.map(cell).join(' | ');
    if (size + line.length > SQL_BUDGET) break;
    lines.push(line);
    size += line.length + 1;
    shown++;
  }
  if (r.rows.length === 0) lines.push('(no rows)');
  if (shown < r.rows.length) lines.push(`(output cut at ${shown} rows to stay compact)`);
  else if (r.truncated) lines.push(`(truncated at ${r.rows.length} rows)`);
  return lines.join('\n');
}
