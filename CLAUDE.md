# Magpie (the Tell Me Anything Tracker)

A household tracker for two people. They tell Claude things (restaurants, recipes, documents, dates) and it files
them; they browse, search and chat with it in a web app. Each household runs its own copy. `README.md` is the
user-facing guide; read it before large changes.

If `docs/household.md` exists, this copy is someone's own deployment and that file says where it runs, how it is
deployed and what has been tried on their phones. Read it before deploying or touching the live server.

If someone asks you to set this up for them ("set up my own Magpie"), follow `docs/setup-with-claude.md` step by
step. It covers the cost to confirm first, what to ask, and how to run the setup script without ever seeing a
password or key.

## Commands

Needs Node 26.13 or newer. Node runs the TypeScript directly: there is no build step.

- `npm ci` once, then `npm run check` (typecheck plus all tests). Run it before every commit.
- `npm test` runs the tests alone; one file: `node --test --test-concurrency=1 test/photos-ask.test.ts`.
- `npm run dev` runs a local server from `.env` (copy `.env.example`). `BOOTSTRAP_EMPTY_DB=1` is needed the
  first time a data folder is empty.
- Deploy: `fly deploy -a <app> --ha=false` (one machine, one SQLite file; never scale past one).
  `setup.cmd` (Windows) and `./setup.sh` (macOS, Linux) do the same and also handle first-time setup. Secrets
  live on Fly, not in the repo.
- Server logs: `fly logs -a <app> --no-tail`. Unhandled errors are JSON lines with `"level":"error"` and a
  stack; this is the fastest way to diagnose a 500.

## Layout

- `src/domain/` is all the rules (entries, logs, collections, search, undo, privacy, files, the dates in
  `upcoming.ts`, pins). Both front ends call it; nothing else writes to the database.
- `src/db/vault.ts` and `src/domain/sealed.ts` are the encryption of sensitive collections ("Sealed text" below).
- `src/mcp/` is the 13-tool MCP server Claude's connector uses, at `/mcp`. `instructions()` in `server.ts` is what
  Claude reads; a test keeps it under 3,000 characters.
- `src/auth/` is the OAuth server for the connector plus web sign-in (passwords, optional Google).
- `src/web/` is the web app: `routes.ts`, `views.ts`, `chat.ts` (the Ask page), `calendar.ts` (the calendar
  link, the one page that works without signing in), `markdown.ts`, `export.ts` and `zip.ts` (the downloads),
  and `static/` (`app.css`, `app.js`, `sw.js`, the manifest).
- `src/jobs/` runs on a timer: `snapshot.ts` (the nightly copy of the database) and `photos.ts` (the photos'
  copies in the off-site backup, also run at start-up).
- `src/assistant/` is the Ask chat: an agent loop on the Anthropic Messages API that calls the same MCP tools
  in-process, so privacy, Activity and Undo behave the same as through Claude. `npm run eval -- --ask` runs the
  eval fixtures through its prompt and settings; evals spend real money on the configured API key, so ask before running one.
- `src/db/migrations/tracker/` are numbered SQL files applied in order. Add a new file; never edit an applied one.
- `test/` uses `node:test`. `test/app-helpers.ts` starts a whole app in memory; `test/photos-ask.test.ts` shows
  how to script the model for Ask tests.

## Conventions that matter

- TypeScript must be erasable syntax only (no enums, no parameter properties) and imports carry the `.ts` extension.
- Templates are `hono/html`. Never build HTML from strings; anything from a user or the model is escaped by the
  template. Markdown goes through `src/web/markdown.ts`, which only emits a fixed set of tags.
- The Content-Security-Policy forbids inline scripts and inline `style=""` attributes. Put behaviour in
  `static/app.js` and styles in `static/app.css`.
- When `app.css`, `app.js` or `sw.js` change, bump `ASSET_VERSION` in `src/web/layout.ts` and the matching
  version strings at the top of `static/sw.js`. Static files are cached for a day under that version, and by the
  service worker until the version changes. The server reads them into memory when it starts, so restart
  `npm run dev` after editing one.
- The service worker keeps pages and photos on the phone (README, "On your phone"). `page()` in
  `src/web/routes.ts` marks the pages it may keep with `X-Magpie-Keep`, using the `KEEPABLE` pattern that is
  repeated in `sw.js`: never a form, never a page showing a one-time message. A new kind of page is not kept
  until it is added in both places. Every request that is not a GET clears the kept pages.
- Dates are stored and passed to tools as `YYYY-MM-DD` and shown to people as `MM-DD-YYYY` (`usDate`).
- Every write goes through a domain function with a `Ctx` (who, via what) so it lands in Activity and can be
  undone. Private collections are only visible to their owner; check with the domain helpers, not ad hoc SQL.
