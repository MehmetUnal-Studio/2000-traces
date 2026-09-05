import test from 'node:test';
import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { oscBundles, eventOscGroup, validateDestination } from '../src/osc-replay.js';
import { loadReplayData } from '../src/replay-data.js';
import { createUdpReplay, ensureVenueOutputPaused } from '../src/udp-replay.js';
import { createControlServer } from '../src/server.js';

const names = { 0: 'keepalive', 1: 'noteOn', 2: 'noteOff', 3: 'fingerMove', 5: 'disconnect' };
const record = (t, k = 3, extra = {}) => ({ t, k, z: 0, s: 1, f: 0, x: .2, y: .3, ...extra });

function session(t, records, { durationMs = 1000, complete = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'traces-udp-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = 'session-udp-test.jsonl'; const path = join(dir, file);
  const values = [{ kind: 'session', schemaVersion: 1, sessionId: 'session-udp-test', durationMs, label: 'UDP fixture', visualSeed: 1 },
    ...records.map((e, i) => ({ kind: 'event', seq: i, tMs: e.t, eventType: names[e.k], participantId: `${String.fromCharCode(65 + e.z)}${e.s}`,
      zone: String.fromCharCode(65 + e.z), seatNumber: e.s, ...(e.f === null ? {} : { finger: e.f }),
      ...(e.x === null ? {} : { u: e.x }), ...(e.y === null ? {} : { v: e.y }),
      raw: { t: e.k === 5 ? -1 : e.k, z: e.z, s: e.s, ...(e.f === null ? {} : { f: e.f }), ...(e.x === null ? {} : { uu: e.x }), ...(e.y === null ? {} : { vv: e.y }), ts: 1000 + e.t } })),
    ...(complete ? [{ kind: 'end', events: records.length, participants: 1, stats: { stored: records.length } }] : [])];
  writeFileSync(path, values.map((value) => JSON.stringify(value)).join('\n') + '\n');
  return { dir, file, path };
}

// Independent decoder asserts OSC framing, null termination and wire typetags.
function decode(packet) {
  assert.equal(packet.subarray(0, 8).toString('ascii'), '#bundle\0');
  assert.equal(packet.readBigUInt64BE(8), 1n, 'replay uses immediate bundles; scheduling happens on the local clock');
  const messages = [];
  for (let at = 16; at < packet.length;) {
    const length = packet.readUInt32BE(at); at += 4;
    const message = packet.subarray(at, at + length); at += length;
    const end = message.indexOf(0); assert.ok(end > 0);
    const tagsAt = Math.ceil((end + 1) / 4) * 4;
    const tagEnd = message.indexOf(0, tagsAt); const tags = message.subarray(tagsAt, tagEnd).toString();
    const dataAt = Math.ceil((tagEnd + 1) / 4) * 4;
    assert.ok(tags === ',i' || tags === ',f'); assert.equal(dataAt + 4, message.length);
    messages.push({ address: message.subarray(0, end).toString(), type: tags.slice(1), value: tags === ',i' ? message.readInt32BE(dataAt) : message.readFloatBE(dataAt) });
  }
  return messages;
}

function harness({ failSend = 0 } = {}) {
  let clock = 0; let next = 0; let sendCalls = 0; const timers = new Map(); const sent = [];
  const transport = createUdpReplay({ now: () => clock,
    schedule: (fn, delay) => { const id = next++; timers.set(id, { fn, at: clock + delay }); return id; }, unschedule: (id) => timers.delete(id),
    sender: { send: async (packets, destination) => {
      if (++sendCalls === failSend) throw new Error('injected UDP send failure');
      sent.push({ time: clock, destination, messages: packets.flatMap(decode) });
    }, close() {} },
    guardDestination: async () => {},
  });
  return { transport, sent, async advance(time) {
    for (let n = 0; n < 10000; n++) {
      const due = [...timers].find(([, item]) => item.at <= time);
      if (!due) break;
      clock = due[1].at; timers.delete(due[0]); due[1].fn();
      for (let i = 0; i < 3; i++) await new Promise(setImmediate);
    }
    clock = time;
  } };
}

test('OSC replay matches the Engine U/V/On contract and chunks whole event groups', () => {
  const onset = eventOscGroup(record(0, 1, { x: .123456789, y: .987654321 }));
  const messages = decode(oscBundles([onset])[0]);
  assert.deepEqual(messages, [
    { address: '/cs/A/1/finger0/u', type: 'f', value: Math.fround(.123456789) },
    { address: '/cs/A/1/finger0/v', type: 'f', value: Math.fround(.987654321) },
    { address: '/cs/A/1/finger0/on', type: 'i', value: 1 },
  ]);
  assert.deepEqual(decode(oscBundles([eventOscGroup(record(1, 2))])[0]), [{ address: '/cs/A/1/finger0/on', type: 'i', value: 0 }]);
  for (const packet of oscBundles(Array.from({ length: 1000 }, () => onset))) {
    assert.ok(packet.length <= 8192);
    const decoded = decode(packet); assert.equal(decoded.length % 3, 0);
    for (let i = 0; i < decoded.length; i += 3) assert.deepEqual(decoded.slice(i, i + 3), messages);
  }
  assert.equal(eventOscGroup(record(1, 1, { f: null })), null);
  assert.equal(eventOscGroup(record(1, 3, { x: NaN })), null);
  assert.throws(() => validateDestination({ host: 'example.com', port: 6061 }));
});

test('source loader keeps precise fields, sorts timestamps and discloses unsupported identities', async (t) => {
  const { path } = session(t, [record(200, 2), record(20.125, 1, { x: .12345678901234568 }), record(20.125, 3), record(30, 3, { f: null }), record(40, 3, { f: 3 })]);
  const data = await loadReplayData(path);
  assert.equal(data.sourceEvents, 5); assert.equal(data.eventCount, 4); assert.equal(data.skipped, 1); assert.equal(data.bridgeUnsupported, 1);
  assert.deepEqual([0, 1, 2, 3].map((index) => data.at(index).t), [20.125, 20.125, 40, 200]);
  assert.equal(data.at(0).x, .12345678901234568); assert.equal(data.at(0).k, 1); assert.equal(data.at(1).k, 3);
  assert.equal(data.lowerBound(20.125), 0); assert.equal(data.lowerBound(20.126), 2);
  const partial = session(t, [record(0, 1)], { complete: false });
  await assert.rejects(loadReplayData(partial.path), /complete session/);
  await assert.rejects(loadReplayData(path, { maxEvents: 3 }), /event limit/);
});

test('default-route guard refuses active or unverifiable Engine output without probing custom test ports', async (t) => {
  let state = { paused: false, udpHost: '127.0.0.1', udpPort: 6061 }; let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return { ok: true, json: async () => state }; });
  await assert.rejects(ensureVenueOutputPaused({ host: '127.0.0.1', port: 6061 }), /still sending/);
  state.paused = true; await ensureVenueOutputPaused({ host: '127.0.0.1', port: 6061 });
  state = {}; await assert.rejects(ensureVenueOutputPaused({ host: '127.0.0.1', port: 6061 }), /could not be verified/);
  const before = calls; await ensureVenueOutputPaused({ host: '127.0.0.1', port: 12345 }); assert.equal(calls, before);
});

