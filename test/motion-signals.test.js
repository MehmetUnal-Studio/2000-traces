import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLiveMotionSignals, createPackMotionSignals } from '../viz/src/motion-signals.js';
import { EVENT_RECORD_BYTES, GESTURE_RECORD_BYTES, TYPE } from '../viz/src/pack-loader.js';

function record(t, x, y, extra = {}) { return { lane: 0, finger: 0, kind: TYPE.move, t, x, y, ...extra }; }
function pack(records, { exact = true, durationMs = 20000 } = {}) {
  const events = new DataView(new ArrayBuffer(records.length * EVENT_RECORD_BYTES));
  const gestures = exact ? new DataView(new ArrayBuffer(records.length * GESTURE_RECORD_BYTES)) : null;
  records.forEach((event, index) => {
    const base = index * EVENT_RECORD_BYTES;
    events.setUint16(base, event.lane ?? 0, true);
    events.setUint16(base + 2, Math.round((event.x ?? 0) * 65535), true);
    events.setUint16(base + 4, Math.round((event.y ?? 0) * 65535), true);
    events.setUint32(base + 6, event.t, true);
    events.setUint8(base + 10, event.kind);
    if (gestures) for (const [offset, value] of [[0, event.t], [8, event.x], [16, event.y], [24, event.finger]]) {
      gestures.setFloat64(index * GESTURE_RECORD_BYTES + offset, value ?? NaN, true);
    }
  });
  return { manifest: { eventCount: records.length, laneCount: 3, durationMs, ...(exact ? { gestures: {} } : {}) }, events, gestures };
}
function close(actual, expected, tolerance = 1e-12) {
  assert.ok(Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)), `${actual} != ${expected}`);
}
function closeState(actual, expected) {
  assert.deepEqual(Object.keys(actual), Object.keys(expected));
  for (const key of Object.keys(actual)) close(actual[key], expected[key]);
}
function path(hz, seconds = 4, { lane = 0, finger = 0, reverse = false, circular = false } = {}) {
  return Array.from({ length: hz * seconds + 1 }, (_, index) => {
    const phase = index / (hz * seconds);
    const x = circular ? .5 + .2 * Math.cos(phase * Math.PI * 2) : reverse ? .9 - .8 * phase : .1 + .8 * phase;
    const y = circular ? .5 + .2 * Math.sin(phase * Math.PI * 2) : .5;
    return record(index * 1000 / hz, x, y, { lane, finger, kind: index ? TYPE.move : TYPE.noteOn });
  });
}

test('motion measures both axes in screen units/second and decays without inventing input', () => {
  const live = createLiveMotionSignals();
  assert.equal(live.ingest(record(0, .1, .2, { kind: 'noteOn' })).valid, false);
  const diagonal = live.ingest(record(500, .4, .6));
  assert.equal(diagonal.valid, true);
  close(diagonal.speed, 1); close(diagonal.directionX, .6); close(diagonal.directionY, .8);
  close(diagonal.turn, 0); close(diagonal.energy, 1 - Math.exp(-500 / 800));
  const current = live.sample(500); const later = live.sample(2100);
  close(later.energy, current.energy * Math.exp(-2));
  close(later.speed, current.speed * Math.exp(-2));
  close(later.active, current.active * Math.exp(-2));
  assert.deepEqual(live.sample(500), current, 'sample is read-only');
  assert.throws(() => live.sample(499), /cannot seek/);
  assert.equal(live.sample(30000).coherence, 0);
  live.reset();
  assert.equal(live.sample(0).energy, 0); assert.equal(live.stats().trackedFingers, 0);
});

test('straight and curved paths retain their character at 30/60 Hz', () => {
  for (const circular of [false, true]) {
    const states = [];
    for (const hz of [30, 60]) {
      const live = createLiveMotionSignals(); let measured;
      for (const event of path(hz, 4, { circular })) measured = live.ingest(event);
      states.push(live.sample(4000));
      close(measured.speed, circular ? Math.PI * .1 : .2, circular ? .0001 : 1e-12);
      close(measured.turn, circular ? Math.PI / 2 : 0, 1e-10);
      assert.ok(measured.speed01 > 0 && measured.speed01 <= 1);
    }
    for (const key of ['speed', 'turn', 'coherence', 'energy', 'active']) close(states[0][key], states[1][key], .008);
  }
});

