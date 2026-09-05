// test/session.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession, sanitizeLabel } from '../src/session.js';

const NOTE = (z, s, ts, extra = {}) => ({ t: 1, z, s, l: 1, f: 0, uu: 0.5, vv: 0.5, ts, ...extra });

test('state machine transitions', () => {
  const ss = createSession({ visualSeed: 7, sessionId: 'test-1' });
  assert.equal(ss.state(), 'IDLE');
  ss.arm();
  assert.equal(ss.state(), 'ARMED');
  ss.start();
  assert.equal(ss.state(), 'RECORDING');
  ss.stop();
  assert.equal(ss.state(), 'FINALIZING');
  const done = ss.finalize();
  assert.equal(ss.state(), 'COMPLETE');
  assert.equal(done.sessionId, 'test-1');
  assert.equal(done.visualSeed, 7);
  assert.throws(() => ss.start());
});

test('meta() carries the sanitized label, default empty', () => {
  const noLabel = createSession({ visualSeed: 1, sessionId: 'no-label' });
  assert.equal(noLabel.meta().label, '');

  const ss = createSession({ visualSeed: 1, sessionId: 'labeled', label: 'prova 1' });
  assert.equal(ss.meta().label, 'prova 1');
});

test('sanitizeLabel strips to [\\p{L}\\p{N} _-], caps at 40 chars, allows empty', () => {
  assert.equal(sanitizeLabel('prova 1'), 'prova 1');
  assert.equal(sanitizeLabel(''), '');
  assert.equal(sanitizeLabel(undefined), '');
  assert.equal(sanitizeLabel('<script>x'), 'scriptx');
  assert.equal(sanitizeLabel('İstanbul_gösteri-1'), 'İstanbul_gösteri-1'); // unicode letters kept
  const long = 'a'.repeat(200);
  assert.equal(sanitizeLabel(long), 'a'.repeat(40));
});

test('ingest anchors tMs to first stored event and stores in arrival order', () => {
  const ss = createSession({ sessionId: 't', visualSeed: 1 });
  ss.arm(); ss.start();
  assert.deepEqual(ss.ingest(NOTE(0, 1, 1000), 5), { accepted: true, seq: 0, tMs: 0 });
  assert.deepEqual(ss.ingest(NOTE(0, 2, 1250), 6), { accepted: true, seq: 1, tMs: 250 });
  assert.equal(ss.stats().stored, 2);
  assert.equal(ss.store.eventsOf('A1')[0].tMs, 0);
});

test('events outside RECORDING are counted, not stored', () => {
  const ss = createSession({ sessionId: 't', visualSeed: 1 });
  assert.equal(ss.ingest(NOTE(0, 1, 1000), 0).accepted, false); // IDLE
  ss.arm();
  ss.ingest(NOTE(0, 1, 1001), 0);                               // ARMED
  assert.equal(ss.stats().ignored, 2);
  ss.start();
  ss.ingest(NOTE(0, 1, 1002), 0);
  ss.stop();
  assert.equal(ss.ingest(NOTE(0, 1, 1003), 0).accepted, false); // FINALIZING
  assert.equal(ss.stats().late, 1);
  assert.equal(ss.stats().stored, 1);
});

test('events past durationMs are late; malformed and duplicates are counted', () => {
  const ss = createSession({ sessionId: 't', visualSeed: 1, durationMs: 90000 });
  ss.arm(); ss.start();
  ss.ingest(NOTE(0, 1, 1000), 0);
  assert.equal(ss.ingest(NOTE(0, 1, 92000), 1).accepted, false);      // tMs 91000 > 90000
  assert.equal(ss.stats().late, 1);
  assert.equal(ss.ingest({ garbage: true }, 2).accepted, false);
  assert.equal(ss.stats().malformed, 1);
  ss.ingest(NOTE(0, 1, 1500), 3);
  assert.equal(ss.ingest(NOTE(0, 1, 1500), 4).accepted, false);       // exact dup of previous
  assert.equal(ss.stats().duplicates, 1);
  assert.equal(ss.stats().received, 5);
  assert.equal(ss.stats().stored, 2);
});

test('new sessions accept the full three-minute boundary and finalize with its duration', () => {
  let clock = 5000;
  const ss = createSession({ sessionId: 'three-minutes', visualSeed: 1, now: () => clock });
  assert.equal(ss.meta().durationMs, 180000);
  ss.arm(); ss.start();
  assert.equal(ss.ingest(NOTE(0, 1, 1000), 0).accepted, true);
  assert.equal(ss.ingest(NOTE(0, 1, 91001), 90001).accepted, true, 'new recordings continue beyond the historical 90 s window');
  assert.equal(ss.ingest(NOTE(0, 1, 181000), 180000).accepted, true, 'the exact event-time boundary is included');
  assert.deepEqual(ss.ingest(NOTE(0, 1, 181001), 180001), { accepted: false, reason: 'past-duration' });
  clock += 180000;
  ss.stop();
  assert.deepEqual(ss.ingest(NOTE(0, 1, 181000), 180002), { accepted: false, reason: 'after-stop' });
  const done = ss.finalize();
  assert.equal(ss.state(), 'COMPLETE');
  assert.equal(done.durationMs, 180000);
  assert.equal(done.endedAtLocalMs - done.startedAtLocalMs, 180000);
  assert.equal(done.events, 3);
  assert.equal(done.stats.late, 2);
});

test('events whose ts precedes the anchor are rejected and counted early', () => {
  const ss = createSession({ sessionId: 't', visualSeed: 1 });
  ss.arm(); ss.start();
  assert.equal(ss.stats().early, 0); // counter exists from init
  assert.equal(ss.ingest(NOTE(0, 1, 1000000), 0).accepted, true); // anchors the clock
  // another upstream shard stamped 1 ms before the anchor: tMs would be -1
  const r = ss.ingest(NOTE(0, 2, 999999), 1);
  assert.deepEqual(r, { accepted: false, reason: 'before-anchor' });
  assert.equal(ss.stats().early, 1);
  assert.equal(ss.stats().stored, 1);
  // stats invariant with the new counter
  const st = ss.stats();
  assert.equal(st.stored + st.malformed + st.duplicates + st.late + st.early, st.received);
  ss.stop();
  const done = ss.finalize();
  assert.equal(done.stats.early, 1, 'early reaches the finalize/endLine summary');
});

test('snapshot frames are silently skipped (not counted malformed)', () => {
  const ss = createSession({ sessionId: 't', visualSeed: 1 });
  ss.arm(); ss.start();
  assert.equal(ss.ingest({ type: 'snapshot', zones: {} }, 0).accepted, false);
  assert.equal(ss.stats().malformed, 0);
  assert.equal(ss.stats().received, 0);
});
