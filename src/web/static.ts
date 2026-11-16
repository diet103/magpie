import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), 'static');

const TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json',
};

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** Serves the fixed set of files in src/web/static from memory: no path handling, no traversal. */
export function staticRoutes(): Hono {
  const app = new Hono();
  const files = new Map<string, { body: Buffer; type: string }>();
  for (const p of walk(ROOT)) {
    const type = TYPES[extname(p)];
    if (type) files.set('/' + relative(ROOT, p).split('\\').join('/'), { body: readFileSync(p), type });
  }
  const send = (name: string, cache: string) => {
    const f = files.get(name);
    if (!f) return undefined;
    return new Response(new Uint8Array(f.body), { headers: { 'Content-Type': f.type, 'Cache-Control': cache } });
  };
  app.get('/static/*', (c) => send(c.req.path.slice('/static'.length), 'public, max-age=86400') ?? c.notFound());
  app.get('/manifest.webmanifest', (c) => send('/manifest.webmanifest', 'public, max-age=3600') ?? c.notFound());
  app.get('/sw.js', (c) => {
    const res = send('/sw.js', 'no-cache');
    if (!res) return c.notFound();
    res.headers.set('Service-Worker-Allowed', '/');
    return res;
  });
  app.get('/offline.html', (c) => send('/offline.html', 'public, max-age=3600') ?? c.notFound());
  return app;
}
