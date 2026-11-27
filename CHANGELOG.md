# Changes

What changed for someone running their own copy. To update: get the new version, then run setup again
(`setup.cmd` on Windows, `./setup.sh` on macOS and Linux). Updates only move forward: once a release has
changed the database, do not go back to an older one.

## 1.0.2

- An older version of Magpie now refuses to start on a database that a newer version has used, and says so
  in one line of its log, instead of running on data it does not understand. Nothing in the database is
  changed by the refused start. Deploy the newer code again and it comes back.
- The admin commands (`src/cli.ts`) say in one line why a data folder cannot be used, not with a stack trace.

## 1.0.1

For people setting up a new copy. Nothing changes in the database.

- A new copy's Home page shows how to connect Claude and what to say, until the first collection exists.
  The address for Claude is always in Settings, with a copy button.
- The Ask page says how to switch Ask on for macOS, Linux, Windows and Docker, not only Windows.
- Docker and local development: a `.env` copied from `.env.example` now starts. A setting left blank counts
  as not set; before, one blank line stopped the app.
- Setup ends a first install by saying why Fly.io needs a card on file.
- The README says what the reviews were (AI sessions, not a professional audit), what has and has not been
  tried, how to add a second person later, and how to remove Magpie. The Docker guide's steps are in order.
- Dependency updates: hono, @hono/node-server, openid-client, jose.

## 1.0.0

The first public release. It already includes:

- Saving and finding through Claude (a connector with 13 tools) and through the web app's Ask box.
- Collections with their own fields, ratings, tags, visits, checklists, photos and PDFs.
- Private collections, and sensitive ones that are encrypted in the database.
- Coming up on Home (the next 30 days, each date can be hidden) and a calendar link.
- Pinned entries and pinned collections.
- Activity with Undo, Trash, and a download of everything.
- Works on a phone as an installed app, including without a signal.
- Optional: Google sign-in, continuous backups to Cloudflare R2.
