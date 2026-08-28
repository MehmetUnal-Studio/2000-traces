// test/adapter.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEvent, participantId, zoneLetter } from '../src/adapter.js';

test('zone letters and participant ids', () => {
  assert.equal(zoneLetter(0), 'A');
  assert.equal(zoneLetter(25), 'Z');
  assert.equal(participantId(10, 5), 'K5');
});

test('normalizes a real NOTE_ON', () => {
  const raw = { t: 1, z: 0, s: 8, l: 6, f: 0, uu: 0.65, vv: 0.42, ts: 1787907718030 };
  const r = normalizeEvent(raw);
  assert.equal(r.ok, true);
  assert.equal(r.event.eventType, 'noteOn');
  assert.equal(r.event.participantId, 'A8');
  assert.equal(r.event.zone, 'A');
  assert.equal(r.event.seatNumber, 8);
  assert.equal(r.event.u, 0.65);
  assert.equal(r.event.v, 0.42);
  assert.equal(r.event.line, 6);
  assert.equal(r.event.finger, 0);
  assert.equal(r.event.serverTimestampMs, 1787907718030);
  assert.equal(r.event.raw, raw);
});

test('normalizes real NOTE_OFF / FINGER_UV / keepalive / disconnect / load progress', () => {
  assert.equal(normalizeEvent({ t: 2, z: 1, s: 10, l: 9, f: 0, ts: 1 }).event.eventType, 'noteOff');
  const uv = normalizeEvent({ t: 3, z: 19, s: 2, f: 0, uu: 0.52, vv: 0.44, ts: 2 }).event;
  assert.equal(uv.eventType, 'fingerMove');
  assert.equal(uv.line, undefined);
  assert.equal(normalizeEvent({ t: 0, z: 23, s: 6, ts: 3 }).event.eventType, 'keepalive');
  assert.equal(normalizeEvent({ t: -1, z: 23, s: 6, ts: 4 }).event.eventType, 'disconnect');
  assert.equal(normalizeEvent({ t: 4, z: 0, s: 0, p: 0.5, ts: 5 }).event.progress, 0.5);
});

test('optional future fields pp and sid are carried when present', () => {
  const r = normalizeEvent({ t: 1, z: 2, s: 42, l: 4, f: 0, uu: 0.2, vv: 0.9, sid: 'w1:9:x:1', pp: 2, ts: 6 });
  assert.equal(r.event.connectionId, 'w1:9:x:1');
  assert.equal(r.event.protocol, 2);
});

test('rejects snapshot, malformed, unknown type, out-of-range identity', () => {
  assert.deepEqual(normalizeEvent({ type: 'snapshot', zones: {} }), { ok: false, reason: 'snapshot' });
  assert.equal(normalizeEvent(null).ok, false);
  assert.equal(normalizeEvent('nope').ok, false);
  assert.equal(normalizeEvent({ t: 9, z: 0, s: 0, ts: 1 }).reason, 'unknown-type');
  assert.equal(normalizeEvent({ t: 1, z: 26, s: 0, ts: 1 }).reason, 'identity-range');
  assert.equal(normalizeEvent({ t: 1, z: 0, s: 256, ts: 1 }).reason, 'identity-range');
  assert.equal(normalizeEvent({ t: 1, z: 0, s: 0 }).reason, 'missing-core-fields');
});
