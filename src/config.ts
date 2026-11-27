import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import * as z from 'zod';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8787),
  PUBLIC_URL: z.string().url().default('http://localhost:8787'),
  DATA_DIR: z.string().default('./data'),
  // An IANA name such as America/Chicago. The setup scripts ask for it and write it into fly.toml.
  HOUSEHOLD_TZ: z.string().default('UTC'),
  // "alex@example.com=Alex,sam@example.com=Sam"
  ALLOWED_USERS: z.string().default(''),
  // Optional password sign-in: "alex@example.com=long-password,sam@example.com=other-password".
  // Each password needs 16 or more characters and no commas or spaces. The setup scripts generate them.
  LOGIN_PASSWORDS: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_ISSUER: z.string().url().default('https://accounts.google.com'),
  CIMD_ALLOWED_ORIGINS: z.string().default('https://claude.ai,https://claude.com'),
  ALLOWED_REDIRECT_URIS: z
    .string()
    .default('https://claude.ai/api/mcp/auth_callback,https://claude.com/api/mcp/auth_callback'),
  BOOTSTRAP_EMPTY_DB: z.string().optional(),
  // 32 random bytes, base64. Encrypts uploaded photos; without it uploads are refused. The setup scripts create it.
  FILES_KEY: z.string().optional(),
  // Optional: turns on the Ask box in the web app. Everyone who can sign in uses this one key.
  ANTHROPIC_API_KEY: z.string().optional(),
  ASSISTANT_MODEL: z.string().default('claude-sonnet-5-5'),
  /** Set to 0 to stop the Ask chat from looking things up on the web. */
  ASSISTANT_WEB: z.string().default('1'),
  /** How much the Ask chat's model thinks before it acts. Low is the quickest; raise it if saves come out wrong. */
  ASSISTANT_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('low'),
  R2_ACCOUNT_ID: z.string().optional(),
  R2_BUCKET: z.string().optional(),
  R2_ENDPOINT: z.string().url().optional(),
  LITESTREAM_ACCESS_KEY_ID: z.string().optional(),
  LITESTREAM_SECRET_ACCESS_KEY: z.string().optional(),
  HEALTHCHECKS_URL: z.string().url().optional(),
  SNAPSHOT_TIME: z.string().regex(/^\d{2}:\d{2}$/).default('03:30'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  AUTH_RATE_LIMIT: z.coerce.number().int().positive().default(20),
  /** The header your proxy puts the visitor's address in. Fly's by default; "none" when nothing sits in front. */
  CLIENT_IP_HEADER: z.string().regex(/^[A-Za-z0-9-]+$/).default('fly-client-ip'),
  // Test-only escape hatches. Refused outside NODE_ENV=test.
  TEST_ALLOW_INSECURE_OIDC: z.string().optional(),
  TEST_ALLOW_HTTP_CIMD: z.string().optional(),
});

