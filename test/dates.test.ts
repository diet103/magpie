import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { loggedPath } from '../src/app.ts';
import { get } from '../src/db/sqlite.ts';
import { createCollection } from '../src/domain/collections.ts';
import { createEntry, deleteItem, purgeEntry, updateEntry } from '../src/domain/entries.ts';
import { NotFoundError } from '../src/domain/errors.ts';
import { todayIn } from '../src/domain/time.ts';
import type { Ctx } from '../src/domain/types.ts';
import { comingUp, hiddenDates, homeDates, nextOccurrence, setDateHidden } from '../src/domain/upcoming.ts';
import { findUserByEmail } from '../src/domain/users.ts';
import { icsCalendar } from '../src/web/calendar.ts';
import { CookieJar, ALEX, SAM, PUBLIC, signInWeb, startTestApp, type TestApp } from './app-helpers.ts';
import { ok, setupDb } from './helpers.ts';

const TODAY = '2026-11-12';
const FEED = { aheadDays: 400, behindDays: 30, allPast: true };

describe('dates that come back', () => {
  const env = setupDb();
  after(() => env.cleanup());
  const web = () => env.as('alex', 'web');
  const rows = (window?: Parameters<typeof comingUp>[2]) => comingUp(web(), TODAY, window).map((u) => [u.title, u.date, u.days, u.note ?? ''].join(' | '));

  test('the next time a month and day come round', () => {
    assert.equal(nextOccurrence('2020-03-14', TODAY), '2027-03-14');
    assert.equal(nextOccurrence('2020-11-12', TODAY), '2026-11-12', 'today counts');
    assert.equal(nextOccurrence('2030-12-25', TODAY), '2026-12-25', 'whatever year was stored');
    assert.equal(nextOccurrence('2024-02-29', TODAY), '2027-02-28');
    assert.equal(nextOccurrence('2024-02-29', '2028-01-10'), '2028-02-29');
  });

  test('a yearly date is shown at its next occurrence instead of dropping out once it passes', () => {
    ok(
      createCollection(env.alex, {
        name: 'Important dates',
        description: 'Birthdays, anniversaries and other dates to remember.',
        fields: [
          { key: 'type', type: 'enum', options: ['birthday', 'anniversary', 'other'] },
          { key: 'date', type: 'date', description: 'Next occurrence of the date' },
          { key: 'repeats_yearly', type: 'boolean' },
        ],
      }),
    );
    ok(createCollection(env.alex, { name: 'Pets', description: 'Our pets.', fields: [{ key: 'birth_date', type: 'date' }] }));
    const add = (collection: string, title: string, fields: Record<string, unknown>) => ok(createEntry(env.alex, { collection, title, fields, raw_text: title }));
    add('important-dates', 'Wedding anniversary', { type: 'anniversary', date: '2026-11-02', repeats_yearly: true });
    add('important-dates', "Mom's birthday", { type: 'birthday', date: '2025-12-03', repeats_yearly: true });
    add('important-dates', 'Grandpa Joe', { type: 'birthday', date: '2024-11-30' });
    add('important-dates', 'Dentist', { type: 'other', date: '2026-11-20', repeats_yearly: false });
    add('important-dates', 'A one-off that has passed', { type: 'other', date: '2026-11-01', repeats_yearly: false });
    add('important-dates', 'Said not to repeat', { type: 'birthday', date: '2026-11-05', repeats_yearly: false });
    add('pets', 'Biscuit', { birth_date: '2021-11-28' });

    assert.deepEqual(rows(), [
      'Dentist | 2026-11-20 | 8 | ',
      'Biscuit | 2026-11-28 | 16 | turns 5',
      'Grandpa Joe | 2026-11-30 | 18 | ',
      "Mom's birthday | 2026-12-03 | 21 | ",
    ]);
    // The anniversary that passed ten days ago is a year away, which is too far for Home but on the calendar.
    const far = comingUp(web(), TODAY, FEED).find((u) => u.title === 'Wedding anniversary')!;
    assert.deepEqual([far.date, far.yearly], ['2027-11-02', true]);
    assert.equal(comingUp(web(), TODAY, FEED).find((u) => u.title === 'Dentist')!.yearly, false);
  });

  test('a start and an end date are one stretch of days, and a finished trip is not overdue', () => {
    ok(
      createCollection(env.alex, {
        name: 'Trips',
        description: 'Trips taken or booked.',
        fields: [
          { key: 'start_date', type: 'date' },
          { key: 'end_date', type: 'date' },
        ],
      }),
    );
    const trip = (title: string, start: string, end: string) => ok(createEntry(env.alex, { collection: 'trips', title, fields: { start_date: start, end_date: end }, raw_text: title }));
    trip('Thanksgiving at the coast', '2026-11-25', '2026-11-29');
    trip('Halloween in the city', '2026-10-30', '2026-11-01');
    trip('Cabin weekend', '2026-11-10', '2026-11-14');
    trip('A lease, not a trip', '2026-01-01', '2026-11-05');
    const trips = comingUp(web(), TODAY).filter((u) => u.collection === 'Trips');
    assert.deepEqual(
      trips.map((u) => [u.title, u.label, u.date, u.until ?? '', u.days]),
      [
        // Ten months is two dates in their own right: the end is treated as something that ran out.
        ['A lease, not a trip', 'End date', '2026-11-05', '', -7],
        ['Cabin weekend', 'Start date', '2026-11-10', '2026-11-14', -2],
        ['Thanksgiving at the coast', 'Start date', '2026-11-25', '2026-11-29', 13],
      ],
    );
  });

  test('the calendar file: all-day events, yearly repeats, stretches, safe text', () => {
    const items = comingUp(web(), TODAY, FEED);
    const ics = icsCalendar(items, { name: 'Magpie', host: 'tracker.test', publicUrl: 'https://tracker.test', now: new Date('2026-11-12T12:00:00Z') });
    assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n') && ics.endsWith('END:VCALENDAR\r\n'));
    assert.ok(ics.split('\r\n').every((line) => Buffer.byteLength(line) <= 75), 'no line longer than 75 bytes');
    const event = (title: string) => ics.split('BEGIN:VEVENT').find((e) => e.includes(`SUMMARY:${title}`))!;
    const mom = event("Mom's birthday");
    assert.match(mom, /DTSTART;VALUE=DATE:20261203\r\nDTEND;VALUE=DATE:20261204\r\nRRULE:FREQ=YEARLY\r\n/);
    assert.match(mom, /UID:e\d+-date@tracker\.test\r\nDTSTAMP:20261112T120000Z/);
    assert.match(event('Thanksgiving at the coast'), /DTSTART;VALUE=DATE:20261125\r\nDTEND;VALUE=DATE:20261130\r\nSUMMARY:Thanksgiving at the coast\r\n/);
    assert.match(event('Biscuit: Birth date'), /RRULE:FREQ=YEARLY/);
    assert.ok(!event('Dentist').includes('RRULE'));
    assert.match(event('A one-off that has passed'), /DTSTART;VALUE=DATE:20261101/, 'the calendar keeps what just happened');

    const odd = icsCalendar(
      [{ entryId: 7, title: `Smith, Jones; "dinner" \\ drinks\nand a very long name that goes on well past the seventy five bytes one line may hold`, collection: 'Trips', icon: null, sensitive: false, field: 'date', label: 'Date', date: '2026-12-01', days: 19, yearly: false }],
      { name: 'Magpie', host: 'tracker.test', publicUrl: 'https://tracker.test' },
    );
    assert.match(odd.replace(/\r\n /g, ''), /SUMMARY:Smith\\, Jones\\; "dinner" \\\\ drinks\\nand a very long name/);
    assert.ok(odd.split('\r\n').every((line) => Buffer.byteLength(line) <= 75));
  });
});

