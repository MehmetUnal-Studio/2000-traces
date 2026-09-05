import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLiveFlowEnergy, createPackFlowEnergy } from '../viz/src/flow-energy.js';
import { EVENT_RECORD_BYTES, GESTURE_RECORD_BYTES, TYPE } from '../viz/src/pack-loader.js';

function pack(records, { exact = true, durationMs = 20000 } = {}) {
  const events = new DataView(new ArrayBuffer(records.length * EVENT_RECORD_BYTES));
  const gestures = exact ? new DataView(new ArrayBuffer(records.length * GESTURE_RECORD_BYTES)) : null;
  records.forEach(([time, kind], i) => {
    events.setUint32(i * EVENT_RECORD_BYTES + 6, Math.round(time), true);
    events.setUint8(i * EVENT_RECORD_BYTES + 10, kind);
    gestures?.setFloat64(i * GESTURE_RECORD_BYTES, time, true);
  });
  return { manifest: { eventCount: records.length, durationMs, ...(exact ? { gestures: {} } : {}) }, events, gestures };
}

function close(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) <= Math.max(1, Math.abs(expected)) * 1e-12, `${message ?? 'value'}: ${actual} != ${expected}`);
}

test('live and archive share the causal rate at fractional times and arbitrary replay seeks', () => {
  const records = [[1600.75, TYPE.move], [100.125, TYPE.noteOn], [700.5, TYPE.move], [700.5, TYPE.move], [900, TYPE.disconnect], [1200, TYPE.noteOff], [19000, TYPE.move]];
  const archive = createPackFlowEnergy(pack(records));
  const causal = records.filter(([, kind]) => kind === TYPE.move || kind === TYPE.noteOn).sort((a, b) => a[0] - b[0]);
  for (const time of [0, 100.124, 100.125, 701, 2000, 19001, 701, 100.125, 0, 2000]) {
    const live = createLiveFlowEnergy();
    for (const [t, kind] of causal) if (t <= time) live.ingest(t, kind);
    const a = archive.sample(time); const b = live.sample(time);
    assert.deepEqual(a, b, 'same recorded events produce identical live and archive response');
    const expected = causal.filter(([t]) => t <= time).reduce((sum, [t]) => sum + Math.exp(-(time - t) / 1000), 0);
    close(a.rate, expected, 'independent causal sum excludes future events');
    close(a.energy, Math.min(1, Math.log1p(expected / 5) / Math.log1p(20000 / 5)));
  }
});

test('flow rejects malformed inputs and lifecycle frames, then decays without new input', () => {
  const live = createLiveFlowEnergy();
  for (const kind of [TYPE.keepalive, TYPE.progress, TYPE.noteOff, TYPE.disconnect, -1, 'snapshot', undefined]) assert.equal(live.ingest(1000, kind), false);
  for (const time of [NaN, Infinity, -1, '1000', null]) assert.equal(live.ingest(time, TYPE.move), false);
  assert.deepEqual(live.sample(1000), { rate: 0, energy: 0, eventCount: 0, lastEventTime: null });
  assert.equal(live.ingest(1000, TYPE.move), true);
  const first = live.sample(1000);
  live.ingest(2000, TYPE.disconnect);
  close(live.sample(2000).rate, first.rate / Math.E);
  assert.ok(live.sample(11000).energy < first.energy / 10000);
  assert.equal(live.sample(11000).eventCount, 1);
  assert.deepEqual(live.sample(1000), first, 'sampling does not mutate envelope state');
  assert.throws(() => live.sample(999), /cannot seek/);
  live.reset();
  assert.equal(live.sample(0).energy, 0);
  for (const options of [{ tauMs: 0 }, { tauMs: NaN }, { referenceRate: Infinity }, { referenceRate: -1 }]) assert.throws(() => createLiveFlowEnergy(options), RangeError);
  assert.throws(() => live.sample(NaN), RangeError);
});

test('late live arrivals retain their source age and match a chronological archive', () => {
  const records = [[1200, TYPE.move], [100.5, TYPE.noteOn], [1000.25, TYPE.move], [1200, TYPE.move]];
  const live = createLiveFlowEnergy();
  for (const [time, kind] of records) live.ingest(time, kind);
  const archive = createPackFlowEnergy(pack(records));
  for (const time of [1200, 2000, 9000]) {
    close(live.sample(time).rate, archive.sample(time).rate);
    close(live.sample(time).energy, archive.sample(time).energy);
    assert.equal(live.sample(time).eventCount, archive.sample(time).eventCount);
  }
});

test('increasing observed rate remains visibly distinct from one phone through a large ensemble', () => {
  function measure(rate) {
    const live = createLiveFlowEnergy();
    for (let i = 0; i < rate * 10; i++) live.ingest(i * 1000 / rate, TYPE.move);
    const sample = live.sample(10000);
    assert.equal(sample.eventCount, rate * 10);
    assert.ok(Number.isFinite(sample.rate));
    return sample;
  }
  const one = measure(20); const small = measure(4000); const large = measure(20000);
  assert.ok(one.energy > 0.1 && one.energy < small.energy);
  assert.ok(large.rate > small.rate * 4.9);
  assert.ok(large.energy > small.energy + 0.15, '260-to-1300-scale flow does not saturate at the lower rate');
  assert.ok(large.energy <= 1);
});

test('legacy timestamp fallback and malformed precise records preserve an honest activity count', () => {
  const legacy = createPackFlowEnergy(pack([[20, TYPE.noteOn], [100, TYPE.move]], { exact: false }));
  assert.equal(legacy.sample(19).eventCount, 0);
  assert.equal(legacy.sample(100).eventCount, 2);
  const invalid = createPackFlowEnergy(pack([[NaN, TYPE.move], [Infinity, TYPE.noteOn], [-1, TYPE.move], [20001, TYPE.move], [15.5, TYPE.noteOn], [10, TYPE.noteOff]]));
  assert.equal(invalid.eventCount, 1);
  assert.equal(invalid.sample(15.49).eventCount, 0);
  assert.equal(invalid.sample(15.5).lastEventTime, 15.5);
  assert.throws(() => createPackFlowEnergy({ ...pack([]), gestures: null }), /sidecar is missing/);
});