export interface AllowedUser {
  email: string;
  name: string;
}

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(given: Record<string, string | undefined> = process.env) {
  // A setting left blank counts as not set. `.env.example` lists optional settings as `NAME=`, and both
  // `node --env-file` and Docker's `env_file` hand those over as empty text.
  const env = Object.fromEntries(Object.entries(given).filter(([, value]) => value !== undefined && value.trim() !== ''));
  const e = Env.parse(env);
  const publicUrl = e.PUBLIC_URL.replace(/\/+$/, '');
  const isTest = e.NODE_ENV === 'test';
  if (e.NODE_ENV === 'production' && !publicUrl.startsWith('https://')) throw new Error('PUBLIC_URL must be https:// in production');
  if (new URL(publicUrl).pathname !== '/') throw new Error('PUBLIC_URL must be an origin without a path, like https://tracker.example.com');
  if (!isTest && (e.TEST_ALLOW_INSECURE_OIDC || e.TEST_ALLOW_HTTP_CIMD)) {
    throw new Error('TEST_* settings are only allowed when NODE_ENV=test');
  }
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: e.HOUSEHOLD_TZ });
  } catch {
    throw new Error(`HOUSEHOLD_TZ "${e.HOUSEHOLD_TZ}" is not a time zone name. Use one like America/Chicago or Europe/London.`);
  }
  const allowedUsers: AllowedUser[] = e.ALLOWED_USERS.split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const [email, name] = pair.split('=').map((x) => x.trim());
      if (!email || !email.includes('@')) throw new Error(`ALLOWED_USERS entry "${pair}" needs email=Name`);
      return { email: email.toLowerCase(), name: name || email.split('@')[0] };
    });
  // Passwords are kept only as SHA-256 digests in memory. They must be long and random (the setup script's are):
  // that, not slow hashing or a hard lockout, is what makes guessing hopeless.
  const passwordDigests = new Map<string, Buffer>();
  for (const pair of (e.LOGIN_PASSWORDS ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
    const eq = pair.indexOf('=');
    const email = (eq === -1 ? pair : pair.slice(0, eq)).trim().toLowerCase();
    const password = eq === -1 ? '' : pair.slice(eq + 1);
    if (!allowedUsers.some((u) => u.email === email)) throw new Error('LOGIN_PASSWORDS has an entry for someone who is not in ALLOWED_USERS (it is a list of email=password pairs separated by commas; a password cannot contain a comma)');
    if (password.length < 16 || /\s/.test(password)) {
      throw new Error(`The LOGIN_PASSWORDS entry for ${email} needs a password of 16 or more characters with no spaces or commas`);
    }
    passwordDigests.set(email, createHash('sha256').update(password, 'utf8').digest());
  }
  let filesKey: Buffer | undefined;
  if (e.FILES_KEY) {
    filesKey = Buffer.from(e.FILES_KEY, 'base64');
    if (filesKey.length !== 32) throw new Error('FILES_KEY must be 32 random bytes in base64');
  }
  const dataDir = resolve(e.DATA_DIR);
  const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);
  return {
    env: e.NODE_ENV,
    isProd: e.NODE_ENV === 'production',
    isTest,
    port: e.PORT,
    publicUrl,
    publicHost: new URL(publicUrl).host,
    mcpUrl: `${publicUrl}/mcp`,
    issuer: publicUrl,
    dataDir,
    trackerDbPath: resolve(dataDir, 'tracker.db'),
    authDbPath: resolve(dataDir, 'auth.db'),
    snapshotDir: resolve(dataDir, 'snapshots'),
    filesDir: resolve(dataDir, 'files'),
    filesKey,
    assistant: { apiKey: e.ANTHROPIC_API_KEY || undefined, model: e.ASSISTANT_MODEL, web: e.ASSISTANT_WEB !== '0', effort: e.ASSISTANT_EFFORT, baseUrl: (env.ANTHROPIC_BASE_URL_FOR_ASSISTANT ?? 'https://api.anthropic.com').replace(/\/+$/, '') },
    tz: e.HOUSEHOLD_TZ,
    allowedUsers,
    passwordDigests,
    google: {
      clientId: e.GOOGLE_CLIENT_ID,
      clientSecret: e.GOOGLE_CLIENT_SECRET,
      issuer: e.GOOGLE_ISSUER,
      allowInsecure: isTest && e.TEST_ALLOW_INSECURE_OIDC === '1',
    },
    cimdOrigins: list(e.CIMD_ALLOWED_ORIGINS),
    cimdAllowHttp: isTest && e.TEST_ALLOW_HTTP_CIMD === '1',
    allowedRedirects: list(e.ALLOWED_REDIRECT_URIS),
    bootstrapEmptyDb: e.BOOTSTRAP_EMPTY_DB === '1' || e.NODE_ENV !== 'production',
    r2: {
      accountId: e.R2_ACCOUNT_ID,
      bucket: e.R2_BUCKET,
      endpoint: e.R2_ENDPOINT ?? (e.R2_ACCOUNT_ID ? `https://${e.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : undefined),
      accessKeyId: e.LITESTREAM_ACCESS_KEY_ID,
      secretAccessKey: e.LITESTREAM_SECRET_ACCESS_KEY,
    },
    healthchecksUrl: e.HEALTHCHECKS_URL,
    snapshotTime: e.SNAPSHOT_TIME,
    logLevel: e.LOG_LEVEL,
    authRateLimit: e.AUTH_RATE_LIMIT,
    clientIpHeader: e.CLIENT_IP_HEADER,
  };
}
