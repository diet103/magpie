#!/usr/bin/env bash
# Sets up Magpie (the Tell Me Anything Tracker) on Fly.io with one command, on macOS and Linux.
# setup.ps1 does the same on Windows. Keep the two behaving alike.
#
# Run it with no options. It:
#   1. installs the Fly.io command-line tool if it is missing (it asks first),
#   2. opens the browser so you can log in to Fly.io,
#   3. asks who may sign in (one or two email addresses) and for the household's time zone,
#   4. creates the app, its disk and its settings, and deploys it,
#   5. checks that it answers, then prints the address to paste into Claude and a password for each person.
#
# It is safe to run again. It continues where it stopped, and on a finished setup it deploys the latest code.
# It needs only curl and openssl besides the usual shell tools. No Node, no Docker.

set -u

APP_LABEL='Magpie'
APP_PREFIX='magpie-'
VOLUME_NAME='tracker_data'
LOGIN_FILE='magpie-login.txt'
PHOTO_KEY_FILE='magpie-photo-key.txt'

usage() {
  cat <<'USAGE'
Magpie setup

  ./setup.sh                  first setup, or deploy the latest code (safe to run any time)

Later, when you want them:
  ./setup.sh --backups        continuous off-site backups to Cloudflare R2
  ./setup.sh --google         "Sign in with Google" instead of (or next to) passwords
  ./setup.sh --assistant      switch on the Ask box in the web app (uses your Anthropic API key)
  ./setup.sh --new-passwords  replace the sign-in passwords
  ./setup.sh --dry-run        show what would happen, change nothing

Every question has an option, so it can run without asking anything:
  --email A --name N                  who may sign in
  --partner-email A --partner-name N  a second person (with --email, only added by --partner-email)
  --timezone America/Chicago          the household's time zone (first setup; on a later run it changes it)
  --app my-name                       first setup: the app's name, which is also its address
  --region iad   --org personal       first setup: where it runs, and the Fly.io organization
  --yes                               install the Fly.io tool without asking
  --google-only                       with --google: switch password sign-in off without asking
  --no-show                           never print a password or key; they go to their files only. Use this
                                      when an AI assistant runs the script. It then refuses to ask for a secret.

The add-ons take their values from the environment when these are set, instead of asking:
  --assistant   MAGPIE_ANTHROPIC_API_KEY
  --google      MAGPIE_GOOGLE_CLIENT_ID, MAGPIE_GOOGLE_CLIENT_SECRET
  --backups     MAGPIE_R2_ACCOUNT_ID, MAGPIE_R2_BUCKET, MAGPIE_R2_ACCESS_KEY_ID, MAGPIE_R2_SECRET_ACCESS_KEY
USAGE
}

# ---- output helpers ---------------------------------------------------------------------------------
if [ -t 1 ]; then
  C_CYAN=$'\033[36m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'; C_OFF=$'\033[0m'
else
  C_CYAN=''; C_GREEN=''; C_YELLOW=''; C_RED=''; C_OFF=''
fi
step() { printf '\n%s== %s%s\n' "$C_CYAN" "$1" "$C_OFF"; }
info() { printf '   %s\n' "$1"; }
good() { printf '%s   %s%s\n' "$C_GREEN" "$1" "$C_OFF"; }
note() { printf '%s   %s%s\n' "$C_YELLOW" "$1" "$C_OFF"; }
stop() { printf '\n%sSetup stopped: %s%s\n\n' "$C_RED" "$1" "$C_OFF"; exit 1; }

trim() { printf '%s' "$1" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//'; }
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

# Puts the reply in ANSWER. Enter, or nobody there to type, takes the default. ASKED_NOBODY says which.
ask() {
  local question=$1 default=${2:-} reply=''
  ASKED_NOBODY=0
  if [ -n "$default" ]; then printf '%s [%s]: ' "$question" "$default"; else printf '%s: ' "$question"; fi
  if ! IFS= read -r reply; then ASKED_NOBODY=1; printf '\n'; fi
  reply=$(trim "$reply")
  ANSWER=${reply:-$default}
}

# Puts y or n in ANSWER. The default is y or n.
ask_yes_no() {
  local question=$1 default=$2 hint='y/N'
  if [ "$default" = y ]; then hint='Y/n'; fi
  ask "$question [$hint]"
  case "$(lower "$ANSWER")" in
    '') ANSWER=$default ;;
    y*) ANSWER=y ;;
    *) ANSWER=n ;;
  esac
}

# With --no-show nothing secret may pass through this terminal, so a step that has to ask for one is turned away.
refuse_secret_prompt() {
  if [ "$NO_SHOW" = 1 ]; then
    stop "$1 would have to be typed here, and --no-show means no secret is typed or shown in this terminal. Run this step yourself, in your own terminal: ./setup.sh $2"
  fi
}

