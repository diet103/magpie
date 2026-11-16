import type { Context, MiddlewareHandler } from 'hono';

/** Fixed-window, in-memory counters. Plenty for a two-person server on one machine. */
export class RateLimiter {
  private hits = new Map<string, { count: number; reset: number }>();
  private readonly limit: number;
  private readonly windowMs: number;
  private lastPrune = Date.now();

  constructor(limit: number, windowMs = 60_000) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  /** Returns seconds to wait, or 0 if the request may proceed. */
  take(key: string): number {
    const now = Date.now();
    if (now - this.lastPrune > this.windowMs * 5) {
      for (const [k, v] of this.hits) if (v.reset <= now) this.hits.delete(k);
      this.lastPrune = now;
    }
    let h = this.hits.get(key);
    if (!h || h.reset <= now) {
      h = { count: 0, reset: now + this.windowMs };
      this.hits.set(key, h);
    }
    h.count++;
    return h.count > this.limit ? Math.ceil((h.reset - now) / 1000) : 0;
  }

  /** Seconds to wait if the key has already used up its allowance, without counting this call. */
  blocked(key: string): number {
    const h = this.hits.get(key);
    const now = Date.now();
    return h && h.reset > now && h.count >= this.limit ? Math.ceil((h.reset - now) / 1000) : 0;
  }

  reset(key: string) {
    this.hits.delete(key);
  }
}

/**
 * Which request header carries the visitor's address. Only the proxy directly in front of the app can be believed
 * about that, so exactly one header is read, and a header the proxy did not set is never trusted: Fly sets
 * Fly-Client-IP. Behind another proxy, CLIENT_IP_HEADER names its header; "none" means there is no proxy.
 */
let ipHeader = 'fly-client-ip';
export function trustClientIpHeader(name: string) {
  ipHeader = name.trim().toLowerCase();
}

export function clientIp(c: Context): string {
  const socket = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress ?? 'local';
  if (!ipHeader || ipHeader === 'none') return socket;
  const value = c.req.header(ipHeader);
  if (!value) return socket;
  // A forwarding proxy adds the address it saw to the end of the list; anything before that came from the visitor.
  return value.split(',').at(-1)!.trim() || socket;
}

export function rateLimit(limiter: RateLimiter, key: (c: Context) => string): MiddlewareHandler {
  return async (c, next) => {
    const wait = limiter.take(key(c));
    if (wait > 0) {
      c.header('Retry-After', String(wait));
      return c.text('Too many requests. Try again in a minute.', 429);
    }
    await next();
  };
}
