// The Ask box's saved conversation. Each person has their own; nobody else can read it, and it is not part of
// query_sql or the data download. What was said is sealed in the database (src/domain/sealed.ts): people tell
// the chat their document numbers before any entry exists to hold them.
import { all, run, type DB } from '../db/sqlite.ts';
import { resolveEntry } from '../domain/entries.ts';
import { chatText, openChat } from '../domain/sealed.ts';
import { nowIso } from '../domain/time.ts';
import type { Ctx } from '../domain/types.ts';
import type { AskResult, Turn } from './chat.ts';

export interface ChatLink {
  id: number;
  /** What the reply did to the entry ("Saved", "Updated"...), or empty when it only talked about it. */
  verb: string;
}

export interface ChatRow {
  id: number;
  user_id: number;
  role: 'user' | 'assistant';
  text: string;
  attachment_id: number | null;
  attachment_ids: string;
  links: string;
  sources: string;
  created_at: string;
  sealed?: string | null;
}

const KEEP = 300;
/** A chat left alone this long is over: the next visit starts a fresh one. What it saved stays saved. */
export const CHAT_IDLE_MS = 60 * 60_000;
const CONTEXT_TURNS = 16;

/** Ends a conversation that has gone quiet. Returns true when it removed one. */
export function expireIdleChat(db: DB, userId: number, now = Date.now()): boolean {
  const last = all<{ created_at: string }>(db, 'SELECT created_at FROM chat_messages WHERE user_id = ? ORDER BY id DESC LIMIT 1', userId)[0];
  if (!last || now - Date.parse(last.created_at) < CHAT_IDLE_MS) return false;
  clearChat(db, userId);
  return true;
}

export function addMessage(db: DB, userId: number, m: { role: 'user' | 'assistant'; text: string; attachmentIds?: number[]; links?: ChatLink[]; sources?: { url: string; title: string }[] }): ChatRow {
  const files = m.attachmentIds ?? [];
  const res = run(
    db,
    'INSERT INTO chat_messages (user_id, role, attachment_id, attachment_ids, links, created_at, text, sources, sealed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    userId,
    m.role,
    files[0] ?? null,
    JSON.stringify(files),
    JSON.stringify(m.links ?? []),
    nowIso(),
    ...chatText(db, { text: m.text, sources: JSON.stringify(m.sources ?? []) }),
  );
  const id = Number(res.lastInsertRowid);
  run(db, 'DELETE FROM chat_messages WHERE user_id = ? AND id <= (SELECT id FROM chat_messages WHERE user_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)', userId, userId, KEEP);
  return openChat(db, all<ChatRow>(db, 'SELECT * FROM chat_messages WHERE id = ?', id)[0]);
}

/** The current chat's newest messages, oldest first. */
export function recentMessages(db: DB, userId: number, limit = 80): ChatRow[] {
  expireIdleChat(db, userId);
  return all<ChatRow>(db, 'SELECT * FROM chat_messages WHERE user_id = ? ORDER BY id DESC LIMIT ?', userId, limit).reverse().map((r) => openChat(db, r));
}

/** What the model gets as the conversation so far: the current chat, short, and starting with something the person said. */
export function contextTurns(db: DB, userId: number, now = Date.now()): Turn[] {
  expireIdleChat(db, userId, now);
  const rows = all<ChatRow>(db, 'SELECT * FROM chat_messages WHERE user_id = ? ORDER BY id DESC LIMIT ?', userId, CONTEXT_TURNS).reverse().map((r) => openChat(db, r));
  while (rows.length && rows[0].role !== 'user') rows.shift();
  return rows.map((r) => ({ role: r.role, text: r.text }));
}

/** The files a message came with: the list, or the single one on a message saved before there were lists. */
export function attachmentsOf(row: Pick<ChatRow, 'attachment_id' | 'attachment_ids'>): number[] {
  try {
    const v = JSON.parse(row.attachment_ids) as unknown;
    if (Array.isArray(v) && v.length) return v.filter((x): x is number => Number.isInteger(x));
  } catch {
    // fall through to the single id
  }
  return row.attachment_id === null ? [] : [row.attachment_id];
}

export function clearChat(db: DB, userId: number) {
  run(db, 'DELETE FROM chat_messages WHERE user_id = ?', userId);
}

export function parseLinks(json: string): ChatLink[] {
  try {
    const v = JSON.parse(json) as unknown;
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is ChatLink => typeof x === 'object' && x !== null && Number.isInteger((x as ChatLink).id)).map((x) => ({ id: x.id, verb: typeof x.verb === 'string' ? x.verb : '' }));
  } catch {
    return [];
  }
}

/**
 * Turns the model's answer into what is stored and shown: "(#12)" markers come out of the text and become links,
 * next to the entries the turn saved or changed. Only entries this person can see are linked.
 */
export function finishReply(ctx: Ctx, result: AskResult): { text: string; links: ChatLink[] } {
  const links: ChatLink[] = result.touched.map((t) => ({ id: t.id, verb: t.verb }));
  const seen = new Set(links.map((l) => l.id));
  const marker = /\s*\(#(\d{1,9})(?:, log \d+)?\)/g;
  for (const m of result.text.matchAll(marker)) {
    const id = Number(m[1]);
    if (seen.has(id) || links.length >= 6) continue;
    seen.add(id);
    try {
      links.push({ id: resolveEntry(ctx, id, { allowDeleted: true }).entry.id, verb: '' });
    } catch {
      // Not theirs to see, or gone: no link.
    }
  }
  const text = result.text.replace(marker, '').replace(/[ \t]+([.,;:!?])/g, '$1').trim();
  return { text: text || 'Done.', links };
}

export function parseSources(json: string): { url: string; title: string }[] {
  try {
    const v = JSON.parse(json) as unknown;
    if (!Array.isArray(v)) return [];
    return v.flatMap((x) => (x && typeof x.url === 'string' && /^https?:\/\//.test(x.url) ? [{ url: x.url as string, title: typeof x.title === 'string' ? x.title : '' }] : []));
  } catch {
    return [];
  }
}
