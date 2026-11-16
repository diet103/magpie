// In-process app + fake Google (a tiny OIDC provider signed with jose) + fake CIMD documents + a cookie jar.
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createApp } from '../src/app.ts';
import { GoogleSignIn } from '../src/auth/google.ts';
import { AuthStore } from '../src/auth/store.ts';
import { loadConfig } from '../src/config.ts';
import { openAuthDb, openTrackerDb } from '../src/db/sqlite.ts';
import { syncUsers } from '../src/domain/users.ts';
import type { AppDeps } from '../src/types.ts';
import { TEST_FILES_KEY } from './helpers.ts';

export const PUBLIC = 'https://tracker.test';
export const CLAUDE_CODE_CIMD = 'https://claude.ai/oauth/claude-code-client-metadata';
export const HOSTED_CIMD = 'https://claude.ai/oauth/mcp-oauth-client-metadata';
export const HOSTED_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

export interface FakeGoogle {
  issuer: string;
  issueCode(id: { sub: string; email: string; email_verified?: boolean; nonce: string; name?: string }): string;
  close(): Promise<void>;
}

export async function startFakeGoogle(clientId: string): Promise<FakeGoogle> {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const codes = new Map<string, { sub: string; email: string; email_verified?: boolean; nonce: string; name?: string }>();
  let issuer = '';
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', issuer);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
      });
    }
    if (url.pathname === '/jwks') return json(200, { keys: [jwk] });
    if (url.pathname === '/token' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const p = new URLSearchParams(body);
      const id = codes.get(p.get('code') ?? '');
      if (!id || !p.get('code_verifier')) return json(400, { error: 'invalid_grant' });
      codes.delete(p.get('code')!);
      const idToken = await new SignJWT({ email: id.email, email_verified: id.email_verified ?? true, nonce: id.nonce, name: id.name ?? 'Test' })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(issuer)
        .setAudience(clientId)
        .setSubject(id.sub)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
      return json(200, { access_token: 'google-access', token_type: 'Bearer', expires_in: 3600, id_token: idToken });
    }
    json(404, { error: 'not_found' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let n = 0;
  return {
    issuer,
    issueCode(id) {
      const code = `gcode-${++n}`;
      codes.set(code, id);
      return code;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

export function fakeCimdFetch(): typeof fetch {
  const docs: Record<string, unknown> = {
    [CLAUDE_CODE_CIMD]: {
      client_id: CLAUDE_CODE_CIMD,
      client_name: 'Claude Code',
      redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    },
    [HOSTED_CIMD]: {
      client_id: HOSTED_CIMD,
      client_name: 'Claude',
      redirect_uris: [HOSTED_CALLBACK],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    },
    'https://claude.ai/oauth/mismatch': { client_id: 'https://claude.ai/oauth/other', redirect_uris: [HOSTED_CALLBACK], token_endpoint_auth_method: 'none' },
    'https://claude.ai/oauth/evil-redirect': { client_id: 'https://claude.ai/oauth/evil-redirect', redirect_uris: ['https://evil.example/cb'], token_endpoint_auth_method: 'none' },
  };
  return (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith('/oauth/blocked')) return new Response('Forbidden', { status: 403 });
    if (url in docs) return new Response(JSON.stringify(docs[url]), { headers: { 'content-type': 'application/json' } });
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

export class CookieJar {
  private jar = new Map<string, string>();
  store(res: Response) {
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const expired = attrs.some((a) => /max-age=0\b/i.test(a.trim()) || /expires=thu, 01 jan 1970/i.test(a.trim()));
      if (expired || value === '') this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }
  header(): string {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  get(name: string) {
    return this.jar.get(name);
  }
  clear() {
    this.jar.clear();
  }
}

export interface TestApp {
  deps: AppDeps;
  google: FakeGoogle;
  request: (path: string, init?: RequestInit & { jar?: CookieJar }) => Promise<Response>;
  fetch: typeof fetch;
  close: () => Promise<void>;
}

export async function startTestApp(extraEnv: Record<string, string> = {}, opts: { google?: boolean } = {}): Promise<TestApp> {
  const withGoogle = opts.google ?? true;
  const google = await startFakeGoogle('google-client');
  const dir = mkdtempSync(join(tmpdir(), 'tracker-app-'));
  const config = loadConfig({
    NODE_ENV: 'test',
    PUBLIC_URL: PUBLIC,
    DATA_DIR: dir,
    ALLOWED_USERS: 'alex@example.com=Alex,sam@example.com=Sam',
    ...(withGoogle ? { GOOGLE_CLIENT_ID: 'google-client', GOOGLE_CLIENT_SECRET: 'google-secret' } : {}),
    GOOGLE_ISSUER: google.issuer,
    TEST_ALLOW_INSECURE_OIDC: '1',
    AUTH_RATE_LIMIT: '100000',
    ...extraEnv,
  });
  const db = openTrackerDb(config.trackerDbPath, true, config.filesKey ?? TEST_FILES_KEY);
  syncUsers(db, config.allowedUsers);
  const authDb = openAuthDb(config.authDbPath);
  const deps: AppDeps = {
    config,
    db,
    store: new AuthStore(authDb),
    google: new GoogleSignIn({
      issuer: google.issuer,
      clientId: withGoogle ? 'google-client' : undefined,
      clientSecret: withGoogle ? 'google-secret' : undefined,
      redirectUri: `${PUBLIC}/auth/google/callback`,
      allowInsecure: true,
    }),
    startedAt: new Date(),
    fetchImpl: fakeCimdFetch(),
    backups: { lastSnapshotAt: null, lastSnapshotError: null },
  };
  const { app, close } = createApp(deps);
  const request = async (path: string, init: RequestInit & { jar?: CookieJar } = {}) => {
    const headers = new Headers(init.headers);
    if (init.jar && init.jar.header()) headers.set('cookie', init.jar.header());
    const res = await app.request(path.startsWith('http') ? path : `${PUBLIC}${path}`, { ...init, headers, redirect: 'manual' });
    init.jar?.store(res);
    return res;
  };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    return app.request(req);
  }) as typeof fetch;
  return {
    deps,
    google,
    request,
    fetch: fetchImpl,
    close: async () => {
      await close();
      await google.close();
      db.close();
      authDb.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Plays the browser: authorize URL -> Google -> consent -> redirect back to the client. Returns the redirect URL. */
export async function browserAuthorize(
  t: TestApp,
  authorizeUrl: string,
  who: { sub: string; email: string; email_verified?: boolean },
  opts: { jar?: CookieJar; decision?: 'allow' | 'deny' } = {},
): Promise<{ final: URL | null; jar: CookieJar; status: number; body?: string }> {
  const jar = opts.jar ?? new CookieJar();
  let res = await t.request(authorizeUrl, { jar });
  if (res.status !== 302) return { final: null, jar, status: res.status, body: await res.text() };
  let loc = new URL(res.headers.get('location')!, PUBLIC);
  if (loc.origin === new URL(t.google.issuer).origin) {
    const code = t.google.issueCode({ ...who, nonce: loc.searchParams.get('nonce')! });
    res = await t.request(`/auth/google/callback?code=${code}&state=${loc.searchParams.get('state')}`, { jar });
    if (res.status !== 302) return { final: null, jar, status: res.status, body: await res.text() };
    loc = new URL(res.headers.get('location')!, PUBLIC);
  }
  if (loc.origin !== PUBLIC || loc.pathname !== '/oauth/consent') return { final: loc, jar, status: res.status };
  res = await t.request(loc.pathname + loc.search, { jar });
  const page = await res.text();
  if (res.status !== 200) return { final: null, jar, status: res.status, body: page };
  const csrf = /name="_csrf" value="([^"]+)"/.exec(page)![1];
  const request = /name="request" value="([^"]+)"/.exec(page)![1];
  res = await t.request('/oauth/consent', {
    jar,
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: PUBLIC },
    body: new URLSearchParams({ _csrf: csrf, request, decision: opts.decision ?? 'allow' }).toString(),
  });
  return { final: res.status === 302 ? new URL(res.headers.get('location')!) : null, jar, status: res.status, body: res.status === 302 ? undefined : await res.text() };
}

export async function signInWeb(t: TestApp, who: { sub: string; email: string }): Promise<CookieJar> {
  const jar = new CookieJar();
  let res = await t.request('/auth/google/start?return_to=/', { jar });
  const loc = new URL(res.headers.get('location')!);
  const code = t.google.issueCode({ ...who, nonce: loc.searchParams.get('nonce')! });
  res = await t.request(`/auth/google/callback?code=${code}&state=${loc.searchParams.get('state')}`, { jar });
  if (res.status !== 302) throw new Error(`sign-in failed: ${res.status} ${await res.text()}`);
  return jar;
}

export const ALEX = { sub: 'google-sub-alex', email: 'alex@example.com' };
export const SAM = { sub: 'google-sub-sam', email: 'sam@example.com' };
