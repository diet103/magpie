import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

// setup.ps1 (Windows) and setup.sh (macOS and Linux) are two spellings of one setup. Neither can be run here
// against Fly.io, so these checks read them as text and hold the two to the same promises.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (name: string) => readFileSync(resolve(ROOT, name), 'utf8');
const ps1 = read('setup.ps1');
const sh = read('setup.sh');

/** The Fly secret names a script sets: every quoted NAME=value argument in it. */
function secretNames(script: string): string[] {
  const names = new Set<string>();
  for (const m of script.matchAll(/["']([A-Z][A-Z0-9_]+)=/g)) names.add(m[1]);
  return [...names].sort();
}

/** The number of the first line that matches, counting from 1. */
function lineOf(script: string, pattern: RegExp, what: string): number {
  const at = script.split(/\r?\n/).findIndex((line) => pattern.test(line));
  assert.notEqual(at, -1, `no line for: ${what}`);
  return at + 1;
}

/** The lines of an ignore file, without comments, blank lines or a trailing slash. */
function ignored(name: string): string[] {
  return read(name)
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\/$/, ''))
    .filter((line) => line && !line.startsWith('#'));
}

describe('the two setup scripts', () => {
  test('set the same Fly secrets', () => {
    const expected = [
      'ALLOWED_USERS',
      'ANTHROPIC_API_KEY',
      'BOOTSTRAP_EMPTY_DB',
      'FILES_KEY',
      'GOOGLE_CLIENT_ID',
      'GOOGLE_CLIENT_SECRET',
      'LITESTREAM_ACCESS_KEY_ID',
      'LITESTREAM_SECRET_ACCESS_KEY',
      'LOGIN_PASSWORDS',
      'PUBLIC_URL',
      'R2_ACCOUNT_ID',
      'R2_BUCKET',
    ];
    assert.deepEqual(secretNames(ps1), expected);
    assert.deepEqual(secretNames(sh), expected);
  });

  test('save the passwords before the deploy, so a failed deploy cannot lose them', () => {
    assert.match(ps1, /^\$LoginFile = 'magpie-login\.txt'$/m);
    assert.match(sh, /^LOGIN_FILE='magpie-login\.txt'$/m);
    // Each has one function that writes the file...
    assert.match(ps1, /^function Save-LoginFile\b[^]*?WriteAllLines\(\(Join-Path \$PSScriptRoot \$LoginFile\)[^]*?^\}/m);
    assert.match(sh, /^save_login_file\(\) \{[^]*?\} > "\$LOGIN_FILE"[^]*?^\}/m);
    // ...and nothing else in the script does.
    assert.equal(ps1.match(/\$LoginFile\)/g)?.length, 1);
    assert.equal(sh.match(/> "\$LOGIN_FILE"/g)?.length, 1);
    // It is called after the passwords are staged and before the line that deploys.
    const order = (script: string, staged: RegExp, saved: RegExp, deployed: RegExp) => [
      lineOf(script, staged, 'staging LOGIN_PASSWORDS'),
      lineOf(script, saved, 'saving the login file'),
      lineOf(script, deployed, 'the deploy'),
    ];
    for (const [stagedAt, savedAt, deployedAt] of [
      order(ps1, /^\s*Invoke-Fly \(@\('secrets', 'set', '--stage'.*\$settings\)/, /^\s*Save-LoginFile \$people/, /^\s*Invoke-Fly @\('deploy',/),
      order(sh, /^\s*run_fly secrets set --stage -a "\$APP_NAME" "\$@"/, /^\s*save_login_file "\$URL"/, /^\s*run_fly deploy /),
    ]) {
      assert.ok(stagedAt < savedAt, `staged on line ${stagedAt}, saved on line ${savedAt}`);
      assert.ok(savedAt < deployedAt, `saved on line ${savedAt}, deployed on line ${deployedAt}`);
    }
  });

  test('tell the person to keep magpie-photo-key.txt, and why', () => {
    assert.match(ps1, /^\$PhotoKeyFile = 'magpie-photo-key\.txt'$/m);
    assert.match(sh, /^PHOTO_KEY_FILE='magpie-photo-key\.txt'$/m);
    assert.match(ps1, /Note "Important: save \$PhotoKeyFile in your password manager/);
    assert.match(sh, /note "Important: save \$PHOTO_KEY_FILE in your password manager/);
    for (const script of [ps1, sh]) assert.match(script, /Photos and sensitive entries cannot be recovered without the key in it\./);
  });

  test('end a first install by saying why Fly.io needs a card', () => {
    // Without one the install works but the server is stopped every few minutes, and nothing else says why.
    for (const script of [ps1, sh]) {
      assert.match(script, /Fly\.io card: if you have not added one yet, do it now at https:\/\/fly\.io\/dashboard\/personal\/billing/);
      assert.match(script, /Without a card a new account has \\?\$1 of credit for 7 days, and Fly\.io has stopped such servers five minutes after every start/);
    }
    assert.match(ps1, /^\s*if \(\$firstConfig\) \{\r?\n\s*Write-Host ''\r?\n\s*Note 'Fly\.io card:/m, 'only after a first install');
    assert.match(sh, /^if \[ "\$FIRST_CONFIG" = 1 \]; then\n\s*printf '\\n'\n\s*note 'Fly\.io card:/m, 'only after a first install');
  });

  test('take the same options', () => {
    const options = ['email', 'name', 'partner-email', 'partner-name', 'app', 'region', 'org', 'timezone', 'google', 'google-only', 'backups', 'new-passwords', 'assistant', 'no-show', 'yes', 'dry-run'];
    const params = [...ps1.slice(ps1.indexOf('param('), ps1.indexOf("$ErrorActionPreference")).matchAll(/\$([A-Za-z]+)/g)].map((m) => m[1].toLowerCase());
    assert.deepEqual(params.sort(), options.map((o) => o.replaceAll('-', '')).sort());
    for (const option of options) assert.match(sh, new RegExp(`^\\s+(?:[a-z| -]*\\| )?--${option}(?: \\||\\))`, 'm'), `setup.sh has no --${option}`);
  });

  test('write the time zone into fly.toml, where the key sits indented under [env]', () => {
    assert.match(read('fly.toml'), /^\s+HOUSEHOLD_TZ = "[^"]+"$/m);
    assert.match(ps1, /Set-TomlValue 'HOUSEHOLD_TZ' \$TimeZone/);
    assert.match(sh, /set_toml_value HOUSEHOLD_TZ "\$TIME_ZONE"/);
  });

  test('are plain ASCII, and the shell script has LF line endings', () => {
    for (const [name, script] of [['setup.ps1', ps1], ['setup.sh', sh]] as const) {
      // Windows PowerShell 5.1 reads a script without a byte-order mark as ANSI, so anything else garbles.
      assert.equal(/[^\x09\x0a\x0d\x20-\x7e]/.exec(script)?.[0], undefined, `${name} must be plain ASCII`);
    }
    assert.ok(!sh.includes('\r'), 'setup.sh needs LF line endings to run');
    assert.ok(sh.startsWith('#!/usr/bin/env bash\n'));
  });
});

describe('what stays out of the image and the repository', () => {
  test('.dockerignore leaves out the secrets setup writes and the assistant folder', () => {
    const list = ignored('.dockerignore');
    for (const name of ['magpie-login.txt', 'magpie-photo-key.txt', '.claude', '.env']) assert.ok(list.includes(name), `.dockerignore is missing ${name}`);
  });

  test('.gitignore leaves them out too', () => {
    const list = ignored('.gitignore');
    for (const name of ['magpie-login.txt', 'magpie-photo-key.txt', '.claude/worktrees', '.env']) assert.ok(list.includes(name), `.gitignore is missing ${name}`);
  });
});
