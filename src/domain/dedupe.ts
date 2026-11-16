import { all } from '../db/sqlite.ts';
import { dice, titleKey } from './normalize.ts';
import type { Collection, Ctx } from './types.ts';

export interface DupCandidate {
  id: number;
  title: string;
  collectionId: number;
  collectionName: string;
  logNoun: string | null;
  rating: number | null;
  logCount: number;
  lastLoggedOn: string | null;
  why: string;
  score: number;
}

interface Row {
  id: number;
  title: string;
  title_key: string;
  collection_id: number;
  cname: string;
  display: string;
  rating: number | null;
  log_count: number;
  last_logged_on: string | null;
}

/**
 * Possible duplicates for a new title (section 3.5): same collection with the same or a similar title,
 * or the same title in another visible collection. Up to 5, best first.
 */
export function findDuplicates(ctx: Ctx, coll: Collection, title: string, excludeIds: number[] = []): DupCandidate[] {
  const key = titleKey(title) || title.trim().toLowerCase();
  const rows = all<Row>(
    ctx.db,
    `SELECT e.id, e.title, e.title_key, e.collection_id, c.name AS cname, c.display, e.rating, e.log_count, e.last_logged_on
       FROM entries e JOIN collections c ON c.id = e.collection_id
      WHERE e.deleted_at IS NULL AND e.merged_into_id IS NULL AND c.archived_at IS NULL
        AND (c.visibility = 'shared' OR c.owner_id = ?)
        AND (e.collection_id = ? OR e.title_key = ?)`,
    ctx.actor.userId,
    coll.id,
    key,
  );
  const out: DupCandidate[] = [];
  for (const r of rows) {
    if (excludeIds.includes(r.id)) continue;
    let why = '';
    let score = 0;
    if (r.collection_id === coll.id) {
      if (r.title_key === key) {
        why = 'same name';
        score = 3;
      } else {
        const sim = dice(r.title_key, key);
        const [short, long] = r.title_key.length <= key.length ? [r.title_key, key] : [key, r.title_key];
        const contains = short.length >= 4 && long.includes(short);
        if (sim >= 0.55 || contains) {
          why = 'similar name';
          score = 1 + Math.max(sim, contains ? 0.6 : 0);
        }
      }
    } else if (r.title_key === key) {
      why = `same name, in ${r.cname}`;
      score = 0.5;
    }
    if (!why) continue;
    const display = JSON.parse(r.display) as { log_noun?: string };
    out.push({
      id: r.id,
      title: r.title,
      collectionId: r.collection_id,
      collectionName: r.cname,
      logNoun: display.log_noun ?? null,
      rating: r.rating,
      logCount: r.log_count,
      lastLoggedOn: r.last_logged_on,
      why,
      score,
    });
  }
  return out.sort((a, b) => b.score - a.score || b.logCount - a.logCount || a.id - b.id).slice(0, 5);
}
