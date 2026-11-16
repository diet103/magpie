// The Ask page: a chat window. The same markup is used for the saved conversation and for each new reply,
// which the browser appends as it arrives.
import { html, raw } from 'hono/html';
import { APP_NAME } from '../brand.ts';
import { localDateOf } from '../domain/time.ts';
import { icon, type Html } from './layout.ts';
import { markdown } from './markdown.ts';
import { csrfField, entryUrl } from './views.ts';

export interface ChatView {
  role: 'user' | 'assistant';
  text: string;
  at: string;
  /** Files the person sent with this message: each still viewable, or no longer kept. */
  photos: ({ id: number; pdf: boolean; name: string; /** Whether it has a small preview to show here. */ small: boolean } | 'gone')[];
  links: { id: number; title: string; collection: string; icon: string | null; verb: string }[];
  /** Web pages the reply drew on. */
  sources: { url: string; title: string }[];
}

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Chat replies use the same renderer as notes. */
export const richText = markdown;

export function clock(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
}

function dayLabel(day: string, today: string): string {
  if (day === today) return 'Today';
  const d = new Date(`${day}T12:00:00Z`);
  const t = new Date(`${today}T12:00:00Z`);
  if (t.getTime() - d.getTime() === 24 * 60 * 60_000) return 'Yesterday';
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', ...(day.slice(0, 4) === today.slice(0, 4) ? {} : { year: 'numeric' }) }).format(d);
}

export function chatMessage(m: ChatView, tz: string): Html {
  const mine = m.role === 'user';
  const photos = m.photos.map((p) =>
    p === 'gone'
      ? html`<p class="muted small">Photo (no longer kept)</p>`
      : p.pdf
        ? html`<a class="shot pdf" href="/files/${p.id}?download=1">PDF: ${p.name}</a>`
        : html`<a class="shot" href="/files/${p.id}" data-photo><img src="/files/${p.id}${p.small ? '/small' : ''}" alt="${p.name}" loading="lazy" /></a>`,
  );
  return html`<li class="msg ${mine ? 'me' : 'bot'}">
    <div class="bubble">
      ${photos}
      ${mine ? m.text.split('\n').map((line) => (line ? html`<p>${line}</p>` : '')) : richText(m.text)}
      ${m.links.length
        ? html`<ul class="receipts">
            ${m.links.map(
              (l) => html`<li><a href="${entryUrl(l.id)}">
                <span class="r-icon" aria-hidden="true">${l.icon ?? '📁'}</span>
                <span class="r-main"><b>${l.title}</b><small>${l.verb ? `${l.verb} in ${l.collection}` : l.collection}</small></span>
              </a></li>`,
            )}
          </ul>`
        : ''}
      ${m.sources.length
        ? html`<p class="sources">From the web: ${m.sources.map((s, i) => html`${i ? ', ' : ''}<a href="${s.url}" target="_blank" rel="noopener noreferrer" title="${s.title}">${host(s.url)}</a>`)}</p>`
        : ''}
    </div>
    <time datetime="${m.at}">${clock(m.at, tz)}</time>
  </li>`;
}

export interface Suggestion {
  label: string;
  /** Text put in the message box. */
  text: string;
  /** Send straight away instead of waiting for the person to finish the sentence. */
  send?: boolean;
  /** Open the photo picker instead. */
  pick?: boolean;
}

/** The message sent for the person when a search found nothing and they pressed "Ask". */
export function findMessage(what: string): string {
  return `Find "${what.replaceAll('"', "'")}" in what we have saved. A plain search found nothing, so look for other words it could be saved under.`;
}

export function askPage(o: { messages: ChatView[]; enabled: boolean; photos: boolean; suggestions: Suggestion[]; csrf: string; tz: string; today: string; idleMinutes: number; /** Words to put in the message box, from a search that found nothing. Never sent by itself. */ prefill?: string; /** What a search just failed to find. The chat opens already looking for it. */ find?: string; flash?: Html | string }): Html {
  if (!o.enabled) {
    return html`<section class="card narrow">
      <h1>Ask</h1>
      <p>This is a chat that saves and finds things right here, without opening Claude. It runs on your own Anthropic API key, and it isn't switched on yet.</p>
      <p>To switch it on, open the project folder on your computer and double-click <code>turn-on-ask.cmd</code>. It asks for the key once.</p>
    </section>`;
  }
  const items: Html[] = [];
  let lastDay = '';
  for (const m of o.messages) {
    const day = localDateOf(m.at, o.tz);
    if (day !== lastDay) {
      items.push(html`<li class="day"><span>${dayLabel(day, o.today)}</span></li>`);
      lastDay = day;
    }
    items.push(chatMessage(m, o.tz));
  }
  const empty = o.messages.length === 0;
  return html`<div class="chat" id="chat" data-idle-minutes="${o.idleMinutes}" ${o.find ? html`data-send-now="${findMessage(o.find)}"` : ''}>
    <h1 class="visually-hidden">Ask ${APP_NAME}</h1>
    <div class="chat-scroll" id="chat-scroll">
      ${o.flash ?? ''}
      <form method="post" action="/ask/reset" class="chat-new" id="chat-new" ${empty ? raw('hidden') : ''}>${csrfField(o.csrf)}<button class="secondary small">New chat</button></form>
      <div class="chat-empty" id="chat-empty" ${empty ? '' : raw('hidden')}>
        <h2>What should ${APP_NAME} remember?</h2>
        <p class="muted">Tell it about a place, a recipe, a movie, a gift idea. Or ask about anything you've saved.</p>
        <p class="muted small">A chat clears itself after an hour of quiet. Everything it saved stays in your collections.</p>
        <div class="suggest">
          ${o.suggestions.map(
            (s) => html`<button type="button" class="secondary" data-suggest="${s.text}" ${s.send ? raw('data-send') : ''} ${s.pick ? raw('data-pick') : ''}>${s.label}</button>`,
          )}
        </div>
      </div>
      <ol class="chat-log" id="chat-log" aria-live="polite" data-today="${o.today}" data-last-day="${lastDay}">${items}</ol>
    </div>
    <form class="composer" id="ask-form" method="post" action="/ask" enctype="multipart/form-data">
      ${csrfField(o.csrf)}
      <div class="tray" id="ask-tray" hidden></div>
      <div class="composer-row">
        ${o.photos
          ? html`<label class="icon-btn" title="Add a photo or PDF">
              ${icon('photo')}<span class="visually-hidden">Add a photo or PDF</span>
              <input type="file" id="ask-photo" name="photo" accept="image/jpeg,image/png,image/webp,application/pdf" multiple class="visually-hidden" />
            </label>`
          : ''}
        <textarea name="text" rows="1" placeholder="Message ${APP_NAME}" aria-label="Message" maxlength="4000" autocomplete="off">${o.prefill ?? ''}</textarea>
        <button class="icon-btn send" aria-label="Send">${icon('send')}</button>
      </div>
    </form>
  </div>`;
}
