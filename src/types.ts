import type { AuthInfo } from '@modelcontextprotocol/server';
import type { GoogleSignIn } from './auth/google.ts';
import type { AuthStore, Session } from './auth/store.ts';
import type { Config } from './config.ts';
import type { DB } from './db/sqlite.ts';
import type { User } from './domain/users.ts';

export interface AppDeps {
  config: Config;
  db: DB;
  store: AuthStore;
  google: GoogleSignIn;
  startedAt: Date;
  /** Used to fetch client metadata documents; tests swap it. */
  fetchImpl?: typeof fetch;
  /** Backup status for Settings, filled in by the jobs. photos is the last copy of the photos to the off-site backup. */
  backups: {
    lastSnapshotAt: string | null;
    lastSnapshotError: string | null;
    photos?: { at: string; held: number; error?: string } | null;
  };
  /** Set by createApp: the in-process MCP endpoint, used by the Ask box. */
  mcpFetch?: (req: Request, authInfo: AuthInfo) => Promise<Response>;
  /** Tests swap this to stand in for the Anthropic API. */
  assistantFetch?: typeof fetch;
}

export type AppEnv = {
  Variables: {
    user: User;
    session: Session;
    sessionId: string;
    authInfo: AuthInfo;
    /** Set when this response shows a one-time message, so the page is not one for the phone to keep. */
    flashed: boolean;
  };
};
