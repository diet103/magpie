// Client ID Metadata Documents (plan 5.4): the client_id is an HTTPS URL on an allowlisted origin, and the
// document it serves lists the client's redirect URIs.
import { get, run } from '../db/sqlite.ts';
import { log } from '../log.ts';
import type { AuthStore } from './store.ts';

export class ClientError extends Error {}
/** The document exists as far as we know, but its host would not serve it to us (blocked, rate-limited, down). */
export class DocumentUnavailable extends ClientError {}

export interface ClientInfo {
  clientId: string;
  host: string;
  clientName: string | null;
  redirectUris: string[];
}

export interface CimdOptions {
  allowedOrigins: string[];
  allowedRedirects: string[];
  allowHttp: boolean;
  fetchImpl?: typeof fetch;
}

const CACHE_MS = 60 * 60_000;
const MAX_BYTES = 64 * 1024;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

function parseClientId(clientId: string, opts: CimdOptions): URL {
  let u: URL;
  try {
    u = new URL(clientId);
  } catch {
    throw new ClientError('client_id must be a URL (a Client ID Metadata Document).');
  }
  if (u.protocol !== 'https:' && !(opts.allowHttp && u.protocol === 'http:')) throw new ClientError('client_id must be an https URL.');
  if (u.hash || u.username || u.password) throw new ClientError('client_id must not contain a fragment or credentials.');
  if (!opts.allowedOrigins.includes(u.origin)) {
    log.warn('rejected client_id origin', { origin: u.origin, path: u.pathname });
    throw new ClientError(`This tracker only accepts Claude as a client (got a client from ${u.host}).`);
  }
  return u;
}

async function readCapped(res: Response): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel();
      throw new ClientError('Client metadata document is too large.');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function fetchDocument(url: URL, opts: CimdOptions): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await (opts.fetchImpl ?? fetch)(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(5000),
      headers: { accept: 'application/json', 'user-agent': 'magpie-tracker/0.1 (OAuth client metadata fetch)' },
    });
  } catch (err) {
    throw new DocumentUnavailable(`Couldn't fetch the client metadata document (${err instanceof Error ? err.name : 'error'}).`);
  }
  if ([401, 403, 429].includes(res.status) || res.status >= 500) {
    throw new DocumentUnavailable(`Client metadata document answered HTTP ${res.status}.`);
  }
  if (res.status !== 200) throw new ClientError(`Client metadata document answered HTTP ${res.status}.`);
  const type = res.headers.get('content-type') ?? '';
  if (!/\bjson\b/i.test(type)) throw new ClientError('Client metadata document is not JSON.');
  const text = await readCapped(res);
  try {
    const doc = JSON.parse(text);
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('not an object');
    return doc as Record<string, unknown>;
  } catch {
    throw new ClientError('Client metadata document is not valid JSON.');
  }
}

function validateDocument(clientId: string, doc: Record<string, unknown>): ClientInfo {
  if (doc.client_id !== clientId) throw new ClientError('Client metadata document client_id does not match its URL.');
  if (doc.token_endpoint_auth_method !== 'none') throw new ClientError('Client must use token_endpoint_auth_method "none".');
  const uris = doc.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || !uris.every((x) => typeof x === 'string')) {
    throw new ClientError('Client metadata document has no redirect_uris.');
  }
  return {
    clientId,
    host: new URL(clientId).host,
    clientName: typeof doc.client_name === 'string' ? doc.client_name.slice(0, 100) : null,
    redirectUris: uris as string[],
  };
}

/** Claude Code's metadata document: the only client that asks for a code on a loopback address. */
const LOCAL_CLIENT_PATH = '/oauth/claude-code-client-metadata';

/** Fetches (or reads from the 1 h cache) and validates a client's metadata document. */
export async function resolveClient(store: AuthStore, clientId: string, opts: CimdOptions): Promise<ClientInfo> {
  const url = parseClientId(clientId, opts);
  const cached = get<{ document: string; fetched_at: string }>(store.db, 'SELECT document, fetched_at FROM cimd_cache WHERE client_id = ?', clientId);
  if (cached && Date.now() - Date.parse(cached.fetched_at) < CACHE_MS) {
    return validateDocument(clientId, JSON.parse(cached.document));
  }
  let doc: Record<string, unknown>;
  try {
    doc = await fetchDocument(url, opts);
  } catch (err) {
    if (!(err instanceof DocumentUnavailable)) throw err;
    // claude.ai turns away some server-to-server requests. The client_id is already on an allowlisted origin, and
    // what actually protects the flow is our own redirect allowlist (Claude's callback, or loopback), PKCE and the
    // consent page, so fall back to those fixed redirect URIs instead of refusing to connect.
    log.warn('client metadata unavailable; using built-in redirect allowlist', { host: url.host, reason: err.message });
    // A code is sent to a program on the same device only for the one client known to run there. Any other
    // address on the allowlisted origin would otherwise let a local program borrow Claude's name on the consent page.
    const local = url.pathname === LOCAL_CLIENT_PATH ? ['http://localhost/callback', 'http://127.0.0.1/callback'] : [];
    return { clientId, host: url.host, clientName: null, redirectUris: [...opts.allowedRedirects, ...local] };
  }
  const info = validateDocument(clientId, doc);
  run(
    store.db,
    `INSERT INTO cimd_cache (client_id, document, fetched_at) VALUES (?, ?, ?)
     ON CONFLICT(client_id) DO UPDATE SET document = excluded.document, fetched_at = excluded.fetched_at`,
    clientId,
    JSON.stringify(doc),
    new Date().toISOString(),
  );
  return info;
}

export function isLoopbackRedirect(uri: string): boolean {
  try {
    const u = new URL(uri);
    return u.protocol === 'http:' && LOOPBACK.has(u.hostname.startsWith('[') ? u.hostname : u.hostname) && u.pathname === '/callback' && !u.search && !u.hash && !u.username;
  } catch {
    return false;
  }
}

function sameIgnoringLoopbackPort(a: string, b: string): boolean {
  if (a === b) return true;
  if (!isLoopbackRedirect(a) || !isLoopbackRedirect(b)) return false;
  const A = new URL(a);
  const B = new URL(b);
  return A.protocol === B.protocol && A.hostname === B.hostname && A.pathname === B.pathname;
}

/** The redirect URI must be in the client's document AND allowed by us (exact, or loopback with any port). */
export function redirectAllowed(uri: string, client: ClientInfo, allowed: string[]): boolean {
  if (!client.redirectUris.some((r) => sameIgnoringLoopbackPort(uri, r))) return false;
  return allowed.includes(uri) || isLoopbackRedirect(uri);
}

/** A friendly name for activity logs and Settings. */
export function clientDisplayName(clientId: string | null): string {
  if (!clientId) return 'Personal token';
  if (/claude-code/i.test(clientId)) return 'Claude Code';
  try {
    const host = new URL(clientId).host;
    return host === 'claude.ai' || host === 'claude.com' ? 'Claude' : host;
  } catch {
    return clientId.slice(0, 40);
  }
}
