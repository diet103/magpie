// The tracker's own OAuth 2.1 authorization server (plan section 5) plus sign-in for the web app:
// a per-person password, "Sign in with Google", or both, depending on what is configured.
import { createHash, timingSafeEqual } from 'node:crypto';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { APP_NAME } from '../brand.ts';
import { html } from 'hono/html';
import { csrf } from 'hono/csrf';
import type { Config } from '../config.ts';
import { run } from '../db/sqlite.ts';
import { findUserByEmail, getUser, type User } from '../domain/users.ts';
import { errorFields, log } from '../log.ts';
import type { AppDeps, AppEnv } from '../types.ts';
import { layout, messagePage } from '../web/layout.ts';
import { ClientError, clientDisplayName, isLoopbackRedirect, redirectAllowed, resolveClient } from './cimd.ts';
import { PKCE_CHALLENGE_RE, PKCE_VERIFIER_RE, pkceChallenge, safeEqual } from './crypto.ts';
import type { GoogleIdentity } from './google.ts';
import { clientIp, RateLimiter, rateLimit } from './ratelimit.ts';
import {
  clearAuthzCookie,
  clearFlowCookie,
  clearSessionCookie,
  currentSession,
  isAllowlisted,
  readAuthzCookie,
  readFlowCookie,
  requireCsrf,
  requireUser,
  safeReturnTo,
  setAuthzCookie,
  setFlowCookie,
  setSessionCookie,
} from './session.ts';

export const SCOPE = 'tracker';
const OTHER_BROWSER = 'This connection request was started in a different browser, or it expired. Start connecting again from Claude on this device.';

function safeEqualOrFalse(a: string | undefined, b: string): boolean {
  return Boolean(a) && safeEqual(a!, b);
}

export function protectedResourceMetadata(cfg: Config) {
  return {
    resource: cfg.mcpUrl,
    authorization_servers: [cfg.issuer],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: APP_NAME,
  };
}

