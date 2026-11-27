# Security

Magpie holds things people would not want read by others, so problems here are taken seriously.

## Reporting a problem

Please report it privately: on GitHub, open the **Security** tab of this repository and choose **Report a
vulnerability**. Do not open a public issue. Say what you found, how to see it, and what someone could do
with it. This is a spare-time project with no bounty, so allow a few days for an answer.

## How a copy is protected

Each household runs its own copy on its own server. Nobody else operates it, and nothing is sent anywhere
except to Anthropic when you talk to Claude or use the Ask box, and to your own backup bucket if you switch
backups on.

- **Sign-in.** Long random passwords made by setup (the app refuses anything under 16 characters), or
  Google sign-in. Ten wrong passwords for one person from one address lock that sign-in for ten minutes. Claude connects through
  OAuth with PKCE and tokens that can be revoked in Settings.
- **Between two people.** A private collection is visible only to its owner, in pages, search, exports,
  Undo and the connector alike.
- **Encryption.** Photos and PDFs are encrypted on disk. What a sensitive collection holds (details, notes,
  visits, history) and everything said in the Ask box is encrypted in the database, in its snapshots and in
  its backups (AES-256-GCM). The key, `FILES_KEY`, is a server setting and is in none of those files.
- **The page itself.** No inline scripts are allowed, text from people or the model is escaped, and
  Markdown is drawn from a fixed set of tags with links to http(s) only.
- **Logs** never contain tokens, calendar links, tool arguments or what anyone said or saved. They do show
  which pages were opened, and a collection's page address includes its name.

## What it does not protect against

- Whoever controls your hosting account can read the key and the files. Use a strong password and
  two-factor sign-in there.
- Titles, tags, ratings and dates are not encrypted, and neither is anything in an ordinary collection.
  Keep numbers out of titles.
- Anything Claude reads to you passes through Anthropic, like the rest of your conversations.
- The download in Settings is your own readable copy. Keep it somewhere safe.
- Lose `FILES_KEY` and the photos and sensitive entries cannot be recovered. Changing the key is not built.
- Do not store passwords, card numbers or bank logins. Use a password manager for those.

## How it has been checked

It has not had a professional security audit. It was written with Claude Code, then reviewed twice in
November 2026 by separate AI sessions that had not seen the code before, each reading one area cold: sign-in
and the connector's OAuth; privacy, Activity and Undo; the web app and the phone's worker; backups, start-up
and the Ask box; and everything that can be reached without signing in. What they found was fixed, and each
fix has a test. Code added after those reviews has tests but has not been reviewed. If you can read code,
`src/auth/`, `src/domain/privacy.ts` and `src/db/vault.ts` are where a second pair of eyes is worth most.

## Known limits

- **The Ask box reads text that is not yours.** A web page, a photo, a PDF, or a note the other person saved
  can carry words written to steer whoever reads them. The model is told that all of these are information
  and never instructions. In code, a message that includes a web page, a photo or a PDF cannot delete, merge,
  move, undo or reorganise anything, or change who can see a collection. Two things rest on the model's
  instructions alone: it could be talked into putting something it has just read into a web search (set
  `ASSISTANT_WEB=0` to switch web lookups off), and a note written by one person is read with the other
  person's access when their chat opens it. Magpie is built for two people who trust each other.
- **Connecting Claude.** Only press Allow on the connection page if you started it yourself in Claude a
  moment ago. A link someone sends you to that page would connect their Claude to your tracker.
- **Either person can delete a shared entry for good.** Delete, then Delete forever from the Trash, removes
  its history and photos. The nightly snapshot is then the only way back.
- **Sessions last 30 days from last use**, with no fixed end. Settings shows them and can end them.
- **Changing passwords does not sign anyone out.** After a suspected leak also run
  `fly ssh console -C "node src/cli.ts signout-all --email <address>"` for each person.
- **Sign-ins are not backed up**, on purpose. After a restore everyone signs in and reconnects Claude again.

The fuller account, with what each backup holds and for how long, is in the README under "Photos and
personal documents".
