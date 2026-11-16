// "Coming up" on the home screen, and the calendar link: entries with a date that is near.
//
// Any date field counts when it is ahead of today. A date that has just passed only counts when the field is
// about something running out or falling due. Three things are read from how an entry is filled in:
//   - A date that comes round every year (a birthday, an anniversary) is shown at its next occurrence.
//   - A start date with an end date beside it is one stretch of days (a trip), not two separate dates.
//   - A birth date gets the age it leads to ("turns 5").
import { all, run } from '../db/sqlite.ts';
import { visibleCollections } from './collections.ts';
import { resolveEntry } from './entries.ts';
import { UserError } from './errors.ts';
import { fieldLabel } from './fields.ts';
import { addDays, isRealDate, nowIso } from './time.ts';
import type { Ctx, FieldDef, Fields } from './types.ts';

export interface Upcoming {
  entryId: number;
  title: string;
  collection: string;
  icon: string | null;
  sensitive: boolean;
  /** Key of the date field this comes from. */
  field: string;
  label: string;
  /** The day it falls on. For a date that repeats every year, the next time it comes round. */
  date: string;
  /** Days from today; negative when the date has passed. */
  days: number;
  yearly: boolean;
  /** The last day, when this is a stretch of days such as a trip. */
  until?: string;
  /** A few more words for the row, such as "turns 5". */
  note?: string;
}

export interface DateWindow {
  aheadDays: number;
  behindDays: number;
  /** Past dates in the window are kept whatever the field is about (the calendar shows what just happened too). */
  allPast?: boolean;
  limit?: number;
}

/** Home looks a month ahead. Anything further off is in the calendar link, which has its own window. */
const HOME: DateWindow = { aheadDays: 30, behindDays: 30, limit: 8 };
/** A hidden date is forgotten once it is this far behind: it left "Coming up" long before. */
const HIDDEN_KEPT_DAYS = 90;
const LAPSES = /expir|due|renew|deadline|until|ends?_/;
const SPAN_START = /(^|_)(start|starts|begin|begins|depart|departs|departure|arrive|arrival|check_?in)(_|$)/;
const SPAN_END = /(^|_)(end|ends|return|returns|check_?out)(_|$)/;
/** A longer start-to-end pair (a job, a lease) is two dates in their own right, not one stretch. */
const SPAN_MAX_DAYS = 60;
const BIRTH = /(^|_)(birth|birthday|birthdate|born|dob)(_|$)/;
const ANNIVERSARY = /anniversar/;
const YEARLY_FLAG = /^(repeats?_?(yearly|annually|every_year)|yearly|annual|annually|every_year)$/;
const KIND_KEYS = ['type', 'kind', 'category', 'occasion'];

/** Whether a date on this entry comes round every year, and if it is a birth date (which also gives an age). */
function repeats(fieldKey: string, fields: Fields): 'birth' | 'yearly' | null {
  if (BIRTH.test(fieldKey)) return 'birth';
  if (ANNIVERSARY.test(fieldKey)) return 'yearly';
  // A yes/no field such as repeats_yearly settles it for the entry's dates, either way.
  for (const [k, v] of Object.entries(fields)) if (typeof v === 'boolean' && YEARLY_FLAG.test(k)) return v ? 'yearly' : null;
  // "type: birthday" says the same thing without a flag.
  for (const k of KIND_KEYS) {
    const v = fields[k];
    if (typeof v === 'string' && /^(birthday|anniversary)$/i.test(v.trim())) return 'yearly';
  }
  return null;
}

/** The next time a month and day come round, today included. February 29 falls on the 28th in other years. */
export function nextOccurrence(date: string, today: string): string {
  const monthDay = date.slice(4);
  const year = Number(today.slice(0, 4));
  for (const y of [year, year + 1]) {
    const candidate = isRealDate(`${y}${monthDay}`) ? `${y}${monthDay}` : `${y}-02-28`;
    if (candidate >= today) return candidate;
  }
  return `${year + 1}${monthDay}`;
}

const dayNumber = (date: string) => Math.round(Date.parse(`${date}T00:00:00Z`) / 86_400_000);

