// test/server.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { connect } from 'node:net';
import { createControlServer, broadcastFrame, LIVE_CLIENT_MAX_BUFFER } from '../src/server.js';
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

// --- Task 3: control server correctness -------------------------------------

const writeCapture = (path, lines) => writeFileSync(path, lines.map((l) => l + '\n\n').join(''));
const getStatus = async (base) => (await fetch(`${base}/api/status`)).json();
const waitState = async (base, state, timeoutMs = 5000) => {
  let st = await getStatus(base);
  const t0 = Date.now();
  while (st.state !== state && Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 25));
    st = await getStatus(base);
  }
  return st;
};

// Collects /api/live SSE frames in the background; waitFor polls the buffer.
async function openLive(base) {
  const res = await fetch(`${base}/api/live`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const frames = [];
  let buf = '';
  (async () => {
    while (true) {
      const { done, value } = await reader.read().catch(() => ({ done: true }));
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (line.startsWith('data: ')) frames.push(JSON.parse(line.slice(6)));
      }
    }
  })();
  return {
    frames,
    async waitFor(pred, timeoutMs = 5000) {
      const t0 = Date.now();
      while (Date.now() - t0 < timeoutMs) {
        const hit = frames.find(pred);
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 25));
      }
      return frames.find(pred) ?? null;
    },
    close: () => reader.cancel().catch(() => {}),
  };
}

const CAP_ZONE_A = [
  'data: {"type":"snapshot","zones":{"0":{"1":{"lastSeen":1}}}}',
  'data: {"t":1,"z":0,"s":1,"l":3,"f":0,"uu":0.5,"vv":0.5,"ts":1000}',
  'data: {"t":2,"z":0,"s":1,"l":3,"f":0,"ts":1500}',
];
const CAP_ZONE_B = [
  'data: {"type":"snapshot","zones":{"1":{"9":{"lastSeen":1}}}}',
  'data: {"t":1,"z":1,"s":9,"l":2,"f":0,"uu":0.3,"vv":0.7,"ts":2000}',
  'data: {"t":2,"z":1,"s":9,"l":2,"f":0,"ts":2400}',
];

test('failed take: honest IDLE + lastError, no stale stats from the previous take', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'traces-fail-'));
  let take = 0;
  async function* explodingSource() {
    yield { raw: { t: 1, z: 0, s: 1, l: 3, f: 0, uu: 0.5, vv: 0.5, ts: 1000 }, arrivalMs: Date.now() };
    throw new Error('upstream exploded');
  }
  const srv = createControlServer({
    sessionsDir: dir,
    sourceFactory: () => (take === 1 ? explodingSource() : fileSource(FIXTURE)),
  });
  await srv.listen(0);
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.port()}`;

  // take 1 succeeds and leaves real numbers behind
  await fetch(`${base}/api/arm`, { method: 'POST' });
  await fetch(`${base}/api/start`, { method: 'POST' });
  let st = await waitState(base, 'COMPLETE');
  assert.equal(st.state, 'COMPLETE');
  assert.equal(st.stats.stored > 0, true);

  // take 2 blows up after one event
  take = 1;
  const live = await openLive(base);
  await fetch(`${base}/api/arm`, { method: 'POST' });
  await fetch(`${base}/api/start`, { method: 'POST' });
  st = await waitState(base, 'IDLE');
  assert.equal(st.state, 'IDLE');
  assert.ok(st.lastError, 'status must carry the failure');
  assert.match(st.lastError.message, /upstream exploded/);
  // the previous take's numbers must not masquerade as this take's outcome
  assert.equal(st.stats, null);
  assert.equal(st.participants, 0);
  assert.equal(st.sessionId, null);
  const idle = await live.waitFor((f) => f.kind === 'state' && f.state === 'IDLE' && f.error);
  assert.ok(idle, 'live clients must hear about the failure');
  assert.match(idle.error, /upstream exploded/);
  live.close();

  // the next start clears the error
  take = 2;
  await fetch(`${base}/api/arm`, { method: 'POST' });
  await fetch(`${base}/api/start`, { method: 'POST' });
  st = await waitState(base, 'COMPLETE');
  assert.equal(st.state, 'COMPLETE');
  assert.equal(st.lastError, null);
  assert.equal(st.stats.stored > 0, true);
});

test('auto-pack failure: take still COMPLETE, packError surfaced, packName null', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'traces-packfail-'));
  const packs = join(dir, 'packs');
  writeFileSync(packs, 'dosya, dizin degil'); // a FILE where the packs dir should be
  const capture = join(dir, 'cap.raw');
  writeCapture(capture, CAP_ZONE_A);
  const srv = createControlServer({ sessionsDir: dir, packsDir: packs, autoPack: true, sourceFactory: () => fileSource(capture) });
  await srv.listen(0);
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.port()}`;

  const live = await openLive(base);
  await fetch(`${base}/api/arm`, { method: 'POST' });
  await fetch(`${base}/api/start`, { method: 'POST' });
  const st = await waitState(base, 'COMPLETE');
  assert.equal(st.state, 'COMPLETE', 'a pack failure must never demote a successful take');
  assert.equal(st.packName, null);
  assert.ok(st.packError, 'status must surface the pack failure');
  assert.equal(st.stats.stored > 0, true); // the take itself is intact on disk
  assert.equal(st.lastError, null);
  const complete = await live.waitFor((f) => f.kind === 'state' && f.state === 'COMPLETE');
  assert.ok(complete, 'COMPLETE must still be broadcast when packing fails');
  assert.equal(complete.packName, null);
  assert.ok(complete.packError);
  live.close();
});

