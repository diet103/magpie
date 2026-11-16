import type { DB } from '../db/sqlite.ts';

export type Via = 'mcp' | 'web' | 'cli';

/** Who is acting. Always derived from the OAuth token, web session or CLI flag, never from tool arguments. */
export interface Actor {
  userId: number;
  name: string;
  via: Via;
  client?: string | null;
}

export interface Ctx {
  db: DB;
  tz: string;
  actor: Actor;
}

export type FieldType = 'text' | 'number' | 'date' | 'url' | 'enum' | 'list' | 'boolean';
export const FIELD_TYPES: FieldType[] = ['text', 'number', 'date', 'url', 'enum', 'list', 'boolean'];

export interface FieldDef {
  key: string;
  type: FieldType;
  label?: string;
  options?: string[];
  description?: string;
  hidden?: boolean;
}

export interface Display {
  list_columns?: string[];
  default_sort?: { by: string; dir: 'asc' | 'desc' };
  subtitle?: string;
  log_noun?: string;
  filters?: string[];
  /** A list to tick off: the web app shows tick boxes, and each item has a hidden yes/no field `done`. */
  checklist?: boolean;
}

export type FieldValue = string | number | boolean | string[];
export type Fields = Record<string, FieldValue>;

export interface CollectionRow {
  id: number;
  slug: string;
  name: string;
  description: string;
  icon: string | null;
  fields: string;
  display: string;
  visibility: 'shared' | 'private';
  owner_id: number | null;
  created_by: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  sensitive: number;
}

export interface Collection extends Omit<CollectionRow, 'fields' | 'display'> {
  fields: FieldDef[];
  display: Display;
}

export interface EntryRow {
  id: number;
  collection_id: number;
  title: string;
  title_key: string;
  fields: string;
  tags: string;
  rating: number | null;
  rating_override: number | null;
  notes: string;
  source_text: string | null;
  first_logged_on: string | null;
  last_logged_on: string | null;
  log_count: number;
  created_by: number;
  updated_by: number | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  merged_into_id: number | null;
  revision: number;
  /** The encrypted text of an entry in a sensitive collection (src/domain/sealed.ts). Missing on rows in snapshots taken before sealing existed. */
  sealed?: string | null;
}

export interface LogRow {
  id: number;
  entry_id: number;
  occurred_on: string;
  note: string;
  rating: number | null;
  raw_text: string | null;
  created_by: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  sealed?: string | null;
}

export interface AttachmentRow {
  id: number;
  entry_id: number | null;
  filename: string;
  mime: string;
  size: number;
  created_by: number;
  created_at: string;
  deleted_at: string | null;
  preview_size: number | null;
}

export interface ActivityRow {
  id: number;
  at: string;
  user_id: number;
  via: Via;
  client: string | null;
  action: string;
  collection_id: number | null;
  entry_id: number | null;
  summary: string;
  raw_text: string | null;
  before_json: string | null;
  after_json: string | null;
  undone_by: number | null;
  sealed?: string | null;
}

export interface Snapshot {
  entries?: EntryRow[];
  logs?: LogRow[];
  collections?: CollectionRow[];
  attachments?: AttachmentRow[];
}

/** A completed write. summary is the one-line confirmation Claude repeats; extra lines are things worth mentioning. */
export interface WriteResult {
  ok: true;
  summary: string;
  extra: string[];
  entryId?: number;
  logId?: number;
  collectionId?: number;
  activityId?: number;
  replay?: boolean;
}

/** A normal, non-error refusal (possible duplicate, look-alike collection). text ends with the exact next call. */
export interface Refusal {
  ok: false;
  text: string;
  candidates?: { id: number; title: string; why: string }[];
}