describe('Coming up on one person\'s Home', () => {
  const env = setupDb();
  after(() => env.cleanup());
  const alex = () => env.as('alex', 'web');
  const sam = () => env.as('sam', 'web');
  const titles = (ctx: Ctx, today = TODAY) => homeDates(ctx, today).shown.map((u) => u.title);
  const inCalendar = (ctx: Ctx) => comingUp(ctx, TODAY, FEED).map((u) => u.title);
  const id: Record<string, number> = {};

  before(() => {
    ok(createCollection(env.alex, { name: 'Renewals', description: 'Things that run out.', fields: [{ key: 'due_date', type: 'date' }] }));
    ok(
      createCollection(env.alex, {
        name: 'Important dates',
        description: 'Birthdays and other dates to remember.',
        fields: [
          { key: 'date', type: 'date' },
          { key: 'repeats_yearly', type: 'boolean' },
        ],
      }),
    );
    const add = (collection: string, title: string, fields: Record<string, unknown>) => {
      id[title] = ok(createEntry(env.alex, { collection, title, fields, raw_text: title })).entryId!;
    };
    add('renewals', 'Passport', { due_date: '2026-11-20' }); // 8 days
    add('renewals', 'Car registration', { due_date: '2026-12-12' }); // 30 days, the last day Home shows
    add('renewals', 'Lease', { due_date: '2026-12-13' }); // 31 days
    add('important-dates', "Mom's birthday", { date: '2025-12-03', repeats_yearly: true }); // 21 days
  });

  test('Home looks 30 days ahead, and the calendar still has what is further off', () => {
    assert.deepEqual(titles(alex()), ['Passport', "Mom's birthday", 'Car registration']);
    assert.ok(inCalendar(alex()).includes('Lease'));
  });

  test('a hidden date leaves that person\'s Home only, the calendar keeps it, and it can be shown again', () => {
    const passport = { entryId: id.Passport, field: 'due_date', date: '2026-11-20' };
    setDateHidden(alex(), passport, true, TODAY);
    assert.deepEqual(titles(alex()), ["Mom's birthday", 'Car registration']);
    assert.equal(homeDates(alex(), TODAY).hiddenCount, 1);
    assert.deepEqual(hiddenDates(alex(), TODAY).map((u) => u.title), ['Passport']);
    assert.ok(titles(sam()).includes('Passport'), 'the other person still sees it');
    assert.equal(homeDates(sam(), TODAY).hiddenCount, 0);
    assert.ok(inCalendar(alex()).includes('Passport'));
    setDateHidden(alex(), passport, true, TODAY);
    assert.equal(get(env.db, 'SELECT count(*) AS n FROM hidden_dates')!.n, 1, 'hiding twice is still one row');

    setDateHidden(alex(), passport, false, TODAY);
    assert.deepEqual(titles(alex()), ['Passport', "Mom's birthday", 'Car registration']);
    assert.deepEqual(hiddenDates(alex(), TODAY), []);
  });

  test('what is hidden is one occurrence: next year\'s birthday shows again, and so does a date that changes', () => {
    setDateHidden(alex(), { entryId: id["Mom's birthday"], field: 'date', date: '2026-12-03' }, true, TODAY);
    assert.ok(!titles(alex()).includes("Mom's birthday"));
    assert.ok(titles(alex(), '2027-11-20').includes("Mom's birthday"), 'a year on it is back');

    setDateHidden(alex(), { entryId: id.Passport, field: 'due_date', date: '2026-11-20' }, true, TODAY);
    assert.ok(!titles(alex()).includes('Passport'));
    ok(updateEntry(env.alex, { entry_id: id.Passport, fields: { due_date: '2026-11-27' } }));
    assert.ok(titles(alex()).includes('Passport'), 'the new date was never hidden');
  });

  test('the list is cut to eight after hidden dates are taken out, so hiding one lets the next one in', () => {
    const more = ['Water filter', 'Smoke alarm battery', 'Fire extinguisher', 'Library card', 'Gym membership', 'Domain name', 'Parking permit', 'Tetanus booster'];
    more.forEach((title, i) => ok(createEntry(env.alex, { collection: 'renewals', title, fields: { due_date: `2026-11-${14 + i}` }, raw_text: title })));
    const before = titles(sam());
    assert.equal(before.length, 8);
    assert.ok(!before.includes('Car registration'), 'more than eight are near, so the furthest are cut');
    const first = homeDates(sam(), TODAY).shown[0];
    setDateHidden(sam(), first, true, TODAY);
    const now = titles(sam());
    assert.equal(now.length, 8);
    assert.deepEqual(now.slice(0, 7), before.slice(1));
    assert.ok(!before.includes(now[7]), 'the ninth moved up into view');
  });

  test('only a date on an entry the person can see can be hidden, and a purged entry takes its hidden dates along', () => {
    ok(createCollection(env.sam, { name: 'Surprises', description: 'Not for Alex.', private: true, fields: [{ key: 'due_date', type: 'date' }] }));
    const secret = ok(createEntry(env.sam, { collection: 'surprises', title: 'Party', fields: { due_date: '2026-11-22' }, raw_text: 'x' })).entryId!;
    assert.throws(() => setDateHidden(alex(), { entryId: secret, field: 'due_date', date: '2026-11-22' }, true, TODAY), NotFoundError);
    assert.throws(() => setDateHidden(alex(), { entryId: id.Lease, field: 'due_date', date: 'next week' }, true, TODAY), /could not be found/);
    assert.throws(() => setDateHidden(alex(), { entryId: id.Lease, field: 'not_a_field', date: '2026-12-13' }, true, TODAY), /could not be found/);

    setDateHidden(sam(), { entryId: secret, field: 'due_date', date: '2026-11-22' }, true, TODAY);
    ok(deleteItem(env.sam, { entry_id: secret }));
    ok(purgeEntry(env.sam, secret));
    assert.equal(get(env.db, 'SELECT count(*) AS n FROM hidden_dates WHERE entry_id = ?', secret)!.n, 0);
  });

  test('a hidden date is forgotten once it is long past', () => {
    setDateHidden(alex(), { entryId: id.Lease, field: 'due_date', date: '2026-12-13' }, true, TODAY);
    const mine = () => get(env.db, 'SELECT count(*) AS n FROM hidden_dates WHERE user_id = ? AND date = ?', alex().actor.userId, '2026-12-13')!.n;
    assert.equal(mine(), 1);
    // The next time this person hides something, months later, the old row goes.
    setDateHidden(alex(), { entryId: id['Car registration'], field: 'due_date', date: '2027-04-12' }, true, '2027-04-01');
    assert.equal(mine(), 0);
  });
});

