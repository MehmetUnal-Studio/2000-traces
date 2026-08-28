// test/library.test.js — Task 4: library API (list, pack on demand, safe delete)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { connect } from 'node:net';
import { createControlServer } from '../src/server.js';
import { readSessionMeta } from '../src/library.js';
import { packSession } from '../src/viz-pack.js';

// --- fixtures: hand-written JSONL matching recorder output ------------------

const headerLine = (sessionId, extra = {}) => JSON.stringify({
  kind: 'session', schemaVersion: 1, sessionId, durationMs: 90000, visualSeed: 7,
  anchorServerMs: null, startedAtLocalMs: 1, endedAtLocalMs: null, source: 'test', ...extra,
});
const eventLine = (tMs, eventType) => JSON.stringify({
  kind: 'event', participantId: 'A-1', zone: 'A', seatNumber: 1, eventType,
  tMs, u: 0.5, v: 0.5, finger: 0, line: 3, serverTimestampMs: 1000 + tMs, seq: 0,
});
const endLine = () => JSON.stringify({
  kind: 'end', stats: { received: 2, stored: 2, malformed: 0, duplicates: 0, late: 0, early: 0, ignored: 0 },
  participants: 1, events: 2, anchorServerMs: 1000, endedAtLocalMs: 99,
});
const completeSession = (sessionId, extra = {}) =>
  [headerLine(sessionId, extra), eventLine(0, 'noteOn'), eventLine(500, 'noteOff'), endLine()].join('\n') + '\n';
const incompleteSession = (sessionId) =>
  [headerLine(sessionId), eventLine(0, 'noteOn')].join('\n') + '\n';

const dummySource = () => (async function* () {})();

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

