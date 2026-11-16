import type { MiddlewareHandler } from 'hono';
import { getUser } from '../domain/users.ts';
import type { TokenExtra } from '../mcp/server.ts';
import type { AppDeps, AppEnv } from '../types.ts';
import { clientDisplayName } from './cimd.ts';
import { sha256 } from './crypto.ts';
import { RateLimiter } from './ratelimit.ts';
import { wwwAuthenticate } from './routes.ts';
import { isAllowlisted } from './session.ts';

/** Verifies the bearer token on /mcp. Failures answer 401 with the header that starts Claude's sign-in. */
export function bearerAuth(deps: AppDeps): MiddlewareHandler<AppEnv> {
  const cfg = deps.config;
  const perToken = new RateLimiter(300);
  return async (c, next) => {
    const m = /^Bearer\s+(\S+)\s*$/i.exec(c.req.header('authorization') ?? '');
    if (!m) {
      c.header('WWW-Authenticate', wwwAuthenticate(cfg));
      return c.json({ error: 'unauthorized', error_description: 'Sign in to use the tracker.' }, 401);
    }
    const row = deps.store.verifyAccess(m[1]);
    const user = row ? getUser(deps.db, row.user_id) : undefined;
    if (!row || !user || !isAllowlisted(cfg, user) || (row.resource !== null && row.resource !== cfg.mcpUrl)) {
      c.header('WWW-Authenticate', wwwAuthenticate(cfg, 'invalid_token'));
      return c.json({ error: 'invalid_token', error_description: 'The access token is invalid or expired.' }, 401);
    }
    const wait = perToken.take(sha256(m[1]));
    if (wait > 0) {
      c.header('Retry-After', String(wait));
      return c.json({ error: 'rate_limited', error_description: 'Too many requests. Try again in a minute.' }, 429);
    }
    const extra: TokenExtra = {
      userId: user.id,
      clientName: row.kind === 'pat' ? `token: ${row.label ?? 'personal'}` : clientDisplayName(row.client_id),
    };
    c.set('authInfo', {
      token: m[1],
      clientId: row.client_id ?? 'personal-access-token',
      scopes: (row.scope ?? 'tracker').split(' '),
      expiresAt: Math.floor(Date.parse(row.expires_at) / 1000),
      resource: new URL(cfg.mcpUrl),
      extra: extra as unknown as Record<string, unknown>,
    });
    await next();
  };
}
