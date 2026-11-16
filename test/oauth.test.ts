import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Client, StreamableHTTPClientTransport, UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/client';
import { pkceChallenge } from '../src/auth/crypto.ts';
import { run } from '../src/db/sqlite.ts';
import {
  browserAuthorize,
  CLAUDE_CODE_CIMD,
  CookieJar,
  ALEX,
  SAM,
  HOSTED_CALLBACK,
  HOSTED_CIMD,
  PUBLIC,
  signInWeb,
  startTestApp,
  type TestApp,
} from './app-helpers.ts';

let t: TestApp;
before(async () => {
  t = await startTestApp();
});
after(async () => {
  await t.close();
});

function authorizeUrl(o: { clientId?: string; redirect?: string; challenge?: string; method?: string; state?: string; resource?: string; responseType?: string } = {}) {
  const p = new URLSearchParams({
    response_type: o.responseType ?? 'code',
    client_id: o.clientId ?? HOSTED_CIMD,
    redirect_uri: o.redirect ?? HOSTED_CALLBACK,
    code_challenge: o.challenge ?? pkceChallenge('v'.repeat(50)),
    code_challenge_method: o.method ?? 'S256',
    state: o.state ?? 'st-123',
    scope: 'tracker',
    resource: o.resource ?? `${PUBLIC}/mcp`,
  });
  return `/oauth/authorize?${p}`;
}

async function token(params: Record<string, string>) {
  const res = await t.request('/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  return { res, body: (await res.json()) as Record<string, string> };
}

async function mcpStatus(accessToken: string) {
  const res = await t.request('/mcp', {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {}, }),
  });
  return res.status;
}

async function hostedCode(who = ALEX, verifier = 'v'.repeat(50)) {
  const r = await browserAuthorize(t, authorizeUrl({ challenge: pkceChallenge(verifier) }), who);
  assert.ok(r.final, `authorize failed: ${r.status} ${r.body ?? ''}`);
  return r.final!;
}

describe('discovery and 401', () => {
  test('the discovery documents tell a client where to sign in and what is supported', async () => {
    for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
      const prm = await (await t.request(path)).json();
      assert.deepEqual(prm, {
        resource: `${PUBLIC}/mcp`,
        authorization_servers: [PUBLIC],
        scopes_supported: ['tracker'],
        bearer_methods_supported: ['header'],
        resource_name: 'Magpie',
      });
    }
    const as = (await (await t.request('/.well-known/oauth-authorization-server')).json()) as Record<string, unknown>;
    assert.equal(as.issuer, PUBLIC);
    assert.equal(as.client_id_metadata_document_supported, true);
    assert.deepEqual(as.token_endpoint_auth_methods_supported, ['none']);
    assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
    assert.equal(as.authorization_response_iss_parameter_supported, true);
    assert.equal(as.registration_endpoint, undefined);
  });

  test('/mcp answers 401 with the challenge header', async () => {
    const res = await t.request('/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('www-authenticate'), `Bearer resource_metadata="${PUBLIC}/.well-known/oauth-protected-resource/mcp", scope="tracker"`);
    const bad = await mcpStatus('tma_at_nope');
    assert.equal(bad, 401);
  });

  test('security headers and host pinning', async () => {
    const res = await t.request('/login');
    assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'self'.*frame-ancestors 'none'/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.match(res.headers.get('strict-transport-security') ?? '', /max-age=/);
    const wrongHost = await t.request('https://evil.test/login');
    assert.equal(wrongHost.status, 421);
    assert.equal((await t.request('https://10.0.0.1/healthz')).status, 200);
  });
});

