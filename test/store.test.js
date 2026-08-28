// test/store.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store.js';

function ev(pid, ts, type = 'fingerMove') {
  const zone = pid[0]; const seatNumber = Number(pid.slice(1));
  return { participantId: pid, zone, seatNumber, serverTimestampMs: ts, eventType: type, raw: {} };
}

test('appends and indexes by participant', () => {
  const st = createStore();
  st.append(ev('A1', 100), 0, 0);
  st.append(ev('B2', 105), 5, 1);
  st.append(ev('A1', 110), 10, 2);
  assert.equal(st.size(), 3);
  assert.equal(st.participantCount(), 2);
  const a1 = st.eventsOf('A1');
  assert.equal(a1.length, 2);
  assert.deepEqual(a1.map((e) => e.seq), [0, 2]);
  assert.deepEqual(a1.map((e) => e.tMs), [0, 10]);
  assert.equal(a1[0].raw, undefined); // store keeps normalized only — raw lives on disk
  assert.deepEqual(st.eventsOf('Z9'), []);
});

test('participant metadata accumulates', () => {
  const st = createStore();
  st.append(ev('A1', 100, 'noteOn'), 0, 0);
  st.append(ev('A1', 200, 'fingerMove'), 100, 1);
  const p = st.participants().get('A1');
  assert.equal(p.zone, 'A');
  assert.equal(p.seatNumber, 1);
  assert.equal(p.eventCount, 2);
  assert.equal(p.firstTMs, 0);
  assert.equal(p.lastTMs, 100);
  assert.deepEqual(p.byType, { noteOn: 1, fingerMove: 1 });
});
