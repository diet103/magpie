import { createMcpHandler, McpServer, type AuthInfo, type McpHttpHandler } from '@modelcontextprotocol/server';
import { APP_NAME } from '../brand.ts';
import type { DB } from '../db/sqlite.ts';
import { joinAnd } from '../domain/format.ts';
import type { Actor } from '../domain/types.ts';
import { getUser } from '../domain/users.ts';
import { errorFields, log } from '../log.ts';
import { registerTools } from './tools.ts';

export const SERVER_VERSION = '1.0.0';

/** Server instructions (plan section 4.2). Household names come from the allowlist. */
export function instructions(names: string[]): string {
  const household = names.length ? joinAnd(names) : 'the household';
  return `${APP_NAME} (the household tracker): a shared household memory for ${household} (restaurants, movies, books, gift ideas, anything). The user talks, often by voice from their phone; you file what they say and answer questions about it later.

Saving something the user tells you:
1. Call list_collections once per conversation. It gives the collections, their fields and tags, today's date, and who you're acting for.
2. Pick the collection whose description fits. If none fits, create_collection with a broad name (Restaurants, not Thai Restaurants) and mention it in your reply.
3. search_entries by name first. Something already saved (a second visit, a rewatch) gets add_log on that entry, never a new entry.
4. create_entry only for new things. If it answers NOT SAVED with candidates, use add_log on the match, or call it again with not_duplicate_of if it really is different.
5. Always pass raw_text: the user's own words about this item, verbatim.
6. Use the collection's existing field keys and tags. Ratings are 0-5 in half steps; convert other scales (7/10 = 3.5). Don't turn words like "loved it" into a number.
7. Turn relative dates ("tonight", "last Friday") into YYYY-MM-DD using today's date from list_collections.
8. If you can't tell which saved entry the user means, or the thing has no name, ask one short question. Otherwise don't ask; save your best reading.
9. After a successful write, reply with one short line based on the tool's confirmation. No recap, no follow-up questions.
One message can mention several things (dinner and a movie): handle each one.
Personal documents and IDs (driver's license, passport, insurance, memberships) go in one shared collection created with sensitive: true, e.g. "Personal documents" (private: true only if the user asks to hide them from the other person). Search finds them by any word but shows only titles; open one with get_entry and repeat only what was asked for. Photos are added in the web app, not through you.
If you can search the web: when the user saves a real-world thing (restaurant, product, film, book, place), check the name and add a few useful details (address, website, year); say what you added or corrected. Never search for personal or sensitive items. Show dates to the user as MM-DD-YYYY.
Notes and long text fields are shown as Markdown in the app: format longer ones (recipes, steps, specs) with short headings, lists and numbered steps. Titles and short fields stay plain.

Answering questions: search_entries (keywords plus filters like min_rating, tags, logged_from/logged_to), get_entry for details and the user's original words, query_sql for counts and rankings. "We" means the household; filter by added_by only when asked about one person.

Fixing mistakes: update_entry, update_log, merge_entries, delete_item, and undo_last_change when the user says "undo that". Deletions can be undone.`;
}

export interface McpDeps {
  db: DB;
  dbPath: string;
  tz: string;
  webUrl?: string;
  householdNames: () => string[];
}

/** What the bearer-token check stores in AuthInfo.extra. */
export interface TokenExtra {
  userId: number;
  clientName: string | null;
}

export function actorFromAuth(db: DB, auth: AuthInfo | undefined): Actor {
  const extra = auth?.extra as TokenExtra | undefined;
  if (!extra?.userId) throw new Error('MCP request without a verified user');
  const user = getUser(db, extra.userId);
  if (!user) throw new Error(`token for unknown user ${extra.userId}`);
  return { userId: user.id, name: user.display_name, via: 'mcp', client: extra.clientName };
}

export function buildMcpServer(deps: McpDeps, actor: Actor): McpServer {
  const server = new McpServer(
    { name: 'magpie', title: APP_NAME, version: SERVER_VERSION },
    { instructions: instructions(deps.householdNames()) },
  );
  registerTools(server, { ctx: { db: deps.db, tz: deps.tz, actor }, dbPath: deps.dbPath, webUrl: deps.webUrl });
  return server;
}

/** One handler for both protocol eras: 2026-07-28 per-request envelopes and 2025-era stateless JSON-RPC. */
export function createMcpEndpoint(deps: McpDeps): McpHttpHandler {
  return createMcpHandler(({ authInfo }) => buildMcpServer(deps, actorFromAuth(deps.db, authInfo)), {
    legacy: 'stateless',
    onerror: (err) => log.warn('mcp transport error', errorFields(err)),
  });
}
