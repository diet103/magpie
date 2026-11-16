// "Sign in with Google" (OpenID Connect, authorization code + PKCE + nonce). Google only proves who you are:
// we ask for openid email profile and keep no Google tokens.
import * as oidc from 'openid-client';
import { log } from '../log.ts';

export interface GoogleIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
}

export interface GoogleOptions {
  issuer: string;
  clientId?: string;
  clientSecret?: string;
  redirectUri: string;
  allowInsecure: boolean;
}

export class GoogleSignIn {
  private config: oidc.Configuration | undefined;
  private pending: Promise<oidc.Configuration> | undefined;
  readonly opts: GoogleOptions;

  constructor(opts: GoogleOptions) {
    this.opts = opts;
  }

  get configured(): boolean {
    return Boolean(this.opts.clientId && this.opts.clientSecret);
  }

  private async configuration(): Promise<oidc.Configuration> {
    if (this.config) return this.config;
    if (!this.configured) throw new Error('Google sign-in is not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).');
    this.pending ??= oidc
      .discovery(
        new URL(this.opts.issuer),
        this.opts.clientId!,
        this.opts.clientSecret!,
        oidc.ClientSecretPost(this.opts.clientSecret!),
        this.opts.allowInsecure ? { execute: [oidc.allowInsecureRequests] } : undefined,
      )
      .then((c) => (this.config = c))
      .finally(() => (this.pending = undefined));
    return this.pending;
  }

  /** Returns the URL to send the browser to, plus the values the callback needs to check. */
  async start(): Promise<{ url: URL; state: string; nonce: string; codeVerifier: string }> {
    const config = await this.configuration();
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const url = oidc.buildAuthorizationUrl(config, {
      redirect_uri: this.opts.redirectUri,
      scope: 'openid email profile',
      response_type: 'code',
      code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
      code_challenge_method: 'S256',
      state,
      nonce,
      prompt: 'select_account',
    });
    return { url, state, nonce, codeVerifier };
  }

  /** Exchanges the code and validates the ID token (issuer, audience, expiry, nonce). */
  async finish(currentUrl: URL, check: { state: string; nonce: string; codeVerifier: string }): Promise<GoogleIdentity> {
    const config = await this.configuration();
    const tokens = await oidc.authorizationCodeGrant(config, currentUrl, {
      pkceCodeVerifier: check.codeVerifier,
      expectedState: check.state,
      expectedNonce: check.nonce,
      idTokenExpected: true,
    });
    const claims = tokens.claims();
    if (!claims) throw new Error('Google returned no ID token');
    const email = typeof claims.email === 'string' ? claims.email.toLowerCase() : '';
    if (!email) log.warn('google id token without email', { sub: claims.sub });
    return {
      sub: claims.sub,
      email,
      emailVerified: claims.email_verified === true,
      name: typeof claims.name === 'string' ? claims.name : null,
    };
  }
}
