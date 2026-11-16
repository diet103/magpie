// auth.db access: authorization requests, Google sign-in flows, codes, tokens and web sessions.
// Every secret is stored as a SHA-256 hash; plaintext only ever exists in the response that issues it.
import { all, get, run, tx, type DB } from '../db/sqlite.ts';
import { randomToken, sha256, TOKEN_PREFIX } from './crypto.ts';

export const LIFETIME = {
  authRequestMs: 10 * 60_000,
  loginFlowMs: 10 * 60_000,
  codeMs: 60_000,
  accessMs: 60 * 60_000,
  refreshMs: 90 * 24 * 60 * 60_000,
  refreshGraceMs: 60_000,
  sessionMs: 30 * 24 * 60 * 60_000,
  patMaxMs: 30 * 24 * 60 * 60_000,
  auditMs: 30 * 24 * 60 * 60_000,
};

const iso = (ms: number) => new Date(ms).toISOString();
const now = () => Date.now();

export interface AuthRequest {
  id: string;
  client_id: string;
  redirect_uri: string;
  state: string | null;
  code_challenge: string;
  scope: string | null;
  resource: string | null;
  created_at: string;
  expires_at: string;
}

export interface LoginFlow {
  state: string;
  nonce: string;
  code_verifier: string;
  purpose: 'web' | 'oauth';
  auth_request_id: string | null;
  return_to: string | null;
  expires_at: string;
}

export interface AuthCode {
  code_hash: string;
  auth_request_id: string;
  user_id: number;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  scope: string | null;
  resource: string | null;
  expires_at: string;
  used_at: string | null;
}

export interface TokenRow {
  token_hash: string;
  kind: 'access' | 'refresh' | 'pat';
  family_id: string | null;
  user_id: number;
  client_id: string | null;
  scope: string | null;
  resource: string | null;
  label: string | null;
  created_at: string;
  expires_at: string;
  last_used_at: string | null;
  rotated_at: string | null;
  successor: string | null;
  revoked_at: string | null;
}

export interface Session {
  id_hash: string;
  user_id: number;
  csrf_secret: string;
  created_at: string;
  expires_at: string;
  last_seen_at: string | null;
  user_agent: string | null;
  /** Set by getSession when that read extended the session, so the caller can send the cookie again. */
  renewed?: boolean;
}

/** A person's private calendar link. */
export interface CalendarFeed {
  token_hash: string;
  user_id: number;
  include_sensitive: number;
  created_at: string;
  last_fetched_at: string | null;
}

export interface IssuedTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
  familyId: string;
}

export type RefreshOutcome = { ok: true; tokens: IssuedTokens; userId: number } | { ok: false; reason: string };

export class AuthStore {
  readonly db: DB;
  constructor(db: DB) {
    this.db = db;
  }

