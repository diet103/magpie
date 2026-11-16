import { UserError } from './errors.ts';

/** Today's calendar date (YYYY-MM-DD) in the household time zone. */
export function todayIn(tz: string, now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(now)
    .reduce<Record<string, string>>((acc, p) => ((acc[p.type] = p.value), acc), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function isRealDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Validates an occasion date: real, and not more than one day in the future. */
export function checkOccurredOn(s: string | undefined, tz: string): string {
  const today = todayIn(tz);
  if (s === undefined || s === '') return today;
  if (!isRealDate(s)) throw new UserError(`"${s}" isn't a real date. Use YYYY-MM-DD (today is ${today}).`);
  if (s > addDays(today, 1)) throw new UserError(`${s} is in the future (today is ${today}). Check the year.`);
  return s;
}

/** How dates are shown to people: 2028-09-02 becomes 09-02-2028. Anything else is returned as it came. */
export function usDate(ymd: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd ?? '');
  return m ? `${m[2]}-${m[3]}-${m[1]}` : (ymd ?? '');
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** "Nov 8" for confirmations; adds the year when it isn't the current one. */
export function shortDate(date: string, tz: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  const sameYear = date.slice(0, 4) === todayIn(tz).slice(0, 4);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: sameYear ? undefined : 'numeric', timeZone: 'UTC' });
}

export function minutesAgoIso(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function tzOffsetMs(t: number, tz: string): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(new Date(t))
      .map((x) => [x.type, x.value]),
  );
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - t;
}

/** The UTC instant (ISO-8601) when a household calendar day starts. */
export function zonedDayStartUtc(date: string, tz: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const midnight = Date.UTC(y, m - 1, d);
  let t = midnight;
  for (let i = 0; i < 2; i++) t = midnight - tzOffsetMs(t, tz);
  return new Date(t).toISOString();
}

/** The household calendar date of a UTC timestamp. */
export function localDateOf(iso: string, tz: string): string {
  return todayIn(tz, new Date(iso));
}
