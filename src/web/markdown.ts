// A small, safe Markdown renderer for notes, long text fields and chat replies. It builds escaped HTML from a
// known set of constructs (headings, lists, bold, italic, code, links, quotes); anything else is shown as typed.
// No raw HTML ever passes through, and links are limited to http(s).
import { html } from 'hono/html';
import { realNewlines } from '../domain/text.ts';
import type { Html } from './layout.ts';

const INLINE = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\)|https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]|(?<![\w*])\*[^*\s][^*\n]*\*(?![\w*])|(?<![\w_])_[^_\s][^_\n]*_(?![\w_]))/g;

function inline(s: string): Html {
  return html`${s.split(INLINE).map((p, i) => {
    if (i % 2 === 0) return p;
    if (p.startsWith('**')) return html`<strong>${inline(p.slice(2, -2))}</strong>`;
    if (p.startsWith('`')) return html`<code>${p.slice(1, -1)}</code>`;
    if (p.startsWith('[')) {
      const m = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(p)!;
      return html`<a href="${m[2]}" target="_blank" rel="noopener noreferrer nofollow">${m[1]}</a>`;
    }
    if (p.startsWith('http')) return html`<a href="${p}" target="_blank" rel="noopener noreferrer nofollow">${p}</a>`;
    return html`<em>${inline(p.slice(1, -1))}</em>`;
  })}`;
}

export function markdown(input: string): Html {
  const text = realNewlines(input);
  const blocks: Html[] = [];
  let list: { ordered: boolean; items: Html[] } | null = null;
  let quote: string[] = [];
  let para: string[] = [];
  const flush = () => {
    if (list) blocks.push(list.ordered ? html`<ol>${list.items}</ol>` : html`<ul>${list.items}</ul>`);
    if (quote.length) blocks.push(html`<blockquote>${quote.map((q) => html`<p>${inline(q)}</p>`)}</blockquote>`);
    if (para.length) blocks.push(html`<p>${para.map((l, i) => html`${i ? html`<br />` : ''}${inline(l)}`)}</p>`);
    list = null;
    quote = [];
    para = [];
  };
  for (const rawLine of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.trim();
    if (!line) {
      flush();
      continue;
    }
    const heading = /^(#{1,4})\s+(.+?)\s*#*$/.exec(line);
    const bullet = /^[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\d{1,3}[.)]\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push(heading[1].length <= 2 ? html`<h3>${inline(heading[2])}</h3>` : html`<h4>${inline(heading[2])}</h4>`);
    } else if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
      flush();
      blocks.push(html`<hr />`);
    } else if (bullet || numbered) {
      const ordered = Boolean(numbered);
      if (!list || list.ordered !== ordered || quote.length || para.length) flush();
      list ??= { ordered, items: [] };
      const item = (bullet ?? numbered)![1];
      const box = /^\[( |x|X)\]\s+(.*)$/.exec(item);
      list.items.push(box ? html`<li class="task">${box[1] === ' ' ? '☐' : '☑'} ${inline(box[2])}</li>` : html`<li>${inline(item)}</li>`);
    } else if (line.startsWith('>')) {
      if (list || para.length) flush();
      quote.push(line.replace(/^>\s?/, ''));
    } else {
      if (list || quote.length) flush();
      para.push(line);
    }
  }
  flush();
  return html`${blocks}`;
}

/**
 * The bulleted lines of some notes, as plain text, by the same rules markdown() draws them with. When the notes
 * have a heading that matches `section` ("Ingredients"), only the bullets under it count; otherwise all of them.
 * Numbered lines are steps, not things, and are left out.
 */
export function bulletItems(input: string, section: RegExp): string[] {
  const all: string[] = [];
  const under: string[] = [];
  let inSection = false;
  let sawSection = false;
  for (const rawLine of realNewlines(input).replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.trim();
    const heading = /^(#{1,4})\s+(.+?)\s*#*$/.exec(line) ?? /^\*\*(.+?):?\*\*:?$/.exec(line)?.slice(0, 2).concat('') ?? null;
    if (heading) {
      inSection = section.test(heading[2] || heading[1]);
      sawSection ||= inSection;
      continue;
    }
    const bullet = /^[-*•]\s+(.*)$/.exec(line);
    if (!bullet) continue;
    const text = bullet[1].replace(/^\[( |x|X)\]\s+/, '').replace(/\*\*|__|`/g, '').trim();
    if (!text) continue;
    all.push(text);
    if (inSection) under.push(text);
  }
  return sawSection ? under : all;
}

/** Whether a value is worth rendering as Markdown rather than as a plain line. */
export function looksFormatted(input: string): boolean {
  const s = realNewlines(input);
  return s.includes('\n') || /\*\*[^*]+\*\*|^#{1,4}\s|^\s*[-*]\s|\[[^\]]+\]\(https?:/m.test(s);
}
