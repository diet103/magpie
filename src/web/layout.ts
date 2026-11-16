import { html, raw } from 'hono/html';
import { APP_NAME } from '../brand.ts';
import type { HtmlEscapedString } from 'hono/utils/html';

export type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

export const ASSET_VERSION = '21';

const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  ask: '<path d="M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-8l-5 4v-4H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/>',
  activity: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  person: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/>',
  photo: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="10" r="1.5"/><path d="m21 15-5-5-9 9"/>',
  send: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
} as const;

/** A small line icon. Decorative: pair it with text or an aria-label. */
export function icon(name: keyof typeof ICONS): Html {
  return raw(`<svg class="ico" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`) as unknown as Html;
}

export interface LayoutOptions {
  title: string;
  body: Html;
  userName?: string;
  /** Who the page was made for. The page's script uses it to keep one person's unsent changes from another's. */
  userId?: number;
  csrf?: string;
  bare?: boolean;
  active?: 'home' | 'activity' | 'trash' | 'settings' | 'ask';
  /** Extra class on <body>, for pages with their own layout (the chat fills the screen). */
  bodyClass?: string;
}

export function layout(o: LayoutOptions): Html {
  const nav = o.bare
    ? ''
    : html`<header class="top">
        <a class="brand" href="/">${APP_NAME}</a>
        <form class="topsearch" action="/search" method="get" role="search">
          <input type="search" name="q" placeholder="Search everything" aria-label="Search everything" autocomplete="off" />
        </form>
        <nav>
          <a href="/ask" ${o.active === 'ask' ? raw('aria-current="page"') : ''}>Ask</a>
          <a href="/activity" ${o.active === 'activity' ? raw('aria-current="page"') : ''}>Activity</a>
          <a href="/settings" ${o.active === 'settings' ? raw('aria-current="page"') : ''}>${o.userName ?? 'Settings'}</a>
        </nav>
      </header>`;
  const current = (name: LayoutOptions['active']) => (o.active === name ? raw('aria-current="page"') : '');
  // Phones get the main places as a bar under the thumb; wider screens use the links in the header.
  const tabs = o.bare
    ? ''
    : html`<nav class="tabbar" aria-label="Main">
        <a href="/" ${current('home')}>${icon('home')}<span>Home</span></a>
        <a href="/ask" ${current('ask')}>${icon('ask')}<span>Ask</span></a>
        <a href="/activity" ${current('activity')}>${icon('activity')}<span>Activity</span></a>
        <a href="/settings" ${current('settings')}>${icon('person')}<span>${o.userName ?? 'Settings'}</span></a>
      </nav>`;
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="color-scheme" content="light dark" />
<meta name="theme-color" content="#1f6f5c" />
<meta name="htmx-config" content='{"includeIndicatorStyles":false,"allowEval":false}' />
${o.csrf ? html`<meta name="csrf-token" content="${o.csrf}" />` : ''}
${o.userId ? html`<meta name="magpie-user" content="${o.userId}" />` : ''}
<title>${o.title} · ${APP_NAME}</title>
<link rel="manifest" href="/manifest.webmanifest" />
<link rel="icon" href="/static/icons/icon.svg" type="image/svg+xml" />
<link rel="apple-touch-icon" href="/static/icons/icon-192.png" />
<link rel="stylesheet" href="/static/app.css?v=${ASSET_VERSION}" />
<script src="/static/htmx.min.js?v=${ASSET_VERSION}" defer></script>
<script src="/static/app.js?v=${ASSET_VERSION}" defer></script>
</head>
<body${o.bodyClass ? raw(` class="${o.bodyClass}"`) : ''}>
${nav}
<main>${o.body}</main>
${tabs}
</body>
</html>`;
}

/** A simple message page (errors, sign-in problems). */
export function messagePage(title: string, message: Html | string, extra: Html | string = ''): Html {
  return layout({
    title,
    bare: true,
    body: html`<section class="card narrow">
      <h1>${title}</h1>
      <p>${message}</p>
      ${extra}
    </section>`,
  });
}
