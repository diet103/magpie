// Service worker. Three jobs:
//  1. The app shell (CSS, scripts, icons, the offline page) is stored when the app is installed.
//  2. Pages you have opened, and the photos on them, are kept on this phone. A kept page shows at once, the
//     current one is fetched behind it, and the page is told when the two differ. With no connection the kept
//     copy is what you get.
//  3. Something shared into the app from another app is parked for the chat page.
// Anything that changes data (every request that is not a GET) clears the kept pages first, so a page is never
// shown from before your own change. Reaching a sign-in page clears pages and photos alike.
const VERSION = 'tracker-shell-22';
const SHELL = [
  '/static/app.css?v=22',
  '/static/app.js?v=22',
  '/static/htmx.min.js?v=22',
  '/static/icons/icon.svg',
  '/static/icons/icon-192.png',
  '/static/icons/icon-512.png',
  '/offline.html',
];
const SHARE_CACHE = 'magpie-share';
// Kept pages go with each new version: an old page points at old scripts and styles.
const PAGES = 'magpie-pages-' + VERSION;
// The "-2" starts every phone with no photos kept. Until the database stopped handing out a removed photo's
// id again (tracker migration 008), a phone could be holding the old picture under a new photo's id.
const FILES = 'magpie-files-2';
const MAX_PAGES = 150;
// A photo is /files/12 and its small preview is /files/12/small. Both are kept, so the limit covers two apiece.
const MAX_FILES = 240;
const PHOTO = /^\/files\/\d+(\/small)?$/;
// The same pages the server marks with X-Magpie-Keep (see page() in src/web/routes.ts). The header decides
// what is stored; this only saves looking for pages that never are.
const KEEPABLE = /^\/(c\/\d+(-[a-z0-9-]*)?|e\/\d+|search|activity)?$/;
const SIGN_IN = /^\/(login|logout|auth\/|oauth\/)/;

// Goes up with every change. A refresh that started before one finishes too late to be trusted.
let generation = 0;
// Pages being fetched ahead of the tap that will open them, and the ones that just were.
const ahead = new Map();
const fetchedAhead = new Map();
// The last thing found out about each page, for a page that asks before the news reaches it.
const latest = new Map();

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const mine = [VERSION, SHARE_CACHE, PAGES, FILES];
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => !mine.includes(k)).map((k) => caches.delete(k)));
      // Lets the browser start fetching a page while this worker is still starting up.
      if (self.registration.navigationPreload) await self.registration.navigationPreload.enable();
      await self.clients.claim();
    })(),
  );
});

// Something shared into the app from another app (a photo, a link, some text) arrives as a form post to /share.
// It is parked here for a moment and handed to the chat page, which puts it in the message box and removes it.
async function takeShare(req) {
  try {
    const form = await req.formData();
    const cache = await caches.open(SHARE_CACHE);
    const words = ['title', 'text', 'url'].map((k) => (typeof form.get(k) === 'string' ? form.get(k).trim() : '')).filter(Boolean);
    await cache.put('/shared/text', new Response(JSON.stringify({ text: [...new Set(words)].join('\n') })));
    const file = form.getAll('photo').find((f) => f instanceof File && f.size > 0);
    if (file) await cache.put('/shared/file', new Response(file, { headers: { 'content-type': file.type || 'application/octet-stream', 'x-name': encodeURIComponent(file.name || 'shared') } }));
    else await cache.delete('/shared/file');
  } catch (e) {
    // Fall through to the chat with nothing prefilled.
  }
  return Response.redirect('/ask?shared=1', 303);
}

// ---- Kept pages ----------------------------------------------------------------------------------------

/** One page, whatever it was opened from: the home screen icon adds ?source=pwa, which is not a different page. */
function pageKey(url) {
  const params = new URLSearchParams(url.search);
  params.delete('source');
  const query = params.toString();
  return url.pathname + (query ? '?' + query : '');
}

const REFRESH = { headers: { 'X-Magpie-Refresh': '1' }, credentials: 'same-origin', redirect: 'manual', cache: 'no-store' };

async function trim(name, max) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

async function keepPage(key, res) {
  const cache = await caches.open(PAGES);
  await cache.put(key, res);
  await trim(PAGES, MAX_PAGES);
}

async function dropPage(key) {
  const cache = await caches.open(PAGES);
  await cache.delete(key);
}

function forget() {
  generation++;
  ahead.clear();
  fetchedAhead.clear();
  latest.clear();
}

/** After a change: every kept page may now be out of date. */
async function clearPages() {
  forget();
  await caches.delete(PAGES);
}

/** At sign-in and sign-out, and when the server says nobody is signed in: nothing kept stays. */
async function wipe() {
  forget();
  await Promise.all([caches.delete(PAGES), caches.delete(FILES)]);
}

