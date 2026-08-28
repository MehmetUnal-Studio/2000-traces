// test/env.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnv } from '../src/env.js';

const KEYS = ['CS_EVENTS_URL', 'CS_EVENTS_AUTH', 'CS_EVENTS_TOKEN'];

function withCleanProcessEnv(fn) {
  const saved = {};
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  try { return fn(); } finally {
    for (const k of KEYS) { if (saved[k] !== undefined) process.env[k] = saved[k]; }
  }
}

test('loadEnv parses an LF .env file', () => {
  withCleanProcessEnv(() => {
    const dir = mkdtempSync(join(tmpdir(), 'traces-env-'));
    const p = join(dir, '.env');
    writeFileSync(p, 'CS_EVENTS_URL=http://127.0.0.1:9/api/events\nCS_EVENTS_AUTH=user:pass\n');
    const env = loadEnv(p);
    assert.equal(env.CS_EVENTS_URL, 'http://127.0.0.1:9/api/events');
    assert.equal(env.CS_EVENTS_AUTH, 'user:pass');
  });
});

test('loadEnv parses a CRLF .env file', () => {
  withCleanProcessEnv(() => {
    const dir = mkdtempSync(join(tmpdir(), 'traces-env-'));
    const p = join(dir, '.env');
    writeFileSync(p, 'CS_EVENTS_URL=http://127.0.0.1:9/api/events\r\nCS_EVENTS_AUTH=user:pass\r\nCS_EVENTS_TOKEN=abc123\r\n');
    const env = loadEnv(p);
    assert.equal(env.CS_EVENTS_URL, 'http://127.0.0.1:9/api/events');
    assert.equal(env.CS_EVENTS_AUTH, 'user:pass');
    assert.equal(env.CS_EVENTS_TOKEN, 'abc123'); // no trailing \r into the Authorization header
  });
});
