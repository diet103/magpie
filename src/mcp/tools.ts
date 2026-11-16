import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { realNewlines } from '../domain/text.ts';
import * as z from 'zod';
import { collectionsOverview, createCollection, updateCollection } from '../domain/collections.ts';
import { addLog, createEntry, deleteItem, getEntryDetail, mergeEntries, updateEntry, updateLog } from '../domain/entries.ts';
import { UserError } from '../domain/errors.ts';
import { relatedEntries, searchEntries } from '../domain/search.ts';
import { todayIn } from '../domain/time.ts';
import type { Ctx } from '../domain/types.ts';
import { undoLastChange } from '../domain/undo.ts';
import { errorFields, log } from '../log.ts';
import { runQuerySql } from '../sql/run.ts';
import { formatCollections, formatEntry, formatSearch, formatSql, formatWrite } from './format.ts';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');
const rating = z.number().min(0).max(5);
const fieldValue = z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]);
const rawText = z.string().min(1).max(4000).describe("The user's own words about this item, verbatim.");
const displaySchema = z.object({
  list_columns: z.array(z.string()).max(6).optional(),
  default_sort: z.object({ by: z.string(), dir: z.enum(['asc', 'desc']) }).optional(),
  subtitle: z.string().optional(),
  log_noun: z.string().max(20).optional().describe('What a log is called here: visit, viewing, read...'),
  filters: z.array(z.string()).max(4).optional(),
});
const fieldDef = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
  type: z.enum(['text', 'number', 'date', 'url', 'enum', 'list', 'boolean']),
  label: z.string().max(60).optional(),
  options: z.array(z.string().max(40)).max(20).optional().describe('Required for enum.'),
  description: z.string().max(200).optional(),
});

export interface ToolDeps {
  ctx: Ctx;
  dbPath: string;
  webUrl?: string;
}

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
const ALWAYS = { 'anthropic/alwaysLoad': true };

function text(t: string, isError = false): CallToolResult {
  return isError ? { content: [{ type: 'text', text: t }], isError: true } : { content: [{ type: 'text', text: t }] };
}

/** Runs a tool body: UserErrors become isError results with their message; anything else is logged. */
async function run(name: string, deps: ToolDeps, body: () => string | Promise<string>): Promise<CallToolResult> {
  const started = Date.now();
  try {
    const out = await body();
    log.info('tool', { tool: name, user: deps.ctx.actor.userId, ms: Date.now() - started, ok: true });
    return text(out);
  } catch (err) {
    if (err instanceof UserError) {
      log.info('tool', { tool: name, user: deps.ctx.actor.userId, ms: Date.now() - started, ok: false });
      return text(err.message, true);
    }
    log.error('tool failed', { tool: name, user: deps.ctx.actor.userId, ...errorFields(err) });
    return text('Something went wrong on the tracker server, and nothing was changed. Try again in a moment.', true);
  }
}