test('collective direction gives equal time-weighted votes to differently sampled fingers', () => {
  function ensemble(reverse) {
    const live = createLiveMotionSignals();
    const events = [...path(30, 4, { finger: 0 }), ...path(60, 4, { finger: 1, reverse })].sort((a, b) => a.t - b.t);
    for (const event of events) live.ingest(event);
    return live.sample(4000);
  }
  const aligned = ensemble(false); const opposing = ensemble(true);
  close(aligned.coherence, 1);
  assert.ok(opposing.coherence < 1e-12, 'a 60 Hz opposite finger must not dominate a 30 Hz finger');
  close(opposing.energy, aligned.energy);
  close(aligned.active, 2 * (1 - Math.exp(-5)));
  assert.equal(aligned.trackedFingers, 2);
});

test('release, restart, missing fields, zero dt and long gaps never manufacture a velocity', () => {
  const live = createLiveMotionSignals();
  live.ingest(record(0, 0, 0));
  assert.equal(live.ingest(record(100, .1, 0)).valid, true);
  for (const interruption of [
    record(200, null, null, { kind: TYPE.noteOff }),
    record(500, .9, .9, { kind: TYPE.noteOn }),
    record(800, null, .5),
    record(1100, .5, null),
    record(1400, null, null, { kind: TYPE.disconnect }),
  ]) {
    assert.equal(live.ingest(interruption).valid, false);
    const start = live.ingest(record(interruption.t + 100, .2, .2));
    // A noteOn is a new anchor, unlike a noteOff/missing position.
    assert.equal(start.valid, interruption.kind === TYPE.noteOn);
    assert.equal(live.ingest(record(interruption.t + 200, .3, .2)).valid, true);
  }
  assert.equal(live.ingest(record(1600, .9, .9)).valid, false, 'equal time is a discontinuity');
  assert.equal(live.ingest(record(1700, .8, .8)).valid, false, 'equal-time discontinuity clears the anchor');
  assert.equal(live.ingest(record(1800, .7, .8)).valid, true);
  assert.equal(live.ingest(record(3101, 0, 0)).valid, false, 'gap over 1200 ms starts a new anchor');
  assert.equal(live.ingest(record(3201, .1, 0)).valid, true);
  const stationary = live.ingest(record(3301, .1, 0));
  assert.equal(stationary.valid, true); assert.equal(stationary.speed, 0); assert.equal(stationary.turn, 0);
  assert.equal(stationary.directionX, 0); assert.equal(stationary.directionY, 0);
  assert.equal(live.ingest(record(3401, .2, .2, { finger: null })).valid, false);
  assert.equal(live.ingest(record(3501, .2, .2, { finger: 1.5 })).valid, false);
});

test('global arrival reordering retains separate fingers, while late same-finger input resets only', () => {
  const records = [record(0, 0, 0), record(0, 0, 0, { finger: 1 }), record(500, .5, 0),
    record(100, 0, .1, { finger: 1 }), record(600, 0, .6, { finger: 1 })];
  const arrival = createLiveMotionSignals();
  for (const event of records) arrival.ingest(event);
  const ordered = createLiveMotionSignals();
  for (const event of [...records].sort((a, b) => a.t - b.t)) ordered.ingest(event);
  closeState(arrival.sample(600), ordered.sample(600));
  assert.equal(arrival.ingest(record(400, .9, .9)).valid, false);
  assert.equal(arrival.ingest(record(550, .1, .1)).valid, false, 'late input does not become a derivative anchor');
  close(arrival.ingest(record(650, .2, .1)).speed, 1);
});