# ---- options ------------------------------------------------------------------------------------------
EMAIL=''; NAME=''; PARTNER_EMAIL=''; PARTNER_NAME=''
APP=''; REGION='iad'; REGION_GIVEN=0; ORG='personal'; TIME_ZONE=''
GOOGLE=0; GOOGLE_ONLY=0; BACKUPS=0; NEW_PASSWORDS=0; ASSISTANT=0; NO_SHOW=0; YES=0; DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --*=*)
      option=${1%%=*}; value=${1#*=}; shift
      set -- "$option" "$value" "$@"
      ;;
  esac
  case "$1" in
    --email | --name | --partner-email | --partner-name | --app | --region | --org | --timezone)
      if [ $# -lt 2 ]; then stop "$1 needs a value after it."; fi
      case "$1" in
        --email) EMAIL=$2 ;;
        --name) NAME=$2 ;;
        --partner-email) PARTNER_EMAIL=$2 ;;
        --partner-name) PARTNER_NAME=$2 ;;
        --app) APP=$2 ;;
        --region) REGION=$2; REGION_GIVEN=1 ;;
        --org) ORG=$2 ;;
        --timezone) TIME_ZONE=$2 ;;
      esac
      shift 2
      ;;
    --google) GOOGLE=1; shift ;;
    --google-only) GOOGLE_ONLY=1; shift ;;
    --backups) BACKUPS=1; shift ;;
    --new-passwords) NEW_PASSWORDS=1; shift ;;
    --assistant) ASSISTANT=1; shift ;;
    --no-show) NO_SHOW=1; shift ;;
    --yes) YES=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) stop "\"$1\" is not an option. See ./setup.sh --help" ;;
  esac
done

# ---- flyctl -------------------------------------------------------------------------------------------
FLY=''
FLY_TEXT=''

find_fly() {
  local name path
  FLY=''
  for name in flyctl fly; do
    if command -v "$name" >/dev/null 2>&1; then FLY=$(command -v "$name"); return; fi
  done
  for path in "$HOME/.fly/bin/flyctl" "$HOME/.fly/bin/fly"; do
    if [ -x "$path" ]; then FLY=$path; return; fi
  done
}

install_fly() {
  step 'Installing the Fly.io command-line tool'
  if [ "$DRY_RUN" = 1 ]; then info '[dry run] would run the installer from https://fly.io/install.sh'; FLY='flyctl'; return; fi
  if [ "$YES" != 1 ]; then
    ask_yes_no '   The Fly.io tool is not on this computer. Install it now?' y
    if [ "$ASKED_NOBODY" = 1 ]; then stop 'Nobody answered. Run setup again with --yes to install the Fly.io tool without being asked.'; fi
    if [ "$ANSWER" != y ]; then stop 'The Fly.io tool is needed. Install it from https://fly.io/docs/flyctl/install/ and run setup again.'; fi
  fi
  info 'Running the official installer from https://fly.io/install.sh (it goes into your home folder, under .fly).'
  if ! curl -L https://fly.io/install.sh | sh; then note 'The installer reported a problem.'; fi
  PATH="$HOME/.fly/bin:$PATH"
  export PATH
  find_fly
  if [ -z "$FLY" ]; then stop 'The Fly.io tool did not install. Install it from https://fly.io/docs/flyctl/install/ and run setup again.'; fi
}

# Hides the values of NAME=VALUE arguments when a command is shown on screen.
format_fly_args() {
  local shown='' arg name
  for arg in "$@"; do
    name=${arg%%=*}
    if [ "$name" != "$arg" ] && printf '%s' "$name" | grep -Eq '^[A-Z][A-Z0-9_]+$'; then arg="$name=..."; fi
    shown="$shown $arg"
  done
  printf '%s' "${shown# }"
}

# Runs flyctl with its output on screen. Stops the setup if it fails.
run_fly() {
  if [ "$DRY_RUN" = 1 ]; then info "[dry run] fly $(format_fly_args "$@")"; return 0; fi
  if ! "$FLY" "$@"; then
    stop "The command failed: fly $(format_fly_args "$@")
   If Fly.io asked for a payment method, add a card at https://fly.io/dashboard/personal/billing and run setup again. It continues where it stopped."
  fi
}

# Runs flyctl quietly: its output goes to FLY_TEXT and its result is this function's result.
fly_quiet() {
  FLY_TEXT=$("$FLY" "$@" 2>&1)
}

# Runs a flyctl command that lists something and puts the list in FLY_TEXT. Stops the setup if the command
# fails, because guessing "nothing there" could create a second disk or replace the sign-in passwords.
fly_read() {
  FLY_TEXT=''
  if [ "$DRY_RUN" = 1 ]; then return 0; fi
  if ! FLY_TEXT=$("$FLY" "$@" 2>/dev/null); then
    stop "Could not read from Fly.io: fly $*   Check your connection and run setup again."
  fi
}

