import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { loadConfig } from '../src/config.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const base = { NODE_ENV: 'test', PUBLIC_URL: 'http://localhost:8787', ALLOWED_USERS: 'alex@example.com=Alex' };

describe('settings', () => {
  // The README and the Docker guide both say: copy .env.example to .env. That copy has to start the app.
  test('the example settings file loads as it ships', () => {
    const example = parseEnv(readFileSync(resolve(ROOT, '.env.example'), 'utf8'));
    assert.equal(example.HEALTHCHECKS_URL, '', 'the example lists optional settings with nothing after the equals sign');
    const cfg = loadConfig(example);
    assert.deepEqual(cfg.allowedUsers.map((u) => u.name), ['Alex', 'Sam']);
    assert.equal(cfg.passwordDigests.size, 2);
    assert.equal(cfg.healthchecksUrl, undefined);
    assert.equal(cfg.assistant.apiKey, undefined);
    assert.equal(cfg.filesKey, undefined);
  });

  test('a setting left blank counts as not set', () => {
    const cfg = loadConfig({ ...base, HEALTHCHECKS_URL: '', R2_ENDPOINT: '  ', PORT: '', ASSISTANT_MODEL: '', ANTHROPIC_BASE_URL_FOR_ASSISTANT: '' });
    assert.equal(cfg.healthchecksUrl, undefined);
    assert.equal(cfg.r2.endpoint, undefined);
    assert.equal(cfg.port, 8787);
    assert.equal(cfg.assistant.model, 'claude-sonnet-5-5');
    assert.equal(cfg.assistant.baseUrl, 'https://api.anthropic.com');
  });

  test('a setting that is filled in wrongly is still refused', () => {
    assert.throws(() => loadConfig({ ...base, HEALTHCHECKS_URL: 'not a web address' }), /HEALTHCHECKS_URL/);
  });
});