test('arm twice: second arm disarms back to IDLE and broadcasts', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'traces-disarm-'));
  const srv = createControlServer({ sessionsDir: dir, sourceFactory: () => fileSource(FIXTURE) });
  await srv.listen(0);
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.port()}`;

  const live = await openLive(base);
  await fetch(`${base}/api/arm`, { method: 'POST' });
  assert.equal((await getStatus(base)).state, 'ARMED');
  const second = await fetch(`${base}/api/arm`, { method: 'POST' });
  assert.equal(second.status, 200);
  assert.equal((await second.json()).state, 'IDLE');
  assert.equal((await getStatus(base)).state, 'IDLE');
  assert.ok(await live.waitFor((f) => f.kind === 'state' && f.state === 'ARMED'));
  assert.ok(await live.waitFor((f) => f.kind === 'state' && f.state === 'IDLE'),
    'disarm must be broadcast so viewers resync');
  // stop stays phase-honest outside a recording
  const stop = await fetch(`${base}/api/stop`, { method: 'POST' });
  assert.equal(stop.status, 409);
  assert.match((await stop.json()).error, /cannot stop from IDLE/);
  // arming again still works after a disarm
  await fetch(`${base}/api/arm`, { method: 'POST' });
  assert.equal((await getStatus(base)).state, 'ARMED');
  live.close();
});

test('take 2 hello carries no roster from take 1 (session boundary)', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'traces-roster-'));
  const cap1 = join(dir, 'cap1.raw');
  const cap2 = join(dir, 'cap2.raw');
  writeCapture(cap1, CAP_ZONE_A);
  writeCapture(cap2, CAP_ZONE_B);
  let take = 0;
  const srv = createControlServer({ sessionsDir: dir, sourceFactory: () => fileSource(take === 0 ? cap1 : cap2) });
  await srv.listen(0);
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.port()}`;

  await fetch(`${base}/api/arm`, { method: 'POST' });
  await fetch(`${base}/api/start`, { method: 'POST' });
  await waitState(base, 'COMPLETE');

  // viz sequence for take 2: arm -> connect -> hello -> start
  take = 1;
  await fetch(`${base}/api/arm`, { method: 'POST' });
  const live = await openLive(base);
  const hello = await live.waitFor((f) => f.kind === 'hello');
  assert.equal(hello.roster, null,
    `stale roster leaked into the ARMED hello: ${JSON.stringify(hello.roster)}`);
  await fetch(`${base}/api/start`, { method: 'POST' });
  const roster = await live.waitFor((f) => f.kind === 'roster');
  assert.deepEqual(roster.roster, [{ z: 'B', s: 9 }]);
  await waitState(base, 'COMPLETE');
  live.close();
});

test('viewerless take 1 events do not leak into take 2 batches', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'traces-batch-'));
  const cap1 = join(dir, 'cap1.raw');
  const cap2 = join(dir, 'cap2.raw');
  writeCapture(cap1, CAP_ZONE_A);
  writeCapture(cap2, CAP_ZONE_B);
  let take = 0;
  const srv = createControlServer({ sessionsDir: dir, sourceFactory: () => fileSource(take === 0 ? cap1 : cap2) });
  await srv.listen(0);
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.port()}`;

  // take 1 records with NO live client: its compacted events sit in pendingBatch
  await fetch(`${base}/api/arm`, { method: 'POST' });
  await fetch(`${base}/api/start`, { method: 'POST' });
  await waitState(base, 'COMPLETE');

  take = 1;
  await fetch(`${base}/api/arm`, { method: 'POST' });
  const live = await openLive(base);
  await fetch(`${base}/api/start`, { method: 'POST' });
  assert.ok(await live.waitFor((f) => f.kind === 'state' && f.state === 'COMPLETE'));
  const events = live.frames.filter((f) => f.kind === 'batch').flatMap((f) => f.events);
  assert.equal(events.length > 0, true, 'take 2 must stream its own events');
  assert.deepEqual(events.filter((e) => e.z === 'A'), [],
    'take 1 events leaked into take 2 batches');
  live.close();
});

test('broadcast drops a stalled live client past the buffer high-water mark', () => {
  assert.equal(LIVE_CLIENT_MAX_BUFFER, 4 * 1024 * 1024);
  const client = (writableLength) => ({
    writableLength, wrote: [], destroyed: false,
    write(frame) { this.wrote.push(frame); return true; },
    destroy() { this.destroyed = true; },
  });
  const healthy = client(0);
  const stalled = client(LIVE_CLIENT_MAX_BUFFER + 1);
  const clients = new Set([healthy, stalled]);
  broadcastFrame(clients, 'data: {"kind":"batch"}\n\n');
  assert.deepEqual(healthy.wrote, ['data: {"kind":"batch"}\n\n']);
  assert.equal(stalled.wrote.length, 0, 'no further writes into a stalled client');
  assert.equal(stalled.destroyed, true);
  assert.equal(clients.has(stalled), false, 'stalled client must leave the hub');
  assert.equal(clients.has(healthy), true);
  assert.equal(healthy.destroyed, false);
});