/** Tells the open page (if there is one for this address) what was found out about it. */
async function announce(key, state, html) {
  latest.set(key, { state, at: Date.now() });
  if (latest.size > 40) latest.delete(latest.keys().next().value);
  const windows = await self.clients.matchAll({ type: 'window' });
  for (const w of windows) {
    if (pageKey(new URL(w.url)) === key) w.postMessage({ type: 'magpie-page', key, state, html });
  }
}

/**
 * Gets the current version of a page that was just shown from its kept copy, and says how the two compare:
 * "same", "fresh" (with the new page), "gone" (moved, deleted, or signed out) or "offline".
 */
async function refresh(key, kept, preload) {
  const gen = generation;
  let now;
  try {
    const early = preload ? await preload : undefined;
    now = early && early.status === 200 ? early : await fetch(key, REFRESH);
  } catch (e) {
    return announce(key, 'offline');
  }
  if (gen !== generation) return;
  if (now.status === 401) {
    await wipe();
    return announce(key, 'gone');
  }
  // Moved (a redirect shows up here with no status), deleted, or no longer theirs to see.
  if (now.status === 0 || (now.status >= 300 && now.status < 400) || now.status === 404 || now.status === 410) {
    await dropPage(key);
    return announce(key, 'gone');
  }
  // The server is busy or restarting: the kept copy stands, and the page will ask again shortly.
  if (now.status !== 200) return announce(key, 'offline');
  const html = await now.clone().text();
  // A page carrying a one-time message is shown, and not kept.
  if (now.headers.get('X-Magpie-Keep')) await keepPage(key, now);
  else await dropPage(key);
  const before = kept ? await kept.text() : null;
  return announce(key, before === html ? 'same' : 'fresh', before === html ? undefined : html);
}

async function fromNetwork(event, key) {
  try {
    const res = (await event.preloadResponse) || (await fetch(event.request));
    if (key && res.status === 200 && res.headers.get('X-Magpie-Keep')) event.waitUntil(keepPage(key, res.clone()).catch(() => {}));
    return res;
  } catch (e) {
    // No connection. A kept copy beats the offline page, even when a reload was asked for.
    if (key) {
      const kept = await caches
        .open(PAGES)
        .then((cache) => cache.match(key))
        .catch(() => undefined);
      if (kept) {
        event.waitUntil(announce(key, 'offline'));
        return kept;
      }
    }
    return (await caches.match('/offline.html')) || Response.error();
  }
}

async function navigate(event) {
  const req = event.request;
  const url = new URL(req.url);
  if (SIGN_IN.test(url.pathname)) {
    await wipe().catch(() => {});
    return fromNetwork(event, null);
  }
  const key = KEEPABLE.test(url.pathname) ? pageKey(url) : null;
  // Pulling down to refresh, or a page reloading itself, asks for the real thing.
  const reloading = req.cache === 'reload' || req.cache === 'no-cache';
  if (key && !reloading) {
    try {
      const kept = await caches.open(PAGES).then((cache) => cache.match(key));
      if (kept) {
        const at = fetchedAhead.get(key);
        fetchedAhead.delete(key);
        // Fetched a moment ago, on the touch that led here: no need to fetch it again.
        if (at && Date.now() - at < 5000) event.waitUntil(Promise.resolve(event.preloadResponse).catch(() => {}));
        else event.waitUntil(refresh(key, kept.clone(), event.preloadResponse).catch(() => {}));
        return kept;
      }
      const coming = ahead.get(key);
      if (coming) {
        const res = await coming.catch(() => null);
        if (res) {
          fetchedAhead.delete(key);
          event.waitUntil(Promise.resolve(event.preloadResponse).catch(() => {}));
          return res;
        }
      }
    } catch (e) {
      // Storage trouble must never stand between a tap and its page.
    }
  }
  return fromNetwork(event, key);
}

/** Starts fetching a page on the touch that is about to open it, or keeps a pinned one ready with its photos. */
function fetchAhead(key, deep) {
  if (ahead.has(key)) return ahead.get(key);
  const gen = generation;
  const job = (async () => {
    const kept = await caches.open(PAGES).then((cache) => cache.match(key));
    if (kept) {
      if (deep) await keepPhotos(await kept.text());
      return null;
    }
    const res = await fetch(key, REFRESH);
    if (gen !== generation || res.status !== 200 || !res.headers.get('X-Magpie-Keep')) return null;
    await keepPage(key, res.clone());
    fetchedAhead.set(key, Date.now());
    if (deep) await keepPhotos(await res.clone().text());
    return res;
  })().finally(() => ahead.delete(key));
  ahead.set(key, job);
  return job;
}

/** For a page kept ahead of time: the pictures it shows (previews, where there are any) and the ones they open. */
async function keepPhotos(html) {
  const shown = [...html.matchAll(/src="(\/files\/\d+(?:\/small)?)"/g)].map((m) => m[1]);
  const behind = [...html.matchAll(/href="(\/files\/\d+)" data-photo/g)].map((m) => m[1]);
  await keepFiles([...new Set([...shown.slice(0, 8), ...behind.slice(0, 8)])]);
}

