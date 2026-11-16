# Changes

What changed for someone running their own copy. To update: get the new version, then run setup again
(`setup.cmd` on Windows, `./setup.sh` on macOS and Linux). Updates only move forward: once a release has
changed the database, do not go back to an older one.

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