test('transport schedules source time, releases on pause, restores held XY on seek/resume and obeys speed', async (t) => {
  const { path, file } = session(t, [record(200, 2), record(40, 3, { x: .6, y: .7 }), record(0, 1), record(120, 3, { x: .8, y: .9 })]);
  const h = harness(); t.after(() => h.transport.close());
  assert.equal((await h.transport.load(path, file)).state, 'READY'); assert.equal(h.sent.length, 0);
  await h.transport.seek(0); assert.equal(h.sent.length, 0, 'silent preparation never emits UDP');
  await h.transport.play({ destination: { host: '127.0.0.1', port: 12345 } });
  await h.advance(0); assert.equal(h.sent[0].messages.at(-1).value, 1);
  await h.advance(39); assert.equal(h.sent.length, 1, 'future movement cannot be sent early');
  await h.advance(40); assert.equal(h.sent[1].messages[0].value, Math.fround(.6));
  await h.advance(60); await h.transport.pause();
  assert.equal(h.sent.at(-1).messages[0].value, 0); assert.equal(h.transport.status().activeVoices, 0);
  const pausedCount = h.sent.length; await h.transport.seek(100); assert.equal(h.sent.length, pausedCount);
  await h.transport.play();
  assert.deepEqual(h.sent.at(-1).messages.map((message) => message.value), [Math.fround(.6), Math.fround(.7), 1]);
  await h.transport.setSpeed(2); await h.advance(70);
  assert.equal(h.sent.at(-1).time, 70); assert.equal(h.sent.at(-1).messages[0].value, Math.fround(.8));
  await h.transport.seek(50);
  assert.deepEqual(h.sent.at(-1).messages.map((message) => message.value), [Math.fround(.6), Math.fround(.7), 1]);
  await h.transport.stop(); const stopped = h.sent.length;
  await h.advance(2000); assert.equal(h.sent.length, stopped); assert.equal(h.transport.status().state, 'READY');
  assert.equal(h.transport.status().positionMs, 0); assert.equal(h.transport.status().activeVoices, 0);
});

test('natural completion and disconnect release only replay-owned active voices', async (t) => {
  const { path, file } = session(t, [record(0, 2, { s: 99 }), record(0, 1), record(20, 1, { f: 1 }), record(40, 5, { f: null }), record(60, 1, { s: 2 })], { durationMs: 100 });
  const h = harness(); t.after(() => h.transport.close()); await h.transport.load(path, file);
  await h.transport.play({ destination: { host: '127.0.0.1', port: 12345 } });
  for (const time of [0, 20, 40, 60, 100]) await h.advance(time);
  assert.equal(h.transport.status().state, 'COMPLETE'); assert.equal(h.transport.status().activeVoices, 0);
  const messages = h.sent.flatMap((frame) => frame.messages);
  assert.equal(messages.some((message) => message.address.includes('/99/')), false, 'orphaned note-off cannot touch another sender');
  const offs = messages.filter((message) => message.address.endsWith('/on') && message.value === 0);
  assert.deepEqual(offs.map((message) => message.address), ['/cs/A/1/finger0/on', '/cs/A/1/finger1/on', '/cs/A/2/finger0/on']);
});