- Sensitive collections: search shows titles only, and they are left out of `query_sql`.
- Sealed text. What a sensitive collection holds is encrypted in `tracker.db` under a key derived from
  `FILES_KEY`: a row's text columns are empty and its text is in `sealed` (entries: `fields`, `notes`,
  `source_text`; logs: `note`, `raw_text`; activity: `summary`, `raw_text`; every chat message). Titles, tags,
  ratings and dates stay plain. Four rules:
  - Read text through `open_entries`, `open_logs` and `open_activity`, views that exist only on the app's own
    connection and open what is sealed. The tables themselves are for ids, titles, counts and writes. Search
    uses `open_fts`, an index held in memory and filled at start; `entries_fts` on disk has only titles and tags
    for sealed entries.
  - A statement that sets an entry's or a log's text sets all its text columns and `sealed` together, with
    `ENTRY_TEXT_SET` and `entryText()` (or the log pair). Triggers in migration 009 abort anything else, in
    both directions: plain text in a sensitive collection, or a sealed row in an ordinary one.
  - Rows inside `before_json` and `after_json` are in stored form. `recordActivity` takes care of that, and
    seals earlier history when an entry comes into a sensitive collection. Undo compares rows opened and
    writes them back in the form their collection stores today.
  - After anything that changes which collection an entry is in, or a collection's `sensitive` setting, call
    `fitEntry` or `fitCollection`. A row that was merged away follows the entry it went into: while that entry
    is sensitive the row is kept sealed, in that entry's collection if its own is an ordinary one.
  - Sealing text that was stored plain leaves old copies of it in unused parts of the file, which only a
    `VACUUM` clears. `rewriteDue()` records that one is owed (table `rewrite_due`); the server does it as soon
    as the change commits and at every start. `fitEntry`, `sealHistory` and `recordActivity` call it; new
    code that seals existing text some other way must too.
  `test/sealed.test.ts` checks the file's own bytes; add to it when adding a place text is kept. An independent
  review on 2026-11-15 found four leaks on the paths where text becomes sensitive or stops being; they are
  fixed and tested there. Not built: changing `FILES_KEY`, and a way past one sealed row that will not open.
  Entries changed by another process (`sqlite3`, the CLI) are not in `open_fts` until the server restarts.
- At every start the server runs `tidy()`: it seals anything still plain (a database from before migration
  009, or a copy restored from then) and does any rewrite that is owed. Under Litestream it cannot empty the
  write-ahead log, where pages written before a rewrite can still carry old text; the log is emptied at the
  next restart, so restart once after the log says "text sealed just now". The server will not open a
  database whose sealed rows its key does not open. Releases from before migration 009 cannot read a database
  that has been through it: do not roll back past it.
- A checklist is a collection with `display.checklist` and a hidden yes/no field `done` (`src/domain/checklist.ts`);
  its items are entries. `createEntry` treats the same name there as the same item and skips the look-alike
  question. Ticks and adds from the page are the app's only htmx posts: with the `hx-request` header the route
  returns a fragment (`#checklist`, or `#checklist-items` when that is the target), without it a redirect.
- A checklist page polls `/c/:id/stamp` every five seconds and refetches `/c/:id/items` when it changes. A tick
  or add that cannot be sent goes into a queue in `localStorage` (`app.js`, "Checklists") and is drawn over the
  list by `showWaiting()`. For these requests alone the worker (`LIST_CHANGE` in `sw.js`) does not clear the
  kept pages first, and the page asks for the list to be kept again after each change.
- Current Claude models refuse a forced `tool_choice`. `src/assistant/fill.ts` (the one-shot call that fills a
  field) offers a single tool, asks for it in the prompt, and treats a reply without it as "nothing found".
- Photos are encrypted on disk with `FILES_KEY`, each with an optional small preview beside it that the browser
  makes (`files.ts`, `shrink()` and `drawSmall()` in `app.js`). Three rules hold them together. A photo's id is
  never handed out again (the table is `AUTOINCREMENT`), because a phone keeps `/files/<id>` for good and the
  off-site backup stores it under that id. A preview, once written, is not replaced while its file exists. And a preview sent in
  by a page is made from the photo fetched fresh from the server, never from what the phone has kept.
- Removing a photo only marks it (`deleted_at`), so it can be undone for 30 days; `cleanupFiles` then deletes
  the row and the files. Every deleted row is noted in `removed_attachments` by a trigger, which is the only
  thing that makes `src/jobs/photos.ts` remove a copy from the off-site backup.
- The chat's conversation is per person, ends after an hour of quiet, and is never part of exports or
  `query_sql`.
- A person's own choices about Home are personal shortcuts, not changes: pinned entries (`pins`), pinned
  collections (`collection_pins`) and dates hidden from Coming up (`hidden_dates`, one occurrence each). They
  are not in Activity, exports or `query_sql`, there is nothing to undo, and the calendar link ignores them.
  Their rows go wherever `pins` rows go when an entry or collection is deleted for good.
