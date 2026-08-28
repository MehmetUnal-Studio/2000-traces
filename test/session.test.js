// test/session.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession } from '../src/session.js';

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
