# Setting up Magpie for someone

This is for an AI coding assistant (Claude Code) whose person has said something like "set up my own Magpie".
Follow it in order. The setup script does the work; your part is to ask, run it, and check.

## Rules

- Never print, read or ask for a password or an API key. Do not open `magpie-login.txt` or `magpie-photo-key.txt`,
  and do not `cat`, `grep` or summarize them. The person opens them.
- Always pass the no-show option (`--no-show`, or `-NoShow` on Windows). It keeps passwords and keys out of the
  script's output, which you read.
- Do not run `--assistant`, `--google` or `--backups` yourself. They need a secret typed in, so the person runs
  them in their own terminal.
- Change nothing on Fly.io by hand. If a step fails, run the script again: it continues where it stopped.
  Looking is fine: `fly auth whoami`, `fly status` and `fly logs` change nothing.
- The Fly.io tool may not be on your PATH. After the script installs it, it is at `~/.fly/bin/fly`
  (Windows: `%USERPROFILE%\.fly\bin\fly.exe`).

## 1. Pick the script

- Windows: `.\setup.cmd` (it runs `setup.ps1`; options look like `-Email`).
- macOS or Linux: `./setup.sh` (options look like `--email`).

Check you are in the folder that holds `fly.toml` and `Dockerfile`. Node and Docker are not needed.

## 2. Say what it costs, and get a yes

Tell the person, before anything else:

- Magpie runs on Fly.io, in their own account, where it uses about $4 a month. As of November 2026 a new
  Fly.io account's Free plan includes $5 of usage a month once a card is on file, so it may cost them
  nothing; https://fly.io/docs/about/free-trial/ has the current terms. Do not promise that it is free.
- Fly.io needs a card on file, and it should be added before the install, not after. Without one a new
  account has $1 of credit for 7 days, and Fly.io has stopped such servers five minutes after every start,
  which makes pages slow and cuts Ask replies short. Ask whether the card is there; they add it themselves
  at https://fly.io/dashboard/personal/billing.
- The script installs Fly.io's command-line tool if it is missing, creates one small app with a 1 GB disk, and
  deploys it. It takes about five minutes.

Go on only when they say yes.

If the Fly.io tool is already installed, run `fly auth whoami`. If it names an account, tell the person which
one and ask whether that is the account to use: the app is created in it and billed to it. If it is the wrong
one, they run `fly auth logout` themselves first.

## 3. Ask for the details

Ask, and wait for answers. Do not guess any of these:

1. Their email address and first name. The email is what they will type to sign in.
2. Whether a second person will use it, and that person's email and first name.
3. The household's time zone, as a name like `America/Chicago` or `Europe/London`. Offer the computer's own
   zone as the suggestion if you can tell what it is.

Then ask these two once, and take "no preference" for an answer:

4. A name for the app (`--app`), which becomes its address, `https://<app>.fly.dev`. Without one the script
   picks `magpie-` and four random characters.
5. Where they are, roughly. The server goes in the US East region (`iad`) unless you pass `--region` with a
   closer one: for example `lhr` London, `fra` Frankfurt, `ord` Chicago, `sjc` San Jose, `syd` Sydney,
   `sin` Singapore.

To suggest a time zone: on macOS or Linux, `readlink /etc/localtime` ends in the zone's name; on Windows,
`tzutil /g` prints Windows' own name for it, which you can translate.

The script uses the Fly.io organization called `personal`, which every account has. Someone who wants the app
in another organization says so, and you pass `--org`.

## 4. Run it

Give every answer as an option so the script asks nothing. With the made-up people Alex and Sam:

```sh
./setup.sh --no-show --yes --email alex@example.com --name Alex \
  --partner-email sam@example.com --partner-name Sam --timezone America/Chicago
```

```powershell
.\setup.cmd -NoShow -Yes -Email alex@example.com -Name Alex -PartnerEmail sam@example.com -PartnerName Sam -TimeZone America/Chicago
```

Leave out the partner options for one person. `--yes` lets the script install the Fly.io tool; you have their
yes from step 2. A preview is not needed. If the person asks for one, add `--dry-run` (`-DryRun`): it lists
the steps and changes nothing, but it does not check their Fly.io sign-in or card, and the address it shows
is only an example.

- The first run can take ten minutes. Run it in the background, or with the longest timeout you have, and read
  its output as it goes.
- If the person is not signed in to Fly.io, the script opens their browser. They sign in or create the account,
  and add the card, themselves. Keep reading the output while you wait: if no browser opens, the script prints
  a link, and you pass it on. If the person needs longer than your time limit, let the script stop and run the
  same command again when they are ready.
- After sign-in the script prints `Fly.io account:` and the address of the account it is using.
- If it stops with "Setup stopped", read the reason, fix what it names (most often: no card on file yet), and
  run the same command again. An app that already exists is found and reused. On Windows, `setup.cmd` waits for
  a key press at the end; `powershell -NoProfile -ExecutionPolicy Bypass -File setup.ps1 ...` does not.

## 5. Check it

Near the end the script prints three checks. All three must say `ok`, followed by `All 3 checks passed.`, and
the script must end with exit code 0. A failed check ends it with exit code 1.

1. The sign-in page loads.
2. The address for Claude asks for sign-in.
3. The sign-in details Claude reads give the right address.

It then prints `Magpie is running at https://<app>.fly.dev`. Note that address. If a check says `FAILED`, look
at `fly logs -a <app> --no-tail` and tell the person what you found before trying anything else.

The script has written the app's name, region and time zone into `fly.toml`. That is expected. Leave the file
as it is and do not commit it anywhere public; later runs read the app's name from it.

## 6. Hand over

Tell the person, in this order:

1. **Passwords.** "Open `magpie-login.txt` in this folder. It has the sign-in password for each person." Do not
   open it for them.
2. **Connect Claude.** Each person does this once, from their own Claude account. Any plan works; the Free
   plan allows one custom connector. On their own computer the script has put the address on the clipboard.
   - Open https://claude.ai > Customize > Connectors > Add custom connector.
   - Name: `Magpie`. URL: `https://<app>.fly.dev/mcp` (give them the real address).
   - Click Connect, sign in with their email and password, and choose Allow. The phone app picks it up from
     their account.
3. **Claude Code, if they want it here too.** Offer to run:
   `claude mcp add --transport http magpie https://<app>.fly.dev/mcp`
   They then run `/mcp` and sign in themselves.
4. **The web app** is at `https://<app>.fly.dev`. On a phone, in Chrome: menu > Add to Home screen.
5. **The Ask box** (optional, typing to Magpie inside the web app) needs an Anthropic API key. That step is
   theirs: they run `./setup.sh --assistant` (Windows: `turn-on-ask.cmd`) in their own terminal and paste the
   key there. Never take the key in the chat.

## 7. The password manager

Finish with this, plainly:

- "Save `magpie-photo-key.txt` in your password manager now. Photos and sensitive entries cannot be recovered
  without the key in it. Nobody else has a copy."
- "Save the passwords from `magpie-login.txt` there too. Then delete both files."

Both files are ignored by git. Do not commit them, copy them, or move them anywhere.

## Later

- Deploy new code: run the script again with no options (plus the no-show option).
- New passwords: `--new-passwords` with `--no-show` and `--email` (and `--partner-email`). The person reads them
  in `magpie-login.txt`.
- Backups to Cloudflare R2 (`--backups`) and Google sign-in (`--google`): the person runs these themselves.
- `README.md` covers everything else.