describe('connecting Claude (CIMD + PKCE + Google)', () => {
  test('Claude Code style: the SDK client does discovery, PKCE, token exchange and tool calls', async () => {
    const saved: { tokens?: Parameters<OAuthClientProvider['saveTokens']>[0]; verifier?: string; authUrl?: URL; client?: { client_id: string } } = {};
    const redirect = 'http://localhost:47123/callback';
    const provider: OAuthClientProvider = {
      get redirectUrl() {
        return redirect;
      },
      clientMetadataUrl: CLAUDE_CODE_CIMD,
      get clientMetadata() {
        return { client_name: 'Claude Code', redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' };
      },
      clientInformation: () => saved.client as never,
      saveClientInformation: (info) => {
        saved.client = info as { client_id: string };
      },
      tokens: () => saved.tokens,
      saveTokens: (tk) => {
        saved.tokens = tk;
      },
      redirectToAuthorization: (url) => {
        saved.authUrl = url;
      },
      saveCodeVerifier: (v) => {
        saved.verifier = v;
      },
      codeVerifier: () => saved.verifier!,
    };
    const transport = new StreamableHTTPClientTransport(new URL(`${PUBLIC}/mcp`), { authProvider: provider, fetch: t.fetch });
    const client = new Client({ name: 'oauth-test', version: '1' });
    await assert.rejects(client.connect(transport), UnauthorizedError);
    assert.ok(saved.authUrl);
    assert.equal(saved.authUrl.searchParams.get('client_id'), CLAUDE_CODE_CIMD);
    assert.equal(saved.authUrl.searchParams.get('resource'), `${PUBLIC}/mcp`);
    const r = await browserAuthorize(t, saved.authUrl.toString(), ALEX);
    assert.ok(r.final, `browser flow failed: ${r.status} ${r.body}`);
    assert.equal(r.final.origin, 'http://localhost:47123');
    assert.equal(r.final.searchParams.get('iss'), PUBLIC);
    await transport.finishAuth(r.final.searchParams);
    const client2 = new Client({ name: 'oauth-test', version: '1' });
    await client2.connect(new StreamableHTTPClientTransport(new URL(`${PUBLIC}/mcp`), { authProvider: provider, fetch: t.fetch }));
    const out = await client2.callTool({ name: 'list_collections', arguments: {} });
    assert.match((out.content as { text: string }[])[0].text, /Acting for: Alex\./);
    await client2.close();
  });

  test('hosted Claude: code exchange, refresh rotation, grace window, reuse detection, revocation', async () => {
    const verifier = 'w'.repeat(60);
    const back = await hostedCode(ALEX, verifier);
    assert.equal(back.origin + back.pathname, HOSTED_CALLBACK);
    assert.equal(back.searchParams.get('state'), 'st-123');
    assert.equal(back.searchParams.get('iss'), PUBLIC);
    const code = back.searchParams.get('code')!;

    const bad = await token({ grant_type: 'authorization_code', code, code_verifier: 'x'.repeat(60), client_id: HOSTED_CIMD, redirect_uri: HOSTED_CALLBACK });
    assert.equal(bad.body.error, 'invalid_grant');
    // the failed attempt consumed the code: single use, no retries with other verifiers
    const again = await token({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: HOSTED_CIMD, redirect_uri: HOSTED_CALLBACK });
    assert.equal(again.body.error, 'invalid_grant');

    const code2 = (await hostedCode(ALEX, verifier)).searchParams.get('code')!;
    const ok = await token({ grant_type: 'authorization_code', code: code2, code_verifier: verifier, client_id: HOSTED_CIMD, redirect_uri: HOSTED_CALLBACK, resource: `${PUBLIC}/mcp` });
    assert.equal(ok.res.status, 200);
    assert.equal(ok.res.headers.get('cache-control'), 'no-store');
    assert.equal(ok.body.token_type, 'Bearer');
    assert.equal(Number(ok.body.expires_in), 3600);
    assert.match(ok.body.access_token, /^tma_at_/);
    assert.match(ok.body.refresh_token, /^tma_rt_/);
    assert.equal(await mcpStatus(ok.body.access_token), 200);
    const reuse = await token({ grant_type: 'authorization_code', code: code2, code_verifier: verifier, client_id: HOSTED_CIMD, redirect_uri: HOSTED_CALLBACK });
    assert.equal(reuse.body.error, 'invalid_grant');
    // a replayed code revokes the tokens it produced
    assert.equal(await mcpStatus(ok.body.access_token), 401);
    const afterReplay = await token({ grant_type: 'refresh_token', refresh_token: ok.body.refresh_token, client_id: HOSTED_CIMD });
    assert.equal(afterReplay.body.error, 'invalid_grant');
    const fresh = await token({ grant_type: 'authorization_code', code: (await hostedCode(ALEX, verifier)).searchParams.get('code')!, code_verifier: verifier, client_id: HOSTED_CIMD, redirect_uri: HOSTED_CALLBACK });
    ok.body.access_token = fresh.body.access_token;
    ok.body.refresh_token = fresh.body.refresh_token;

    const r1 = await token({ grant_type: 'refresh_token', refresh_token: ok.body.refresh_token, client_id: HOSTED_CIMD });
    assert.equal(r1.res.status, 200);
    assert.notEqual(r1.body.refresh_token, ok.body.refresh_token);
    // a lost response: the old refresh token again within 60 s gets a fresh pair, and r1's refresh token dies
    const r2 = await token({ grant_type: 'refresh_token', refresh_token: ok.body.refresh_token, client_id: HOSTED_CIMD });
    assert.equal(r2.res.status, 200);
    assert.equal(await mcpStatus(r1.body.access_token), 401);
    assert.equal(await mcpStatus(r2.body.access_token), 200);
    // wrong client
    const wrongClient = await token({ grant_type: 'refresh_token', refresh_token: r2.body.refresh_token, client_id: CLAUDE_CODE_CIMD });
    assert.equal(wrongClient.body.error, 'invalid_grant');
    // r2 rotates normally
    const r3 = await token({ grant_type: 'refresh_token', refresh_token: r2.body.refresh_token, client_id: HOSTED_CIMD });
    assert.equal(r3.res.status, 200);
    // reuse of r2 outside the grace window revokes the whole family
    run(t.deps.store.db, 'UPDATE tokens SET rotated_at = ? WHERE rotated_at IS NOT NULL', new Date(Date.now() - 5 * 60_000).toISOString());
    const stolen = await token({ grant_type: 'refresh_token', refresh_token: r2.body.refresh_token, client_id: HOSTED_CIMD });
    assert.equal(stolen.body.error, 'invalid_grant');
    assert.match(stolen.body.error_description, /reuse detected/);
    assert.equal(await mcpStatus(r3.body.access_token), 401);
    const r4 = await token({ grant_type: 'refresh_token', refresh_token: r3.body.refresh_token, client_id: HOSTED_CIMD });
    assert.equal(r4.body.error, 'invalid_grant');

    // Two holders of one refresh token: the second to use it (within the grace window) gets the live pair, and
    // the first holder's pair is revoked. When that revoked token is then presented, somebody has a copy they
    // should not, so the whole connection ends rather than leaving the second holder's line alive.
    const two = await token({ grant_type: 'authorization_code', code: (await hostedCode(ALEX, verifier)).searchParams.get('code')!, code_verifier: verifier, client_id: HOSTED_CIMD, redirect_uri: HOSTED_CALLBACK });
    const first = await token({ grant_type: 'refresh_token', refresh_token: two.body.refresh_token, client_id: HOSTED_CIMD });
    const second = await token({ grant_type: 'refresh_token', refresh_token: two.body.refresh_token, client_id: HOSTED_CIMD });
    assert.equal(second.res.status, 200);
    const loser = await token({ grant_type: 'refresh_token', refresh_token: first.body.refresh_token, client_id: HOSTED_CIMD });
    assert.equal(loser.body.error, 'invalid_grant');
    assert.equal(await mcpStatus(second.body.access_token), 401);
    assert.equal((await token({ grant_type: 'refresh_token', refresh_token: second.body.refresh_token, client_id: HOSTED_CIMD })).body.error, 'invalid_grant');

    // revocation (RFC 7009)
    const code3 = (await hostedCode(SAM, verifier)).searchParams.get('code')!;
    const em = await token({ grant_type: 'authorization_code', code: code3, code_verifier: verifier, client_id: HOSTED_CIMD, redirect_uri: HOSTED_CALLBACK });
    assert.equal(await mcpStatus(em.body.access_token), 200);
    const rev = await t.request('/oauth/revoke', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: em.body.refresh_token, client_id: HOSTED_CIMD }).toString() });
    assert.equal(rev.status, 200);
    assert.equal(await mcpStatus(em.body.access_token), 401);
  });

  test('token endpoint input checks', async () => {
    const json = await t.request('/oauth/token', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' });
    assert.equal(json.status, 400);
    assert.equal((await token({ grant_type: 'password', username: 'a' })).body.error, 'unsupported_grant_type');
    assert.equal((await token({ grant_type: 'authorization_code', code: 'x' })).body.error, 'invalid_request');
    assert.equal((await token({ grant_type: 'client_credentials', client_secret: 's' })).body.error, 'invalid_client');
    const verifier = 'z'.repeat(50);
    const code = (await hostedCode(ALEX, verifier)).searchParams.get('code')!;
    assert.equal((await token({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: HOSTED_CIMD, redirect_uri: 'https://claude.com/api/mcp/auth_callback' })).body.error, 'invalid_grant');
  });
});

