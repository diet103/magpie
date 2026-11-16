import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Config } from '../config.ts';
import { getUser, type User } from '../domain/users.ts';
import type { AppDeps, AppEnv } from '../types.ts';
import { safeEqual, sha256 } from './crypto.ts';
import { LIFETIME, type Session } from './store.ts';

const SESSION = 'tracker_session';
const FLOW = 'tracker_flow';
const AUTHZ = 'tracker_authz';

/** __Host- cookies need HTTPS; plain-HTTP development uses unprefixed, non-Secure cookies. */
function secure(cfg: Config) {
  return cfg.publicUrl.startsWith('https://');
}

function opts(cfg: Config, maxAgeSec: number) {
  return secure(cfg)
    ? ({ prefix: 'host', httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: maxAgeSec } as const)
    : ({ httpOnly: true, secure: false, sameSite: 'Lax', path: '/', maxAge: maxAgeSec } as const);
}

function read(c: Context, cfg: Config, name: string): string | undefined {
  return secure(cfg) ? getCookie(c, name, 'host') : getCookie(c, name);
}

function clear(c: Context, cfg: Config, name: string) {
  if (secure(cfg)) deleteCookie(c, name, { prefix: 'host', secure: true, path: '/' });
  else deleteCookie(c, name, { path: '/' });
}

export function setSessionCookie(c: Context, cfg: Config, id: string) {
  setCookie(c, SESSION, id, opts(cfg, LIFETIME.sessionMs / 1000));
}

export function clearSessionCookie(c: Context, cfg: Config) {
  clear(c, cfg, SESSION);
}

export function setFlowCookie(c: Context, cfg: Config, state: string) {
  setCookie(c, FLOW, state, opts(cfg, LIFETIME.loginFlowMs / 1000));
}

export function readFlowCookie(c: Context, cfg: Config): string | undefined {
  return read(c, cfg, FLOW);
}

export function clearFlowCookie(c: Context, cfg: Config) {
  clear(c, cfg, FLOW);
}

/** Binds a pending /oauth/authorize request to the browser that started it, so a consent link can't be forwarded. */
export function setAuthzCookie(c: Context, cfg: Config, requestId: string) {
  setCookie(c, AUTHZ, requestId, opts(cfg, LIFETIME.authRequestMs / 1000));
}

export function readAuthzCookie(c: Context, cfg: Config): string | undefined {
  return read(c, cfg, AUTHZ);
}

export function clearAuthzCookie(c: Context, cfg: Config) {
  clear(c, cfg, AUTHZ);
}

export function isAllowlisted(cfg: Config, user: Pick<User, 'email'>): boolean {
  return cfg.allowedUsers.some((u) => u.email === user.email.toLowerCase());
}

export function currentSession(c: Context, deps: AppDeps): { session: Session; user: User; id: string } | undefined {
  const id = read(c, deps.config, SESSION);
  if (!id) return undefined;
  const session = deps.store.getSession(id);
  if (!session) return undefined;
  const user = getUser(deps.db, session.user_id);
  if (!user || !isAllowlisted(deps.config, user)) return undefined;
  return { session, user, id };
}

/** Only same-site relative paths: "/c/12", never "//evil.example" or "https://...". */
export function safeReturnTo(s: string | undefined | null): string {
  // eslint-disable-next-line no-control-regex
  if (!s || !s.startsWith('/') || /[\u0000-\u001F\u007F\\]/.test(s)) return '/';
  try {
    const base = 'https://return-to.invalid';
    const u = new URL(s, base);
    if (u.origin !== base) return '/';
    const out = u.pathname + u.search + u.hash;
    // Dot segments can normalize into "//host" (e.g. "/.//evil.example"), which browsers treat as another site.
    if (out.startsWith('//')) return '/';
    return out.slice(0, 500);
  } catch {
    return '/';
  }
}

/** Web pages: signed-in users only; others go to /login and come back afterwards. */
export function requireUser(deps: AppDeps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const cur = currentSession(c, deps);
    if (!cur) {
      const url = new URL(c.req.url);
      const returnTo = c.req.method === 'GET' ? url.pathname + url.search : '/';
      const login = `/login?return_to=${encodeURIComponent(returnTo)}`;
      // The service worker refreshing a page it keeps: a plain "signed out", which tells it to drop its copies.
      if (c.req.header('x-magpie-refresh')) return c.body(null, 401);
      if (c.req.header('hx-request')) {
        c.header('HX-Redirect', login);
        return c.body(null, 401);
      }
      return c.redirect(login, 302);
    }
    c.set('user', cur.user);
    c.set('session', cur.session);
    c.set('sessionId', cur.id);
    // The server just extended the session. The cookie's own 30 days have to move with it, or the browser
    // drops it 30 days after sign-in however often the app is used.
    if (cur.session.renewed) setSessionCookie(c, deps.config, cur.id);
    await next();
  };
}

/** State-changing web requests must carry the session's CSRF token (form field _csrf or X-CSRF-Token). */
export function requireCsrf(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.req.method === 'GET' || c.req.method === 'HEAD') return next();
    const session = c.get('session');
    let provided = c.req.header('x-csrf-token');
    if (!provided) {
      const type = c.req.header('content-type') ?? '';
      if (type.includes('application/x-www-form-urlencoded') || type.includes('multipart/form-data')) {
        const body = await c.req.parseBody();
        provided = typeof body._csrf === 'string' ? body._csrf : undefined;
      }
    }
    if (!session || !provided || !safeEqual(provided, session.csrf_secret)) {
      return c.text('This form expired. Go back, reload the page and try again.', 403);
    }
    await next();
  };
}

export function sessionHash(id: string): string {
  return sha256(id);
}