async function keepFiles(paths) {
  if (paths.length === 0) return;
  const cache = await caches.open(FILES);
  for (const key of paths) {
    if (!PHOTO.test(key) || (await cache.match(key))) continue;
    const res = await fetch(key, { credentials: 'same-origin' });
    if (res.status === 200) await cache.put(key, res);
  }
  await trim(FILES, MAX_FILES);
}

/** A photo never changes once stored, and neither does its preview, so the kept copy is always right. */
async function photo(event) {
  const key = new URL(event.request.url).pathname;
  const cache = await caches.open(FILES).catch(() => null);
  const kept = cache ? await cache.match(key) : undefined;
  if (kept) return kept;
  const res = await fetch(event.request);
  if (cache && res.status === 200) {
    event.waitUntil(
      cache
        .put(key, res.clone())
        .then(() => trim(FILES, MAX_FILES))
        .catch(() => {}),
    );
  }
  return res;
}

/** Anything that is not a GET may change what the kept pages show. */
/**
 * A tick or a new item sent by a checklist page's script. These are the changes made in a shop with a poor
 * signal, so the kept copy of the list must survive one that never left the phone: the page holds it in its
 * own queue, draws it over the kept copy and sends it later. The kept pages are cleared once it has gone through.
 */
const LIST_CHANGE = /^\/(e\/\d+\/tick|c\/\d+(-[a-z0-9-]*)?\/entries)$/;

async function change(event) {
  const url = new URL(event.request.url);
  const fromList = LIST_CHANGE.test(url.pathname) && event.request.headers.get('HX-Request');
  try {
    if (SIGN_IN.test(url.pathname)) await wipe();
    else if (!fromList) await clearPages();
  } catch (e) {
    // The request matters more than the housekeeping.
  }
  try {
    const res = await fetch(event.request);
    // And once more when it is done: a refresh that was under way may have put an older copy back.
    event.waitUntil(clearPages().catch(() => {}));
    return res;
  } catch (e) {
    if (event.request.mode === 'navigate') return (await caches.match('/offline.html')) || Response.error();
    throw e;
  }
}

self.addEventListener('message', (event) => {
  const m = event.data || {};
  if (m.type === 'magpie-files') {
    // An entry page showing previews asks for the full-size pictures behind them, so they open with no signal.
    const paths = Array.isArray(m.files) ? m.files.filter((f) => typeof f === 'string').slice(0, 8) : [];
    event.waitUntil(keepFiles(paths).catch(() => {}));
    return;
  }
  if (typeof m.key !== 'string' && typeof m.url !== 'string') return;
  if (m.type === 'magpie-hello') {
    // A page that has just loaded asks whether anything was found out about it before it could listen.
    const news = latest.get(m.key);
    if (!news || news.at < m.since || news.state === 'same') return;
    event.waitUntil(
      (async () => {
        const kept = news.state === 'fresh' ? await caches.open(PAGES).then((cache) => cache.match(m.key)) : undefined;
        event.source.postMessage({ type: 'magpie-page', key: m.key, state: news.state, html: kept ? await kept.text() : undefined });
      })().catch(() => {}),
    );
  } else if (m.type === 'magpie-ahead') {
    const url = new URL(m.url, self.location.origin);
    if (url.origin === self.location.origin && KEEPABLE.test(url.pathname)) event.waitUntil(fetchAhead(pageKey(url), Boolean(m.deep)).catch(() => {}));
  } else if (m.type === 'magpie-refresh') {
    // The app came back to the front still showing what it showed when it was put away.
    const url = new URL(m.key, self.location.origin);
    if (url.origin !== self.location.origin || !KEEPABLE.test(url.pathname)) return;
    event.waitUntil(
      caches
        .open(PAGES)
        .then((cache) => cache.match(m.key))
        .then((kept) => refresh(m.key, kept || null, null))
        .catch(() => {}),
    );
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.method === 'POST' && url.pathname === '/share') {
    event.respondWith(takeShare(req));
    return;
  }
  if (req.method === 'HEAD') return;
  if (req.method !== 'GET') {
    // A slow-load report changes nothing anyone sees. Nor does the preview a page makes for an older photo.
    if (url.pathname !== '/beacon' && !/^\/files\/\d+\/small$/.test(url.pathname)) event.respondWith(change(event));
    return;
  }
  if (req.mode === 'navigate') {
    event.respondWith(navigate(event));
    return;
  }
  if (url.pathname.startsWith('/static/')) {
    // The stored file when there is one for this exact version; with no connection, whichever version is stored.
    event.respondWith(caches.match(req).then((hit) => hit || fetch(req).catch(() => caches.match(req, { ignoreSearch: true }))));
    return;
  }
  if (PHOTO.test(url.pathname) && !url.search) event.respondWith(photo(event));
});
