/**
 * Text sometimes arrives with its line breaks written out as the two characters "\n" instead of real line
 * breaks. When a text has no real breaks and clearly uses those as breaks, read them as breaks. A lone
 * backslash-n (a Windows path like C:\new) is left alone.
 */
export function realNewlines(text: string): string {
  if (text.includes('\n') || !text.includes('\\n')) return text;
  const count = text.split('\\n').length - 1;
  if (count < 2 && !/\\n(\\n|[-*#]|\d+[.)])/.test(text)) return text;
  return text.replace(/\\r?\\n|\\n/g, '\n');
}
