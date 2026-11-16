import { Hono, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { bearerAuth } from './auth/bearer.ts';
import { trustClientIpHeader } from './auth/ratelimit.ts';
import { authRoutes } from './auth/routes.ts';
import { NotFoundError, UserError } from './domain/errors.ts';
import { errorFields, log } from './log.ts';
import { createMcpEndpoint } from './mcp/server.ts';
import type { AppDeps, AppEnv } from './types.ts';
import { calendarRoutes } from './web/calendar.ts';
import { messagePage } from './web/layout.ts';
import { webRoutes } from './web/routes.ts';
import { staticRoutes } from './web/static.ts';

const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'self'; object-src 'none'";

/** Security headers, set after the handler only where the handler didn't set its own (the consent page widens form-action). */
function securityHeaders(https: boolean): MiddlewareHandler {
  return async (c, next) => {
    await next();
    let res = c.res;
    const apply = () => {
      const h = res.headers;
      const set = (k: string, v: string) => {
        if (!h.has(k)) h.set(k, v);
      };
      set('Content-Security-Policy', CSP);
      set('X-Content-Type-Options', 'nosniff');
      set('Referrer-Policy', 'no-referrer');
      set('X-Frame-Options', 'DENY');
      set('Cross-Origin-Opener-Policy', 'same-origin');
      set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
      if (https) set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    };
    try {
      apply();
    } catch {
      res = new Response(res.body, res);
      apply();
      c.res = res;
    }
  };
}

/** The path as it is written to the log: never with a secret in it (a consent request, a sign-in code, a calendar link). */
export function loggedPath(path: string): string {
  return path.replace(/\/(oauth\/consent|auth\/google\/callback).*/, '/$1').replace(/^\/cal\/.*/, '/cal');
}

function requestLog(): MiddlewareHandler {
  return async (c, next) => {
    const started = Date.now();
    await next();
    if (c.req.path === '/healthz' || c.req.path.startsWith('/static/')) return;
    log.info('http', { method: c.req.method, path: loggedPath(c.req.path), status: c.res.status, ms: Date.now() - started });
  };
}

/** Requests must be for PUBLIC_URL's host (except the health check, which Fly calls by IP). */
function hostCheck(host: string): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.path !== '/healthz') {
      const reqHost = c.req.header('host') ?? new URL(c.req.url).host;
      if (reqHost !== host) return c.text('Unknown host', 421);
    }
    await next();
  };
}

export function createApp(deps: AppDeps): { app: Hono<AppEnv>; close: () => Promise<void> } {
  const cfg = deps.config;
  trustClientIpHeader(cfg.clientIpHeader);
  const app = new Hono<AppEnv>();
  app.use('*', requestLog());
  app.use('*', hostCheck(cfg.publicHost));
  app.use('*', securityHeaders(cfg.publicUrl.startsWith('https://')));

  app.get('/healthz', (c) => {
    deps.db.prepare('SELECT 1').get();
    deps.store.db.prepare('SELECT 1').get();
    c.header('Cache-Control', 'no-store');
    return c.text('ok');
  });

  app.route('/', staticRoutes());
  // Bodies are tiny everywhere except /mcp (the SDK caps those at 4 MB itself).
  app.use('/oauth/*', bodyLimit({ maxSize: 16 * 1024 }));
  app.use('/logout', bodyLimit({ maxSize: 16 * 1024 }));
  app.use('/login', bodyLimit({ maxSize: 16 * 1024 }));
  app.route('/', authRoutes(deps));
  app.route('/', calendarRoutes(deps));

  const mcp = createMcpEndpoint({
    db: deps.db,
    dbPath: cfg.trackerDbPath,
    tz: cfg.tz,
    webUrl: cfg.publicUrl,
    householdNames: () => cfg.allowedUsers.map((u) => u.name),
  });
  app.all('/mcp', bearerAuth(deps), (c) => mcp.fetch(c.req.raw, { authInfo: c.get('authInfo') }));

  deps.mcpFetch = (req, authInfo) => mcp.fetch(req, { authInfo });
  // Forms are small; only the two routes that take a photo get room for one.
  const small = bodyLimit({ maxSize: 512 * 1024 });
  const withPhoto = bodyLimit({ maxSize: 12 * 1024 * 1024 });
  app.on(['POST', 'PUT', 'PATCH', 'DELETE'], '*', (c, next) => (/^\/(ask|e\/\d+\/photos)$/.test(c.req.path) ? withPhoto(c, next) : small(c, next)));
  app.route('/', webRoutes(deps));

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    if (err instanceof NotFoundError) return c.html(messagePage('Not found', err.message), 404);
    if (err instanceof UserError) return c.html(messagePage("Couldn't do that", err.message), 400);
    log.error('unhandled error', { path: loggedPath(c.req.path), ...errorFields(err) });
    return c.html(messagePage('Something went wrong', 'The server hit an error. Nothing was changed. Try again in a moment.'), 500);
  });
  app.notFound((c) => c.html(messagePage('Not found', "That page doesn't exist."), 404));

  return { app, close: () => mcp.close() };
}
