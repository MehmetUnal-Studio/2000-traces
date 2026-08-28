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
  }
  server.close();
  assert.equal(hits() >= 2, true);
  assert.equal(got.includes(3), true);
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