// fetch() normalizes `..` in paths, so hostile paths must speak HTTP raw.
const rawRequest = (port, method, path) => new Promise((res, rej) => {
  const sock = connect(port, '127.0.0.1', () => {
    sock.write(`${method} ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
  });
  let buf = '';
  sock.on('data', (d) => { buf += d; });
  sock.on('end', () => res(buf));
  sock.on('error', rej);
});

// --- readSessionMeta: head + tail only, never the whole file ----------------

test('readSessionMeta reads header + tail only: a garbage middle never parses', () => {
  const dir = mkdtempSync(join(tmpdir(), 'traces-lib-'));
  // 2000 lines of invalid JSON in the middle: any implementation that parses
  // the whole file (importSession-style) throws here; head+tail must not care.
  const middle = Array.from({ length: 2000 }, (_, i) => `not json at all ${i} ${'x'.repeat(100)}`).join('\n');
  const good = join(dir, 'session-big.jsonl');
  writeFileSync(good, headerLine('session-big') + '\n' + middle + '\n' + endLine() + '\n');
  const meta = readSessionMeta(good);
  assert.equal(meta.sessionId, 'session-big');
  assert.equal(meta.label, null);
  assert.equal(meta.complete, true);
  assert.equal(meta.events, 2);
  assert.equal(meta.participants, 1);
});

test('readSessionMeta: crash-torn tail reads as incomplete, label passes through', () => {
  const dir = mkdtempSync(join(tmpdir(), 'traces-lib-'));
  const torn = join(dir, 'session-torn.jsonl');
  writeFileSync(torn, headerLine('session-torn') + '\n' + eventLine(0, 'noteOn') + '\n' + '{"kind":"event","tru');
  const meta = readSessionMeta(torn);
  assert.equal(meta.sessionId, 'session-torn');
  assert.equal(meta.complete, false);
  assert.equal(meta.events, null);
  assert.equal(meta.participants, null);

  const labeled = join(dir, 'session-lbl.jsonl');
  writeFileSync(labeled, completeSession('session-lbl', { label: 'prova 1' }));
  assert.equal(readSessionMeta(labeled).label, 'prova 1'); // Task 5 forward-compat
});

// --- GET /api/library --------------------------------------------------------

test('GET /api/library lists sessions with metadata and packName joined via index', async (t) => {
  const parent = mkdtempSync(join(tmpdir(), 'traces-lib-'));
  const sessions = join(parent, 'sessions');
  const packs = join(parent, 'packs');
  mkdirSync(sessions);
  writeFileSync(join(sessions, 'session-aaa.jsonl'), completeSession('session-aaa'));
  writeFileSync(join(sessions, 'session-bbb.jsonl'), incompleteSession('session-bbb'));
  await packSession(join(sessions, 'session-aaa.jsonl'), join(packs, 'kayit-aaa'));

  const srv = createControlServer({ sessionsDir: sessions, packsDir: packs, sourceFactory: dummySource });
  await srv.listen(0);
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.port()}`;

  const res = await fetch(`${base}/api/library`);
  assert.equal(res.status, 200);
  const lib = await res.json();

  assert.equal(lib.sessions.length, 2);
  const aaa = lib.sessions.find((s) => s.file === 'session-aaa.jsonl');
  assert.ok(aaa);
  assert.equal(aaa.bytes, statSync(join(sessions, 'session-aaa.jsonl')).size);
  assert.equal(aaa.mtimeMs > 0, true);
  assert.equal(aaa.sessionId, 'session-aaa');
  assert.equal(aaa.label, null);
  assert.equal(aaa.complete, true);
  assert.equal(aaa.events, 2);
  assert.equal(aaa.participants, 1);
  assert.equal(aaa.packName, 'kayit-aaa');

  const bbb = lib.sessions.find((s) => s.file === 'session-bbb.jsonl');
  assert.ok(bbb);
  assert.equal(bbb.complete, false);
  assert.equal(bbb.events, null);
  assert.equal(bbb.participants, null);
  assert.equal(bbb.packName, null);

  assert.equal(lib.packs.length, 1);
  const p = lib.packs[0];
  assert.equal(p.name, 'kayit-aaa');
  assert.equal(p.sessionId, 'session-aaa');
  assert.equal(p.label, null);
  assert.equal(p.lanes, 1);
  assert.equal(p.events, 2);
  assert.equal(p.strokes >= 1, true);
  const expectBytes = readdirSync(join(packs, 'kayit-aaa'))
    .reduce((n, f) => n + statSync(join(packs, 'kayit-aaa', f)).size, 0);
  assert.equal(p.bytes, expectBytes);
});

// --- POST /api/pack ----------------------------------------------------------

test('POST /api/pack packs an existing session on demand and updates the index', async (t) => {
  const parent = mkdtempSync(join(tmpdir(), 'traces-lib-'));
  const sessions = join(parent, 'sessions');
  const packs = join(parent, 'packs');
  mkdirSync(sessions);
  writeFileSync(join(sessions, 'session-ccc.jsonl'), completeSession('session-ccc'));

  const srv = createControlServer({ sessionsDir: sessions, packsDir: packs, sourceFactory: dummySource });
  await srv.listen(0);
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.port()}`;
  const post = (body) => fetch(`${base}/api/pack`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

  const ok = await post({ file: 'session-ccc.jsonl' });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true, packName: 'kayit-ccc' });
  assert.equal(existsSync(join(packs, 'kayit-ccc', 'manifest.json')), true);
  const index = JSON.parse(readFileSync(join(packs, 'index.json'), 'utf8'));
  assert.ok(index.packs.some((e) => e.name === 'kayit-ccc'));
  const lib = await (await fetch(`${base}/api/library`)).json();
  assert.equal(lib.sessions.find((s) => s.file === 'session-ccc.jsonl').packName, 'kayit-ccc');

  // unknown file
  assert.equal((await post({ file: 'session-yok.jsonl' })).status, 404);

  // invalid bodies: not an object / no string file / path separators / bad JSON
  for (const bad of ['"session-ccc.jsonl"', '[1,2]', '{}', '{"file":123}', 'bozuk json {{{']) {
    assert.equal((await post(bad)).status, 400, `expected 400 for body ${bad}`);
  }
  for (const evil of ['../evil.jsonl', 'a/b.jsonl', 'a\\b.jsonl', '..', 'x\0.jsonl']) {
    assert.equal((await post({ file: evil })).status, 400, `expected 400 for file ${JSON.stringify(evil)}`);
  }
});

test('POST /api/pack and DELETE refuse the actively-recording session (409)', async (t) => {
  const parent = mkdtempSync(join(tmpdir(), 'traces-lib-'));
  const sessions = join(parent, 'sessions');
  const packs = join(parent, 'packs');
  mkdirSync(sessions);
  let release;
  const gate = new Promise((r) => { release = r; });
  const srv = createControlServer({
    sessionsDir: sessions, packsDir: packs,
    sourceFactory: () => (async function* () {
      yield { raw: { t: 1, z: 0, s: 1, l: 3, f: 0, uu: 0.5, vv: 0.5, ts: 1000 }, arrivalMs: Date.now() };
      await gate; // hold the take open
    })(),
  });
  await srv.listen(0);
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.port()}`;

  await fetch(`${base}/api/arm`, { method: 'POST' });
  const { sessionId } = await (await fetch(`${base}/api/start`, { method: 'POST' })).json();
  const file = `${sessionId}.jsonl`;

  const pack = await fetch(`${base}/api/pack`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file }),
  });
  assert.equal(pack.status, 409, 'packing the active take must be refused');
  const del = await fetch(`${base}/api/sessions/${file}`, { method: 'DELETE' });
  assert.equal(del.status, 409, 'deleting the active take must be refused');
  assert.equal(existsSync(join(sessions, file)), true, 'the live take must stay on disk');

  release();
  const st = await waitState(base, 'COMPLETE');
  assert.equal(st.state, 'COMPLETE');
});