export function authorizationServerMetadata(cfg: Config) {
  return {
    issuer: cfg.issuer,
    authorization_endpoint: `${cfg.publicUrl}/oauth/authorize`,
    token_endpoint: `${cfg.publicUrl}/oauth/token`,
    revocation_endpoint: `${cfg.publicUrl}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    client_id_metadata_document_supported: true,
    scopes_supported: [SCOPE, 'offline_access'],
    authorization_response_iss_parameter_supported: true,
  };
}

export function wwwAuthenticate(cfg: Config, error?: 'invalid_token' | 'insufficient_scope'): string {
  return `Bearer ${error ? `error="${error}", ` : ''}resource_metadata="${cfg.publicUrl}/.well-known/oauth-protected-resource/mcp", scope="${SCOPE}"`;
}

function cimdOptions(deps: AppDeps) {
  return {
    allowedOrigins: deps.config.cimdOrigins,
    allowedRedirects: deps.config.allowedRedirects,
    allowHttp: deps.config.cimdAllowHttp,
    fetchImpl: deps.fetchImpl,
  };
}

function noStore(c: Context) {
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
}

function tokenError(c: Context, error: string, description: string, status: 400 | 401 = 400) {
  noStore(c);
  return c.json({ error, error_description: description }, status);
}

function redirectBack(c: Context, cfg: Config, redirectUri: string, params: Record<string, string | null | undefined>) {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
  u.searchParams.set('iss', cfg.issuer);
  noStore(c);
  return c.redirect(u.toString(), 302);
}

/** We grant one scope whatever was requested; RFC 6749 3.3 lets the server narrow the request. */
function scopeFor(_requested: string | null | undefined): string {
  return SCOPE;
}

/** Maps a verified Google identity to an allowlisted household member, linking the Google sub on first sign-in. */
export function userForIdentity(deps: AppDeps, id: GoogleIdentity): User | { error: string } {
  if (!id.emailVerified || !id.email) return { error: "This Google account can't use this tracker." };
  const bySub = deps.db.prepare('SELECT * FROM users WHERE google_sub = ?').get(id.sub) as User | undefined;
  if (bySub) return isAllowlisted(deps.config, bySub) ? bySub : { error: "This Google account can't use this tracker." };
  if (!deps.config.allowedUsers.some((u) => u.email === id.email)) return { error: "This Google account can't use this tracker." };
  const user = findUserByEmail(deps.db, id.email);
  if (!user) return { error: "This Google account can't use this tracker." };
  if (user.google_sub && user.google_sub !== id.sub) {
    log.warn('google sub mismatch for allowlisted email', { user: user.id });
    return { error: "This Google account can't use this tracker." };
  }
  if (!user.google_sub) run(deps.db, 'UPDATE users SET google_sub = ? WHERE id = ?', id.sub, user.id);
  return getUser(deps.db, user.id)!;
}

export function authRoutes(deps: AppDeps): Hono<AppEnv> {
  const cfg = deps.config;
  const app = new Hono<AppEnv>();
  const perIp = new RateLimiter(cfg.authRateLimit);
  const limitIp: MiddlewareHandler = rateLimit(perIp, (c) => `ip:${clientIp(c)}`);

  // ---- discovery ------------------------------------------------------------------------------
  const prm = (c: Context) => {
    c.header('Access-Control-Allow-Origin', '*');
    c.header('Cache-Control', 'public, max-age=300');
    return c.json(protectedResourceMetadata(cfg));
  };
  app.get('/.well-known/oauth-protected-resource/mcp', prm);
  app.get('/.well-known/oauth-protected-resource', prm);
  app.get('/.well-known/oauth-authorization-server', (c) => {
    c.header('Access-Control-Allow-Origin', '*');
    c.header('Cache-Control', 'public, max-age=300');
    return c.json(authorizationServerMetadata(cfg));
  });

  app.use('/oauth/*', limitIp);
  app.use('/auth/*', limitIp);
  app.post('/login', limitIp);

  const passwordsOn = cfg.passwordDigests.size > 0;
  // Wrong guesses per email address and network address: 10 in 10 minutes, then that pair has to wait.
  // Keyed on both so a stranger who knows an email can't lock its owner out from everywhere.
  const failedLogins = new RateLimiter(10, 10 * 60_000);
  const DUMMY_DIGEST = createHash('sha256').update('no such user').digest();

  // ---- authorization endpoint -----------------------------------------------------------------
  app.get('/oauth/authorize', async (c) => {
    const q = c.req.query();
    const clientId = q.client_id ?? '';
    const redirectUri = q.redirect_uri ?? '';
    // Until the client and redirect URI check out, problems are shown here, never redirected.
    let client;
    try {
      client = await resolveClient(deps.store, clientId, cimdOptions(deps));
    } catch (err) {
      const msg = err instanceof ClientError ? err.message : 'The app asking for access could not be verified.';
      if (!(err instanceof ClientError)) log.error('cimd failure', errorFields(err));
      return c.html(messagePage("Can't connect", msg), 400);
    }
    if (!redirectUri || !redirectAllowed(redirectUri, client, cfg.allowedRedirects)) {
      log.warn('rejected redirect_uri', { client: client.host });
      return c.html(messagePage("Can't connect", 'The app asked to send you back to an address this tracker does not allow.'), 400);
    }
    const back = (error: string, description: string) => redirectBack(c, cfg, redirectUri, { error, error_description: description, state: q.state });
    if (q.response_type !== 'code') return back('unsupported_response_type', 'Only response_type=code is supported.');
    if (q.code_challenge_method !== 'S256') return back('invalid_request', 'PKCE with code_challenge_method=S256 is required.');
    if (!q.code_challenge || !PKCE_CHALLENGE_RE.test(q.code_challenge)) return back('invalid_request', 'code_challenge is missing or malformed.');
    if (q.resource && q.resource !== cfg.mcpUrl) return back('invalid_target', `resource must be ${cfg.mcpUrl}.`);
    const requestId = deps.store.createAuthRequest({
      client_id: clientId,
      redirect_uri: redirectUri,
      state: q.state ?? null,
      code_challenge: q.code_challenge,
      scope: scopeFor(q.scope),
      resource: cfg.mcpUrl,
    });
    setAuthzCookie(c, cfg, requestId);
    const consent = `/oauth/consent?request=${encodeURIComponent(requestId)}`;
    if (currentSession(c, deps)) return c.redirect(consent, 302);
    // With password sign-in on, the login page offers every configured method and then returns to consent.
    if (passwordsOn) return c.redirect(`/login?return_to=${encodeURIComponent(consent)}`, 302);
    return startGoogle(c, 'oauth', { authRequestId: requestId });
  });

  // ---- consent ------------------------------------------------------------------------------
  app.get('/oauth/consent', requireUser(deps), async (c) => {
    const req = deps.store.getAuthRequest(c.req.query('request') ?? '');
    if (!req) return c.html(messagePage('Request expired', 'This sign-in request expired. Start again from Claude.'), 400);
    if (!safeEqualOrFalse(readAuthzCookie(c, cfg), req.id)) return c.html(messagePage('Start again from Claude', OTHER_BROWSER), 400);
    const user = c.get('user');
    const host = new URL(req.client_id).host;
    const loopback = isLoopbackRedirect(req.redirect_uri);
    const redirectOrigin = new URL(req.redirect_uri).origin;
    c.header('Content-Security-Policy', `default-src 'self'; img-src 'self' data:; form-action 'self' ${redirectOrigin}; frame-ancestors 'none'`);
    noStore(c);
    return c.html(
      layout({
        title: 'Allow access?',
        bare: true,
        csrf: c.get('session').csrf_secret,
        body: html`<section class="card narrow consent">
          <h1>Allow <strong>${host}</strong> to read and change your tracker as ${user.display_name}?</h1>
          ${loopback ? html`<p class="warn">A program on this computer (${clientDisplayName(req.client_id)}) is asking.</p>` : ''}
          <p>It will be able to save, search, edit and delete entries in the collections you can see. You can revoke access any time in Settings.</p>
          <p>Only allow this if you pressed Connect in Claude yourself just now. If a link or a message brought you here, press Deny: allowing would connect someone else's Claude to your tracker.</p>
          <form method="post" action="/oauth/consent" class="row">
            <input type="hidden" name="_csrf" value="${c.get('session').csrf_secret}" />
            <input type="hidden" name="request" value="${req.id}" />
            <button type="submit" name="decision" value="deny" class="secondary">Deny</button>
            <button type="submit" name="decision" value="allow">Allow</button>
          </form>
        </section>`,
      }),
    );
  });

  app.post('/oauth/consent', csrf({ origin: cfg.publicUrl }), requireUser(deps), requireCsrf(), async (c) => {
    const body = await c.req.parseBody();
    const requestId = String(body.request ?? '');
    if (!safeEqualOrFalse(readAuthzCookie(c, cfg), requestId)) return c.html(messagePage('Start again from Claude', OTHER_BROWSER), 400);
    clearAuthzCookie(c, cfg);
    const req = deps.store.takeAuthRequest(requestId);
    if (!req) return c.html(messagePage('Request expired', 'This sign-in request expired. Start again from Claude.'), 400);
    if (body.decision !== 'allow') return redirectBack(c, cfg, req.redirect_uri, { error: 'access_denied', error_description: 'The user denied access.', state: req.state });
    const user = c.get('user');
    const code = deps.store.issueCode({
      auth_request_id: req.id,
      user_id: user.id,
      client_id: req.client_id,
      redirect_uri: req.redirect_uri,
      code_challenge: req.code_challenge,
      scope: req.scope,
      resource: req.resource,
    });
    log.info('oauth consent granted', { user: user.id, client: new URL(req.client_id).host });
    return redirectBack(c, cfg, req.redirect_uri, { code, state: req.state });
  });

  // ---- token endpoint -------------------------------------------------------------------------
  app.post('/oauth/token', async (c) => {
    let p: Record<string, string>;
    try {
      p = await formParams(c);
    } catch {
      return tokenError(c, 'invalid_request', 'Send the parameters as application/x-www-form-urlencoded.');
    }
    if (p.client_secret) return tokenError(c, 'invalid_client', 'This server only supports public clients (no client secret).', 401);
    if (p.grant_type === 'authorization_code') {
      if (!p.code || !p.code_verifier || !p.client_id || !p.redirect_uri) {
        return tokenError(c, 'invalid_request', 'code, code_verifier, client_id and redirect_uri are required.');
      }
      if (!PKCE_VERIFIER_RE.test(p.code_verifier)) return tokenError(c, 'invalid_grant', 'Malformed code_verifier.');
      const code = deps.store.takeCode(p.code);
      if (!code) return tokenError(c, 'invalid_grant', 'The authorization code is invalid, expired or already used.');
      if (code.client_id !== p.client_id) return tokenError(c, 'invalid_grant', 'The code was issued to another client.');
      if (code.redirect_uri !== p.redirect_uri) return tokenError(c, 'invalid_grant', 'redirect_uri does not match.');
      if (!safeEqual(pkceChallenge(p.code_verifier), code.code_challenge)) return tokenError(c, 'invalid_grant', 'PKCE verification failed.');
      if (p.resource && p.resource !== (code.resource ?? cfg.mcpUrl)) return tokenError(c, 'invalid_target', `resource must be ${cfg.mcpUrl}.`);
      const user = getUser(deps.db, code.user_id);
      if (!user || !isAllowlisted(cfg, user)) return tokenError(c, 'invalid_grant', 'This user can no longer use the tracker.');
      const t = deps.store.issueTokens({ userId: user.id, clientId: code.client_id, scope: code.scope ?? SCOPE, resource: code.resource ?? cfg.mcpUrl });
      deps.store.bindCodeToFamily(code.code_hash, t.familyId);
      noStore(c);
      return c.json({ access_token: t.access_token, token_type: 'Bearer', expires_in: t.expires_in, refresh_token: t.refresh_token, scope: t.scope });
    }
    if (p.grant_type === 'refresh_token') {
      if (!p.refresh_token || !p.client_id) return tokenError(c, 'invalid_request', 'refresh_token and client_id are required.');
      if (p.resource && p.resource !== cfg.mcpUrl) return tokenError(c, 'invalid_target', `resource must be ${cfg.mcpUrl}.`);
      const out = deps.store.rotateRefresh(p.refresh_token, p.client_id, cfg.mcpUrl);
      if (!out.ok) {
        log.info('refresh refused', { reason: out.reason });
        return tokenError(c, 'invalid_grant', out.reason);
      }
      const user = getUser(deps.db, out.userId);
      if (!user || !isAllowlisted(cfg, user)) {
        deps.store.revokeFamily(out.tokens.familyId);
        return tokenError(c, 'invalid_grant', 'This user can no longer use the tracker.');
      }
      noStore(c);
      return c.json({ access_token: out.tokens.access_token, token_type: 'Bearer', expires_in: out.tokens.expires_in, refresh_token: out.tokens.refresh_token, scope: out.tokens.scope });
    }
    return tokenError(c, 'unsupported_grant_type', 'Use authorization_code or refresh_token.');
  });

  app.post('/oauth/revoke', async (c) => {
    let p: Record<string, string>;
    try {
      p = await formParams(c);
    } catch {
      return tokenError(c, 'invalid_request', 'Send the parameters as application/x-www-form-urlencoded.');
    }
    if (p.token) deps.store.revokeToken(p.token, p.client_id);
    noStore(c);
    return c.body(null, 200);
  });

  // ---- web sign-in ----------------------------------------------------------------------------
  async function startGoogle(c: Context, purpose: 'web' | 'oauth', o: { authRequestId?: string; returnTo?: string }) {
    if (!deps.google.configured) {
      return c.html(messagePage('Sign-in unavailable', 'Google sign-in is not configured on this server yet (GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET).'), 503);
    }
    try {
      const g = await deps.google.start();
      deps.store.createLoginFlow({
        state: g.state,
        nonce: g.nonce,
        code_verifier: g.codeVerifier,
        purpose,
        auth_request_id: o.authRequestId ?? null,
        return_to: o.returnTo ?? null,
      });
      setFlowCookie(c, cfg, g.state);
      noStore(c);
      return c.redirect(g.url.toString(), 302);
    } catch (err) {
      log.error('google start failed', errorFields(err));
      return c.html(messagePage('Sign-in unavailable', "Couldn't reach Google. Try again in a minute."), 502);
    }
  }

  const LOGIN_ERRORS = new Map([['cancelled', 'Sign-in was cancelled.']]);

  function loginPage(c: Context, returnTo: string, o: { error?: string; email?: string; status?: 200 | 401 | 429 } = {}) {
    noStore(c);
    const none = !passwordsOn && !deps.google.configured;
    return c.html(
      layout({
        title: 'Sign in',
        bare: true,
        body: html`<section class="card narrow center">
          <h1>${APP_NAME}</h1>
          <p class="muted">Everything you've told Claude to remember.</p>
          ${o.error ? html`<p class="warn" role="alert">${o.error}</p>` : ''}
          ${passwordsOn
            ? html`<form method="post" action="/login" class="stack login">
                <input type="hidden" name="return_to" value="${returnTo}" />
                <label>Email <input type="email" name="email" value="${o.email ?? ''}" autocomplete="username" autocapitalize="none" required /></label>
                <label>Password <input type="password" name="password" autocomplete="current-password" required /></label>
                <button class="big">Sign in</button>
              </form>`
            : ''}
          ${deps.google.configured
            ? html`<p><a class="button big ${passwordsOn ? 'secondary' : ''}" href="/auth/google/start?return_to=${encodeURIComponent(returnTo)}">Sign in with Google</a></p>`
            : ''}
          ${none ? html`<p class="warn">Sign-in isn't set up on this server yet. Run setup again, or set LOGIN_PASSWORDS or the Google keys.</p>` : ''}
        </section>`,
      }),
      o.status ?? 200,
    );
  }

  app.get('/login', (c) => {
    const returnTo = safeReturnTo(c.req.query('return_to'));
    if (currentSession(c, deps)) return c.redirect(returnTo, 302);
    return loginPage(c, returnTo, { error: LOGIN_ERRORS.get(c.req.query('error') ?? '') });
  });

  // Password sign-in. The Origin check stops other sites from signing a browser in; the per-IP and
  // per-email limits stop guessing.
  app.post('/login', csrf({ origin: cfg.publicUrl }), async (c) => {
    const body = await c.req.parseBody();
    const returnTo = safeReturnTo(typeof body.return_to === 'string' ? body.return_to : '/');
    if (!passwordsOn) return loginPage(c, returnTo, { error: 'Password sign-in is not turned on.', status: 401 });
    const email = (typeof body.email === 'string' ? body.email : '').trim().toLowerCase().slice(0, 254);
    const password = typeof body.password === 'string' ? body.password : '';
    const attemptKey = `${email}|${clientIp(c)}`;
    const wait = failedLogins.blocked(attemptKey);
    if (wait > 0) {
      c.header('Retry-After', String(wait));
      return loginPage(c, returnTo, { error: `Too many wrong passwords. Try again in ${Math.ceil(wait / 60)} minutes.`, email, status: 429 });
    }
    const expected = cfg.passwordDigests.get(email);
    const given = createHash('sha256').update(password, 'utf8').digest();
    const matches = timingSafeEqual(given, expected ?? DUMMY_DIGEST);
    const user = expected && matches ? findUserByEmail(deps.db, email) : undefined;
    if (!user || !isAllowlisted(cfg, user)) {
      failedLogins.take(attemptKey);
      log.warn('password sign-in failed', { known: Boolean(expected) });
      return loginPage(c, returnTo, { error: 'Wrong email or password.', email, status: 401 });
    }
    failedLogins.reset(attemptKey);
    const old = currentSession(c, deps);
    if (old) deps.store.deleteSession(old.id);
    const session = deps.store.createSession(user.id, c.req.header('user-agent') ?? null);
    setSessionCookie(c, cfg, session.id);
    log.info('signed in', { user: user.id, purpose: 'password' });
    noStore(c);
    return c.redirect(returnTo, 303);
  });

  app.get('/auth/google/start', (c) => startGoogle(c, 'web', { returnTo: safeReturnTo(c.req.query('return_to')) }));

  app.get('/auth/google/callback', async (c) => {
    const url = new URL(c.req.url);
    const state = url.searchParams.get('state') ?? '';
    const cookieState = readFlowCookie(c, cfg);
    clearFlowCookie(c, cfg);
    if (!state || !cookieState || !safeEqual(state, cookieState)) {
      return c.html(messagePage('Sign-in failed', 'This sign-in started in a different browser or expired. Try again.', html`<p><a class="button" href="/login">Sign in</a></p>`), 400);
    }
    const flow = deps.store.takeLoginFlow(state);
    if (!flow) return c.html(messagePage('Sign-in failed', 'This sign-in expired. Try again.', html`<p><a class="button" href="/login">Sign in</a></p>`), 400);
    const authReq = flow.auth_request_id ? deps.store.getAuthRequest(flow.auth_request_id) : undefined;
    if (url.searchParams.get('error')) {
      if (authReq) {
        deps.store.takeAuthRequest(authReq.id);
        return redirectBack(c, cfg, authReq.redirect_uri, { error: 'access_denied', error_description: 'Sign-in was cancelled.', state: authReq.state });
      }
      return c.redirect(`/login?error=cancelled&return_to=${encodeURIComponent(safeReturnTo(flow.return_to))}`, 302);
    }
    // Rebuild the URL Google redirected to from PUBLIC_URL, so a proxy's internal host never breaks the check.
    const callbackUrl = new URL(`${cfg.publicUrl}/auth/google/callback${url.search}`);
    let identity: GoogleIdentity;
    try {
      identity = await deps.google.finish(callbackUrl, { state: flow.state, nonce: flow.nonce, codeVerifier: flow.code_verifier });
    } catch (err) {
      log.warn('google callback failed', errorFields(err));
      return c.html(messagePage('Sign-in failed', "Google sign-in didn't complete. Try again.", html`<p><a class="button" href="/login">Sign in</a></p>`), 400);
    }
    const user = userForIdentity(deps, identity);
    if ('error' in user) {
      if (authReq) deps.store.takeAuthRequest(authReq.id);
      return c.html(messagePage('Not allowed', user.error), 403);
    }
    const old = currentSession(c, deps);
    if (old) deps.store.deleteSession(old.id);
    const session = deps.store.createSession(user.id, c.req.header('user-agent') ?? null);
    setSessionCookie(c, cfg, session.id);
    log.info('signed in', { user: user.id, purpose: flow.purpose });
    if (flow.purpose === 'oauth') {
      if (!authReq) return c.html(messagePage('Request expired', 'This sign-in request expired. Start again from Claude.'), 400);
      return c.redirect(`/oauth/consent?request=${encodeURIComponent(authReq.id)}`, 302);
    }
    return c.redirect(safeReturnTo(flow.return_to), 302);
  });

  app.post('/logout', csrf({ origin: cfg.publicUrl }), requireUser(deps), requireCsrf(), (c) => {
    deps.store.deleteSession(c.get('sessionId'));
    clearSessionCookie(c, cfg);
    c.header('Clear-Site-Data', '"cache"');
    return c.redirect('/login', 302);
  });

  return app;
}

async function formParams(c: Context): Promise<Record<string, string>> {
  const type = c.req.header('content-type') ?? '';
  if (type.includes('application/json')) {
    const j = (await c.req.json()) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(j).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
  }
  if (!type.includes('application/x-www-form-urlencoded') && !type.includes('multipart/form-data')) throw new Error('bad content type');
  const body = await c.req.parseBody();
  return Object.fromEntries(Object.entries(body).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
}

