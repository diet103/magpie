import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const A = Buffer.from(a);
  const B = Buffer.from(b);
  return A.length === B.length && timingSafeEqual(A, B);
}

/** RFC 7636: BASE64URL(SHA256(ASCII(code_verifier))). */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

export const PKCE_VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;
export const PKCE_CHALLENGE_RE = /^[A-Za-z0-9\-_]{43}$/;

/** Prefixes make leaked tokens recognizable to secret scanners. */
export const TOKEN_PREFIX = { access: 'tma_at_', refresh: 'tma_rt_', pat: 'tma_pat_', code: 'tma_ac_', calendar: 'tma_cal_' } as const;