describe('authorization request validation', () => {
  test('bad clients and redirect URIs get an error page, never a redirect', async () => {
    const cases = [
      authorizeUrl({ clientId: 'https://evil.example/client' }),
      authorizeUrl({ clientId: 'http://claude.ai/oauth/mcp-oauth-client-metadata' }),
      authorizeUrl({ clientId: 'not a url' }),
      authorizeUrl({ clientId: 'https://claude.ai/oauth/mismatch' }),
      authorizeUrl({ clientId: 'https://claude.ai/oauth/unknown' }),
      authorizeUrl({ redirect: 'https://claude.ai/api/mcp/other' }),
      authorizeUrl({ clientId: 'https://claude.ai/oauth/evil-redirect', redirect: 'https://evil.example/cb' }),
      authorizeUrl({ clientId: CLAUDE_CODE_CIMD, redirect: 'http://localhost:5000/other' }),
      authorizeUrl({ clientId: CLAUDE_CODE_CIMD, redirect: 'http://evil.example/callback' }),
    ];
    for (const url of cases) {
      const res = await t.request(url);
      assert.equal(res.status, 400, url);
      assert.equal(res.headers.get('location'), null, url);
    }
    // loopback with any port is fine
    const ok = await t.request(authorizeUrl({ clientId: CLAUDE_CODE_CIMD, redirect: 'http://127.0.0.1:61234/callback' }));
    assert.equal(ok.status, 302);
  });

  test('when claude.ai refuses to serve the metadata document, the built-in redirect allowlist still applies', async () => {
    const blocked = 'https://claude.ai/oauth/blocked';
    const ok = await t.request(authorizeUrl({ clientId: blocked }));
    assert.equal(ok.status, 302);
    assert.notEqual(new URL(ok.headers.get('location')!, PUBLIC).origin, 'https://evil.example');
    // A program on the same device may only be sent a code when the client is the one known to run there
    // (Claude Code). Any other claude.ai address that fails to load gets Claude's hosted callback and nothing else.
    for (const redirect of ['https://evil.example/cb', 'https://claude.ai/other', 'http://localhost:5555/other', 'http://127.0.0.1:5555/callback', 'http://localhost:5555/callback']) {
      const res = await t.request(authorizeUrl({ clientId: blocked, redirect }));
      assert.equal(res.status, 400, redirect);
      assert.equal(res.headers.get('location'), null);
    }
    // other origins are still refused outright
    assert.equal((await t.request(authorizeUrl({ clientId: 'https://evil.example/oauth/blocked' }))).status, 400);
  });

  test('after the redirect URI checks out, errors go back with state and iss', async () => {
    const check = async (url: string, error: string) => {
      const res = await t.request(url);
      assert.equal(res.status, 302, url);
      const loc = new URL(res.headers.get('location')!);
      assert.equal(loc.origin + loc.pathname, HOSTED_CALLBACK);
      assert.equal(loc.searchParams.get('error'), error);
      assert.equal(loc.searchParams.get('state'), 'st-123');
      assert.equal(loc.searchParams.get('iss'), PUBLIC);
    };
    await check(authorizeUrl({ method: 'plain' }), 'invalid_request');
    await check(authorizeUrl({ challenge: 'short' }), 'invalid_request');
    await check(authorizeUrl({ responseType: 'token' }), 'unsupported_response_type');
    await check(authorizeUrl({ resource: 'https://other.example/mcp' }), 'invalid_target');
  });

  test('denied consent, non-allowlisted and unverified accounts, missing flow cookie', async () => {
    const denied = await browserAuthorize(t, authorizeUrl(), ALEX, { decision: 'deny' });
    assert.equal(denied.final?.searchParams.get('error'), 'access_denied');
    assert.equal(denied.final?.searchParams.get('iss'), PUBLIC);

    const stranger = await browserAuthorize(t, authorizeUrl(), { sub: 'g-x', email: 'stranger@example.com' });
    assert.equal(stranger.status, 403);
    assert.match(stranger.body ?? '', /This Google account can&#39;t use this tracker|This Google account can't use this tracker/);
    const unverified = await browserAuthorize(t, authorizeUrl(), { sub: 'g-y', email: 'alex@example.com', email_verified: false });
    assert.equal(unverified.status, 403);
    // someone else's Google account claiming Alex's email after his sub is linked
    await signInWeb(t, ALEX);
    const impostor = await browserAuthorize(t, authorizeUrl(), { sub: 'g-impostor', email: 'alex@example.com' });
    assert.equal(impostor.status, 403);

    const jar = new CookieJar();
    const start = await t.request('/auth/google/start', { jar });
    const loc = new URL(start.headers.get('location')!);
    const code = t.google.issueCode({ ...ALEX, nonce: loc.searchParams.get('nonce')! });
    const noCookie = await t.request(`/auth/google/callback?code=${code}&state=${loc.searchParams.get('state')}`);
    assert.equal(noCookie.status, 400);
  });

  test('an existing web session skips Google and goes straight to consent', async () => {
    const jar = await signInWeb(t, SAM);
    const res = await t.request(authorizeUrl(), { jar });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location')!, /^\/oauth\/consent\?request=/);
    const page = await t.request(res.headers.get('location')!, { jar });
    const html = await page.text();
    assert.match(html, /Allow <strong>claude\.ai<\/strong> to read and change your tracker as Sam\?/);
    assert.match(page.headers.get('content-security-policy') ?? '', /form-action 'self' https:\/\/claude\.ai/);
    // the same consent link opened in another signed-in browser is refused
    const other = await signInWeb(t, ALEX);
    const forwarded = await t.request(res.headers.get('location')!, { jar: other });
    assert.equal(forwarded.status, 400);
    assert.match(await forwarded.text(), /different browser/);
  });
});

describe('web sessions', () => {
  test('pages need a session; forms need the CSRF token', async () => {
    const anon = await t.request('/');
    assert.equal(anon.status, 302);
    assert.equal(anon.headers.get('location'), '/login?return_to=%2F');
    const jar = await signInWeb(t, ALEX);
    assert.match(jar.get('__Host-tracker_session') ?? '', /.+/);
    const home = await t.request('/', { jar });
    assert.equal(home.status, 200);
    assert.equal(home.headers.get('cache-control'), 'private, no-store');
    const html = await home.text();
    assert.match(html, /Collections/);
    const csrf = /<meta name="csrf-token" content="([^"]+)"/.exec(html)![1];
    const noToken = await t.request('/collections', { jar, method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: PUBLIC }, body: 'name=X&description=Y' });
    assert.equal(noToken.status, 403);
    const crossSite = await t.request('/collections', { jar, method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example' }, body: `name=X&description=Y&_csrf=${csrf}` });
    assert.equal(crossSite.status, 403);
    const created = await t.request('/collections', { jar, method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: PUBLIC }, body: `name=Hikes&description=Trails&_csrf=${csrf}` });
    assert.equal(created.status, 303);
    // open redirects are refused
    const evil = await t.request('/login?return_to=//evil.example', { jar });
    assert.equal(evil.headers.get('location'), '/');
    // sign out
    const out = await t.request('/logout', { jar, method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: PUBLIC }, body: `_csrf=${csrf}` });
    assert.equal(out.status, 302);
    assert.equal((await t.request('/', { jar })).status, 302);
  });

  test('personal access tokens work on /mcp only', async () => {
    const user = t.deps.db.prepare("SELECT id FROM users WHERE email = 'sam@example.com'").get() as { id: number };
    const { token: pat } = t.deps.store.createPat(user.id, 'smoke', 60 * 60_000);
    assert.equal(await mcpStatus(pat), 200);
    const web = await t.request('/', { headers: { authorization: `Bearer ${pat}` } });
    assert.equal(web.status, 302);
  });
});
