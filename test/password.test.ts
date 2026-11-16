import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { pkceChallenge } from '../src/auth/crypto.ts';
import { loadConfig } from '../src/config.ts';
import { CookieJar, ALEX, HOSTED_CALLBACK, HOSTED_CIMD, PUBLIC, startTestApp, type TestApp } from './app-helpers.ts';

const ALEX_PW = 'k7wq-m2xd-9fhp-t4vb-3ncz';
const SAM_PW = 'r8tn-c5gy-2vwh-j6kp-x3md';
const PASSWORDS = `alex@example.com=${ALEX_PW},sam@example.com=${SAM_PW}`;

function login(t: TestApp, jar: CookieJar, fields: Record<string, string>, origin = PUBLIC, ip?: string) {
  return t.request('/login', {
    jar,
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin, ...(ip ? { 'fly-client-ip': ip } : {}) },
    body: new URLSearchParams(fields).toString(),
  });
}

describe('password sign-in (no Google configured)', () => {
  let t: TestApp;
  before(async () => {
    t = await startTestApp({ LOGIN_PASSWORDS: PASSWORDS }, { google: false });
  });
  after(async () => {
    await t.close();
  });

  test('the login page shows only the password form', async () => {
    const res = await t.request('/login?return_to=/activity');
    const page = await res.text();
    assert.equal(res.status, 200);
    assert.match(page, /<form method="post" action="\/login"/);
    assert.match(page, /name="return_to" value="\/activity"/);
    assert.doesNotMatch(page, /Sign in with Google/);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    // unknown error codes show nothing, and nothing from the URL is echoed
    assert.doesNotMatch(await (await t.request('/login?error=constructor')).text(), /function|native code/);
    assert.doesNotMatch(await (await t.request('/login?error=Call%20us%20now')).text(), /Call us now/);
  });

  test('wrong password, unknown email and a good sign-in', async () => {
    const jar = new CookieJar();
    const wrong = await login(t, jar, { email: 'alex@example.com', password: 'not-the-right-password' });
    assert.equal(wrong.status, 401);
    const wrongPage = await wrong.text();
    assert.match(wrongPage, /Wrong email or password\./);
    assert.doesNotMatch(wrongPage, /not-the-right-password/);
    const unknown = await login(t, jar, { email: 'stranger@example.com', password: ALEX_PW });
    assert.equal(unknown.status, 401);
    assert.match(await unknown.text(), /Wrong email or password\./);
    const swapped = await login(t, jar, { email: 'sam@example.com', password: ALEX_PW });
    assert.equal(swapped.status, 401);
    assert.equal((await t.request('/', { jar })).status, 302);

    const good = await login(t, jar, { email: ' Alex@Example.com ', password: ALEX_PW, return_to: '/activity' });
    assert.equal(good.status, 303);
    assert.equal(good.headers.get('location'), '/activity');
    assert.match(jar.get('__Host-tracker_session') ?? '', /.+/);
    const home = await t.request('/', { jar });
    assert.equal(home.status, 200);
    assert.match(await home.text(), /Alex/);
  });

  test('other sites cannot submit the form, and return_to stays on this site', async () => {
    const cross = await login(t, new CookieJar(), { email: 'alex@example.com', password: ALEX_PW }, 'https://evil.example');
    assert.equal(cross.status, 403);
    const res = await login(t, new CookieJar(), { email: 'alex@example.com', password: ALEX_PW, return_to: '//evil.example/x' });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/');
  });

  test('connecting Claude: authorize, password, consent, token, tool call', async () => {
    const verifier = 'p'.repeat(64);
    const jar = new CookieJar();
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: HOSTED_CIMD,
      redirect_uri: HOSTED_CALLBACK,
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: 'S256',
      state: 'st-pw',
      resource: `${PUBLIC}/mcp`,
    });
    const start = await t.request(`/oauth/authorize?${q}`, { jar });
    assert.equal(start.status, 302);
    const loginUrl = new URL(start.headers.get('location')!, PUBLIC);
    assert.equal(loginUrl.pathname, '/login');
    const returnTo = loginUrl.searchParams.get('return_to')!;
    assert.match(returnTo, /^\/oauth\/consent\?request=/);

    const signedIn = await login(t, jar, { email: 'sam@example.com', password: SAM_PW, return_to: returnTo });
    assert.equal(signedIn.status, 303);
    assert.equal(signedIn.headers.get('location'), returnTo);
    const consent = await t.request(returnTo, { jar });
    const page = await consent.text();
    assert.equal(consent.status, 200);
    assert.match(page, /to read and change your tracker as Sam\?/);
    const allow = await t.request('/oauth/consent', {
      jar,
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: PUBLIC },
      body: new URLSearchParams({
        _csrf: /name="_csrf" value="([^"]+)"/.exec(page)![1],
        request: /name="request" value="([^"]+)"/.exec(page)![1],
        decision: 'allow',
      }).toString(),
    });
    assert.equal(allow.status, 302);
    const back = new URL(allow.headers.get('location')!);
    assert.equal(back.origin + back.pathname, HOSTED_CALLBACK);
    assert.equal(back.searchParams.get('state'), 'st-pw');
    const tokenRes = await t.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: back.searchParams.get('code')!, code_verifier: verifier, client_id: HOSTED_CIMD, redirect_uri: HOSTED_CALLBACK }).toString(),
    });
    assert.equal(tokenRes.status, 200);
    const tokens = (await tokenRes.json()) as { access_token: string };
    const mcp = await t.request('/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    assert.equal(mcp.status, 200);

    // the same consent link in a browser that didn't start the request is refused, even when signed in
    const other = new CookieJar();
    await login(t, other, { email: 'alex@example.com', password: ALEX_PW });
    const second = await t.request(`/oauth/authorize?${q}`, { jar: new CookieJar() });
    const stolen = new URL(second.headers.get('location')!, PUBLIC).searchParams.get('return_to')!;
    assert.equal((await t.request(stolen, { jar: other })).status, 400);
  });

  test('ten wrong guesses from one place lock that place out, not the person', async () => {
    const attacker = '203.0.113.7';
    const jar = new CookieJar();
    for (let i = 0; i < 10; i++) {
      const res = await login(t, jar, { email: 'sam@example.com', password: `wrong-guess-number-${i}` }, PUBLIC, attacker);
      assert.equal(res.status, 401);
    }
    const locked = await login(t, jar, { email: 'sam@example.com', password: SAM_PW }, PUBLIC, attacker);
    assert.equal(locked.status, 429);
    assert.match(await locked.text(), /Too many wrong passwords/);
    assert.ok(Number(locked.headers.get('retry-after')) > 0);
    // Sam, signing in from home, is not locked out by a stranger's guesses
    assert.equal((await login(t, new CookieJar(), { email: 'sam@example.com', password: SAM_PW }, PUBLIC, '198.51.100.20')).status, 303);
    // and the other person is unaffected even from the attacker's address
    assert.equal((await login(t, new CookieJar(), { email: 'alex@example.com', password: ALEX_PW }, PUBLIC, attacker)).status, 303);
  });
});