app_is_mine() {
  if [ "$DRY_RUN" = 1 ] || [ -z "$1" ]; then return 1; fi
  fly_quiet status -a "$1"
}

SECRET_NAMES=''
load_secret_names() {
  fly_read secrets list -a "$APP_NAME"
  SECRET_NAMES=$FLY_TEXT
}
has_secret() { printf '%s\n' "$SECRET_NAMES" | grep -qw -- "$1"; }

# ---- fly.toml -----------------------------------------------------------------------------------------
toml_value() {
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*[\"']\\([^\"']*\\)[\"'].*/\\1/p" fly.toml | head -n 1
}

# Rewrites one key's line and leaves the rest of the file, and the line's indentation, as they were.
set_toml_value() {
  local key=$1 value=$2
  if [ "$DRY_RUN" = 1 ]; then info "[dry run] would set $key = \"$value\" in fly.toml"; return; fi
  awk -v key="$key" -v value="$value" '
    {
      line = $0
      sub(/\r$/, "", line)
      if (line ~ ("^[ \t]*" key "[ \t]*=")) {
        indent = line
        sub(/[^ \t].*$/, "", indent)
        print indent key " = \"" value "\""
      } else {
        print $0
      }
    }' fly.toml > "$TMP_DIR/fly.toml" || stop 'Could not rewrite fly.toml.'
  if ! cmp -s "$TMP_DIR/fly.toml" fly.toml; then cat "$TMP_DIR/fly.toml" > fly.toml; fi
}

# ---- small tools --------------------------------------------------------------------------------------
# Random characters from the given alphabet (letters and digits only), from the system's secure generator.
random_text() {
  local length=$1 alphabet=$2 text=''
  while [ "${#text}" -lt "$length" ]; do
    text=$text$(openssl rand -base64 96 | LC_ALL=C tr -dc "$alphabet")
  done
  printf '%s' "$text" | cut -c "1-$length"
}

# 20 random characters in five groups, without look-alikes such as 0/o or 1/l. About 99 bits.
new_password() {
  random_text 20 'abcdefghjkmnpqrstuvwxyz23456789' | sed 's/..../&-/g; s/-$//'
}

test_email() { printf '%s' "$1" | grep -Eq '^[^@[:space:],=]+@[^@[:space:],=]+\.[^@[:space:],=]+$'; }

# Prints a tidy first name: the one given, or one made from the email address.
clean_name() {
  local clean letters
  clean=$(trim "$(printf '%s' "$1" | tr -d ',="'"'")")
  if [ -n "$clean" ]; then printf '%s' "$clean"; return; fi
  letters=$(printf '%s' "${2%%@*}" | LC_ALL=C tr -dc 'A-Za-z')
  if [ -z "$letters" ]; then printf 'Me'; return; fi
  printf '%s' "$letters" | awk '{ print toupper(substr($0, 1, 1)) tolower(substr($0, 2)) }'
}

P1_EMAIL=''; P1_NAME=''; P1_PASSWORD=''; P2_EMAIL=''; P2_NAME=''; P2_PASSWORD=''
HAVE_PEOPLE=0

get_people() {
  local first_email=$EMAIL first_name=$NAME second_email=$PARTNER_EMAIL second_name=$PARTNER_NAME suggestion=''
  if [ -z "$first_email" ]; then
    suggestion=$(git config user.email 2>/dev/null || true)
    info 'Who may sign in? Use the address each person will type to sign in.'
    ask '   Your email' "$suggestion"; first_email=$ANSWER
  fi
  if ! test_email "$first_email"; then stop "\"$first_email\" does not look like an email address."; fi
  if [ -z "$first_name" ] && [ -z "$EMAIL" ]; then
    ask '   Your first name' "$(clean_name '' "$first_email")"; first_name=$ANSWER
  fi
  P1_EMAIL=$(lower "$first_email")
  P1_NAME=$(clean_name "$first_name" "$first_email")

  if [ -z "$second_email" ] && [ -z "$EMAIL" ]; then
    ask "   A second person's email (press Enter to skip)"; second_email=$ANSWER
  fi
  P2_EMAIL=''
  if [ -n "$second_email" ]; then
    if ! test_email "$second_email"; then stop "\"$second_email\" does not look like an email address."; fi
    if [ "$(lower "$second_email")" = "$P1_EMAIL" ]; then stop 'The two email addresses are the same.'; fi
    if [ -z "$second_name" ] && [ -z "$PARTNER_EMAIL" ]; then
      ask '   Their first name' "$(clean_name '' "$second_email")"; second_name=$ANSWER
    fi
    P2_EMAIL=$(lower "$second_email")
    P2_NAME=$(clean_name "$second_name" "$second_email")
    P2_PASSWORD=$(new_password)
  fi
  P1_PASSWORD=$(new_password)
  HAVE_PEOPLE=1
}

test_time_zone() {
  if [ "$1" = 'UTC' ]; then return 0; fi
  if ! printf '%s' "$1" | grep -Eq '^[A-Za-z_]+(/[A-Za-z0-9_+-]+){1,2}$'; then return 1; fi
  if [ -d /usr/share/zoneinfo ] && [ ! -e "/usr/share/zoneinfo/$1" ]; then return 1; fi
  return 0
}

# Prints this computer's time zone as a name like America/Chicago, or nothing if it cannot tell.
computer_time_zone() {
  local zone='' target=''
  if [ -r /etc/timezone ]; then zone=$(trim "$(head -n 1 /etc/timezone)"); fi
  if [ -z "$zone" ] && [ -L /etc/localtime ]; then
    target=$(readlink /etc/localtime)
    case "$target" in *zoneinfo/*) zone=${target##*zoneinfo/} ;; esac
  fi
  if [ -n "$zone" ] && test_time_zone "$zone"; then printf '%s' "$zone"; fi
}

# The household's time zone decides what "today" is. Asked once, on the first setup.
get_household_time_zone() {
  local suggestion attempt
  if [ -n "$TIME_ZONE" ]; then return; fi
  suggestion=$(computer_time_zone)
  info 'Which time zone is the household in? Use a name like America/Chicago or Europe/London'
  info '(the full list: https://en.wikipedia.org/wiki/List_of_tz_database_time_zones).'
  for attempt in 1 2 3; do
    ask '   Time zone' "$suggestion"
    if test_time_zone "$ANSWER"; then TIME_ZONE=$ANSWER; return; fi
    note "\"$ANSWER\" is not a time zone name. It looks like America/Chicago: a region, a slash, a city."
    if [ "$ASKED_NOBODY" = 1 ] || [ "$attempt" = 3 ]; then break; fi
  done
  stop 'A time zone is needed. Run setup again with: ./setup.sh --timezone America/Chicago'
}

save_login_file() {
  local url=$1
  if [ "$DRY_RUN" = 1 ]; then info "[dry run] would save the sign-in passwords in $LOGIN_FILE"; return; fi
  (
    umask 077
    {
      printf '%s\n\n' "$APP_LABEL"
      printf 'Web app:              %s\n' "$url"
      printf 'Address for Claude:   %s/mcp\n\n' "$url"
      printf 'Sign-in:\n'
      printf '  %-10s %-32s %s\n' "$P1_NAME" "$P1_EMAIL" "$P1_PASSWORD"
      if [ -n "$P2_EMAIL" ]; then printf '  %-10s %-32s %s\n' "$P2_NAME" "$P2_EMAIL" "$P2_PASSWORD"; fi
      printf '\nPut the passwords in your password manager, then delete this file.\n'
      printf 'New passwords any time: ./setup.sh --new-passwords\n'
    } > "$LOGIN_FILE"
  ) || stop "Could not write $LOGIN_FILE in this folder."
  good "Saved the sign-in passwords in $LOGIN_FILE, in this folder."
}

# The copying programs keep running in the background; cutting them off from this script's output stops them
# from holding it open.
copy_to_clipboard() {
  if command -v pbcopy >/dev/null 2>&1; then printf '%s' "$1" | pbcopy >/dev/null 2>&1; return; fi
  if command -v wl-copy >/dev/null 2>&1; then printf '%s' "$1" | wl-copy >/dev/null 2>&1; return; fi
  if command -v xclip >/dev/null 2>&1; then printf '%s' "$1" | xclip -selection clipboard >/dev/null 2>&1; return; fi
  return 1
}

HTTP_STATUS=0
# http METHOD URL: the status goes to HTTP_STATUS (0 when there was no answer), the body and the headers to files.
http() {
  : > "$TMP_DIR/body"
  : > "$TMP_DIR/headers"
  if [ "$1" = POST ]; then
    HTTP_STATUS=$(curl -s -o "$TMP_DIR/body" -D "$TMP_DIR/headers" --max-time 15 -w '%{http_code}' -X POST -d '' "$2" 2>/dev/null)
  else
    HTTP_STATUS=$(curl -s -o "$TMP_DIR/body" -D "$TMP_DIR/headers" --max-time 15 -w '%{http_code}' "$2" 2>/dev/null)
  fi
  case "$HTTP_STATUS" in
    [1-5][0-9][0-9]) ;;
    *) HTTP_STATUS=0 ;;
  esac
}

wait_healthy() {
  local url=$1 minutes=5 deadline
  if [ "$DRY_RUN" = 1 ]; then info "[dry run] would wait for $url/healthz"; return; fi
  info "Waiting for $url to answer (a new address can take a minute or two)..."
  deadline=$(($(date +%s) + minutes * 60))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    http GET "$url/healthz"
    if [ "$HTTP_STATUS" = 200 ]; then good 'It is up.'; return; fi
    sleep 5
  done
  stop "$url did not answer within $minutes minutes. Look at the logs with: fly logs -a $APP_NAME   Then run setup again."
}

test_deployment() {
  local url=$1 failed=0
  if [ "$DRY_RUN" = 1 ]; then info '[dry run] would run 3 checks: the sign-in page, the address for Claude, and the sign-in details Claude reads'; return; fi
  http GET "$url/login"
  if [ "$HTTP_STATUS" = 200 ]; then good 'ok      1. The sign-in page loads.'
  else failed=$((failed + 1)); note "FAILED  1. The sign-in page answered $HTTP_STATUS."; fi
  http POST "$url/mcp"
  if [ "$HTTP_STATUS" = 401 ] && grep -i '^www-authenticate:' "$TMP_DIR/headers" | grep -q 'resource_metadata'; then good 'ok      2. The address for Claude asks for sign-in.'
  else failed=$((failed + 1)); note "FAILED  2. The address for Claude answered $HTTP_STATUS instead of asking for sign-in."; fi
  http GET "$url/.well-known/oauth-protected-resource/mcp"
  if [ "$HTTP_STATUS" = 200 ] && grep -qF "$url/mcp" "$TMP_DIR/body"; then good 'ok      3. The sign-in details Claude reads give the right address.'
  else failed=$((failed + 1)); note 'FAILED  3. The sign-in details Claude reads are missing or give the wrong address.'; fi
  if [ "$failed" -gt 0 ]; then CHECKS_FAILED=$failed; note "It is running, but $failed of the 3 checks failed. Logs: $FLY logs -a $APP_NAME --no-tail"
  else good 'All 3 checks passed.'; fi
}

show_connect_steps() {
  local url=$1
  printf '\n%s   Connect Claude (each person does this once, from their own Claude account):%s\n' "$C_CYAN" "$C_OFF"
  info '1. Open https://claude.ai > Customize > Connectors > Add custom connector.'
  info "2. Name: $APP_LABEL     URL: $url/mcp"
  info '3. Click Connect, sign in, and choose Allow. The phone app picks it up from your account.'
  info 'Then just talk to Claude: "we went to that new pho place tonight, 4 out of 5."'
  info "Browse and fix things at $url (in Chrome on your phone: menu > Add to Home screen)."
}

# ---- start --------------------------------------------------------------------------------------------
cd "$(dirname "$0")" || stop 'Could not open the folder this script is in.'
if [ ! -f fly.toml ] || [ ! -f Dockerfile ]; then stop 'Run this from the tracker folder (the one with fly.toml and Dockerfile).'; fi
for tool in curl openssl sed grep awk tr; do
  if ! command -v "$tool" >/dev/null 2>&1; then stop "This needs the \"$tool\" program, which is not on this computer. Install it and run setup again."; fi
done
TMP_DIR=$(mktemp -d 2>/dev/null || mktemp -d -t magpie) || stop 'Could not make a temporary folder.'
trap 'rm -rf "$TMP_DIR"' EXIT

printf '\n%s%s setup%s\n' "$C_CYAN" "$APP_LABEL" "$C_OFF"
if [ "$DRY_RUN" = 1 ]; then note 'Dry run: nothing will be installed, created or changed.'; fi
if [ -n "$TIME_ZONE" ] && ! test_time_zone "$TIME_ZONE"; then stop "\"$TIME_ZONE\" is not a time zone name. Use one like America/Chicago or Europe/London."; fi
if [ "$ASSISTANT" = 1 ] && [ -z "${MAGPIE_ANTHROPIC_API_KEY:-}" ]; then refuse_secret_prompt 'An Anthropic API key' '--assistant'; fi
if [ "$GOOGLE" = 1 ] && { [ -z "${MAGPIE_GOOGLE_CLIENT_ID:-}" ] || [ -z "${MAGPIE_GOOGLE_CLIENT_SECRET:-}" ]; }; then refuse_secret_prompt 'The Google client secret' '--google'; fi
if [ "$BACKUPS" = 1 ] && { [ -z "${MAGPIE_R2_ACCOUNT_ID:-}" ] || [ -z "${MAGPIE_R2_ACCESS_KEY_ID:-}" ] || [ -z "${MAGPIE_R2_SECRET_ACCESS_KEY:-}" ]; }; then refuse_secret_prompt 'The Cloudflare R2 keys' '--backups'; fi

find_fly
if [ -z "$FLY" ]; then install_fly; else info "Fly.io tool: $FLY"; fi

if [ "$DRY_RUN" != 1 ]; then
  if ! fly_quiet auth whoami; then
    step 'Log in to Fly.io'
    info "A browser window opens. Log in, or create an account (Fly.io needs a card on file; this costs about \$4 a month)."
    run_fly auth login
  fi
  # Say whose account this is: the app is created in it and billed to it.
  if fly_quiet auth whoami; then info "Fly.io account: $(printf '%s' "$FLY_TEXT" | tail -n 1)"; fi
fi

# ---- which app? ---------------------------------------------------------------------------------------
TOML_APP=$(toml_value app)
EXISTING=0
APP_NAME=''
if [ -n "$APP" ]; then
  APP_NAME=$(lower "$APP")
  if app_is_mine "$APP_NAME"; then EXISTING=1; fi
elif app_is_mine "$TOML_APP"; then
  APP_NAME=$TOML_APP
  EXISTING=1
fi

if [ "$EXISTING" = 1 ] && [ "$REGION_GIVEN" != 1 ]; then
  TOML_REGION=$(toml_value primary_region)
  if [ -n "$TOML_REGION" ]; then REGION=$TOML_REGION; fi
fi

if [ "$EXISTING" != 1 ] && { [ "$GOOGLE" = 1 ] || [ "$BACKUPS" = 1 ] || [ "$NEW_PASSWORDS" = 1 ]; }; then
  stop 'There is no deployed tracker yet. Run setup with no options first.'
fi

# ---- add-ons for an existing deployment ---------------------------------------------------------------
if [ "$EXISTING" = 1 ] && [ "$GOOGLE" = 1 ]; then
  URL="https://$APP_NAME.fly.dev"
  step 'Add "Sign in with Google"'
  info '1. Open https://console.cloud.google.com/auth/clients (create a project if it asks; under Audience choose External and publish the app).'
  info '2. Create client > Web application.'
  info "3. Under Authorized redirect URIs add:  $URL/auth/google/callback"
  if copy_to_clipboard "$URL/auth/google/callback"; then info '   (That address is on your clipboard.)'; fi
  info '4. Copy the client ID and client secret it shows and paste them here.'
  info 'People sign in with the same email addresses you gave this setup.'
  google_id=$(trim "${MAGPIE_GOOGLE_CLIENT_ID:-}")
  google_secret=$(trim "${MAGPIE_GOOGLE_CLIENT_SECRET:-}")
  asked=0
  if [ -z "$google_id" ] || [ -z "$google_secret" ]; then
    asked=1
    ask '   Client ID' "$google_id"; google_id=$ANSWER
    ask '   Client secret'; google_secret=$ANSWER
  fi
  if [ -z "$google_id" ] || [ -z "$google_secret" ]; then stop 'Both values are needed. Nothing was changed.'; fi
  run_fly secrets set -a "$APP_NAME" "GOOGLE_CLIENT_ID=$google_id" "GOOGLE_CLIENT_SECRET=$google_secret"
  load_secret_names
  if has_secret LOGIN_PASSWORDS; then
    # Passwords stay unless --google-only says otherwise. The question is only put to someone who is typing.
    keep=y
    if [ "$GOOGLE_ONLY" = 1 ]; then keep=n; fi
    if [ "$keep" = y ] && [ "$asked" = 1 ]; then ask_yes_no '   Keep password sign-in as well?' y; keep=$ANSWER; fi
    if [ "$keep" != y ]; then run_fly secrets unset -a "$APP_NAME" LOGIN_PASSWORDS; fi
  fi
  wait_healthy "$URL"
  good 'Google sign-in is on.'
  exit 0
fi

if [ "$EXISTING" = 1 ] && [ "$BACKUPS" = 1 ]; then
  URL="https://$APP_NAME.fly.dev"
  step 'Add continuous backups (Cloudflare R2)'
  info '1. In the Cloudflare dashboard open R2 and create a bucket (for example tracker-backups).'
  info '2. R2 > Manage API tokens > Create token with Object Read & Write, limited to that bucket.'
  info '3. Paste the values here. The account ID is on the R2 overview page.'
  r2_account=$(trim "${MAGPIE_R2_ACCOUNT_ID:-}")
  r2_bucket=$(trim "${MAGPIE_R2_BUCKET:-}")
  r2_key=$(trim "${MAGPIE_R2_ACCESS_KEY_ID:-}")
  r2_secret=$(trim "${MAGPIE_R2_SECRET_ACCESS_KEY:-}")
  if [ -z "$r2_bucket" ]; then r2_bucket='tracker-backups'; fi
  if [ -z "$r2_account" ] || [ -z "$r2_key" ] || [ -z "$r2_secret" ]; then
    ask '   Account ID' "$r2_account"; r2_account=$ANSWER
    ask '   Bucket name' "$r2_bucket"; r2_bucket=$ANSWER
    ask '   Access key ID' "$r2_key"; r2_key=$ANSWER
    ask '   Secret access key'; r2_secret=$ANSWER
  fi
  if [ -z "$r2_account" ] || [ -z "$r2_key" ] || [ -z "$r2_secret" ]; then stop 'All four values are needed. Nothing was changed.'; fi
  run_fly secrets set -a "$APP_NAME" "R2_ACCOUNT_ID=$r2_account" "R2_BUCKET=$r2_bucket" "LITESTREAM_ACCESS_KEY_ID=$r2_key" "LITESTREAM_SECRET_ACCESS_KEY=$r2_secret"
  wait_healthy "$URL"
  good 'Backups are on: every change is copied to R2 within seconds, plus a nightly snapshot.'
  info "Check with: fly logs -a $APP_NAME   (look for lines from litestream)"
  exit 0
fi

# ---- first-time setup, or continuing one --------------------------------------------------------------
if [ "$EXISTING" != 1 ]; then
  get_people
  get_household_time_zone
  step 'Creating the app on Fly.io'
  if [ -n "$APP_NAME" ]; then
    candidates=$APP_NAME
  else
    candidates=''
    for _ in 1 2 3 4; do candidates="$candidates $APP_PREFIX$(random_text 4 'abcdefghijklmnopqrstuvwxyz0123456789')"; done
  fi
  created=0
  for candidate in $candidates; do
    if [ "$DRY_RUN" = 1 ]; then info "[dry run] fly apps create $candidate -o $ORG"; APP_NAME=$candidate; created=1; break; fi
    if fly_quiet apps create "$candidate" -o "$ORG"; then APP_NAME=$candidate; created=1; good "Created $candidate."; break; fi
    if printf '%s' "$FLY_TEXT" | grep -Eqi 'taken|already|not available|reserved'; then info "The name $candidate is taken; trying another."; continue; fi
    printf '%s\n' "$FLY_TEXT"
    stop 'Fly.io would not create the app (see the message above). If it asked for a payment method, add a card at https://fly.io/dashboard/personal/billing and run setup again.'
  done
  if [ "$created" != 1 ]; then stop 'Could not find a free app name. Run setup again with: ./setup.sh --app some-name-you-like'; fi
else
  info "Found your tracker on Fly.io: $APP_NAME"
fi
URL="https://$APP_NAME.fly.dev"
set_toml_value app "$APP_NAME"
if [ "$EXISTING" != 1 ]; then set_toml_value primary_region "$REGION"; fi
# A tracker that is already running keeps the time zone in fly.toml unless --timezone names another.
if [ -n "$TIME_ZONE" ]; then set_toml_value HOUSEHOLD_TZ "$TIME_ZONE"; fi

fly_read volumes list -a "$APP_NAME"
if ! printf '%s\n' "$FLY_TEXT" | grep -qw -- "$VOLUME_NAME"; then
  step 'Creating the disk for the database (1 GB, daily snapshots kept 14 days)'
  run_fly volumes create "$VOLUME_NAME" -a "$APP_NAME" -r "$REGION" -s 1 --snapshot-retention 14 --yes
fi

load_secret_names

# Photos and sensitive entries are encrypted with a key that lives in the app's settings, not on its disk.
MADE_PHOTO_KEY=0
if ! has_secret FILES_KEY; then
  step 'Creating the key that encrypts photos and sensitive entries'
  MADE_PHOTO_KEY=1
  photo_key=$(openssl rand -base64 32)
  if [ "${#photo_key}" -ne 44 ]; then stop 'Could not make a random key with openssl.'; fi
  run_fly secrets set --stage -a "$APP_NAME" "FILES_KEY=$photo_key"
  if [ "$DRY_RUN" != 1 ]; then
    (
      umask 077
      {
        printf '%s photo key (FILES_KEY)\n\n%s\n\n' "$APP_LABEL" "$photo_key"
        printf 'Photos and sensitive entries are encrypted with this key. If the app is ever rebuilt from scratch, it needs this exact key to open them again.\n'
        printf 'Put it in your password manager, then delete this file.\n'
      } > "$PHOTO_KEY_FILE"
    ) || stop "Could not write $PHOTO_KEY_FILE in this folder."
    note "Saved a copy in $PHOTO_KEY_FILE. Put it in your password manager, then delete that file."
  else
    info "[dry run] would save a copy of the key in $PHOTO_KEY_FILE"
  fi
  photo_key=''
fi

if [ "$ASSISTANT" = 1 ]; then
  step 'Switching on the Ask box'
  info 'It runs on an Anthropic API key, billed to your API credits for everyone who can sign in.'
  info 'Create one at https://console.anthropic.com/settings/keys (a separate key just for this is best, with a monthly spend limit).'
  api_key=$(trim "${MAGPIE_ANTHROPIC_API_KEY:-}")
  if [ -z "$api_key" ]; then ask '   API key (starts with sk-ant-)'; api_key=$ANSWER; fi
  if ! printf '%s' "$api_key" | grep -Eq '^sk-ant-[A-Za-z0-9_-]{20,}$'; then stop 'That does not look like an Anthropic API key. Nothing was changed.'; fi
  run_fly secrets set --stage -a "$APP_NAME" "ANTHROPIC_API_KEY=$api_key"
  api_key=''
fi

FIRST_CONFIG=1
if has_secret ALLOWED_USERS; then FIRST_CONFIG=0; fi
if [ "$FIRST_CONFIG" = 1 ] || [ "$NEW_PASSWORDS" = 1 ]; then
  if [ "$HAVE_PEOPLE" != 1 ]; then get_people; fi
  step 'Saving settings'
  allowed="$P1_EMAIL=$P1_NAME"
  passwords="$P1_EMAIL=$P1_PASSWORD"
  if [ -n "$P2_EMAIL" ]; then
    allowed="$allowed,$P2_EMAIL=$P2_NAME"
    passwords="$passwords,$P2_EMAIL=$P2_PASSWORD"
  fi
  set -- "PUBLIC_URL=$URL" "ALLOWED_USERS=$allowed" "LOGIN_PASSWORDS=$passwords"
  if [ "$FIRST_CONFIG" = 1 ]; then set -- "$@" 'BOOTSTRAP_EMPTY_DB=1'; fi
  run_fly secrets set --stage -a "$APP_NAME" "$@"
  # Before the deploy, so a deploy that fails cannot lose the passwords that are now in effect.
  save_login_file "$URL"
else
  HAVE_PEOPLE=0
fi

step 'Building and deploying (the first time takes a few minutes)'
run_fly deploy -a "$APP_NAME" --ha=false
# A first deploy normally gives the app its public addresses; make sure, so the wait below cannot hang.
if [ "$DRY_RUN" != 1 ]; then
  fly_read ips list -a "$APP_NAME" --json
  if ! printf '%s' "$FLY_TEXT" | grep -qi '"address"'; then
    run_fly ips allocate-v4 --shared -a "$APP_NAME"
    run_fly ips allocate-v6 -a "$APP_NAME"
  fi
fi
wait_healthy "$URL"

# The "it is fine to start with an empty database" switch is only for the very first start.
load_secret_names
if [ "$DRY_RUN" = 1 ] || has_secret BOOTSTRAP_EMPTY_DB; then
  step 'Locking the database against accidental resets'
  run_fly secrets unset -a "$APP_NAME" BOOTSTRAP_EMPTY_DB
  wait_healthy "$URL"
fi

step 'Checking it'
test_deployment "$URL"

if [ "$DRY_RUN" = 1 ]; then
  printf '\n'
  note 'That was a dry run. Nothing was installed, created or changed, and it did not check your Fly.io sign-in or card.'
  note "A real run picks its own address; $APP_NAME was only an example."
  printf '\n'
  exit 0
fi

printf '\n%s%s is running at %s%s\n' "$C_GREEN" "$APP_LABEL" "$URL" "$C_OFF"
if [ "$HAVE_PEOPLE" = 1 ]; then
  printf '\n%s   Sign-in (email and password):%s\n' "$C_CYAN" "$C_OFF"
  if [ "$NO_SHOW" = 1 ]; then
    printf '   %-10s %s\n' "$P1_NAME" "$P1_EMAIL"
    if [ -n "$P2_EMAIL" ]; then printf '   %-10s %s\n' "$P2_NAME" "$P2_EMAIL"; fi
    info "The passwords are not shown here. Open $LOGIN_FILE in this folder to read them."
  else
    printf '   %-10s %-32s %s\n' "$P1_NAME" "$P1_EMAIL" "$P1_PASSWORD"
    if [ -n "$P2_EMAIL" ]; then printf '   %-10s %-32s %s\n' "$P2_NAME" "$P2_EMAIL" "$P2_PASSWORD"; fi
    if [ "$DRY_RUN" != 1 ]; then info "Also saved in $LOGIN_FILE in this folder."; fi
  fi
  info "Put the passwords in your password manager, then delete $LOGIN_FILE."
fi
if [ "$DRY_RUN" != 1 ] && copy_to_clipboard "$URL/mcp"; then info "The address for Claude ($URL/mcp) is on your clipboard."; fi
show_connect_steps "$URL"
load_secret_names
if ! has_secret ANTHROPIC_API_KEY; then
  printf '\n'
  note 'Ask box: to save and search from inside the web app using your Anthropic API credits, run ./setup.sh --assistant'
fi
if ! has_secret R2_BUCKET; then
  printf '\n'
  note 'Backups: Fly.io keeps a daily snapshot of the disk for 14 days. For continuous off-site backups, run ./setup.sh --backups when you have ten minutes.'
fi
if [ "$MADE_PHOTO_KEY" = 1 ] || [ -f "$PHOTO_KEY_FILE" ]; then
  printf '\n'
  note "Important: save $PHOTO_KEY_FILE in your password manager now, then delete the file."
  note 'Photos and sensitive entries cannot be recovered without the key in it.'
fi
printf '\n'
# A failed check is a failed setup, so anything running this script can tell.
if [ "${CHECKS_FAILED:-0}" -gt 0 ]; then exit 1; fi
