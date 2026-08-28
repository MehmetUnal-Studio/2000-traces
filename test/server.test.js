// test/server.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { connect } from 'node:net';
import { createControlServer } from '../src/server.js';
import { fileSource } from '../src/sources/file-source.js';

const FIXTURE = new URL('../captures/fixture-small.sse.txt', import.meta.url).pathname;

test('arm/start/stop lifecycle over HTTP', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'traces-'));
  const srv = createControlServer({ sessionsDir: dir, sourceFactory: () => fileSource(FIXTURE) });
  await srv.listen(0);
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.port()}`;

  let st = await (await fetch(`${base}/api/status`)).json();
  assert.equal(st.state, 'IDLE');

  await fetch(`${base}/api/arm`, { method: 'POST' });
  st = await (await fetch(`${base}/api/status`)).json();
  assert.equal(st.state, 'ARMED');

  await fetch(`${base}/api/start`, { method: 'POST' });
  // file source drains fast; wait for completion
  for (let i = 0; i < 100 && st.state !== 'COMPLETE'; i++) {
    await new Promise((r) => setTimeout(r, 50));
    st = await (await fetch(`${base}/api/status`)).json();
  }
  assert.equal(st.state, 'COMPLETE');
  assert.equal(st.stats.stored > 0, true);

  const sessions = await (await fetch(`${base}/api/sessions`)).json();
  assert.equal(sessions.length, 1);
});

test('/sessions/ download rejects path traversal outside sessionsDir', async (t) => {
  const parent = mkdtempSync(join(tmpdir(), 'traces-'));
  const dir = join(parent, 'sessions');
  mkdirSync(dir);
  writeFileSync(join(parent, 'secret.env'), 'CS_EVENTS_AUTH=leaked');
  writeFileSync(join(dir, 'ok.jsonl'), '{"t":"session_meta"}\n');

  const srv = createControlServer({ sessionsDir: dir, sourceFactory: () => fileSource(FIXTURE) });
  await srv.listen(0);
  t.after(() => srv.close());
  const port = srv.port();

  // Legitimate download still works.
  const ok = await fetch(`http://127.0.0.1:${port}/sessions/ok.jsonl`);
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), '{"t":"session_meta"}\n');

  // Raw traversal paths (fetch normalizes `..`, so speak HTTP directly).
  const rawGet = (path) => new Promise((res, rej) => {
    const sock = connect(port, '127.0.0.1', () => {
      sock.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    let buf = '';
    sock.on('data', (d) => { buf += d; });
    sock.on('end', () => res(buf));
    sock.on('error', rej);
  });

  for (const path of ['/sessions/../secret.env', '/sessions/%2e%2e/secret.env', '/sessions/..%2fsecret.env']) {
    const reply = await rawGet(path);
    assert.match(reply, /^HTTP\/1\.1 404 /, `expected 404 for ${path}`);
    assert.equal(reply.includes('leaked'), false, `leaked file body for ${path}`);
  }
});

test('control server binds loopback only', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'traces-'));
  const srv = createControlServer({ sessionsDir: dir, sourceFactory: () => fileSource(FIXTURE) });
  await srv.listen(0);
  t.after(() => srv.close());
  const port = srv.port();

  // Reachable on IPv4 loopback...
  const st = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json();
  assert.equal(st.state, 'IDLE');

  // ...but a connection to any other interface must be refused. An unbound
  // listen(port) binds `::` (all interfaces, dual-stack), which accepts ::1.
  await assert.rejects(
    () => fetch(`http://[::1]:${port}/api/status`),
    undefined,
    'server accepted a non-127.0.0.1 connection: it is not bound to loopback IPv4 only',
  );
});
