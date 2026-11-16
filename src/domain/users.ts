import type { AllowedUser } from '../config.ts';
import { all, get, run, type DB } from '../db/sqlite.ts';
import { UserError } from './errors.ts';
import { foldText } from './normalize.ts';

export interface User {
  id: number;
  email: string;
  display_name: string;
  google_sub: string | null;
  created_at: string;
}

/** Makes sure every allowlisted person has a users row with the configured display name. */
export function syncUsers(db: DB, allowed: AllowedUser[]) {
  for (const u of allowed) {
    run(
      db,
      `INSERT INTO users (email, display_name) VALUES (?, ?)
       ON CONFLICT(email) DO UPDATE SET display_name = excluded.display_name`,
      u.email,
      u.name,
    );
  }
}

export function getUser(db: DB, id: number): User | undefined {
  return get<User>(db, 'SELECT * FROM users WHERE id = ?', id);
}

export function findUserByEmail(db: DB, email: string): User | undefined {
  return get<User>(db, 'SELECT * FROM users WHERE email = ? COLLATE NOCASE', email);
}

export function listUsers(db: DB): User[] {
  return all<User>(db, 'SELECT * FROM users ORDER BY id');
}

export function userNames(db: DB): Map<number, string> {
  return new Map(listUsers(db).map((u) => [u.id, u.display_name]));
}

export function otherNames(db: DB, meId: number): string[] {
  return listUsers(db)
    .filter((u) => u.id !== meId)
    .map((u) => u.display_name);
}

/** Resolves "Sam", "sa", "me" or an email to a household member. */
export function resolvePerson(db: DB, name: string, meId: number): User {
  const n = foldText(name.trim());
  const users = listUsers(db);
  if (['me', 'myself', 'i'].includes(n)) {
    const me = users.find((u) => u.id === meId);
    if (me) return me;
  }
  const exact = users.find((u) => foldText(u.display_name) === n || u.email.toLowerCase() === n);
  if (exact) return exact;
  const prefix = users.filter((u) => foldText(u.display_name).startsWith(n));
  if (prefix.length === 1) return prefix[0];
  throw new UserError(
    `No household member called "${name}". Use one of: ${users.map((u) => u.display_name).join(', ')}.`,
  );
}
