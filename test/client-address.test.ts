// Limits on guessing are counted per visitor address, so the address must come from the proxy, never from the
// visitor. Only one header is believed (src/auth/ratelimit.ts), and it is the last address in it that counts.
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { CookieJar, PUBLIC, startTestApp, type TestApp } from './app-helpers.ts';

const PW = 'k7wq-m2xd-9fhp-t4vb-3ncz';
const guess = (t: TestApp, headers: Record<string, string>, password = 'a-wrong-guess-of-some-length') =>
  t.request('/login', {
    jar: new CookieJar(),
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: PUBLIC, ...headers },
    body: new URLSearchParams({ email: 'alex@example.com', password }).toString(),
  });

describe('where a visitor is counted as coming from', () => {
  const apps: TestApp[] = [];
  const start = async (env: Record<string, string> = {}) => {
    const t = await startTestApp({ LOGIN_PASSWORDS: `alex@example.com=${PW}`, ...env }, { google: false });
    apps.push(t);
    return t;
  };
  after(async () => {
    for (const t of apps) await t.close();
  });

  test('a made-up X-Forwarded-For does not buy more guesses', async () => {
    const t = await start();
    for (let i = 0; i < 10; i++) assert.equal((await guess(t, { 'x-forwarded-for': `198.51.100.${i}` })).status, 401);
    assert.equal((await guess(t, { 'x-forwarded-for': '198.51.100.200' }, PW)).status, 429, 'the eleventh try is locked out whatever it claims');
  });

  test("behind another proxy, its header is the one believed, and only the address the proxy added", async () => {
    const t = await start({ CLIENT_IP_HEADER: 'X-Forwarded-For' });
    // The visitor sends a different made-up first address each time; the proxy appends the real one.
    for (let i = 0; i < 10; i++) assert.equal((await guess(t, { 'x-forwarded-for': `10.0.0.${i}, 203.0.113.9` })).status, 401);
    assert.equal((await guess(t, { 'x-forwarded-for': '10.9.9.9, 203.0.113.9' }, PW)).status, 429);
    assert.equal((await guess(t, { 'x-forwarded-for': '203.0.113.9, 192.0.2.44' }, PW)).status, 303, 'someone at another address is not locked out');
  });
});
