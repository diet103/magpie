// Small progressive enhancements. Everything works without JavaScript; this only adds polish.
(function () {
  'use strict';
  var meta = document.querySelector('meta[name="csrf-token"]');
  var token = meta ? meta.getAttribute('content') : null;

  document.addEventListener('htmx:configRequest', function (e) {
    if (token) e.detail.headers['X-CSRF-Token'] = token;
  });

  // Buttons with data-confirm ask first (e.g. "Delete forever").
  document.addEventListener('click', function (e) {
    var el = e.target instanceof Element ? e.target.closest('[data-confirm]') : null;
    if (el && !window.confirm(el.getAttribute('data-confirm') || 'Are you sure?')) e.preventDefault();
  });

  // ---- Always show that something is happening -------------------------------------------------------
  // A tap that starts loading a page gets a moving bar across the top straight away, and the button that was
  // pressed shows a spinner and can't be pressed twice.
  var bar = document.createElement('div');
  bar.className = 'loadbar';
  bar.hidden = true;
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-label', 'Loading');
  document.body.appendChild(bar);
  var barTimer = null;
  function loading(on) {
    clearTimeout(barTimer);
    bar.hidden = !on;
    // Safety net for taps that turn out not to leave the page (a download, a blocked request).
    if (on) barTimer = setTimeout(done, 15000);
  }
  function done() {
    loading(false);
    Array.prototype.forEach.call(document.querySelectorAll('.is-busy'), function (b) { b.classList.remove('is-busy'); b.removeAttribute('aria-busy'); });
  }
  function busy(button) {
    if (!button) return;
    button.classList.add('is-busy');
    button.setAttribute('aria-busy', 'true');
  }
  var STAYS = /^\/(files\/|export|logout)/; // downloads and the like: the page does not change
  window.addEventListener('pageshow', done);
  document.addEventListener('click', function (e) {
    var a = e.target instanceof Element ? e.target.closest('a[href]') : null;
    if (!a || a.target || a.hasAttribute('download') || a.hasAttribute('data-photo') || e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
    if (a.origin !== location.origin || STAYS.test(a.pathname)) return;
    if (a.pathname === location.pathname && a.search === location.search && a.hash) return;
    setTimeout(function () { if (!e.defaultPrevented) { loading(true); if (a.closest('.tabbar, .top')) a.classList.add('is-going'); } }, 0);
  });
  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (!(f instanceof HTMLFormElement)) return;
    var button = e.submitter || f.querySelector('button:not([type="button"])');
    var action = new URL(f.action, location.href);
    // Checked a moment later so forms another script takes over (the chat) or cancels are left alone.
    setTimeout(function () {
      if (e.defaultPrevented) { if (f.hasAttribute('data-photo-form')) { loading(true); busy(button); } return; }
      // Remove and Read under a photo do lead to a new page, unlike a link to the file itself. Showing them as
      // busy also stops a second tap from sending the form twice.
      var stays = STAYS.test(action.pathname) && !/^\/files\/\d+\/(delete|read)$/.test(action.pathname);
      if (f.target || stays) return;
      loading(true);
      busy(button);
    }, 0);
  });
  // Double taps on a busy button do nothing.
  document.addEventListener('click', function (e) {
    var b = e.target instanceof Element ? e.target.closest('.is-busy') : null;
    if (b) { e.preventDefault(); e.stopPropagation(); }
  }, true);
  document.body.addEventListener('htmx:beforeRequest', function () { loading(true); });
  document.body.addEventListener('htmx:afterRequest', function () { loading(false); });

  // Sort and filter menus apply as soon as a choice is made.
  document.addEventListener('change', function (e) {
    var el = e.target;
    if (el instanceof HTMLSelectElement && el.form && el.form.hasAttribute('data-autosubmit')) el.form.requestSubmit();
  });

  // Phone photos are huge; shrink them in the browser before they are sent.
  function shrink(file) {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type) || !window.createImageBitmap) return Promise.resolve(file);
    return createImageBitmap(file).then(function (bmp) {
      var max = 2200;
      var scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
      if (scale === 1 && file.size < 1500000) return file;
      var canvas = document.createElement('canvas');
      canvas.width = Math.round(bmp.width * scale);
      canvas.height = Math.round(bmp.height * scale);
      canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
      return new Promise(function (resolve) {
        canvas.toBlob(function (blob) {
          resolve(blob ? new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }) : file);
        }, 'image/jpeg', 0.88);
      });
    }).catch(function () { return file; });
  }

  // A small copy of each photo goes up with it, so a page of photos does not load every one at full size.
  // A photo that is small already is shown as it is (the server draws the same 200 KB line, in files.ts).
  var PREVIEW_EDGE = 640;
  var PREVIEW_WORTH = 200 * 1024;
  var idle = window.requestIdleCallback || function (f) { setTimeout(f, 1200); };
  function drawSmall(source, width, height) {
    var scale = Math.min(1, PREVIEW_EDGE / Math.max(width, height));
    var canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    var ctx = canvas.getContext('2d');
    if (!ctx) return Promise.resolve(null);
    ctx.fillStyle = '#fff'; // a see-through PNG would otherwise come out black as a JPEG
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    return new Promise(function (resolve) { canvas.toBlob(resolve, 'image/jpeg', 0.8); });
  }
  function previewOf(file) {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size <= PREVIEW_WORTH || !window.createImageBitmap) return Promise.resolve(null);
    return createImageBitmap(file).then(function (bmp) { return drawSmall(bmp, bmp.width, bmp.height); }).catch(function () { return null; });
  }

  function formWithSmallPhotos(form) {
    var input = form.querySelector('input[type="file"]');
    // Empty files are left out here because the server leaves them out too, and "preview3" must mean the same photo to both.
    var picked = (input ? Array.prototype.slice.call(input.files || []) : []).filter(function (f) { return f.size > 0; });
    return Promise.all(picked.map(shrink)).then(function (files) {
      return Promise.all(files.map(previewOf)).then(function (previews) {
        var data = new FormData();
        var text = form.querySelector('[name="text"]');
        if (text) data.append('text', text.value);
        files.forEach(function (f) { data.append('photo', f, f.name); });
        previews.forEach(function (small, i) { if (small) data.append('preview' + i, small, 'preview.jpg'); });
        return data;
      });
    });
  }

  function post(url, data) {
    return fetch(url, { method: 'POST', body: data, headers: { 'X-CSRF-Token': token || '', Accept: 'application/json' }, credentials: 'same-origin' });
  }

  // Things on the page that are set up one by one. Run again whenever part of the page is replaced.
  function enhance(root) {
    // With scripting on, "Add photo" is a single tap: it opens the picker and uploads as soon as something is chosen.
    Array.prototype.forEach.call(root.querySelectorAll('form[data-photo-form]'), function (f) {
      var input = f.querySelector('input[type="file"]');
      var button = f.querySelector('button');
      if (!input || !button || !window.fetch) return;
      f.classList.add('js');
      button.addEventListener('click', function (e) {
        if (!input.files || input.files.length === 0) { e.preventDefault(); input.click(); }
      });
      input.addEventListener('change', function () { if (input.files && input.files.length) f.requestSubmit(); });
    });
    // Share hands the entry to the phone's own share sheet, so the button only shows where there is one.
    Array.prototype.forEach.call(root.querySelectorAll('[data-share]'), function (b) { b.hidden = !navigator.share; });
    // Pinned entries are kept ready on this phone, photos included, so they open with no signal.
    var pinned = root.querySelectorAll('a[data-keep]');
    if (pinned.length) {
      idle(function () {
        Array.prototype.forEach.call(pinned, function (a) { tellWorker({ type: 'magpie-ahead', url: a.pathname + a.search, deep: true }); });
      });
    }
    // A photo stored before previews existed is shown whole and marked. A preview is made for it here and sent
    // in, so the next visit, from either phone, loads the small one. What is sent in is shown to everyone, so
    // it is never made from the picture on screen, which may be a copy this phone kept: the photo is fetched
    // again as the server has it now (the "?fresh" keeps the service worker out of it). One at a time.
    var waiting = Promise.resolve();
    Array.prototype.forEach.call(root.querySelectorAll('img[data-make-preview]'), function (img) {
      var path = new URL(img.getAttribute('src'), location.href).pathname;
      img.removeAttribute('data-make-preview');
      if (!window.createImageBitmap || !window.fetch || (navigator.connection && navigator.connection.saveData)) return;
      waiting = waiting.then(function () {
        return new Promise(function (resolve) { idle(resolve); });
      }).then(function () {
        // A kept copy of the page may have been showing; if the current page has since replaced it, it decides.
        return document.contains(img) ? fetch(path + '?fresh=1', { credentials: 'same-origin', cache: 'no-store' }) : null;
      }).then(function (res) {
        return res && res.ok ? res.blob() : null;
      }).then(function (blob) {
        return blob ? createImageBitmap(blob) : null;
      }).then(function (bmp) {
        if (!bmp) return null;
        var made = drawSmall(bmp, bmp.width, bmp.height);
        if (bmp.close) bmp.close();
        return made;
      }).then(function (small) {
        if (!small) return;
        var data = new FormData();
        data.append('preview', small, 'preview.jpg');
        return post(path + '/small', data);
      }).catch(function () {});
    });
    // The list shows previews. The pictures behind them are fetched quietly and kept on this phone as well, so
    // a photo still opens at full size with no signal. Not when the phone is set to save data.
    var behind = [];
    Array.prototype.forEach.call(root.querySelectorAll('.photos a[data-photo]'), function (a) {
      var shown = a.querySelector('img');
      if (shown && shown.getAttribute('src') !== a.getAttribute('href')) behind.push(a.getAttribute('href'));
    });
    if (behind.length && !(navigator.connection && navigator.connection.saveData)) {
      idle(function () { tellWorker({ type: 'magpie-files', files: behind.slice(0, 8) }); });
    }
    showWaiting();
  }

  // ---- Checklists: ticking with no signal, and the other phone's changes ------------------------------
  // A tick or a new item that cannot reach the server is shown on the page anyway and kept in a small queue on
  // this phone, then sent in order once there is a connection. Sending one twice is harmless: a tick says what
  // the item should be, not "flip it", and adding a name that is already on the list changes nothing.
  // The queue belongs to the person who made it. If someone else is signed in on this phone when it is next
  // read, it is thrown away: their changes must not be sent, or shown, as anyone else's.
  var QUEUE = 'magpie-list-queue';
  var ME = (document.querySelector('meta[name="magpie-user"]') || {}).content || '';
  function queued() {
    try {
      var kept = JSON.parse(localStorage.getItem(QUEUE) || 'null');
      if (!kept) return [];
      if (Array.isArray(kept)) return kept; // written before the queue carried a name
      if (kept.user === ME) return kept.items || [];
      if (ME) localStorage.removeItem(QUEUE);
      return [];
    } catch (e) { return []; }
  }
  function setQueued(q) {
    try { if (q.length) localStorage.setItem(QUEUE, JSON.stringify({ user: ME, items: q })); else localStorage.removeItem(QUEUE); } catch (e) { /* private mode: nothing is kept */ }
  }
  function itemsBox() { return document.getElementById('checklist-items'); }
  // Every change clears the pages kept on this phone, this list among them. It is asked for again straight
  // away, so the list still opens the next time there is no signal.
  var keeping = 0;
  function keepList() {
    clearTimeout(keeping);
    keeping = setTimeout(function () { if (itemsBox()) tellWorker({ type: 'magpie-ahead', url: pageKey() }); }, 1200);
  }
  var waitingWhy = '';
  // Draws the waiting changes over whatever the list says, so a page reloaded or brought up to date still shows them.
  function showWaiting() {
    var box = itemsBox();
    var note = document.getElementById('checklist-waiting');
    if (!box) return;
    var list = box.getAttribute('data-list');
    var mine = queued().filter(function (op) { return String(op.list) === list; });
    mine.forEach(function (op, n) {
      if (op.kind === 'tick') {
        var li = box.querySelector('li[data-item="' + Number(op.id) + '"]');
        if (!li) return;
        var b = li.querySelector('button.tick');
        var hidden = li.querySelector('input[name="done"]');
        if (b) { b.classList.toggle('on', op.done); b.textContent = op.done ? '\u2713' : ''; b.setAttribute('aria-pressed', op.done ? 'true' : 'false'); }
        if (hidden) hidden.value = op.done ? '0' : '1';
        li.classList.add('waiting');
        var home = box.querySelector(op.done ? 'ul.ticked' : 'ul.todo');
        if (home && li.parentElement !== home) home.appendChild(li);
      } else if (!box.querySelector('li[data-waiting="' + n + '"]')) {
        var added = document.createElement('li');
        added.className = 'waiting';
        added.setAttribute('data-waiting', String(n));
        var gap = document.createElement('span');
        gap.className = 'tick-gap';
        var name = document.createElement('span');
        name.textContent = op.title;
        added.appendChild(gap);
        added.appendChild(name);
        var todo = box.querySelector('ul.todo');
        if (todo) todo.appendChild(added);
      }
    });
    var heading = box.querySelector('h2');
    var ticked = box.querySelector('ul.ticked');
    if (heading && ticked && mine.length) heading.hidden = ticked.children.length === 0;
    if (note) {
      note.hidden = mine.length === 0;
      note.textContent = mine.length === 0 ? '' : (mine.length === 1 ? '1 change is' : mine.length + ' changes are') + ' saved on this phone. ' + (waitingWhy || 'They will be sent when there is a signal.');
    }
  }
  // The request never left the phone: keep what was asked, and show it.
  document.body.addEventListener('htmx:sendError', function (e) {
    var form = e.detail && e.detail.elt instanceof Element ? e.detail.elt.closest('form') : null;
    var box = itemsBox();
    if (!form || !box || !form.closest('#checklist')) return;
    var path = new URL(form.action, location.href).pathname;
    var list = Number(box.getAttribute('data-list'));
    var tick = /^\/e\/(\d+)\/tick$/.exec(path);
    var q = queued();
    if (tick) {
      var done = form.querySelector('input[name="done"]');
      q.push({ kind: 'tick', list: list, id: Number(tick[1]), done: Boolean(done && done.value === '1') });
    } else if (/^\/c\/[^/]+\/entries$/.test(path)) {
      var title = form.querySelector('input[name="title"]');
      if (!title || !title.value.trim()) return;
      q.push({ kind: 'add', list: list, title: title.value.trim().slice(0, 200) });
      title.value = '';
    } else return;
    if (q.length > 200) return;
    setQueued(q);
    waitingWhy = '';
    showWaiting();
  });
  function refreshItems() {
    var box = itemsBox();
    if (!box) return;
    fetch('/c/' + box.getAttribute('data-list') + '/items', { credentials: 'same-origin', redirect: 'manual' })
      .then(function (res) { return res.ok ? res.text() : null; })
      .then(function (html) {
        var now = itemsBox();
        if (!html || !now || document.querySelector('#checklist .htmx-request')) return;
        var next = new DOMParser().parseFromString(html, 'text/html').getElementById('checklist-items');
        if (!next) return;
        var fresh = document.importNode(next, true);
        now.replaceWith(fresh);
        if (window.htmx) window.htmx.process(fresh);
        showWaiting();
        keepList();
      })
      .catch(function () {});
  }
  var sending = false;
  function sendWaiting() {
    var q = queued();
    if (sending || q.length === 0 || !window.fetch) return;
    sending = true;
    var op = q[0];
    var stop = function (why) { sending = false; waitingWhy = why || ''; showWaiting(); };
    var body = new URLSearchParams(op.kind === 'tick' ? { done: op.done ? '1' : '0' } : { title: op.title });
    fetch(op.kind === 'tick' ? '/e/' + Number(op.id) + '/tick' : '/c/' + Number(op.list) + '/entries', {
      method: 'POST', body: body, credentials: 'same-origin', redirect: 'manual',
      headers: { 'X-CSRF-Token': token || '', 'HX-Request': 'true', 'HX-Target': 'checklist-items' },
    }).then(function (res) {
      // Signed out (a redirect to the sign-in page) or this page's form token has gone stale: keep everything.
      if (res.type === 'opaqueredirect' || res.status === 401 || res.status === 403) { stop('Sign in again, then open this list, to send them.'); return; }
      if (res.status >= 500 || res.status === 429) { stop(''); return; }
      // Sent, or turned down for good (the item was cleared by the other person): either way it is done with.
      var rest = queued();
      rest.shift();
      setQueued(rest);
      sending = false;
      if (rest.length) sendWaiting();
      else { waitingWhy = ''; refreshItems(); showWaiting(); }
    }, function () { stop(''); });
  }
  window.addEventListener('online', sendWaiting);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) sendWaiting(); });
  document.body.addEventListener('htmx:afterOnLoad', function () { sendWaiting(); keepList(); });
  setTimeout(sendWaiting, 1500);
  // The other phone: ask every few seconds whether the list has changed, and fetch the lists when it has.
  setInterval(function () {
    var box = itemsBox();
    if (!box || document.hidden || queued().length || sending || document.querySelector('#checklist .htmx-request')) return;
    fetch('/c/' + box.getAttribute('data-list') + '/stamp', { credentials: 'same-origin', redirect: 'manual' })
      .then(function (res) { return res.ok ? res.text() : ''; })
      .then(function (stamp) {
        var now = itemsBox();
        if (now && /^[\d.]+$/.test(stamp) && stamp !== now.getAttribute('data-stamp')) refreshItems();
      })
      .catch(function () {});
  }, 5000);

  // ---- Pages kept on this phone ----------------------------------------------------------------------
  // The service worker shows the last copy of a page at once and fetches the current one behind it. When the
  // two differ it says so here and the page is brought up to date in place, unless you are in the middle of
  // something, in which case it offers to.
  var main = document.querySelector('main');
  var pristine = main ? main.innerHTML : ''; // the page as it arrived, before any script touched it
  var touched = false;
  var worker = 'serviceWorker' in navigator ? navigator.serviceWorker : null;
  function tellWorker(message) {
    if (worker && worker.controller) worker.controller.postMessage(message);
  }
  function pageKey() {
    var params = new URLSearchParams(location.search);
    params.delete('source');
    var query = params.toString();
    return location.pathname + (query ? '?' + query : '');
  }
  ['pointerdown', 'keydown'].forEach(function (type) {
    document.addEventListener(type, function () { touched = true; }, { capture: true, passive: true });
  });
  function midEdit() {
    if (!main) return false;
    return Array.prototype.some.call(main.querySelectorAll('input, textarea, select'), function (f) {
      if (f.type === 'hidden' || f.type === 'search') return false;
      if (f.type === 'checkbox' || f.type === 'radio') return f.checked !== f.defaultChecked;
      if (f.tagName === 'SELECT') return Array.prototype.some.call(f.options, function (o) { return o.selected !== o.defaultSelected; });
      return f.value !== f.defaultValue;
    });
  }
  var note = null;
  function showNote(text, action, onAction) {
    hideNote();
    note = document.createElement('div');
    note.className = 'pagenote';
    note.setAttribute('role', 'status');
    note.appendChild(document.createTextNode(text));
    if (action) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'link';
      b.textContent = action;
      b.addEventListener('click', onAction);
      note.appendChild(b);
    }
    // Above the page's content and in its flow, so it covers nothing and stays in view while scrolling.
    document.body.insertBefore(note, main);
  }
  function hideNote() {
    if (note) note.remove();
    note = null;
  }
  function bringUpToDate(html) {
    var doc = new DOMParser().parseFromString(html, 'text/html');
    var next = doc.querySelector('main');
    if (!next || !main) { location.reload(); return; }
    if (next.innerHTML === pristine) return;
    function apply() {
      hideNote();
      pristine = next.innerHTML;
      document.title = doc.title;
      var incoming = document.importNode(next, true);
      main.textContent = '';
      while (incoming.firstChild) main.appendChild(incoming.firstChild);
      enhance(main);
      if (window.htmx) window.htmx.process(main);
    }
    if (touched || midEdit() || document.body.classList.contains('viewing')) showNote('This page has changed.', 'Show the latest', apply);
    else apply();
  }
  // When the server could not be reached, the page asks again by itself: after 5 seconds, then 10, 20 and so on.
  var retries = 0;
  var retryTimer = null;
  function askAgainLater() {
    clearTimeout(retryTimer);
    if (retries >= 6) return;
    retryTimer = setTimeout(function () {
      if (!document.hidden) tellWorker({ type: 'magpie-refresh', key: pageKey() });
    }, 5000 * Math.pow(2, retries++));
  }
  if (worker) {
    worker.addEventListener('message', function (e) {
      var m = e.data || {};
      if (m.type !== 'magpie-page' || m.key !== pageKey()) return;
      if (m.state === 'offline') {
        showNote('No connection. This is the copy saved on this phone.');
        askAgainLater();
        return;
      }
      clearTimeout(retryTimer);
      retries = 0;
      if (m.state === 'fresh' && m.html) bringUpToDate(m.html);
      else if (m.state === 'gone') location.reload();
      else if (m.state === 'same') hideNote();
    });
    tellWorker({ type: 'magpie-hello', key: pageKey(), since: performance.timeOrigin });
    window.addEventListener('online', function () { tellWorker({ type: 'magpie-refresh', key: pageKey() }); });
    // Fetching starts on the touch, a moment before the tap is complete.
    document.addEventListener('pointerdown', function (e) {
      var a = e.target instanceof Element ? e.target.closest('a[href]') : null;
      if (!a || a.target || a.origin !== location.origin || a.hasAttribute('download') || a.hasAttribute('data-photo')) return;
      tellWorker({ type: 'magpie-ahead', url: a.pathname + a.search });
    }, { passive: true });
  }
  // Coming back to the app: the connection has usually gone stale while the phone was in a pocket, so it is
  // woken before the first tap needs it, and a page that has sat for a while is checked for changes.
  var hiddenAt = 0;
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { hiddenAt = Date.now(); touched = false; return; }
    var away = hiddenAt ? Date.now() - hiddenAt : 0;
    if (away > 20000 && window.fetch) fetch('/healthz', { cache: 'no-store' }).catch(function () {});
    if (away > 60000 && main && !document.getElementById('chat')) tellWorker({ type: 'magpie-refresh', key: pageKey() });
  });

  enhance(document);
  // A preview that will not load (its file is missing on the server) gives way to the photo itself.
  document.addEventListener('error', function (e) {
    var img = e.target;
    if (!(img instanceof HTMLImageElement) || !/^\/files\/\d+\/small$/.test(img.getAttribute('src') || '')) return;
    img.src = img.getAttribute('src').replace(/\/small$/, '');
  }, true);

  // ---- Copy and share --------------------------------------------------------------------------------
  var toastEl = null;
  var toastTimer = null;
  function toast(text) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'toast';
      toastEl.setAttribute('role', 'status');
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = text;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.hidden = true; }, 1600);
  }
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      var box = document.createElement('textarea');
      box.value = text;
      box.setAttribute('readonly', '');
      box.className = 'visually-hidden';
      document.body.appendChild(box);
      box.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      box.remove();
      if (ok) resolve(); else reject(new Error('copy failed'));
    });
  }
  // One tap on the button next to a value copies it: no pressing and dragging to select the text.
  document.addEventListener('click', function (e) {
    var b = e.target instanceof Element ? e.target.closest('[data-copy]') : null;
    if (!b) return;
    e.preventDefault();
    copyText(b.getAttribute('data-copy') || '').then(function () {
      b.classList.add('copied');
      if (navigator.vibrate) navigator.vibrate(8);
      toast('Copied');
      setTimeout(function () { b.classList.remove('copied'); }, 1600);
    }, function () { toast('Could not copy'); });
  });
  document.addEventListener('click', function (e) {
    var b = e.target instanceof Element ? e.target.closest('[data-share]') : null;
    if (!b || !navigator.share) return;
    navigator.share({ title: b.getAttribute('data-share-title') || '', text: b.getAttribute('data-share-text') || '' }).catch(function () {});
  });

  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (!(f instanceof HTMLFormElement) || !f.hasAttribute('data-photo-form') || !window.fetch) return;
    e.preventDefault();
    var button = f.querySelector('button');
    if (button) { button.disabled = true; button.textContent = 'Uploading...'; }
    formWithSmallPhotos(f).then(function (data) { return post(f.action, data); }).then(function (res) {
      // Too much to send in one go is turned away before the server looks at it, so nothing was added and no
      // message is waiting on the reloaded page: say it here.
      if (res && res.status === 413) {
        if (button) { button.disabled = false; button.textContent = 'Too large. Try fewer or smaller files.'; }
        loading(false);
        return;
      }
      location.reload();
    }, function () { location.reload(); });
  });

  // ---- Photos open over the page ----------------------------------------------------------------------
  // Opening the picture as its own page meant Back left the installed app. Here Back just closes the picture.
  var viewer = null;
  function closeViewer() {
    if (!viewer) return;
    viewer.remove();
    viewer = null;
    document.body.classList.remove('viewing');
  }
  document.addEventListener('click', function (e) {
    var link = e.target instanceof Element ? e.target.closest('a[data-photo]') : null;
    if (!link || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    viewer = document.createElement('div');
    viewer.className = 'viewer';
    viewer.setAttribute('role', 'dialog');
    viewer.setAttribute('aria-label', 'Photo');
    var img = document.createElement('img');
    var shown = link.querySelector('img');
    var full = link.getAttribute('href');
    var small = shown ? shown.getAttribute('src') : null;
    img.alt = (shown || {}).alt || 'Photo';
    if (small && small !== full) {
      // The preview is there at once and the full picture takes its place when it has arrived. With no
      // signal, and nothing kept on this phone, the preview is what stays.
      img.src = small;
      var big = new Image();
      big.onload = function () { img.src = full; };
      big.src = full;
    } else {
      img.src = full;
    }
    var close = document.createElement('button');
    close.type = 'button';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Close photo');
    viewer.appendChild(img);
    viewer.appendChild(close);
    viewer.addEventListener('click', function (ev) { if (ev.target !== img) history.back(); });
    document.body.appendChild(viewer);
    document.body.classList.add('viewing');
    history.pushState({ photo: true }, '');
    close.focus();
  });
  window.addEventListener('popstate', closeViewer);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && viewer) history.back(); });

  // ---- Ask: the chat window --------------------------------------------------------------------------
  var chat = document.getElementById('chat');
  if (chat && window.fetch) (function () {
    var scroller = document.getElementById('chat-scroll');
    var logEl = document.getElementById('chat-log');
    var empty = document.getElementById('chat-empty');
    var form = document.getElementById('ask-form');
    var box = form.querySelector('textarea');
    var sendBtn = form.querySelector('button.send');
    var picker = document.getElementById('ask-photo');
    var tray = document.getElementById('ask-tray');
    var coarse = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
    var MAX_FILES = 4; // the front and back of a card, a receipt and its warranty
    var pending = []; // { file, preview, mini } for each file waiting to be sent: preview is for the tray here, mini is the small copy the server keeps
    var busy = false;
    var last = null; // the message being answered, for "Try again"

    function el(tag, cls, text) {
      var node = document.createElement(tag);
      if (cls) node.className = cls;
      if (text !== undefined) node.textContent = text;
      return node;
    }
    function toBottom() { scroller.scrollTop = scroller.scrollHeight; }
    function nearBottom() { return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 160; }
    var lastLength = 0;
    function grow() {
      // The box is only collapsed to re-measure when text was removed; resizing it on every keystroke
      // disturbs the phone keyboard's suggestions.
      if (box.value.length < lastLength) box.style.height = 'auto';
      lastLength = box.value.length;
      var want = Math.min(box.scrollHeight + 2, 152) + 'px';
      if (box.style.height !== want) box.style.height = want;
    }
    function refresh() { sendBtn.disabled = busy || (!box.value.trim() && pending.length === 0); }

    // Keyboard handling. Everything here is driven by the size of the visible area, never by focus: the
    // spell-check and paste pop-ups briefly take focus from the box, and reacting to that by moving things
    // around made the keyboard close.
    var tallest = window.visualViewport ? visualViewport.height : window.innerHeight;
    var lastHeight = tallest;
    function fit() {
      var vv = window.visualViewport;
      if (!vv || Math.abs(vv.scale - 1) > 0.01) return;
      var h = Math.round(vv.height);
      if (h > tallest) tallest = h;
      // The keyboard covers the bottom of the page without resizing it, so the chat is sized and placed to
      // match the part that is still visible.
      if (h < window.innerHeight - 1) document.body.style.setProperty('--vvh', h + 'px');
      else document.body.style.removeProperty('--vvh');
      var top = Math.max(0, Math.round(vv.offsetTop));
      if (top) document.body.style.setProperty('--vvt', top + 'px');
      else document.body.style.removeProperty('--vvt');
      // The bottom tabs give their room to the conversation while the keyboard is up.
      document.body.classList.toggle('typing', coarse && h < tallest - 120);
      if (Math.abs(h - lastHeight) > 40) { lastHeight = h; toBottom(); }
    }
    if (window.visualViewport) {
      visualViewport.addEventListener('resize', fit);
      visualViewport.addEventListener('scroll', fit);
    }

    // The tray above the message box: one small picture (or file name) for each file waiting to be sent.
    function drawTray() {
      tray.textContent = '';
      tray.hidden = pending.length === 0;
      pending.forEach(function (item) {
        var thumb = el('div', 'thumb');
        if (/^image\//.test(item.file.type)) {
          var img = el('img');
          img.alt = 'Photo to send';
          if (item.preview) {
            img.src = item.preview;
          } else {
            var reader = new FileReader();
            reader.onload = function () { img.src = reader.result; item.preview = reader.result; };
            reader.readAsDataURL(item.file);
          }
          thumb.appendChild(img);
        } else {
          thumb.appendChild(el('span', 'pdf', item.file.name));
        }
        var remove = el('button', 'remove', '×');
        remove.type = 'button';
        remove.setAttribute('aria-label', 'Remove this file');
        remove.addEventListener('click', function () {
          pending = pending.filter(function (p) { return p !== item; });
          drawTray();
          box.focus();
        });
        thumb.appendChild(remove);
        tray.appendChild(thumb);
      });
      if (pending.length === 0 && picker) picker.value = '';
      refresh();
    }
    function take(file) {
      if (!file || !file.size) return;
      if (pending.length >= MAX_FILES) { toast('Up to ' + MAX_FILES + ' files in one message.'); return; }
      shrink(file).then(function (small) {
        return previewOf(small).then(function (mini) {
          if (pending.length >= MAX_FILES) return;
          pending.push({ file: small, preview: null, mini: mini });
          drawTray();
        });
      });
    }
    function takeAll(files) {
      var list = Array.prototype.slice.call(files || []);
      var room = Math.max(MAX_FILES - pending.length, 0);
      if (list.length > room) toast('Up to ' + MAX_FILES + ' files in one message.');
      list.slice(0, room).forEach(take);
    }

    function addMine(text, items) {
      var li = el('li', 'msg me');
      var bubble = el('div', 'bubble');
      items.forEach(function (item) {
        if (item.preview) {
          var shot = el('span', 'shot');
          var img = el('img');
          img.src = item.preview;
          img.alt = 'Photo you sent';
          shot.appendChild(img);
          bubble.appendChild(shot);
        } else {
          bubble.appendChild(el('p', 'small', item.file.name));
        }
      });
      text.split('\n').forEach(function (line) { if (line) bubble.appendChild(el('p', '', line)); });
      li.appendChild(bubble);
      li.appendChild(el('time', '', new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })));
      logEl.appendChild(li);
      return li;
    }
    function showError(message, mine) {
      var li = el('li', 'msg bot error');
      var bubble = el('div', 'bubble');
      bubble.appendChild(el('p', '', message));
      if (last) {
        var again = el('button', 'link', 'Try again');
        again.type = 'button';
        again.addEventListener('click', function () {
          if (busy) return;
          li.remove();
          if (mine) mine.remove();
          send(last.text, last.items);
        });
        bubble.appendChild(again);
      }
      li.appendChild(bubble);
      logEl.appendChild(li);
      toBottom();
    }

    function send(text, items) {
      if (busy) return;
      busy = true;
      lastActive = Date.now();
      refresh();
      last = { text: text, items: items };
      empty.hidden = true;
      var fresh = document.getElementById('chat-new');
      if (fresh) fresh.hidden = false;
      if (logEl.getAttribute('data-last-day') !== logEl.getAttribute('data-today')) {
        var day = el('li', 'day');
        day.appendChild(el('span', '', 'Today'));
        logEl.appendChild(day);
        logEl.setAttribute('data-last-day', logEl.getAttribute('data-today'));
      }
      var mine = addMine(text, items);
      var wait = el('li', 'msg bot pending');
      var waitBubble = el('div', 'bubble');
      var dots = el('span', 'dots');
      dots.appendChild(el('i'));
      dots.appendChild(el('i'));
      dots.appendChild(el('i'));
      var label = el('span', '', 'Thinking');
      waitBubble.appendChild(dots);
      waitBubble.appendChild(label);
      wait.appendChild(waitBubble);
      logEl.appendChild(wait);
      toBottom();

      var settled = false;
      function fail(message) {
        if (settled) return;
        settled = true;
        wait.remove();
        showError(message, mine);
      }
      function handle(line) {
        if (!line.trim() || settled) return;
        var m;
        try { m = JSON.parse(line); } catch (e) { return; }
        if (m.step) { label.textContent = m.step; }
        else if (m.error) { fail(m.error); }
        else if (m.html) {
          settled = true;
          wait.remove();
          logEl.insertAdjacentHTML('beforeend', m.html);
          toBottom();
        }
      }
      var data = new FormData();
      data.append('text', text);
      items.forEach(function (item, i) {
        data.append('photo', item.file, item.file.name);
        if (item.mini) data.append('preview' + i, item.mini, 'preview.jpg');
      });
      fetch('/ask', { method: 'POST', body: data, headers: { 'X-CSRF-Token': token || '', Accept: 'application/x-ndjson' }, credentials: 'same-origin' })
        .then(function (res) {
          if ((res.headers.get('content-type') || '').indexOf('ndjson') === -1) {
            fail(res.status === 413 ? 'That file is too large to send.' : 'You have been signed out. Reload this page to sign in again.');
            return;
          }
          if (!res.body || !res.body.getReader) return res.text().then(function (all) { all.split('\n').forEach(handle); });
          var reader = res.body.getReader();
          var decoder = new TextDecoder();
          var buffer = '';
          function pump() {
            return reader.read().then(function (chunk) {
              if (chunk.done) { handle(buffer); return; }
              buffer += decoder.decode(chunk.value, { stream: true });
              var lines = buffer.split('\n');
              buffer = lines.pop();
              lines.forEach(handle);
              return pump();
            });
          }
          return pump();
        })
        .catch(function () { fail('Could not reach the server. Check your connection.'); })
        .then(function () {
          fail('The reply was cut off. Check Activity to see what was saved.');
          busy = false;
          lastActive = Date.now();
          refresh();
          if (!coarse) box.focus();
        });
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var text = box.value.trim();
      if (busy || (!text && pending.length === 0)) return;
      var items = pending;
      pending = [];
      box.value = '';
      grow();
      drawTray();
      send(text, items);
    });
    box.addEventListener('input', function () { grow(); refresh(); });
    box.addEventListener('keydown', function (e) {
      // A keyboard's Enter sends; on a phone it makes a new line and the button sends.
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !coarse) { e.preventDefault(); form.requestSubmit(); }
    });
    box.addEventListener('paste', function (e) {
      var items = (e.clipboardData && e.clipboardData.files) || [];
      if (picker && items.length && /^image\//.test(items[0].type)) { e.preventDefault(); takeAll(items); }
    });
    // Tapping Send must not take focus from the box, or the keyboard closes and the layout jumps mid-tap.
    sendBtn.addEventListener('pointerdown', function (e) { e.preventDefault(); });
    if (picker) {
      picker.addEventListener('change', function () {
        takeAll(picker.files);
        // Emptied so that picking the same file again, after removing it, is still a change.
        picker.value = '';
      });
    }
    chat.addEventListener('click', function (e) {
      var b = e.target instanceof Element ? e.target.closest('[data-suggest]') : null;
      if (!b) return;
      if (b.hasAttribute('data-pick')) { if (picker) picker.click(); return; }
      var text = b.getAttribute('data-suggest') || '';
      if (b.hasAttribute('data-send')) { send(text, []); return; }
      box.value = text;
      grow();
      refresh();
      box.focus();
      box.setSelectionRange(text.length, text.length);
    });
    // Photos in the conversation load late and would otherwise leave the newest message off screen.
    logEl.addEventListener('load', function () { if (nearBottom()) toBottom(); }, true);

    // A chat ends after a quiet spell. If the app is brought back after that long, load the fresh one instead
    // of showing the old conversation the server has already let go of.
    var idleMs = Number(chat.getAttribute('data-idle-minutes') || 60) * 60000;
    var lastActive = Date.now();
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) return;
      if (!busy && !box.value && pending.length === 0 && Date.now() - lastActive > idleMs) location.reload();
    });

    // Arriving from another app's Share menu: put what was shared in the message box, ready to send.
    if (/[?&]shared=1/.test(location.search) && window.caches) {
      history.replaceState(null, '', '/ask');
      caches.open('magpie-share').then(function (cache) {
        return Promise.all([cache.match('/shared/text'), cache.match('/shared/file')]).then(function (found) {
          var jobs = [];
          if (found[0]) jobs.push(found[0].json().then(function (j) { if (j.text) { box.value = j.text; grow(); refresh(); } }));
          if (found[1] && picker) {
            var name = decodeURIComponent(found[1].headers.get('x-name') || 'shared');
            var type = found[1].headers.get('content-type') || '';
            jobs.push(found[1].blob().then(function (blob) { take(new File([blob], name, { type: type })); }));
          }
          return Promise.all(jobs);
        }).then(function () { return Promise.all([cache.delete('/shared/text'), cache.delete('/shared/file')]); });
      }).catch(function () {});
    }

    grow();
    refresh();
    fit();
    toBottom();
    if (!coarse) box.focus();
    // Arriving from a search that found nothing: the question is asked straight away, with no second tap.
    var sendNow = chat.getAttribute('data-send-now');
    if (sendNow) {
      history.replaceState(null, '', '/ask'); // so that going back or reloading does not ask it again
      send(sendNow, []);
    }
  })();

  // Register the service worker (installable app, kept pages, offline page).
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('/sw.js').catch(function () {});
  }

  // ---- Slow loads ------------------------------------------------------------------------------------
  // A page that took long to open is reported with where the time went, so Settings can say what was slow.
  // Only the kind of page is kept on the server, never which entry.
  window.addEventListener('load', function () {
    setTimeout(function () {
      var nav = performance.getEntriesByType ? performance.getEntriesByType('navigation')[0] : null;
      if (!nav || !token || !window.fetch) return;
      var total = Math.round(nav.domContentLoadedEventEnd || nav.responseEnd || 0);
      if (total < 1500) return;
      var span = function (from, to) { return to > 0 && from > 0 && to > from ? Math.round(to - from) : 0; };
      var report = {
        path: location.pathname,
        total: total,
        startup: span(nav.workerStart, nav.fetchStart),
        connect: span(nav.fetchStart, nav.requestStart),
        wait: span(nav.requestStart, nav.responseStart),
        download: span(nav.responseStart, nav.responseEnd),
        render: span(nav.responseEnd, nav.domContentLoadedEventEnd),
        kind: nav.type,
        network: navigator.connection && navigator.connection.effectiveType,
      };
      fetch('/beacon', { method: 'POST', keepalive: true, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token }, body: JSON.stringify(report) }).catch(function () {});
    }, 0);
  });

  // Signing out clears the service worker's caches too.
  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (f instanceof HTMLFormElement && f.getAttribute('action') === '/logout') {
      try { localStorage.removeItem('magpie-list-queue'); } catch (err) { /* nothing was kept */ }
      if (window.caches) caches.keys().then(function (keys) { keys.forEach(function (k) { caches.delete(k); }); });
    }
  });
})();