export function comingUp(ctx: Ctx, today: string, window: DateWindow = HOME): Upcoming[] {
  const t0 = dayNumber(today);
  const out: Upcoming[] = [];
  for (const c of visibleCollections(ctx)) {
    const dated = c.fields.filter((f) => f.type === 'date' && !f.hidden);
    if (dated.length === 0) continue;
    const rows = all<{ id: number; title: string; fields: string }>(
      ctx.db,
      'SELECT id, title, fields FROM open_entries WHERE collection_id = ? AND deleted_at IS NULL AND merged_into_id IS NULL',
      c.id,
    );
    for (const r of rows) {
      const fields = JSON.parse(r.fields) as Fields;
      const valueOf = (f: FieldDef | undefined): string | undefined => {
        const v = f ? fields[f.key] : undefined;
        return typeof v === 'string' && isRealDate(v) ? v : undefined;
      };
      const start = dated.find((f) => SPAN_START.test(f.key) && valueOf(f));
      const end = start
        ? dated.find((f) => {
            const last = f !== start && SPAN_END.test(f.key) ? valueOf(f) : undefined;
            return last !== undefined && last >= valueOf(start)! && dayNumber(last) - dayNumber(valueOf(start)!) <= SPAN_MAX_DAYS;
          })
        : undefined;
      for (const f of dated) {
        const stored = valueOf(f);
        // The last day of a stretch is shown with its first day, not as a date of its own.
        if (!stored || f === end) continue;
        const repeat = repeats(f.key, fields);
        const date = repeat ? nextOccurrence(stored, today) : stored;
        const until = !repeat && f === start ? valueOf(end) : undefined;
        const days = dayNumber(date) - t0;
        if (days > window.aheadDays) continue;
        if (days < 0) {
          const underWay = until !== undefined && until >= today;
          if (!underWay && (days < -window.behindDays || !(window.allPast || LAPSES.test(f.key)))) continue;
        }
        const age = repeat === 'birth' ? Number(date.slice(0, 4)) - Number(stored.slice(0, 4)) : 0;
        out.push({
          entryId: r.id,
          title: r.title,
          collection: c.name,
          icon: c.icon,
          sensitive: Boolean(c.sensitive),
          field: f.key,
          label: fieldLabel(f),
          date,
          days,
          yearly: repeat !== null,
          ...(until ? { until } : {}),
          ...(age > 0 ? { note: `turns ${age}` } : {}),
        });
      }
    }
  }
  out.sort((a, b) => a.days - b.days || a.entryId - b.entryId);
  return window.limit ? out.slice(0, window.limit) : out;
}

// ---- dates a person has hidden from their own Home ---------------------------------------------------------
// Personal, like a pin: nothing about the entry changes, so it is not in Activity and there is nothing to undo.
// The calendar link is not affected.

/** One occurrence of a date: the entry, the date field and the day shown. */
export interface DateRef {
  entryId: number;
  field: string;
  date: string;
}

const refKey = (r: DateRef) => `${r.entryId}|${r.field}|${r.date}`;

function hiddenKeys(ctx: Ctx): Set<string> {
  return new Set(
    all<{ entry_id: number; field: string; date: string }>(ctx.db, 'SELECT entry_id, field, date FROM hidden_dates WHERE user_id = ?', ctx.actor.userId).map((r) =>
      refKey({ entryId: r.entry_id, field: r.field, date: r.date }),
    ),
  );
}

/** "Coming up" as this person sees it on Home, and how many dates in that stretch they have hidden. */
export function homeDates(ctx: Ctx, today: string): { shown: Upcoming[]; hiddenCount: number } {
  const hidden = hiddenKeys(ctx);
  const every = comingUp(ctx, today, { ...HOME, limit: undefined });
  // Hidden ones are taken out before the list is cut to length, so hiding one lets the next one in.
  const shown = every.filter((u) => !hidden.has(refKey(u)));
  return { shown: HOME.limit ? shown.slice(0, HOME.limit) : shown, hiddenCount: every.length - shown.length };
}

/** The dates this person has hidden that would otherwise be on Home now. */
export function hiddenDates(ctx: Ctx, today: string): Upcoming[] {
  const hidden = hiddenKeys(ctx);
  return hidden.size ? comingUp(ctx, today, { ...HOME, limit: undefined }).filter((u) => hidden.has(refKey(u))) : [];
}

/** Hides one occurrence of a date from this person's Home, or shows it again. */
export function setDateHidden(ctx: Ctx, ref: DateRef, hidden: boolean, today: string): void {
  // Only an entry the person can see; a merged entry's date belongs to the entry that was kept.
  const { entry, collection } = resolveEntry(ctx, ref.entryId);
  const isDateField = collection.fields.some((f) => f.key === ref.field && f.type === 'date');
  if (!isDateField || !isRealDate(ref.date)) throw new UserError('That date could not be found.');
  if (!hidden) {
    run(ctx.db, 'DELETE FROM hidden_dates WHERE user_id = ? AND entry_id IN (?, ?) AND field = ? AND date = ?', ctx.actor.userId, entry.id, ref.entryId, ref.field, ref.date);
    return;
  }
  run(ctx.db, 'DELETE FROM hidden_dates WHERE user_id = ? AND date < ?', ctx.actor.userId, addDays(today, -HIDDEN_KEPT_DAYS));
  run(
    ctx.db,
    'INSERT OR IGNORE INTO hidden_dates (user_id, entry_id, field, date, created_at) VALUES (?, ?, ?, ?, ?)',
    ctx.actor.userId,
    entry.id,
    ref.field,
    ref.date,
    nowIso(),
  );
}
