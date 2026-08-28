import { test } from 'node:test';
import assert from 'node:assert/strict';
import { headerLine, eventLine, endLine, importSession } from '../src/jsonl.js';

test('lines are single-line JSON with kinds', () => {
  const h = JSON.parse(headerLine({ sessionId: 's1', durationMs: 90000, visualSeed: 3, schemaVersion: 1 }, 'file:capture.raw'));
  assert.equal(h.kind, 'session');
  assert.equal(h.source, 'file:capture.raw');
  const rec = { seq: 0, tMs: 12, participantId: 'A1', zone: 'A', seatNumber: 1, serverTimestampMs: 100, eventType: 'noteOn', finger: 0, line: 2, u: 0.5, v: 0.5, arrivalMs: 55 };
  const e = JSON.parse(eventLine(rec, { t: 1, z: 0, s: 1, ts: 100 }));
  assert.equal(e.kind, 'event');
  assert.equal(e.raw.ts, 100);
  assert.equal(e.tMs, 12);
  const end = JSON.parse(endLine({ stats: { stored: 1 }, participants: 1, events: 1, anchorServerMs: 100, endedAtLocalMs: 999 }));
  assert.equal(end.kind, 'end');
});

test('import round-trips header, events, end', () => {
  const lines = [
    headerLine({ sessionId: 's1', durationMs: 90000, visualSeed: 3, schemaVersion: 1 }, 'test'),
    eventLine({ seq: 0, tMs: 0, participantId: 'A1', zone: 'A', seatNumber: 1, serverTimestampMs: 100, eventType: 'noteOn' }, { t: 1 }),
    eventLine({ seq: 1, tMs: 9, participantId: 'B2', zone: 'B', seatNumber: 2, serverTimestampMs: 109, eventType: 'fingerMove' }, { t: 3 }),
    endLine({ stats: { stored: 2 }, participants: 2, events: 2, anchorServerMs: 100, endedAtLocalMs: 1 }),
  ];
  const s = importSession(lines);
  assert.equal(s.meta.sessionId, 's1');
  assert.equal(s.events.length, 2);
  assert.equal(s.events[1].participantId, 'B2');
  assert.equal(s.end.participants, 2);
  assert.equal(s.complete, true);
});

test('import of a partial file (no end line) is valid and flagged', () => {
  const s = importSession([
    headerLine({ sessionId: 's1', durationMs: 90000, visualSeed: 3, schemaVersion: 1 }, 'test'),
    eventLine({ seq: 0, tMs: 0, participantId: 'A1', zone: 'A', seatNumber: 1, serverTimestampMs: 100, eventType: 'noteOn' }, { t: 1 }),
  ]);
  assert.equal(s.complete, false);
  assert.equal(s.events.length, 1);
});

test('import rejects files that do not start with a session header', () => {
  assert.throws(() => importSession(['{"kind":"event"}']));
});
