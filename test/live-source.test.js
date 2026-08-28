// test/live-source.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { liveSource } from '../src/sources/live-source.js';

function mockSse({ events, dieAfter = null }) {
  let hits = 0;
  const server = createServer((req, res) => {
    hits += 1;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"type":"snapshot","zones":{}}\n\n');
    events.forEach((e, i) => res.write(`data: ${JSON.stringify(e)}\n\n`));
    if (dieAfter !== null && hits <= dieAfter) res.destroy();
    else res.end();
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ server, port: server.address().port, hits: () => hits })));
}

test('streams events and includes auth header', async () => {
  let sawAuth = null;
  const server = createServer((req, res) => {
    sawAuth = req.headers.authorization;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"t":1,"z":0,"s":1,"ts":10}\n\n');
    res.end();
  });
  await new Promise((r) => server.listen(0, r));
  const url = `http://127.0.0.1:${server.address().port}/api/events`;
  const got = [];
  for await (const { raw } of liveSource({ url, auth: 'user:pw', maxRetries: 0 })) got.push(raw);
  server.close();
  assert.equal(sawAuth, 'Basic ' + Buffer.from('user:pw').toString('base64'));
  assert.deepEqual(got.map((g) => g.t), [1]); // snapshot passes through too if not filtered here
});

test('reconnects after a dropped connection', async () => {
  const { server, port, hits } = await mockSse({ events: [{ t: 3, z: 0, s: 1, ts: 1 }], dieAfter: 1 });
  const got = [];
  for await (const { raw } of liveSource({ url: `http://127.0.0.1:${port}/`, auth: 'a:b', maxRetries: 1, retryDelayMs: 10 })) {
    if (raw.t !== undefined) got.push(raw.t);
    if (hits() >= 2 && raw.t === 3) break; // event arrived over the reconnected stream
  }
  server.close();
  assert.equal(hits() >= 2, true);
  assert.equal(got.includes(3), true);
});

test('reconnects after a clean upstream close', async () => {
  // Upstream sends 2 events then res.end() with no error — a proxy idle
  // timeout / graceful restart. The source must reconnect, not end the take.
  let hits = 0;
  const server = createServer((req, res) => {
    hits += 1;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: {"t":${hits},"z":0,"s":1,"ts":1}\n\n`);
    res.write(`data: {"t":${hits},"z":1,"s":1,"ts":2}\n\n`);
    res.end(); // clean close, no error
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const got = [];
  for await (const { raw } of liveSource({ url: `http://127.0.0.1:${port}/`, auth: 'a:b', maxRetries: 2, retryDelayMs: 10 })) {
    got.push(raw.t);
    if (raw.t === 2) break; // events flowing from the second connection
  }
  server.close();
  assert.equal(hits >= 2, true, `expected a reconnect, got ${hits} connection(s)`);
  assert.equal(got.includes(2), true, `expected events from the second connection, got ${JSON.stringify(got)}`);
});

test('abort during backoff sleep ends the source promptly', async () => {
  // Nothing listens on port 1 — every connect fails fast, so the source sits
  // in its backoff sleep. Abort must wake it, not wait out retryDelayMs.
  const controller = new AbortController();
  const src = liveSource({ url: 'http://127.0.0.1:1/', auth: 'a:b', retryDelayMs: 3000, maxRetryDelayMs: 3000, signal: controller.signal });
  let abortedAt = 0;
  const timer = setTimeout(() => { abortedAt = Date.now(); controller.abort(); }, 50);
  const got = [];
  for await (const { raw } of src) got.push(raw);
  clearTimeout(timer);
  const afterAbortMs = Date.now() - abortedAt;
  assert.equal(got.length, 0);
  assert.equal(abortedAt > 0, true, 'abort fired before the source ended — source must outlive the first failed connect');
  assert.equal(afterAbortMs < 200, true, `source took ${afterAbortMs}ms after abort (backoff sleep ignored the signal)`);
});

test('permanent 401 surfaces an auth error instead of retrying forever', async () => {
  let hits = 0;
  const server = createServer((req, res) => {
    hits += 1;
    res.writeHead(401, { 'Content-Type': 'text/plain' });
    res.end('unauthorized');
  });
  await new Promise((r) => server.listen(0, r));
  const url = `http://127.0.0.1:${server.address().port}/api/events`;
  await assert.rejects(
    async () => {
      // default maxRetries (Infinity) — the auth classification must stop it
      for await (const _ of liveSource({ url, auth: 'a:b', retryDelayMs: 10 })) void _;
    },
    /SSE auth failed \(HTTP 401\).*CS_EVENTS_AUTH.*CS_EVENTS_TOKEN/,
  );
  server.close();
  assert.equal(hits, 2, `401 must be retried exactly once, saw ${hits} request(s)`);
});

test('warns once when both auth and token are configured (token wins)', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  let sawAuth = null;
  const server = createServer((req, res) => {
    sawAuth = req.headers.authorization;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"t":9,"z":0,"s":1,"ts":1}\n\n');
    res.end();
  });
  await new Promise((r) => server.listen(0, r));
  const url = `http://127.0.0.1:${server.address().port}/api/events`;
  const got = [];
  for await (const { raw } of liveSource({ url, auth: 'user:pw', token: 'tok-9', maxRetries: 0 })) got.push(raw.t);
  server.close();
  assert.equal(sawAuth, 'Bearer tok-9');
  assert.deepEqual(got, [9]);
  assert.equal(warn.mock.calls.length, 1);
  assert.match(String(warn.mock.calls[0].arguments[0]), /CS_EVENTS_TOKEN/);
});

test('sends bearer token when token is given', async () => {
  let sawAuth = null;
  const server = createServer((req, res) => {
    sawAuth = req.headers.authorization;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"t":3,"z":0,"s":1,"ts":10}\n\n');
    res.end();
  });
  await new Promise((r) => server.listen(0, r));
  const url = `http://127.0.0.1:${server.address().port}/api/events`;
  const got = [];
  for await (const { raw } of liveSource({ url, token: 'tok-123', maxRetries: 0 })) got.push(raw.t);
  server.close();
  assert.equal(sawAuth, 'Bearer tok-123');
  assert.deepEqual(got, [3]);
});