// --- DELETE /api/sessions/<file> and /api/packs/<name> -----------------------

test('DELETE removes sessions/packs safely; traversal never escapes; index stays honest', async (t) => {
  const parent = mkdtempSync(join(tmpdir(), 'traces-lib-'));
  const sessions = join(parent, 'sessions');
  const packs = join(parent, 'packs');
  mkdirSync(sessions);
  const canary = join(parent, 'canary.txt');
  writeFileSync(canary, 'DOKUNMA');
  writeFileSync(join(sessions, 'session-ddd.jsonl'), completeSession('session-ddd'));
  writeFileSync(join(sessions, 'session-eee.jsonl'), completeSession('session-eee'));
  await packSession(join(sessions, 'session-ddd.jsonl'), join(packs, 'kayit-ddd'));
  await packSession(join(sessions, 'session-eee.jsonl'), join(packs, 'kayit-eee'));

  const srv = createControlServer({ sessionsDir: sessions, packsDir: packs, sourceFactory: dummySource });
  await srv.listen(0);
  t.after(() => srv.close());
  const port = srv.port();
  const base = `http://127.0.0.1:${port}`;

  // CORS preflight must allow DELETE (the viz panel is cross-origin)
  const opt = await fetch(`${base}/api/packs/kayit-ddd`, { method: 'OPTIONS' });
  assert.match(opt.headers.get('access-control-allow-methods') ?? '', /DELETE/);

  // delete a pack: dir gone, index entry gone, other pack kept, session intact
  const delPack = await fetch(`${base}/api/packs/kayit-ddd`, { method: 'DELETE' });
  assert.equal(delPack.status, 200);
  assert.equal(existsSync(join(packs, 'kayit-ddd')), false);
  const index = JSON.parse(readFileSync(join(packs, 'index.json'), 'utf8'));
  assert.equal(index.packs.some((e) => e.name === 'kayit-ddd'), false);
  assert.equal(index.packs.some((e) => e.name === 'kayit-eee'), true);
  assert.equal(existsSync(join(sessions, 'session-ddd.jsonl')), true,
    'deleting a pack must leave its session intact');
  let lib = await (await fetch(`${base}/api/library`)).json();
  assert.equal(lib.sessions.find((s) => s.file === 'session-ddd.jsonl').packName, null,
    'library must stop claiming a deleted pack');
  assert.equal(lib.sessions.find((s) => s.file === 'session-eee.jsonl').packName, 'kayit-eee');

  // delete a session file
  const delSess = await fetch(`${base}/api/sessions/session-ddd.jsonl`, { method: 'DELETE' });
  assert.equal(delSess.status, 200);
  assert.equal(existsSync(join(sessions, 'session-ddd.jsonl')), false);
  lib = await (await fetch(`${base}/api/library`)).json();
  assert.equal(lib.sessions.some((s) => s.file === 'session-ddd.jsonl'), false);

  // gone targets are 404
  assert.equal((await fetch(`${base}/api/packs/kayit-ddd`, { method: 'DELETE' })).status, 404);
  assert.equal((await fetch(`${base}/api/sessions/yok.jsonl`, { method: 'DELETE' })).status, 404);

  // index.json is not a pack and must survive
  const delIndex = await fetch(`${base}/api/packs/index.json`, { method: 'DELETE' });
  assert.equal([400, 404].includes(delIndex.status), true);
  assert.equal(existsSync(join(packs, 'index.json')), true);

  // hostile names: nothing outside the target dir may be touched
  const hostile = [
    '/api/sessions/../canary.txt', '/api/sessions/%2e%2e/canary.txt',
    '/api/sessions/..%2fcanary.txt', '/api/sessions/..%5ccanary.txt',
    '/api/sessions/%2e%2e', '/api/sessions/canary%00.txt',
    '/api/packs/../canary.txt', '/api/packs/%2e%2e%2fcanary.txt',
    '/api/packs/..%5ccanary.txt', '/api/packs/%2e%2e', '/api/packs/kayit%00',
  ];
  for (const path of hostile) {
    const reply = await rawRequest(port, 'DELETE', path);
    assert.match(reply, /^HTTP\/1\.1 (400|404) /, `expected 400/404 for ${path}, got:\n${reply.slice(0, 80)}`);
  }
  assert.equal(readFileSync(canary, 'utf8'), 'DOKUNMA', 'canary outside the target dirs was touched');
  assert.equal(existsSync(join(sessions, 'session-eee.jsonl')), true);
  assert.equal(existsSync(join(packs, 'kayit-eee', 'manifest.json')), true);
});
