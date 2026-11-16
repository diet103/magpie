import { UserError } from './errors.ts';
import { closest, foldText, levenshtein, normalizeFieldKey } from './normalize.ts';
import { isRealDate } from './time.ts';
import {
  FIELD_TYPES,
  type Collection,
  type Display,
  type FieldDef,
  type FieldType,
  type Fields,
  type FieldValue,
} from './types.ts';

export const BUILTIN_COLUMNS = [
  'title',
  'rating',
  'tags',
  'log_count',
  'first_logged_on',
  'last_logged_on',
  'created_at',
  'updated_at',
  'added_by',
] as const;

export const FIELD_KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;
const MAX_FIELDS = 40;

export function fieldLabel(def: FieldDef): string {
  if (def.label) return def.label;
  const s = def.key.replace(/_/g, ' ');
  return s[0].toUpperCase() + s.slice(1);
}

export function describeDef(def: FieldDef): string {
  return def.type === 'enum' ? `${def.key} (enum: ${(def.options ?? []).join(' ')})` : `${def.key} (${def.type})`;
}

function enumKey(s: string): string {
  return foldText(s).trim().replace(/[\s_-]+/g, '_');
}

/** Turns a value into the stored form for this field, or explains what's wrong. */
export function coerceValue(def: FieldDef, value: unknown, collectionName: string): FieldValue {
  const where = `\`${def.key}\` in ${collectionName}`;
  const str = (v: unknown) => (Array.isArray(v) ? v.join(', ') : String(v)).trim();
  switch (def.type) {
    case 'text': {
      const s = str(value);
      if (s.length > 2000) throw new UserError(`${where} is limited to 2,000 characters (got ${s.length}).`);
      return s;
    }
    case 'number': {
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      const n = typeof value === 'string' ? Number(value.replace(/[$,\s]/g, '')) : NaN;
      if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(n)) return n;
      throw new UserError(`${where} takes a number (got ${JSON.stringify(value)}).`);
    }
    case 'date': {
      const s = str(value);
      if (isRealDate(s)) return s;
      throw new UserError(`${where} takes a date as YYYY-MM-DD (got ${JSON.stringify(value)}).`);
    }
    case 'url': {
      let s = str(value);
      if (!/^https?:\/\//i.test(s) && /^[\w-]+(\.[\w-]+)+([/?#]\S*)?$/.test(s)) s = `https://${s}`;
      try {
        const u = new URL(s);
        if (u.protocol === 'http:' || u.protocol === 'https:') return u.toString();
      } catch {
        // fall through
      }
      throw new UserError(`${where} takes a web address starting with http:// or https:// (got ${JSON.stringify(value)}).`);
    }
    case 'enum': {
      const s = str(value);
      const options = def.options ?? [];
      const match = options.find((o) => enumKey(o) === enumKey(s));
      if (match !== undefined) return match;
      const suggestion = closest(s, options);
      throw new UserError(
        `${where} must be one of: ${options.join(', ')} (got "${s}").` +
          (suggestion ? ` Did you mean "${suggestion}"?` : '') +
          ` To allow a new value, call update_collection with update_fields: [{"key": "${def.key}", "options": ${JSON.stringify([...options, s])}}].`,
      );
    }
    case 'list': {
      const items = Array.isArray(value) ? value.map((v) => String(v)) : String(value).split(/[,;\n]/);
      const seen = new Set<string>();
      const out: string[] = [];
      for (const raw of items) {
        const item = raw.trim().slice(0, 200);
        const k = item.toLowerCase();
        if (item && !seen.has(k)) {
          seen.add(k);
          out.push(item);
        }
      }
      if (out.length > 50) throw new UserError(`${where} can hold at most 50 items.`);
      return out;
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      if (value === 1 || value === 0) return value === 1;
      const s = str(value).toLowerCase();
      if (['yes', 'y', 'true', '1', 'on'].includes(s)) return true;
      if (['no', 'n', 'false', '0', 'off'].includes(s)) return false;
      throw new UserError(`${where} takes true or false (got ${JSON.stringify(value)}).`);
    }
  }
}

