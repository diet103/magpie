# Running Magpie with Docker

The setup scripts put Magpie on Fly.io, which is the easy route. This page is for people who would rather
run it on their own machine or home server. You need Docker with Compose, and a way to give it a public
`https://` address.

This route has been run from a clean copy (build, first start, sign-in, saving an entry, a restart with the
data kept), but not yet behind a real proxy or tunnel, so Claude connecting to a Docker copy is unproven. If
you try it, an issue saying what happened, working or not, is welcome.

## Why it needs a public address

Claude reaches your Magpie from Anthropic's servers, not from your phone or laptop, so
`http://192.168.x.x` or `localhost` will not work for the connector. Put Magpie behind something that
gives it a real `https://` name: a reverse proxy with a certificate (Caddy, Traefik, nginx), or a tunnel
(Cloudflare Tunnel, Tailscale Funnel). Point it at port 8080 on the machine running Docker. The web app
itself also expects https, because its sign-in cookies are marked secure.

The compose file publishes that port on `127.0.0.1` only, which suits a proxy or tunnel running on the same
machine. A proxy that runs in its own container cannot reach that address: put it on the same Docker network
as Magpie and point it at `magpie:8080` instead.

## Set it up

1. Copy `.env.example` to `.env` and fill it in. A line you leave blank counts as not set.

   ```sh
   PUBLIC_URL=https://magpie.example.com          # the public address, no trailing slash
   HOUSEHOLD_TZ=America/Chicago                   # your time zone
   ALLOWED_USERS=alex@example.com=Alex,sam@example.com=Sam
   LOGIN_PASSWORDS=alex@example.com=<password>,sam@example.com=<another>
   FILES_KEY=<key>
   BOOTSTRAP_EMPTY_DB=1                           # first start only
   ```

   Make the values with:

   ```sh
   openssl rand -base64 32                        # FILES_KEY
   openssl rand -base64 24 | tr -d '/+=,'         # one password; run it once per person
   ```

   A password needs 16 or more characters and no spaces or commas. Put the passwords and `FILES_KEY` in a
   password manager now. Without `FILES_KEY`, photos and sensitive entries cannot be read again.

2. Tell it which header your proxy uses. Sign-in is locked for ten minutes after ten wrong passwords from
   one address, so Magpie needs the visitor's real address, and only your proxy knows it. Add one of these
   lines to `.env`:

   ```sh
   CLIENT_IP_HEADER=X-Forwarded-For     # nginx, Caddy, Traefik
   CLIENT_IP_HEADER=CF-Connecting-IP    # Cloudflare Tunnel
   ```

   Without it every visitor looks like your proxy, and a stranger's wrong guesses can lock you out for those
   ten minutes. Never name a header your proxy does not set itself.

3. Start it:

   ```sh
   docker compose up -d --build
   docker compose logs -f magpie                  # wait for "listening"
   ```

   If port 8080 is taken on your machine, pick another: `MAGPIE_PORT=8090 docker compose up -d --build`.
   It refuses to start unless `PUBLIC_URL` begins with `https://`.

   ```sh
   docker compose ps                              # says "healthy" after half a minute
   ```

4. Remove `BOOTSTRAP_EMPTY_DB=1` from `.env` and run `docker compose up -d` again. From then on a missing
   or empty database makes it refuse to start instead of quietly starting empty.

5. Open your public address and sign in. Home shows how to connect Claude: claude.ai > Customize >
   Connectors > Add custom connector, URL `https://magpie.example.com/mcp`.

## Looking after it

- **Data** is in the `magpie_data` volume: `tracker.db` (everything you saved), `auth.db` (sign-ins) and
  `files/` (photos, encrypted). Back the volume up, or set the four R2 values from `.env.example` for
  continuous off-site backups. A backup is only useful together with `FILES_KEY`.
- **Updating:** get the new version, then `docker compose up -d --build`. Updates only move forward; do
  not go back to an older version once a newer one has run.
- **Admin commands:** `docker compose exec -u node magpie node src/cli.ts users` (see the top of
  `src/cli.ts` for the list).
- **The Ask box** is off until you add `ANTHROPIC_API_KEY` to `.env` and run `docker compose up -d` again.
  Everything through Claude's connector works without it.
- **Removing it:** `docker compose down -v` deletes the container and the `magpie_data` volume with
  everything in it.
