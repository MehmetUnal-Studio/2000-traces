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

test('live SSE hub: hello, roster, batches, completion with auto-pack', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'traces-live-'));
  const packs = join(dir, 'packs');
  const capture = join(dir, 'cap.raw');
  writeFileSync(capture, [
    'data: {"type":"snapshot","zones":{"0":{"1":{"lastSeen":1}},"2":{"7":{"lastSeen":1}}}}',
    'data: {"t":1,"z":0,"s":1,"l":3,"f":0,"uu":0.5,"vv":0.5,"ts":1000}',
    'data: {"t":3,"z":2,"s":7,"f":0,"uu":0.2,"vv":0.8,"ts":1050}',
    'data: {"t":2,"z":0,"s":1,"l":3,"f":0,"ts":1500}',
  ].map((l) => l + '\n\n').join(''));

  const srv = createControlServer({
    sessionsDir: dir, packsDir: packs, autoPack: true,
    sourceFactory: () => fileSource(capture),
  });
  await srv.listen(0);
  const base = `http://127.0.0.1:${srv.port()}`;

  const frames = [];
  const sse = await fetch(`${base}/api/live`);
  assert.equal(sse.headers.get('access-control-allow-origin'), '*');
  const reader = sse.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const pump = (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (line.startsWith('data: ')) frames.push(JSON.parse(line.slice(6)));
      }
      if (frames.some((f) => f.kind === 'state' && f.state === 'COMPLETE')) break;
    }
  })();

  await fetch(`${base}/api/arm`, { method: 'POST' });
  await fetch(`${base}/api/start`, { method: 'POST' });
  await Promise.race([pump, new Promise((r) => setTimeout(r, 5000))]);
  reader.cancel().catch(() => {});

  assert.equal(frames[0].kind, 'hello');
  const roster = frames.find((f) => f.kind === 'roster');
  assert.deepEqual(roster.roster, [{ z: 'A', s: 1 }, { z: 'C', s: 7 }]);
  const batches = frames.filter((f) => f.kind === 'batch').flatMap((f) => f.events);
  assert.equal(batches.length, 3);
  assert.deepEqual(batches[0], { z: 'A', s: 1, t: 0, k: 1, f: 0, l: 3, u: 0.5, v: 0.5 });
  const complete = frames.find((f) => f.kind === 'state' && f.state === 'COMPLETE');
  assert.equal(complete.participants, 2);
  assert.equal(complete.packName.startsWith('kayit-'), true);
  const { existsSync: ex } = await import('node:fs');
  assert.equal(ex(join(packs, complete.packName, 'manifest.json')), true);
  assert.equal(ex(join(packs, 'index.json')), true);
  const st = await (await fetch(`${base}/api/status`)).json();
  assert.equal(st.state, 'COMPLETE');
  assert.equal(st.packName, complete.packName);
  await srv.close();
});