test('archive attributes follow original indices; arbitrary seeks exactly match causal chronological live input', () => {
  const records = [record(800.25, .3, .4), record(0, 0, 0, { kind: TYPE.noteOn }),
    record(300.125, .3, 0), record(900, null, null, { kind: TYPE.noteOff }),
    record(300.125, .2, .1, { lane: 1, finger: 3, kind: TYPE.noteOn }),
    record(400.5, .2, .2, { lane: 1, finger: 3 }), record(1000, null, null, { kind: TYPE.keepalive }),
    record(1200.75, .2, .2), record(1300.5, .25, .2), record(1300.5, .3, .2),
    record(1500, .4, .2), record(1600, .5, .2)];
  const data = pack(records); const before = Buffer.from(data.events.buffer).toString('hex');
  const archive = createPackMotionSignals(data);
  const sorted = records.map((event, index) => ({ ...event, index })).sort((a, b) => a.t - b.t || a.index - b.index);
  const original = createLiveMotionSignals();
  for (const event of sorted) {
    const result = original.ingest(event);
    assert.equal(archive.attributes.valid[event.index], Number(result.valid));
    if (result.valid) for (const key of Object.keys(archive.attributes).filter((key) => key !== 'valid')) assert.equal(archive.attributes[key][event.index], Math.fround(result[key]));
  }
  for (const t of [0, 300, 300.125, 800.25, 1000.5, 1300.5, 1700, 4000, 0, 800.25]) {
    const live = createLiveMotionSignals();
    for (const event of sorted) if (event.t <= t) live.ingest(event);
    assert.deepEqual(archive.sample(t), live.sample(t), 'Float64 prefixes preserve the same causal arithmetic');
    assert.deepEqual(archive.seek(t), archive.sample(t));
  }
  assert.equal(Buffer.from(data.events.buffer).toString('hex'), before);
  assert.equal(archive.eventCount, records.length);
});

test('invalid/legacy data stays neutral; malformed configuration is rejected', () => {
  const events = [record(0, .1, .1), record(100, .3, .2), record(200, .5, .4)];
  const legacy = createPackMotionSignals(pack(events, { exact: false }));
  assert.equal(legacy.attributes.valid.reduce((sum, value) => sum + value, 0), 0);
  assert.equal(legacy.sample(500).energy, 0); assert.equal(legacy.sample(500).trackedFingers, 0);
  const invalid = createLiveMotionSignals();
  for (const extra of [{ t: NaN }, { t: -1 }, { lane: -1 }, { lane: 65536 }, { kind: TYPE.keepalive }, { x: Infinity }, { y: -1 }, { finger: null }]) {
    assert.equal(invalid.ingest(record(0, .2, .2, extra)).valid, false);
  }
  assert.equal(invalid.sample(0).energy, 0);
  for (const options of [{ tauMs: 0 }, { gapMs: NaN }, { referenceSpeed: -1 }, { referenceTurnRate: Infinity }, { maxFingersPerLane: 17 }, { maxLanes: 0 }]) {
    assert.throws(() => createLiveMotionSignals(options), RangeError);
    assert.throws(() => createPackMotionSignals(pack([]), options), RangeError);
  }
  assert.throws(() => invalid.sample(NaN), RangeError);
  assert.throws(() => createPackMotionSignals({ ...pack([]), gestures: null }), /sidecar is missing/);
  const outOfRange = createPackMotionSignals(pack([record(NaN, .1, .1), record(-10, .2, .2), record(20001, .3, .3)]));
  assert.equal(outOfRange.sample(30000).energy, 0);
});

test('live identity storage is bounded and evicted identities restart without synthetic links', () => {
  const live = createLiveMotionSignals({ maxLanes: 2, maxFingersPerLane: 16 });
  for (let lane = 0; lane < 100; lane++) for (let finger = 0; finger < 100; finger++) {
    live.ingest(record(lane * 1000 + finger * 2, .1, .2, { lane, finger }));
    live.ingest(record(lane * 1000 + finger * 2 + 1, .2, .2, { lane, finger }));
    assert.ok(live.stats().trackedFingers <= 32); assert.ok(live.stats().trackedLanes <= 2);
  }
  assert.equal(live.stats().trackedFingers, 32); assert.equal(live.stats().evictedFingers, 9968);
  assert.equal(live.ingest(record(100000, .9, .9, { lane: 0, finger: 0 })).valid, false);
  const result = live.sample(100000);
  for (const value of Object.values(result)) assert.ok(Number.isFinite(value));
});

test('large archives retain linear typed-array storage and bounded seek work', () => {
  const count = 120000;
  const records = Array.from({ length: count }, (_, index) => {
    const lane = index % 120; const step = Math.floor(index / 120);
    return record(step * 16.5, .5 + .3 * Math.sin(step / 20), .5 + .3 * Math.cos(step / 20), { lane, finger: 0 });
  });
  const archive = createPackMotionSignals(pack(records));
  assert.equal(archive.eventCount, count);
  assert.equal(archive.attributes.valid.reduce((sum, value) => sum + value, 0), count - 120);
  assert.ok(archive.byteLength <= count * 89);
  for (const t of [14000, 400, 16000, 0, 400]) {
    for (const value of Object.values(archive.sample(t))) assert.ok(Number.isFinite(value));
  }
  assert.equal(archive.stats().trackedFingers, 120);
});