- Nothing personal goes into code, tests or commits: examples use Alex and Sam at example.com and invented places.
- Nothing the Ask assistant does may be caused by a link. A GET never sends a message for the person; the one
  page that opens the chat already asking (`POST /ask/find`) is a checked form post. `refusal()` in
  `src/assistant/chat.ts` is where a tool call is turned away (after a web page, or with a photo or PDF in the message, or outside the one entry a
  narrow job is about).
- A setting left blank counts as not set (`loadConfig`), so a `.env` copied from `.env.example` starts as it
  is. `test/config.test.ts` loads the example file: keep it loading when a setting is added.
- Until a person can see a collection, Home shows the first-run steps (`gettingStarted` in `views.ts`) with
  the address Claude's connector needs. Settings always shows that address, because the second person never
  sees what setup printed.
- Text about the host's prices or plans (the README's Fly.io lines, the setup scripts' closing note) carries
  the month it was true. Fly.io changed its free plan between two readings in November 2026: read their
  page again before repeating a figure.
- User-facing text is plain and short, and avoids em dashes.
- A bug fix comes with a test that fails without it.

## Checking changes on a phone

Unit tests do not catch layout or touch problems. Two things have worked:

- Headless Chrome through `puppeteer-core` at a 390x844 touch viewport against `npm run dev`, with a small local
  HTTP server standing in for the Anthropic API (`ANTHROPIC_BASE_URL_FOR_ASSISTANT`).
- The Playwright browser tools against `npm run dev` at 390x844. This is how the service worker was checked:
  `context.setOffline(true)` for no signal, and a request made with `page.request` stands in for a change made on
  the other phone, because it does not pass through the worker. Between runs with the same asset version,
  unregister the worker and clear the browser's cache, or it keeps serving the old scripts. Static files are
  cached by the browser itself for a day as well: clear that too (`Network.clearBrowserCache` over a CDP
  session), or an edited `app.js` is not the one that runs.
- To rehearse an update as a phone meets it, run the previous commit's server on a scratch `DATA_DIR`, use it in
  the browser so the old worker keeps pages and photos, then start the new code on the same folder and port.
- An Android emulator on the same PC: `adb reverse tcp:PORT tcp:PORT` makes a local server reachable as
  `http://localhost:PORT` in the emulator's Chrome, and `adb shell screencap` captures the screen, including
  mid-press.

## Not yet verified

- The Ask chat's web search and page reading against the real Anthropic API (tested with a scripted stand-in).
  It asks for the current web tool versions first and falls back to the earlier ones; which one the real API
  takes is not known.
- The Ask chat at low effort, with cached instructions and PDFs as documents, against the real API.
  `npm run eval -- --ask` has not been run.
- The Android Share menu entry on a real phone.
- Kept pages, offline use, the copy button and several photos in one message on real phones (two Android
  phones are in daily use). They were checked in desktop Chrome at phone size.
- Google Calendar subscribing to the calendar link.
- Nothing has been checked on an iPhone.
- Google sign-in has never been run in production.
- `setup.sh` made a fresh install on Fly.io from a clean copy on Linux (2026-11-15: three checks ok, then the
  connector smoke test passed 15 of 15 for two people). It has not been run on macOS. `setup.ps1` with the same
  changes has only been through its dry run; the add-on steps of both scripts were tried against stand-ins.
- Docker (`docker-compose.yml`, `docs/docker.md`) was run once from a clean copy on Docker Desktop (2026-11-15):
  build, first start, sign-in, saving an entry, a restart without `BOOTSTRAP_EMPTY_DB` with the data kept, the
  container's health check and an admin command. On 2026-11-27 it was run again with a `.env` copied from
  `.env.example` as the guide says (build, healthy, the sign-in page, a restart without `BOOTSTRAP_EMPTY_DB`).
  It has not been run behind a real proxy or tunnel, so Claude connecting to a Docker copy is unproven.
- The first-run steps on an empty Home and the connector address in Settings on a real phone. They were
  checked in desktop Chrome at phone size, light and dark.
- Photo previews, Remove with Undo, and the zip download on real phones. They were checked in desktop
  Chrome at phone size, including an update from the previous version with photos already kept by its worker.
- Filling a field (`src/assistant/fill.ts`) against the real Anthropic API; it is tested with a scripted reply.
- Checklists on real phones. Ticking in place, the other phone's changes arriving, and ticking with no
  signal (including reopening the list offline) were checked in desktop Chrome at phone size.
- Two independent reviews ran in November 2026 and their findings are fixed. The reviewers were separate AI
  sessions given the code cold, not people, and the README and `SECURITY.md` say so: keep it that way, and
  never call it an audit. Code added since has tests but has not been reviewed.