export function inferType(value: unknown): FieldType {
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (Array.isArray(value)) return 'list';
  const s = String(value).trim();
  if (isRealDate(s)) return 'date';
  if (/^https?:\/\/\S+$/i.test(s)) return 'url';
  return 'text';
}

/** Drift guard: an unknown key that's suspiciously close to an existing one. */
export function nearFieldKey(key: string, defs: FieldDef[]): string | undefined {
  const bare = (s: string) => s.replace(/_/g, '');
  for (const d of defs) {
    if (levenshtein(key, d.key) <= 2) return d.key;
    if (bare(key) === bare(d.key)) return d.key;
    const [short, long] = key.length <= d.key.length ? [key, d.key] : [d.key, key];
    if (short.length >= 4 && long.startsWith(short)) return d.key;
  }
  return undefined;
}

export function isEmptyValue(v: unknown): boolean {
  return v === '' || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);
}

export interface FieldApply {
  fields: Fields;
  addedDefs: FieldDef[];
  changes: string[];
}

function showValue(v: FieldValue): string {
  return Array.isArray(v) ? v.join(', ') : typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v);
}

/**
 * Merges field input into the current values. Unknown keys close to existing ones are refused;
 * clearly new keys become new field definitions (returned in addedDefs for the caller to save).
 */
export function applyFields(
  coll: Collection,
  current: Fields,
  input: Record<string, unknown> | undefined,
  opts: { allowClear: boolean },
): FieldApply {
  const fields: Fields = { ...current };
  const addedDefs: FieldDef[] = [];
  const changes: string[] = [];
  if (!input) return { fields, addedDefs, changes };
  for (const [rawKey, value] of Object.entries(input)) {
    const key = normalizeFieldKey(rawKey);
    if (!FIELD_KEY_RE.test(key)) {
      throw new UserError(`"${rawKey}" isn't a usable field key. Keys are snake_case and start with a letter, like price_level.`);
    }
    if (value === null || value === undefined || isEmptyValue(value)) {
      if (key in fields) {
        if (!opts.allowClear) continue;
        delete fields[key];
        changes.push(`${key} cleared`);
      }
      continue;
    }
    const def = coll.fields.find((d) => d.key === key) ?? addedDefs.find((d) => d.key === key);
    let next: FieldValue;
    if (def) {
      next = coerceValue(def, value, coll.name);
    } else if (key in fields) {
      // An extra field the entry brought along from another collection: keep it, lightly checked.
      next = coerceValue({ key, type: inferType(value) }, value, coll.name);
    } else {
      const near = nearFieldKey(key, coll.fields);
      if (near) {
        throw new UserError(
          `${coll.name} has no field \`${rawKey}\`. Did you mean \`${near}\`? Its fields: ${coll.fields.map((d) => d.key).join(', ')}. ` +
            `If this really is a new field, add it first with update_collection add_fields.`,
        );
      }
      if (coll.fields.length + addedDefs.length >= MAX_FIELDS) {
        throw new UserError(`${coll.name} already has ${MAX_FIELDS} fields. Put this in notes instead.`);
      }
      const newDef: FieldDef = { key, type: inferType(value) };
      addedDefs.push(newDef);
      next = coerceValue(newDef, value, coll.name);
    }
    const before = fields[key];
    if (before === undefined || JSON.stringify(before) !== JSON.stringify(next)) {
      fields[key] = next;
      changes.push(before === undefined ? `${key} ${showValue(next)}` : `${key} ${showValue(next)} (was ${showValue(before)})`);
    }
  }
  return { fields, addedDefs, changes };
}

export interface FieldDefInput {
  key: string;
  type: string;
  label?: string;
  options?: string[];
  description?: string;
  hidden?: boolean;
}