test('real ephemeral UDP receiver gets binary OSC and loading does not send', async (t) => {
  const socket = createSocket('udp4'); const received = [];
  await new Promise((resolve) => socket.bind(0, '127.0.0.1', resolve));
  t.after(() => socket.close()); socket.on('message', (packet) => received.push(...decode(packet)));
  const { path, file } = session(t, [record(0, 1)]);
  const replay = createUdpReplay(); t.after(() => replay.close());
  await replay.load(path, file); await new Promise((resolve) => setTimeout(resolve, 20)); assert.equal(received.length, 0);
  await replay.play({ destination: { host: '127.0.0.1', port: socket.address().port } });
  for (let i = 0; i < 100 && received.length < 3; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(received.length, 3); assert.equal(received[2].value, 1);
  await replay.stop();
  for (let i = 0; i < 100 && received.length < 4; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(received.at(-1).address, '/cs/A/1/finger0/on'); assert.equal(received.at(-1).value, 0);
});

test('HTTP API requires explicit play, excludes recording and rejects nonlocal origins', async (t) => {
  const { dir, file } = session(t, [record(0, 1)]);
  let packets = 0;
  const server = createControlServer({ sessionsDir: dir, sourceFactory: () => { throw new Error('must not capture'); },
    replayOptions: { sender: { send: async (buffers) => { packets += buffers.length; }, close() {} }, guardDestination: async () => {} } });
  await server.listen(0); t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port()}`;
  const post = (path, body = {}) => fetch(`${base}/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await (await fetch(`${base}/api/replay/status`)).json()).state, 'EMPTY');
  assert.equal((await post('replay/load', { file })).status, 200); assert.equal(packets, 0);
  await post('arm'); assert.equal((await post('replay/play')).status, 409); assert.equal(packets, 0);
  await post('arm'); assert.equal((await post('replay/play', { destination: { host: '127.0.0.1', port: 12345 } })).status, 200);
  assert.equal((await post('arm')).status, 409);
  assert.equal((await post('replay/stop')).status, 200);
  const foreign = await fetch(`${base}/api/replay/play`, { method: 'POST', headers: { Origin: 'https://unrelated.example', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(foreign.status, 403);
  assert.equal((await post('replay/load', { file: '../outside.jsonl' })).status, 409);
  assert.equal((await post('arm')).status, 200);
});

test('pending route verification reserves the replay/capture mutex before any output', async (t) => {
  const { dir, file } = session(t, [record(0, 1)]);
  let releaseGuard;
  const server = createControlServer({ sessionsDir: dir, sourceFactory: () => { throw new Error('must not capture'); }, replayOptions: {
    sender: { send: async () => {}, close() {} }, guardDestination: () => new Promise((resolve) => { releaseGuard = resolve; }),
  } });
  await server.listen(0); t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port()}`;
  const post = (path, body = {}) => fetch(`${base}/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  await post('replay/load', { file }); const playing = post('replay/play');
  for (let i = 0; i < 100 && !releaseGuard; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(releaseGuard); assert.equal((await post('arm')).status, 409);
  releaseGuard(); assert.equal((await playing).status, 200); await post('replay/stop');
});

test('STOP cancels a pending start before route verification can emit any voice', async (t) => {
  const { path, file } = session(t, [record(0, 1)]);
  let releaseGuard; let packets = 0;
  const replay = createUdpReplay({ sender: { send: async (buffers) => { packets += buffers.length; }, close() {} },
    guardDestination: () => new Promise((resolve) => { releaseGuard = resolve; }) });
  t.after(() => replay.close()); await replay.load(path, file);
  const playing = replay.play(); const canceled = assert.rejects(playing, /canceled/);
  for (let i = 0; i < 100 && !releaseGuard; i++) await new Promise(setImmediate);
  assert.ok(releaseGuard); const stopping = replay.stop(); releaseGuard();
  await canceled; await stopping;
  assert.equal(packets, 0); assert.equal(replay.status().state, 'READY'); assert.equal(replay.status().activeVoices, 0);
});

test('a UDP send failure stops scheduling and releases every potentially sounding replay voice', async (t) => {
  const { path, file } = session(t, [record(0, 1), record(40, 2)]);
  const h = harness({ failSend: 2 }); t.after(() => h.transport.close());
  await h.transport.load(path, file); await h.transport.play({ destination: { host: '127.0.0.1', port: 12345 } });
  await h.advance(0); assert.equal(h.transport.status().activeVoices, 1);
  await h.advance(40);
  assert.equal(h.transport.status().state, 'ERROR'); assert.match(h.transport.status().error, /send failure/);
  assert.equal(h.transport.status().activeVoices, 0);
  assert.deepEqual(h.sent.at(-1).messages, [{ address: '/cs/A/1/finger0/on', type: 'i', value: 0 }], 'failed recorded release is retried by scoped cleanup');
  const count = h.sent.length; await h.advance(2000); assert.equal(h.sent.length, count);
});