describe('the calendar link', () => {
  let t: TestApp;
  let jar: CookieJar;
  let csrf: string;
  let samJar: CookieJar;
  let samCsrf: string;

  const ctxFor = (email: string, name: string): Ctx => ({ db: t.deps.db, tz: t.deps.config.tz, actor: { userId: findUserByEmail(t.deps.db, email)!.id, name, via: 'mcp', client: 'test' } });
  const csrfOf = async (j: CookieJar) => /<meta name="csrf-token" content="([^"]+)"/.exec(await (await t.request('/', { jar: j })).text())![1];
  const post = (path: string, data: Record<string, string>, who = { jar, csrf }) =>
    t.request(path, { jar: who.jar, method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: PUBLIC }, body: new URLSearchParams({ _csrf: who.csrf, ...data }).toString() });
  const linkIn = (html: string) => /https:\/\/tracker\.test(\/cal\/tma_cal_[A-Za-z0-9_-]+\.ics)/.exec(html)?.[1];

  before(async () => {
    t = await startTestApp();
    jar = await signInWeb(t, ALEX);
    samJar = await signInWeb(t, SAM);
    csrf = await csrfOf(jar);
    samCsrf = await csrfOf(samJar);
    const today = todayIn(t.deps.config.tz);
    const plus = (days: number) => new Date(Date.parse(`${today}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
    const alex = ctxFor('alex@example.com', 'Alex');
    const sam = ctxFor('sam@example.com', 'Sam');
    ok(createCollection(alex, { name: 'Paperwork', description: 'Registrations and renewals.', fields: [{ key: 'expires_on', type: 'date' }] }));
    ok(createEntry(alex, { collection: 'paperwork', title: 'Pilot registration', fields: { expires_on: plus(12) }, raw_text: 'registration' }));
    ok(createCollection(alex, { name: 'Personal documents', description: 'IDs.', private: true, sensitive: true, fields: [{ key: 'number', type: 'text' }, { key: 'expires_on', type: 'date' }] }));
    ok(createEntry(alex, { collection: 'personal-documents', title: 'Passport', fields: { number: 'P-99-12345', expires_on: plus(40) }, raw_text: 'passport' }));
    ok(createCollection(sam, { name: 'Gift plans', description: 'Surprises.', private: true, fields: [{ key: 'due_on', type: 'date' }] }));
    ok(createEntry(sam, { collection: 'gift-plans', title: 'Surprise party', fields: { due_on: plus(5) }, raw_text: 'party' }));
  });
  after(() => t.close());

  test('is made on Settings, shown once, and read without signing in', async () => {
    assert.match(await (await t.request('/settings', { jar })).text(), /Create calendar link/);
    const made = await post('/settings/calendar', {});
    assert.equal(made.status, 200);
    const page = await made.text();
    const link = linkIn(page)!;
    assert.ok(link, 'the new link is on the page');
    assert.match(page, /data-copy="https:\/\/tracker\.test\/cal\/tma_cal_/);
    const settings = await (await t.request('/settings', { jar })).text();
    assert.equal(linkIn(settings), undefined, 'only its hash is kept, so it cannot be shown again');
    assert.match(settings, /No calendar has read it yet\./);

    const feed = await t.request(link);
    assert.equal(feed.status, 200);
    assert.match(feed.headers.get('content-type') ?? '', /^text\/calendar/);
    const ics = await feed.text();
    assert.match(ics, /SUMMARY:Pilot registration: Expires on/);
    assert.ok(!ics.includes('Surprise party'), "the other person's private dates stay out");
    assert.ok(!ics.includes('Passport'), 'sensitive collections are left out unless asked for');
    assert.match(await (await t.request('/settings', { jar })).text(), /A calendar last read it \d\d-\d\d-\d{4}\./);
  });

  test('sensitive collections can be let in, by title only', async () => {
    const link = linkIn(await (await post('/settings/calendar', {})).text())!;
    assert.equal((await post('/settings/calendar/sensitive', { sensitive: '1' })).status, 303);
    const ics = await (await t.request(link)).text();
    assert.match(ics, /SUMMARY:Passport: Expires on/);
    assert.ok(!ics.includes('P-99-12345'), 'never what is inside the entry');
    await post('/settings/calendar/sensitive', { sensitive: '0' });
    assert.ok(!(await (await t.request(link)).text()).includes('Passport'));
  });

  test('a wrong, replaced or removed link gets nothing, and each person has their own', async () => {
    const first = linkIn(await (await post('/settings/calendar', {})).text())!;
    assert.equal((await t.request('/cal/tma_cal_notarealtokennotarealtoken.ics')).status, 404);
    assert.equal((await t.request('/cal/whatever.ics')).status, 404);
    const second = linkIn(await (await post('/settings/calendar', {})).text())!;
    assert.notEqual(second, first);
    assert.equal((await t.request(first)).status, 404, 'making a new link switches the old one off');
    assert.equal((await t.request(second)).status, 200);

    const hers = linkIn(await (await post('/settings/calendar', {}, { jar: samJar, csrf: samCsrf })).text())!;
    const herIcs = await (await t.request(hers)).text();
    assert.match(herIcs, /SUMMARY:Surprise party: Due on/);
    assert.match(herIcs, /SUMMARY:Pilot registration/);
    assert.equal((await t.request(second)).status, 200, 'her link does not replace his');

    assert.equal((await post('/settings/calendar/remove', {})).status, 303);
    assert.equal((await t.request(second)).status, 404);
    assert.equal((await t.request(hers)).status, 200);
  });

  test('a link stops working when its owner may no longer sign in', async () => {
    const link = linkIn(await (await post('/settings/calendar', {}, { jar: samJar, csrf: samCsrf })).text())!;
    assert.equal((await t.request(link)).status, 200);
    const cfg = t.deps.config;
    const everyone = cfg.allowedUsers;
    cfg.allowedUsers = everyone.filter((u) => u.email !== 'sam@example.com');
    try {
      const gone = await t.request(link);
      assert.deepEqual([gone.status, await gone.text()], [404, 'Not found'], 'the same answer as a wrong link');
    } finally {
      cfg.allowedUsers = everyone;
    }
    assert.equal((await t.request(link)).status, 200);
  });

  test('the link never reaches the log', () => {
    assert.equal(loggedPath('/cal/tma_cal_abcdefghijklmnopqrstuvwxyz.ics'), '/cal');
    assert.equal(loggedPath('/e/12'), '/e/12');
    assert.equal(loggedPath('/oauth/consent?request=secret'), '/oauth/consent');
  });
});
