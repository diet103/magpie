// The calendar link: a person's dates (expiring documents, birthdays, trips) as an iCalendar file that a
// calendar app subscribes to. The app does the reminding, so the server needs no job or notification of its own.
// The link's secret is the only credential, so this route sits outside sign-in and is rate limited per address.
import { Hono } from 'hono';
import { RateLimiter, clientIp, rateLimit } from '../auth/ratelimit.ts';
import { isAllowlisted } from '../auth/session.ts';
import { APP_NAME } from '../brand.ts';
import { addDays, todayIn } from '../domain/time.ts';
import type { Ctx } from '../domain/types.ts';
import { comingUp, type Upcoming } from '../domain/upcoming.ts';
import { getUser } from '../domain/users.ts';
import type { AppDeps, AppEnv } from '../types.ts';

/** How far ahead the calendar looks, and how long a date that has passed stays on it. */
const FEED_WINDOW = { aheadDays: 400, behindDays: 30, allPast: true };
const GENERIC_LABEL = /^(date|day|when)$/i;

const text = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

/** RFC 5545: a line is at most 75 bytes; a longer one continues on the next line after a space. */
function fold(line: string): string {
  const out: string[] = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch);
    if (bytes + n > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = '';
      bytes = 0;
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join('\r\n ');
}

export function icsCalendar(items: Upcoming[], o: { name: string; host: string; publicUrl: string; now?: Date }): string {
  const stamp = (o.now ?? new Date()).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const day = (d: string) => d.replace(/-/g, '');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:-//${o.name}//Dates//EN`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${text(o.name)}`,
    'REFRESH-INTERVAL;VALUE=DURATION:PT6H',
    'X-PUBLISHED-TTL:PT6H',
  ];
  for (const u of items) {
    const link = `${o.publicUrl}/e/${u.entryId}`;
    // A trip is named by its title alone; so is an entry whose date field is just called "date".
    const summary = u.until || GENERIC_LABEL.test(u.label) ? u.title : `${u.title}: ${u.label}`;
    lines.push(
      'BEGIN:VEVENT',
      `UID:e${u.entryId}-${u.field}@${o.host}`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${day(u.date)}`,
      // All-day events end on the morning after their last day.
      `DTEND;VALUE=DATE:${day(addDays(u.until ?? u.date, 1))}`,
    );
    if (u.yearly) lines.push('RRULE:FREQ=YEARLY');
    lines.push(`SUMMARY:${text(summary)}`, `DESCRIPTION:${text(`${u.collection} in ${o.name}\n${link}`)}`, `URL:${link}`, 'TRANSP:TRANSPARENT', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

export function calendarRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const cfg = deps.config;
  const perAddress = new RateLimiter(30);
  app.get('/cal/:file', rateLimit(perAddress, (c) => `cal:${clientIp(c)}`), (c) => {
    c.header('Cache-Control', 'private, no-store');
    const m = /^(tma_cal_[A-Za-z0-9_-]{20,100})\.ics$/.exec(c.req.param('file'));
    const feed = m ? deps.store.readCalendarFeed(m[1]) : undefined;
    const user = feed ? getUser(deps.db, feed.user_id) : undefined;
    // A wrong link and a link whose owner may no longer sign in look the same from outside.
    if (!feed || !user || !isAllowlisted(cfg, user)) return c.text('Not found', 404);
    const ctx: Ctx = { db: deps.db, tz: cfg.tz, actor: { userId: user.id, name: user.display_name, via: 'web', client: 'calendar' } };
    const items = comingUp(ctx, todayIn(cfg.tz), FEED_WINDOW).filter((u) => feed.include_sensitive === 1 || !u.sensitive);
    return c.body(icsCalendar(items, { name: APP_NAME, host: cfg.publicHost, publicUrl: cfg.publicUrl }), 200, { 'Content-Type': 'text/calendar; charset=utf-8' });
  });
  return app;
}