export function registerTools(server: McpServer, deps: ToolDeps) {
  const { ctx } = deps;

  server.registerTool(
    'list_collections',
    {
      title: 'List collections',
      description:
        "Start here. Lists every collection this user can see (slug, name, what belongs in it, fields with types and allowed values, common tags, entry count, private or shared), plus today's date in the household time zone and who you're acting for. Call once per conversation before saving or searching, then reuse its field keys and tags exactly.",
      inputSchema: z.object({}),
      annotations: READ,
      _meta: ALWAYS,
    },
    () =>
      run('list_collections', deps, () =>
        formatCollections(collectionsOverview(ctx), todayIn(ctx.tz), ctx.tz, ctx.actor.name),
      ),
  );

  server.registerTool(
    'search_entries',
    {
      title: 'Search entries',
      description:
        'Find entries by keywords and/or filters. Use it before saving, to check whether the thing already exists, and to answer questions like "what Thai places have we liked?" (query: thai, collection: restaurants, min_rating: 4) or "what did I say about that taco place last month?" (query: taco, logged_from/logged_to: last month; matching logs and the user\'s original words are included). Keywords match titles, tags, field values, notes, log notes and what the user said; accents and word endings don\'t matter. Returns compact results with ids; call get_entry for the full history.',
      inputSchema: z.object({
        query: z.string().max(200).optional().describe('Plain keywords. Quote a phrase for an exact match.'),
        collection: z.string().optional().describe('Collection slug from list_collections.'),
        tags: z.array(z.string()).max(10).optional().describe('Entries must have all of these tags.'),
        min_rating: rating.optional(),
        max_rating: rating.optional(),
        fields: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe('Exact field matches, e.g. {"status": "want_to_try"}.'),
        logged_from: isoDate.optional().describe('Only entries with a log on or after this date (YYYY-MM-DD).'),
        logged_to: isoDate.optional(),
        added_from: isoDate.optional().describe('Only entries added on or after this date.'),
        added_to: isoDate.optional(),
        added_by: z.string().optional().describe("A person's name. Omit for the whole household."),
        sort: z
          .enum(['relevance', 'rating', 'last_logged', 'added', 'title'])
          .optional()
          .describe('Default: relevance with a query, otherwise last_logged.'),
        limit: z.number().int().min(1).max(50).default(10),
      }),
      annotations: READ,
      _meta: ALWAYS,
    },
    (args) => run('search_entries', deps, () => formatSearch(searchEntries(ctx, args))),
  );

  server.registerTool(
    'get_entry',
    {
      title: 'Get entry',
      description:
        'Full details of one entry: fields, tags, overall rating, notes, every dated log (newest first) with its rating, who logged it and the user\'s original words, and who added the entry and when. Use it to answer detailed questions and before editing. Log ids shown here are what update_log and delete_item take.',
      inputSchema: z.object({
        entry_id: z.number().int(),
        log_limit: z.number().int().min(1).max(100).default(20),
        before_log_id: z.number().int().optional().describe('For older logs: the last log id from the previous page.'),
        full_text: z.boolean().default(false).describe('Return long notes and original words in full instead of cut at 600 chars.'),
      }),
      annotations: READ,
    },
    (args) =>
      run('get_entry', deps, () => {
        const d = getEntryDetail(ctx, args.entry_id, { logLimit: args.log_limit, beforeLogId: args.before_log_id });
        return formatEntry(d, ctx.tz, args.full_text, deps.webUrl, relatedEntries(ctx, d.entry));
      }),
  );

  server.registerTool(
    'create_entry',
    {
      title: 'Create entry',
      description:
        'Create a NEW entry. Only use it after search_entries found nothing for this thing; a repeat visit, rewatch or reread of something already saved is add_log. If the user describes something that happened (went there, watched it), include log so the occasion is recorded with its date. The server checks for duplicates: if it answers NOT SAVED with candidates, either call add_log on the matching entry or, if this really is a different thing, call create_entry again with not_duplicate_of set to those ids. Pass raw_text every time.',
      inputSchema: z.object({
        collection: z.string().describe('Collection slug from list_collections.'),
        title: z
          .string()
          .min(1)
          .max(200)
          .describe(
            "The thing's proper name, e.g. 'Pho 54' or 'Dune: Part Two', not a sentence. If the user didn't give a name, ask; " +
              "if they can't, use a short description like 'New pho place on Main Street' and add the tag needs-details.",
          ),
        fields: z.record(z.string(), fieldValue).optional().describe("Values for the collection's field keys."),
        rating: rating.optional().describe('Overall rating 0-5 in half steps. Omit it if the only rating is for this occasion (put that in log.rating).'),
        tags: z.array(z.string()).max(20).optional().describe('Lowercase, hyphenated. Reuse tags from list_collections.'),
        notes: z.string().max(4000).transform(realNewlines).optional().describe('Lasting notes about the thing itself, not about one occasion. Markdown is rendered in the app: use short headings, lists and numbered steps when it helps (recipes, instructions, specs).'),
        log: z
          .object({
            occurred_on: isoDate.optional().describe('YYYY-MM-DD. Defaults to today.'),
            note: z.string().max(4000).transform(realNewlines).optional(),
            rating: rating.optional().describe('Rating for this occasion.'),
          })
          .optional()
          .describe('Include when the user describes something that happened.'),
        raw_text: rawText,
        not_duplicate_of: z
          .array(z.number().int())
          .optional()
          .describe('Ids from a NOT SAVED answer that are confirmed to be different things.'),
      }),
      annotations: WRITE,
      _meta: ALWAYS,
    },
    (args) => run('create_entry', deps, () => formatWrite(createEntry(ctx, args))),
  );

  server.registerTool(
    'add_log',
    {
      title: 'Add log',
      description:
        'Record a dated occasion on an EXISTING entry: another visit, rewatch, reread, purchase, or a dated note ("went back to Pho 54, broth was better"). This is how repeat events are stored; never create a second entry for the same thing. rating is for this occasion; the entry\'s overall rating follows the most recent rated occasion unless you pass overall_rating. You can update fields (e.g. status: been) and add tags in the same call. Pass raw_text every time.',
      inputSchema: z.object({
        entry_id: z.number().int(),
        occurred_on: isoDate.optional().describe('YYYY-MM-DD. Defaults to today.'),
        note: z.string().max(4000).transform(realNewlines).optional(),
        rating: rating.optional().describe('Rating for this occasion.'),
        overall_rating: rating.optional().describe("Set only if the user gives an overall rating that differs from this occasion's rating."),
        set_fields: z.record(z.string(), fieldValue.nullable()).optional(),
        add_tags: z.array(z.string()).max(20).optional(),
        raw_text: rawText,
      }),
      annotations: WRITE,
      _meta: ALWAYS,
    },
    (args) => run('add_log', deps, () => formatWrite(addLog(ctx, args))),
  );

  server.registerTool(
    'update_entry',
    {
      title: 'Update entry',
      description:
        'Correct or change an existing entry: title, field values, overall rating, notes, tags, or move it to another collection. Use it for fixes ("actually it was 3 stars", "that\'s a bakery, not a restaurant") and for changes that aren\'t a dated occasion (those are add_log). fields are merged into the existing ones; set a key to null to clear it. Pass raw_text every time.',
      inputSchema: z.object({
        entry_id: z.number().int(),
        title: z.string().min(1).max(200).optional(),
        fields: z.record(z.string(), fieldValue.nullable()).optional(),
        rating: rating.nullable().optional().describe('Overall rating (a manual override). null returns it to following the visits.'),
        notes: z.string().max(4000).transform(realNewlines).optional().describe('Replaces the notes. Markdown is rendered in the app.'),
        append_note: z.string().max(4000).transform(realNewlines).optional().describe('Adds a line to the notes.'),
        add_tags: z.array(z.string()).max(20).optional(),
        remove_tags: z.array(z.string()).max(20).optional(),
        move_to_collection: z.string().optional().describe('Collection slug. Fields the target lacks are kept as extra fields.'),
        raw_text: rawText,
      }),
      annotations: DESTRUCTIVE,
    },
    (args) => run('update_entry', deps, () => formatWrite(updateEntry(ctx, args))),
  );

  server.registerTool(
    'update_log',
    {
      title: 'Update log',
      description: 'Correct one dated log: wrong date, rating or note (log ids come from get_entry). To remove a log, use delete_item.',
      inputSchema: z.object({
        log_id: z.number().int(),
        occurred_on: isoDate.optional(),
        note: z.string().max(4000).transform(realNewlines).optional(),
        rating: rating.nullable().optional(),
        raw_text: rawText,
      }),
      annotations: DESTRUCTIVE,
    },
    (args) => run('update_log', deps, () => formatWrite(updateLog(ctx, args))),
  );

  server.registerTool(
    'delete_item',
    {
      title: 'Delete entry or log',
      description:
        "Delete one entry or one log when the user asks, or to remove something saved by mistake. Soft delete: it disappears from search and lists but can be brought back with undo_last_change or from the web app's Trash. For two entries that are the same thing, use merge_entries instead.",
      inputSchema: z.object({
        entry_id: z.number().int().optional(),
        log_id: z.number().int().optional(),
        raw_text: rawText,
      }),
      annotations: DESTRUCTIVE,
    },
    (args) => run('delete_item', deps, () => formatWrite(deleteItem(ctx, args))),
  );

  server.registerTool(
    'merge_entries',
    {
      title: 'Merge entries',
      description:
        "Merge a duplicate entry into the entry to keep. All logs, tags and original words move over; where both have a value, the kept entry's value wins and the other value is appended to its notes; the duplicate is removed (recoverable). Use it when the user says two entries are the same thing or you find a duplicate.",
      inputSchema: z.object({ keep_id: z.number().int(), duplicate_id: z.number().int(), raw_text: rawText }),
      annotations: DESTRUCTIVE,
    },
    (args) => run('merge_entries', deps, () => formatWrite(mergeEntries(ctx, args))),
  );

  server.registerTool(
    'undo_last_change',
    {
      title: 'Undo last change',
      description:
        'Undo the most recent change made through Claude for this user in the last 24 hours (save, log, edit, move, merge or delete). Use it when the user says "undo that" or "that\'s wrong, remove it" right after a change. Returns what was undone; call again to go further back. Refuses, with the reason, if the entry was changed again since.',
      inputSchema: z.object({ raw_text: rawText }),
      annotations: DESTRUCTIVE,
    },
    (args) => run('undo_last_change', deps, () => formatWrite(undoLastChange(ctx, args.raw_text))),
  );

  server.registerTool(
    'create_collection',
    {
      title: 'Create collection',
      description:
        'Create a collection only when nothing from list_collections fits. Keep it broad (Restaurants, not "Thai restaurants"; use tags and fields for subtypes). Give a one-sentence description of what belongs there (future routing depends on it), 3 to 8 typed fields, and display hints for the web app. Set private: true only when the user wants it hidden from the other person, like gift ideas for them. Set sensitive: true (usually with private: true) for personal documents and IDs. Mention the new collection in your reply. Refused if it looks like an existing collection.\n' +
        'Example: Restaurants, "Places we\'ve eaten or want to try." Fields: cuisine (text), neighborhood (text), price (enum $, $$, $$$, $$$$), status (enum want_to_try, been). Display: list_columns [cuisine, neighborhood, rating, last_logged_on], sort last_logged_on desc, log_noun visit.',
      inputSchema: z.object({
        name: z.string().min(1).max(60),
        description: z.string().min(1).max(300),
        fields: z.array(fieldDef).max(20).default([]),
        display: displaySchema.optional(),
        icon: z.string().max(8).optional().describe('One emoji.'),
        private: z.boolean().default(false),
        sensitive: z
          .boolean()
          .default(false)
          .describe('For personal documents and IDs (license, passport, insurance, account details). Entries stay findable by search, but only titles are shown until get_entry is called.'),
        checklist: z.boolean().optional().describe('A list to tick off (shopping, packing, chores). Needs no fields. Items are entries; tick one with update_entry fields {done: true}.'),
        slug: z.string().optional().describe('Defaults to a slug of the name.'),
        confirm_new: z.boolean().optional().describe('Set only if the user wants it despite a similar existing collection.'),
        raw_text: rawText,
      }),
      annotations: WRITE,
    },
    (args) => run('create_collection', deps, () => formatWrite(createCollection(ctx, args))),
  );

  server.registerTool(
    'update_collection',
    {
      title: 'Update collection',
      description:
        "Change a collection's name, description, icon, fields (add, rename, change options, hide), web display hints, or privacy. Renaming a field key also rewrites existing entries. Only the collection's creator can make it private, and only when every entry in it is theirs.",
      inputSchema: z.object({
        collection: z.string(),
        name: z.string().max(60).optional(),
        description: z.string().max(300).optional(),
        icon: z.string().max(8).optional(),
        add_fields: z.array(fieldDef).max(10).optional(),
        update_fields: z
          .array(
            z.object({
              key: z.string(),
              label: z.string().optional(),
              options: z.array(z.string()).optional(),
              remap: z.record(z.string(), z.string()).optional().describe('When removing enum options: old value to new value.'),
              description: z.string().optional(),
              hidden: z.boolean().optional(),
            }),
          )
          .optional(),
        rename_fields: z.array(z.object({ from: z.string(), to: z.string() })).optional(),
        display: displaySchema.optional(),
        private: z.boolean().optional(),
        sensitive: z.boolean().optional(),
        checklist: z.boolean().optional().describe('Turn checklist mode on or off.'),
        raw_text: rawText,
      }),
      annotations: DESTRUCTIVE,
    },
    (args) => run('update_collection', deps, () => formatWrite(updateCollection(ctx, args))),
  );

  server.registerTool(
    'query_sql',
    {
      title: 'Query with SQL',
      description:
        'Run one read-only SQLite SELECT for counts, rankings and other questions search can\'t answer, such as "how many places did we rate 4 or higher this year?". It runs on a snapshot of only what this user can see:\n' +
        'collections(id, slug, name, description, visibility, fields, created_at)\n' +
        'entries(id, collection, collection_id, title, rating, tags, fields, notes, first_logged_on, last_logged_on, log_count, added_by, created_at, updated_at)\n' +
        'logs(id, entry_id, entry_title, collection, occurred_on, rating, note, raw_text, logged_by, created_at)\n' +
        'entry_tags(entry_id, collection, title, tag)\n' +
        'entry_fields(entry_id, collection, title, field, value)\n' +
        "tags and fields are JSON (json_extract(fields, '$.cuisine')); dates are 'YYYY-MM-DD'; created_at is UTC ISO-8601. Use logs.occurred_on for when something happened and entries.created_at for when it was added. At most 200 rows and 3 seconds.",
      inputSchema: z.object({ sql: z.string().min(1).max(5000), max_rows: z.number().int().min(1).max(200).default(100) }),
      annotations: READ,
    },
    (args) =>
      run('query_sql', deps, async () =>
        formatSql(await runQuerySql({ dbPath: deps.dbPath, userId: ctx.actor.userId, sql: args.sql, maxRows: args.max_rows })),
      ),
  );
}