/** Validates new field definitions against the existing ones. */
export function validateFieldDefs(input: FieldDefInput[], existing: FieldDef[]): FieldDef[] {
  const out: FieldDef[] = [];
  const taken = new Set(existing.map((d) => d.key));
  for (const raw of input) {
    const key = normalizeFieldKey(raw.key);
    if (!FIELD_KEY_RE.test(key)) {
      throw new UserError(`Field key "${raw.key}" must be snake_case and start with a letter, like price_level.`);
    }
    if (taken.has(key)) throw new UserError(`There's already a field \`${key}\`.`);
    if (!FIELD_TYPES.includes(raw.type as FieldType)) {
      throw new UserError(`Field \`${key}\` has unknown type "${raw.type}". Use one of: ${FIELD_TYPES.join(', ')}.`);
    }
    const def: FieldDef = { key, type: raw.type as FieldType };
    if (raw.label?.trim()) def.label = raw.label.trim().slice(0, 60);
    if (raw.description?.trim()) def.description = raw.description.trim().slice(0, 200);
    if (raw.hidden) def.hidden = true;
    if (def.type === 'enum') {
      def.options = cleanOptions(raw.options ?? []);
      if (def.options.length === 0) throw new UserError(`Enum field \`${key}\` needs options, e.g. ["want_to_try", "been"].`);
    }
    taken.add(key);
    out.push(def);
  }
  return out;
}

export function cleanOptions(options: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const o of options) {
    const v = String(o).trim().slice(0, 40);
    const k = enumKey(v);
    if (v && !seen.has(k)) {
      seen.add(k);
      out.push(v);
    }
  }
  if (out.length > 20) throw new UserError('An enum field can have at most 20 options.');
  return out;
}

export function enumMatches(a: string, b: string): boolean {
  return enumKey(a) === enumKey(b);
}

/**
 * Validates display hints, overlaying them on base. Unknown columns are dropped (and reported) rather than
 * refused: hints are cosmetic. Missing parts are filled with defaults when fillDefaults is set.
 */
export function normalizeDisplay(
  input: Display | undefined,
  defs: FieldDef[],
  base: Display = {},
  fillDefaults = false,
): { display: Display; ignored: string[] } {
  const keys = new Set(defs.map((d) => d.key));
  const builtin = new Set<string>(BUILTIN_COLUMNS);
  const ignored: string[] = [];
  const display: Display = { ...base, ...(input ?? {}) };
  if (display.list_columns) {
    display.list_columns = display.list_columns.filter((c) => {
      const ok = builtin.has(c) || keys.has(c);
      if (!ok) ignored.push(c);
      return ok;
    }).slice(0, 6);
  }
  if (display.default_sort) {
    const by = display.default_sort.by;
    if (!(builtin.has(by) || keys.has(by))) {
      ignored.push(by);
      delete display.default_sort;
    } else {
      display.default_sort = { by, dir: display.default_sort.dir === 'asc' ? 'asc' : 'desc' };
    }
  }
  if (display.subtitle !== undefined && !keys.has(display.subtitle)) {
    if (display.subtitle) ignored.push(display.subtitle);
    delete display.subtitle;
  }
  if (display.log_noun !== undefined) {
    const noun = display.log_noun.trim().toLowerCase().slice(0, 20);
    if (noun) display.log_noun = noun;
    else delete display.log_noun;
  }
  if (display.checklist !== true) delete display.checklist;
  if (display.filters) {
    display.filters = display.filters.filter((f) => {
      const d = defs.find((x) => x.key === f);
      const ok = d !== undefined && (d.type === 'enum' || d.type === 'boolean');
      if (!ok) ignored.push(f);
      return ok;
    }).slice(0, 4);
  }
  if (fillDefaults) {
    if (!display.list_columns || display.list_columns.length === 0) {
      display.list_columns = [...defs.filter((d) => !d.hidden).slice(0, 2).map((d) => d.key), 'rating', 'last_logged_on'];
    }
    if (!display.default_sort) {
      display.default_sort = display.log_noun ? { by: 'last_logged_on', dir: 'desc' } : { by: 'created_at', dir: 'desc' };
    }
  }
  return { display, ignored };
}

/** Field keys to summarize an entry in one line: the display columns that are fields, else the first fields. */
export function summaryKeys(coll: Collection, max = 3): string[] {
  const keys = new Set(coll.fields.filter((d) => !d.hidden).map((d) => d.key));
  const fromDisplay = (coll.display.list_columns ?? []).filter((c) => keys.has(c));
  const ordered = fromDisplay.length ? fromDisplay : [...keys];
  return ordered.slice(0, max);
}

export function formatValue(v: FieldValue | undefined): string {
  if (v === undefined) return '';
  return showValue(v);
}