  // ---- authorization requests --------------------------------------------------------------
  createAuthRequest(r: Omit<AuthRequest, 'id' | 'created_at' | 'expires_at'>): string {
    const id = randomToken(18);
    run(
      this.db,
      `INSERT INTO auth_requests (id, client_id, redirect_uri, state, code_challenge, scope, resource, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      r.client_id,
      r.redirect_uri,
      r.state,
      r.code_challenge,
      r.scope,
      r.resource,
      iso(now()),
      iso(now() + LIFETIME.authRequestMs),
    );
    return id;
  }

  getAuthRequest(id: string): AuthRequest | undefined {
    return get<AuthRequest>(this.db, 'SELECT * FROM auth_requests WHERE id = ? AND expires_at > ?', id, iso(now()));
  }

  /** Single use: returns the request and deletes it. */
  takeAuthRequest(id: string): AuthRequest | undefined {
    return tx(this.db, () => {
      const r = this.getAuthRequest(id);
      if (r) {
        run(this.db, 'UPDATE login_flows SET auth_request_id = NULL WHERE auth_request_id = ?', id);
        run(this.db, 'DELETE FROM auth_requests WHERE id = ?', id);
      }
      return r;
    });
  }

  // ---- Google sign-in flows ----------------------------------------------------------------
  createLoginFlow(f: Omit<LoginFlow, 'expires_at'>) {
    run(
      this.db,
      `INSERT INTO login_flows (state, nonce, code_verifier, purpose, auth_request_id, return_to, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      f.state,
      f.nonce,
      f.code_verifier,
      f.purpose,
      f.auth_request_id,
      f.return_to,
      iso(now() + LIFETIME.loginFlowMs),
    );
  }

  /** Consumed on first use, valid or not. */
  takeLoginFlow(state: string): LoginFlow | undefined {
    return tx(this.db, () => {
      const f = get<LoginFlow>(this.db, 'SELECT * FROM login_flows WHERE state = ?', state);
      if (f) run(this.db, 'DELETE FROM login_flows WHERE state = ?', state);
      return f && f.expires_at > iso(now()) ? f : undefined;
    });
  }

  // ---- authorization codes ------------------------------------------------------------------
  issueCode(c: Omit<AuthCode, 'code_hash' | 'expires_at' | 'used_at'>): string {
    const code = TOKEN_PREFIX.code + randomToken();
    run(
      this.db,
      `INSERT INTO auth_codes (code_hash, auth_request_id, user_id, client_id, redirect_uri, code_challenge, scope, resource, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      sha256(code),
      c.auth_request_id,
      c.user_id,
      c.client_id,
      c.redirect_uri,
      c.code_challenge,
      c.scope,
      c.resource,
      iso(now() + LIFETIME.codeMs),
    );
    return code;
  }

  /**
   * Marks the code used and returns it, or undefined if it's unknown, expired or already used.
   * A code presented a second time also revokes whatever tokens it produced the first time.
   */
  takeCode(code: string): AuthCode | undefined {
    return tx(this.db, () => {
      const row = get<AuthCode & { family_id: string | null }>(this.db, 'SELECT * FROM auth_codes WHERE code_hash = ?', sha256(code));
      if (!row) return undefined;
      if (row.used_at) {
        if (row.family_id) this.revokeFamily(row.family_id);
        return undefined;
      }
      run(this.db, 'UPDATE auth_codes SET used_at = ? WHERE code_hash = ?', iso(now()), row.code_hash);
      return row.expires_at > iso(now()) ? row : undefined;
    });
  }

  bindCodeToFamily(codeHash: string, familyId: string) {
    run(this.db, 'UPDATE auth_codes SET family_id = ? WHERE code_hash = ?', familyId, codeHash);
  }

  // ---- access and refresh tokens -----------------------------------------------------------
  private insertToken(t: Omit<TokenRow, 'created_at' | 'last_used_at' | 'rotated_at' | 'successor' | 'revoked_at'>) {
    run(
      this.db,
      `INSERT INTO tokens (token_hash, kind, family_id, user_id, client_id, scope, resource, label, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      t.token_hash,
      t.kind,
      t.family_id,
      t.user_id,
      t.client_id,
      t.scope,
      t.resource,
      t.label,
      iso(now()),
      t.expires_at,
    );
  }

  issueTokens(g: { userId: number; clientId: string; scope: string; resource: string; familyId?: string }): IssuedTokens {
    return tx(this.db, () => {
      const familyId = g.familyId ?? randomToken(16);
      const access = TOKEN_PREFIX.access + randomToken();
      const refresh = TOKEN_PREFIX.refresh + randomToken();
      const base = { family_id: familyId, user_id: g.userId, client_id: g.clientId, scope: g.scope, resource: g.resource, label: null };
      this.insertToken({ ...base, token_hash: sha256(access), kind: 'access', expires_at: iso(now() + LIFETIME.accessMs) });
      this.insertToken({ ...base, token_hash: sha256(refresh), kind: 'refresh', expires_at: iso(now() + LIFETIME.refreshMs) });
      return { access_token: access, refresh_token: refresh, expires_in: LIFETIME.accessMs / 1000, scope: g.scope, familyId };
    });
  }

  /**
   * Refresh-token rotation (plan 5.5). A rotated token presented again revokes the whole family, unless it's within
   * 60 s of its rotation (a lost response): then the family's earlier tokens are revoked and one fresh pair is issued.
   */
  rotateRefresh(refreshToken: string, clientId: string, resource: string): RefreshOutcome {
    return tx(this.db, () => {
      const row = get<TokenRow>(this.db, "SELECT * FROM tokens WHERE token_hash = ? AND kind = 'refresh'", sha256(refreshToken));
      if (!row) return { ok: false, reason: 'unknown refresh token' };
      if (row.revoked_at) {
        // A revoked token being used means two parties held this connection's tokens (one of them took the
        // grace-window path and this is the other). End the whole connection so neither line stays alive.
        if (row.family_id) this.revokeFamily(row.family_id);
        return { ok: false, reason: 'refresh token revoked' };
      }
      if (row.client_id !== clientId) return { ok: false, reason: 'refresh token was issued to another client' };
      if (row.rotated_at) {
        const age = now() - Date.parse(row.rotated_at);
        if (age > LIFETIME.refreshGraceMs) {
          this.revokeFamily(row.family_id!);
          return { ok: false, reason: 'refresh token reuse detected; all tokens for this connection were revoked' };
        }
        // A lost response: everything issued from this token onward (and anything derived from that) is
        // revoked, and one fresh pair replaces it, so there is never more than one live branch.
        this.revokeFamily(row.family_id!);
      } else if (row.expires_at <= iso(now())) {
        return { ok: false, reason: 'refresh token expired' };
      }
      const tokens = this.issueTokens({ userId: row.user_id, clientId, scope: row.scope ?? 'tracker', resource: row.resource ?? resource, familyId: row.family_id! });
      run(
        this.db,
        'UPDATE tokens SET rotated_at = coalesce(rotated_at, ?), successor = ? WHERE token_hash = ?',
        iso(now()),
        sha256(tokens.refresh_token),
        row.token_hash,
      );
      return { ok: true, tokens, userId: row.user_id };
    });
  }

  /** Looks up a usable access token or PAT and records its use (at most once a minute). */
  verifyAccess(token: string): TokenRow | undefined {
    if (!token.startsWith(TOKEN_PREFIX.access) && !token.startsWith(TOKEN_PREFIX.pat)) return undefined;
    const row = get<TokenRow>(
      this.db,
      "SELECT * FROM tokens WHERE token_hash = ? AND kind IN ('access', 'pat') AND revoked_at IS NULL AND expires_at > ?",
      sha256(token),
      iso(now()),
    );
    if (row && (!row.last_used_at || now() - Date.parse(row.last_used_at) > 60_000)) {
      run(this.db, 'UPDATE tokens SET last_used_at = ? WHERE token_hash = ?', iso(now()), row.token_hash);
    }
    return row;
  }

  revokeFamily(familyId: string) {
    run(this.db, 'UPDATE tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL', iso(now()), familyId);
  }

  /** RFC 7009. A refresh token takes its whole family with it. Unknown tokens are ignored. */
  revokeToken(token: string, clientId?: string) {
    const row = get<TokenRow>(this.db, 'SELECT * FROM tokens WHERE token_hash = ?', sha256(token));
    if (!row || (clientId && row.client_id && row.client_id !== clientId)) return;
    if (row.kind === 'refresh' && row.family_id) this.revokeFamily(row.family_id);
    else run(this.db, 'UPDATE tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL', iso(now()), row.token_hash);
  }

  /** Connected apps for Settings: one row per live token family. */
  listGrants(userId: number): { family_id: string; client_id: string; created_at: string; last_used_at: string | null }[] {
    return all(
      this.db,
      `SELECT family_id, client_id, min(created_at) AS created_at, max(last_used_at) AS last_used_at FROM tokens
        WHERE user_id = ? AND kind IN ('access', 'refresh') AND family_id IS NOT NULL
        GROUP BY family_id
       HAVING sum(CASE WHEN revoked_at IS NULL AND expires_at > ? THEN 1 ELSE 0 END) > 0
        ORDER BY created_at DESC`,
      userId,
      iso(now()),
    );
  }

  revokeGrant(userId: number, familyId: string) {
    run(this.db, 'UPDATE tokens SET revoked_at = ? WHERE family_id = ? AND user_id = ? AND revoked_at IS NULL', iso(now()), familyId, userId);
  }

  // ---- personal access tokens ----------------------------------------------------------------
  createPat(userId: number, label: string, ttlMs: number): { token: string; expiresAt: string } {
    const ttl = Math.min(Math.max(ttlMs, 60_000), LIFETIME.patMaxMs);
    const token = TOKEN_PREFIX.pat + randomToken();
    const expiresAt = iso(now() + ttl);
    this.insertToken({ token_hash: sha256(token), kind: 'pat', family_id: null, user_id: userId, client_id: null, scope: 'tracker', resource: null, label: label.slice(0, 60), expires_at: expiresAt });
    return { token, expiresAt };
  }

  listPats(userId: number): TokenRow[] {
    return all<TokenRow>(
      this.db,
      "SELECT * FROM tokens WHERE user_id = ? AND kind = 'pat' AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC",
      userId,
      iso(now()),
    );
  }

  revokePat(userId: number, tokenHash: string) {
    run(this.db, "UPDATE tokens SET revoked_at = ? WHERE token_hash = ? AND user_id = ? AND kind = 'pat'", iso(now()), tokenHash, userId);
  }

  // ---- web sessions -------------------------------------------------------------------------
  createSession(userId: number, userAgent: string | null): { id: string; csrf: string } {
    const id = randomToken();
    const csrf = randomToken();
    run(
      this.db,
      'INSERT INTO web_sessions (id_hash, user_id, csrf_secret, created_at, expires_at, last_seen_at, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)',
      sha256(id),
      userId,
      csrf,
      iso(now()),
      iso(now() + LIFETIME.sessionMs),
      iso(now()),
      userAgent?.slice(0, 200) ?? null,
    );
    return { id, csrf };
  }

  /** Returns a live session and slides its expiry (written at most hourly; `renewed` says this call did). */
  getSession(id: string): Session | undefined {
    const s = get<Session>(this.db, 'SELECT * FROM web_sessions WHERE id_hash = ? AND expires_at > ?', sha256(id), iso(now()));
    if (s && (!s.last_seen_at || now() - Date.parse(s.last_seen_at) > 60 * 60_000)) {
      run(this.db, 'UPDATE web_sessions SET last_seen_at = ?, expires_at = ? WHERE id_hash = ?', iso(now()), iso(now() + LIFETIME.sessionMs), s.id_hash);
      s.renewed = true;
    }
    return s;
  }

  deleteSession(id: string) {
    run(this.db, 'DELETE FROM web_sessions WHERE id_hash = ?', sha256(id));
  }

  listSessions(userId: number): Session[] {
    return all<Session>(this.db, 'SELECT * FROM web_sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_seen_at DESC', userId, iso(now()));
  }

  deleteOtherSessions(userId: number, keepIdHash: string) {
    run(this.db, 'DELETE FROM web_sessions WHERE user_id = ? AND id_hash != ?', userId, keepIdHash);
  }

  deleteAllForUser(userId: number) {
    run(this.db, 'DELETE FROM web_sessions WHERE user_id = ?', userId);
    run(this.db, 'UPDATE tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', iso(now()), userId);
    run(this.db, 'DELETE FROM calendar_feeds WHERE user_id = ?', userId);
  }

  // ---- calendar links -----------------------------------------------------------------------
  /** Makes the person's calendar link, replacing any earlier one, and returns its secret (shown once). */
  createCalendarFeed(userId: number, includeSensitive: boolean): string {
    const token = TOKEN_PREFIX.calendar + randomToken();
    tx(this.db, () => {
      run(this.db, 'DELETE FROM calendar_feeds WHERE user_id = ?', userId);
      run(
        this.db,
        'INSERT INTO calendar_feeds (token_hash, user_id, include_sensitive, created_at) VALUES (?, ?, ?, ?)',
        sha256(token),
        userId,
        includeSensitive ? 1 : 0,
        iso(now()),
      );
    });
    return token;
  }

  getCalendarFeed(userId: number): CalendarFeed | undefined {
    return get<CalendarFeed>(this.db, 'SELECT * FROM calendar_feeds WHERE user_id = ?', userId);
  }

  /** Looks a link up by its secret and notes that a calendar has just read it. */
  readCalendarFeed(token: string): CalendarFeed | undefined {
    const feed = get<CalendarFeed>(this.db, 'SELECT * FROM calendar_feeds WHERE token_hash = ?', sha256(token));
    if (feed) run(this.db, 'UPDATE calendar_feeds SET last_fetched_at = ? WHERE token_hash = ?', iso(now()), feed.token_hash);
    return feed;
  }

  setCalendarFeedSensitive(userId: number, include: boolean) {
    run(this.db, 'UPDATE calendar_feeds SET include_sensitive = ? WHERE user_id = ?', include ? 1 : 0, userId);
  }

  deleteCalendarFeed(userId: number) {
    run(this.db, 'DELETE FROM calendar_feeds WHERE user_id = ?', userId);
  }

  // ---- housekeeping -------------------------------------------------------------------------
  cleanup() {
    const t = iso(now());
    const audit = iso(now() - LIFETIME.auditMs);
    tx(this.db, () => {
      run(this.db, 'DELETE FROM login_flows WHERE expires_at < ?', t);
      run(this.db, 'UPDATE login_flows SET auth_request_id = NULL WHERE auth_request_id IN (SELECT id FROM auth_requests WHERE expires_at < ?)', t);
      run(this.db, 'DELETE FROM auth_requests WHERE expires_at < ?', t);
      run(this.db, 'DELETE FROM auth_codes WHERE expires_at < ?', iso(now() - 60 * 60_000));
      run(this.db, 'DELETE FROM web_sessions WHERE expires_at < ?', t);
      run(this.db, 'DELETE FROM cimd_cache WHERE fetched_at < ?', iso(now() - 24 * 60 * 60_000));
      run(this.db, "DELETE FROM tokens WHERE kind IN ('access', 'pat') AND expires_at < ?", audit);
      run(
        this.db,
        `DELETE FROM tokens WHERE kind = 'refresh' AND family_id IN (
           SELECT family_id FROM tokens WHERE kind = 'refresh' GROUP BY family_id HAVING max(expires_at) < ?)`,
        audit,
      );
    });
  }
}
