import type { Collection } from './types.ts';

export function fmtRating(r: number | null | undefined): string {
  if (r === null || r === undefined) return '';
  return `${Number.isInteger(r) ? r : r.toFixed(1)}/5`;
}

export function plural(noun: string, n: number): string {
  if (n === 1) return noun;
  if (/[^aeiou]y$/i.test(noun)) return noun.slice(0, -1) + 'ies';
  if (/(s|x|z|ch|sh)$/i.test(noun)) return noun + 'es';
  return noun + 's';
}

export function countOf(n: number, noun: string): string {
  return `${n} ${plural(noun, n)}`;
}

export function article(word: string): string {
  return /^[aeiou]/i.test(word) ? 'an' : 'a';
}

/** What a log is called in this collection ("visit", "viewing"), or "log" when the collection doesn't say. */
export function logNoun(c: Pick<Collection, 'display'>): string {
  return c.display.log_noun?.trim() || 'log';
}

export function hasLogNoun(c: Pick<Collection, 'display'>): boolean {
  return Boolean(c.display.log_noun?.trim());
}

/** "a visit to", "a stay at", "a viewing of". */
export function logPhrase(noun: string): string {
  const prep = /^(visit|trip)$/.test(noun) ? 'to' : /^(stay|meal|dinner|lunch|brunch)$/.test(noun) ? 'at' : 'of';
  return `${article(noun)} ${noun} ${prep}`;
}

export function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

export function joinAnd(items: string[]): string {
  if (items.length <= 1) return items.join('');
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** Cuts long text for tool output, with a marker so Claude knows there's more. */
export function cut(s: string | null | undefined, max = 600): string {
  if (!s) return '';
  const flat = s.replace(/\s*\n\s*/g, ' / ');
  return flat.length <= max ? flat : flat.slice(0, max).trimEnd() + ' …[cut, full_text: true for all]';
}

export function fieldLabelFromKey(key: string): string {
  return capitalize(key.replace(/_/g, ' '));
}
