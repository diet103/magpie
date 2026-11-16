/** Normalized title used for duplicate detection: "Phở 54" -> "pho 54", "The Rabbit Hole" -> "rabbit hole". */
export function titleKey(title: string): string {
  return foldText(title)
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/^the /, '');
}

/** Lowercase and strip diacritics (đ/ð and a few letters NFKD can't decompose are mapped by hand). */
export function foldText(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[đð]/gi, 'd')
    .replace(/ø/gi, 'o')
    .replace(/æ/gi, 'ae')
    .replace(/ß/g, 'ss')
    .toLowerCase();
}

export function slugify(name: string): string {
  return titleKey(name).replace(/ /g, '-').slice(0, 60) || 'collection';
}

/** Tags are lowercase-hyphenated: "#Date Night" -> "date-night". */
export function normalizeTag(tag: string): string {
  return foldText(tag)
    .replace(/^#+/, '')
    .replace(/[_\s]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

/** Loose key for matching near-identical tags: "datenight", "date-nights" -> "datenight". */
export function looseTagKey(tag: string): string {
  return normalizeTag(tag).replace(/-/g, '').replace(/(es|s)$/, '');
}

/** Field keys are snake_case: "Price Level" -> "price_level". */
export function normalizeFieldKey(key: string): string {
  return foldText(key)
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 40);
}

export function singularize(word: string): string {
  if (word.endsWith('ies') && word.length > 4) return word.slice(0, -3) + 'y';
  if (/(ches|shes|sses|xes)$/.test(word)) return word.slice(0, -2);
  if (word.endsWith('s') && !word.endsWith('ss') && word.length > 3) return word.slice(0, -1);
  return word;
}

/** Collection names compared after folding and singularizing each word. */
export function collectionKey(name: string): string {
  return titleKey(name).split(' ').map(singularize).join(' ');
}

export function trigrams(s: string): Set<string> {
  const padded = `  ${s} `;
  const out = new Set<string>();
  for (let i = 0; i < padded.length - 2; i++) out.add(padded.slice(i, i + 3));
  return out;
}

/** Sørensen-Dice coefficient over character trigrams (0..1). */
export function dice(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = trigrams(a);
  const B = trigrams(b);
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return (2 * inter) / (A.size + B.size);
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

/** Picks the closest candidate for "did you mean" messages, or undefined if nothing is close. */
export function closest(input: string, candidates: string[]): string | undefined {
  let best: string | undefined;
  let bestScore = 0;
  const a = foldText(input);
  for (const c of candidates) {
    const b = foldText(c);
    const score = Math.max(dice(a, b), b.includes(a) || a.includes(b) ? 0.6 : 0, levenshtein(a, b) <= 2 ? 0.7 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return bestScore >= 0.45 ? best : undefined;
}

export function roundHalf(x: number): number {
  return Math.round(x * 2) / 2;
}

export function clip(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + '…';
}
