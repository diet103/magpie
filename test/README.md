# Tests

`npm run check` runs the type check and every test. `npm test` runs the tests alone. One file:

```sh
node --test test/dates.test.ts
```

They use Node's own test runner, no network and no API key. Anything outside the app is stood in for on
`127.0.0.1`: Google sign-in, the R2 bucket, and the Anthropic API (a scripted reply per request).

## How they are laid out

| Kind | Helper | What it gives a test |
|---|---|---|
| Rules (`src/domain`) | `setupDb()` in `helpers.ts` | A real SQLite file in a temp folder, two people (Alex and Sam), and a context for each. `cleanup()` removes it. |
| Pages and the connector | `startTestApp()` in `app-helpers.ts` | The whole app in memory, called with `t.request(...)`, plus sign-in helpers. Nothing listens on a port except the stand-in for Google. |
| Command line (`src/cli.ts`) | `cli.test.ts` | Runs the real command as its own process on a temp data folder. |

Most files share one app or one database for the whole file and build on it test by test, the way a
household's data builds up. So run a file, not a single test from the middle of one. `domain.test.ts` and
`sealed.test.ts` start fresh for every test.

Files run one at a time (`--test-concurrency=1`). They pass in parallel too, and faster, but a few tests
measure time (a query that must be stopped after three seconds, a server that must close promptly), and one
at a time keeps those steady on a small CI machine.

## What goes where

- `sealed.test.ts` reads the database file's own bytes to prove that sensitive text is not in it. Add to it
  when adding a place where text is kept.
- `markdown.test.ts` holds the renderer to its fixed set of tags with a table of hostile inputs. Add a row
  when the renderer learns something new.
- `guardrails.test.ts` covers what must not happen behind someone's back: what Ask may do after reading
  outside text, and what one person may undo or make private over the other's changes.
- `setup-scripts.test.ts` keeps `setup.ps1` and `setup.sh` doing the same thing.
- A bug fix comes with a test that fails without it.

## What is not tested here

The browser side (`src/web/static/app.js` and `sw.js`: offline pages, photo previews, ticking a checklist
with no signal) is checked by hand in a phone-size browser. `CLAUDE.md`, "Checking changes on a phone",
says how. The tests only check that the service worker and the server agree on versions and on which pages
may be kept.