describe('password and Google together', () => {
  let t: TestApp;
  before(async () => {
    t = await startTestApp({ LOGIN_PASSWORDS: PASSWORDS });
  });
  after(async () => {
    await t.close();
  });

  test('the login page offers both, and Google returns to where the person was going', async () => {
    const page = await (await t.request('/login?return_to=/trash')).text();
    assert.match(page, /<form method="post" action="\/login"/);
    assert.match(page, /href="\/auth\/google\/start\?return_to=%2Ftrash"/);
    const jar = new CookieJar();
    const start = await t.request('/auth/google/start?return_to=%2Ftrash', { jar });
    const loc = new URL(start.headers.get('location')!);
    const code = t.google.issueCode({ ...ALEX, nonce: loc.searchParams.get('nonce')! });
    const done = await t.request(`/auth/google/callback?code=${code}&state=${loc.searchParams.get('state')}`, { jar });
    assert.equal(done.headers.get('location'), '/trash');
    // cancelling at Google comes back to the login page with a fixed message
    const jar2 = new CookieJar();
    const s2 = await t.request('/auth/google/start?return_to=%2Ftrash', { jar: jar2 });
    const cancelled = await t.request(`/auth/google/callback?error=access_denied&state=${new URL(s2.headers.get('location')!).searchParams.get('state')}`, { jar: jar2 });
    assert.equal(cancelled.headers.get('location'), '/login?error=cancelled&return_to=%2Ftrash');
    assert.match(await (await t.request(cancelled.headers.get('location')!)).text(), /Sign-in was cancelled\./);
  });
});

describe('sign-in configuration', () => {
  const base = { NODE_ENV: 'test', PUBLIC_URL: PUBLIC, ALLOWED_USERS: 'alex@example.com=Alex' };

  test('passwords must be long and belong to allowlisted people', () => {
    assert.throws(() => loadConfig({ ...base, LOGIN_PASSWORDS: 'alex@example.com=short' }), /16 or more characters/);
    assert.throws(() => loadConfig({ ...base, LOGIN_PASSWORDS: 'alex@example.com=has a space in it ok' }), /no spaces/);
    assert.throws(() => loadConfig({ ...base, LOGIN_PASSWORDS: `stranger@example.com=${ALEX_PW}` }), /not in ALLOWED_USERS/);
    // A password with a comma in it is split in two; the half after the comma must not be printed as if it were an email.
    assert.throws(
      () => loadConfig({ ...base, LOGIN_PASSWORDS: `alex@example.com=${ALEX_PW},tail-of-the-secret` }),
      (err: Error) => /LOGIN_PASSWORDS/.test(err.message) && !err.message.includes('tail-of-the-secret'),
    );
    assert.throws(() => loadConfig({ ...base, LOGIN_PASSWORDS: 'alex@example.com' }), /16 or more characters/);
    const cfg = loadConfig({ ...base, LOGIN_PASSWORDS: `Alex@Example.com=${ALEX_PW}=with=equals` });
    assert.equal(cfg.passwordDigests.size, 1);
    assert.equal(loadConfig(base).passwordDigests.size, 0);
  });

  test('the household time zone falls back to UTC, and a made-up zone is refused at start', () => {
    assert.equal(loadConfig(base).tz, 'UTC');
    assert.equal(loadConfig({ ...base, HOUSEHOLD_TZ: 'America/Chicago' }).tz, 'America/Chicago');
    assert.throws(() => loadConfig({ ...base, HOUSEHOLD_TZ: 'America/Nowhere' }), /HOUSEHOLD_TZ "America\/Nowhere" is not a time zone name/);
    assert.throws(() => loadConfig({ ...base, HOUSEHOLD_TZ: 'Mountain Standard Time' }), /is not a time zone name/);
  });

  test('with no method configured the login page says so, and Claude gets a clear message', async () => {
    const t = await startTestApp({}, { google: false });
    try {
      assert.match(await (await t.request('/login')).text(), /Sign-in isn&#39;t set up|Sign-in isn't set up/);
      const res = await login(t, new CookieJar(), { email: 'alex@example.com', password: ALEX_PW });
      assert.equal(res.status, 401);
    } finally {
      await t.close();
    }
  });
});
