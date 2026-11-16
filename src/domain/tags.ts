import { all } from '../db/sqlite.ts';
import { UserError } from './errors.ts';
import { looseTagKey, normalizeTag } from './normalize.ts';
import type { Ctx } from './types.ts';

export const MAX_TAGS = 20;

const VISIBLE_LIVE = `c.archived_at IS NULL AND (c.visibility = 'shared' OR c.owner_id = :me)
  AND e.deleted_at IS NULL AND e.merged_into_id IS NULL`;

/** Tag usage counts across everything this user can see (optionally one collection). */
export function tagCounts(ctx: Ctx, collectionId?: number): { tag: string; n: number }[] {
  return all<{ tag: string; n: number }>(
    ctx.db,
    `SELECT j.value AS tag, count(*) AS n
       FROM entries e JOIN collections c ON c.id = e.collection_id, json_each(e.tags) j
      WHERE ${VISIBLE_LIVE} ${collectionId ? 'AND e.collection_id = :cid' : ''}
      GROUP BY j.value ORDER BY n DESC, j.value`,
    collectionId ? { me: ctx.actor.userId, cid: collectionId } : { me: ctx.actor.userId },
  );
}

export interface TagResolution {
  tags: string[];
  added: string[];
  newTags: string[];
  mapped: [string, string][];
}

/**
 * Normalizes requested tags and maps near-identical ones onto existing visible tags
 * ("datenight" -> "date-night"), returning current + requested without duplicates.
 */
export function resolveTags(ctx: Ctx, requested: string[] | undefined, current: string[]): TagResolution {
  const tags = [...current];
  const added: string[] = [];
  const newTags: string[] = [];
  const mapped: [string, string][] = [];
  if (!requested || requested.length === 0) return { tags, added, newTags, mapped };
  const existing = tagCounts(ctx);
  const exact = new Set(existing.map((t) => t.tag));
  const loose = new Map<string, string>();
  for (const t of existing) if (!loose.has(looseTagKey(t.tag))) loose.set(looseTagKey(t.tag), t.tag);
  for (const t of current) if (!loose.has(looseTagKey(t))) loose.set(looseTagKey(t), t);
  for (const raw of requested) {
    const norm = normalizeTag(raw);
    if (!norm) continue;
    let tag = norm;
    if (!exact.has(norm) && !current.includes(norm)) {
      const match = loose.get(looseTagKey(norm));
      if (match) {
        tag = match;
        if (match !== norm) mapped.push([raw, match]);
      } else if (!newTags.includes(norm)) {
        newTags.push(norm);
        loose.set(looseTagKey(norm), norm);
      }
    }
    if (!tags.includes(tag)) {
      tags.push(tag);
      added.push(tag);
    }
  }
  if (tags.length > MAX_TAGS) throw new UserError(`An entry can have at most ${MAX_TAGS} tags (this would make ${tags.length}).`);
  return { tags, added, newTags, mapped };
}

export function tagNotes(res: TagResolution): string[] {
  const out: string[] = [];
  if (res.newTags.length) out.push(`New tag${res.newTags.length > 1 ? 's' : ''}: ${res.newTags.join(', ')}`);
  for (const [from, to] of res.mapped) out.push(`Tag "${from}" saved as the existing tag "${to}".`);
  return out;
}
