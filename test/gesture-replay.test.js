import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGestureReplay, readGesture, TYPE } from '../viz/src/gesture-replay.js';
import { EVENT_RECORD_BYTES, GESTURE_RECORD_BYTES, validateManifest } from '../viz/src/pack-loader.js';

function makePack(lanes, { exact = true, durationMs = 10000 } = {}) {
  const eventCount = lanes.reduce((sum, lane) => sum + lane.length, 0);
  const events = new DataView(new ArrayBuffer(eventCount * EVENT_RECORD_BYTES));
  const gestures = exact ? new DataView(new ArrayBuffer(eventCount * GESTURE_RECORD_BYTES)) : null;
  const participants = [];
  let offset = 0;
  lanes.forEach((records, lane) => {
    participants.push({ l: lane, o: offset, n: records.length, p: `A${lane + 1}`, z: 'A', s: lane + 1 });
    for (const record of records) {
      const index = offset++; const base = index * EVENT_RECORD_BYTES;
      events.setUint16(base, lane, true);
      events.setUint16(base + 2, Math.round((record.x ?? 0) * 65535), true);
      events.setUint16(base + 4, Math.round((record.y ?? 0) * 65535), true);
      events.setUint32(base + 6, Math.round(record.t), true);
      events.setUint8(base + 10, record.kind ?? TYPE.move);
      events.setUint8(base + 11, record.line ?? 0);
      if (gestures) {
        const g = index * GESTURE_RECORD_BYTES;
        gestures.setFloat64(g, record.t, true);
        gestures.setFloat64(g + 8, record.x ?? NaN, true);
        gestures.setFloat64(g + 16, record.y ?? NaN, true);
        gestures.setFloat64(g + 24, record.finger ?? NaN, true);
      }
    }
  });
  const manifest = { formatVersion: 1, durationMs, laneCount: lanes.length, eventCount, strokeCount: 0,
    visualSeed: 7, participants, zones: [{ zone: 'A', laneStart: 0, laneCount: lanes.length }],
    ...(exact ? { gestures: { formatVersion: 1, file: 'gestures.bin', recordBytes: 32, count: eventCount } } : {}),
  };
  validateManifest(manifest);
  return { manifest, events, strokes: new DataView(new ArrayBuffer(0)), gestures };
}

test('precise gesture access preserves X/Y, fractional time, finger and absence independently', () => {
  const x = 0.12345678901234568; const y = 0.9876543210987654;
  const pack = makePack([[{ x, y, t: 100.125, finger: 7 }, { t: 200, kind: TYPE.noteOff, finger: 7 }, { x: 0, y: 0, t: 300 }]]);
  const event = readGesture(pack, 0);
  assert.equal(event.x, x); assert.equal(event.y, y); assert.equal(event.t, 100.125);
  assert.equal(event.finger, 7); assert.equal(event.hasXY, true); assert.equal(event.exact, true);
  const missing = readGesture(pack, 1);
  assert.equal(missing.x, null); assert.equal(missing.y, null); assert.equal(missing.hasXY, false);
  const zero = readGesture(pack, 2);
  assert.equal(zero.x, 0); assert.equal(zero.y, 0); assert.equal(zero.hasXY, true);
  assert.equal(zero.finger, null); assert.equal(zero.fingerKnown, false);
  assert.throws(() => readGesture(pack, 3), /out of range/);
});

test('seek reconstructs each finger in chronological order without interpolation or future points', () => {
  const pack = makePack([[
    { finger: 3, t: 250.5, x: .9, y: .2 },
    { finger: 0, t: 100, x: .1, y: .9, kind: TYPE.noteOn },
    { finger: 3, t: 150.25, x: .3, y: .7, kind: TYPE.noteOn },
    { finger: 0, t: 200, x: .2, y: .8 },
  ]]);
  const replay = createGestureReplay(pack);
  const first = replay.seek(225, { lane: 0 });
  assert.deepEqual(first.fingers.map((f) => [f.finger, f.x, f.y, f.t]), [[0, .2, .8, 200], [3, .3, .7, 150.25]]);
  assert.deepEqual(first.fingers[0].trail.map((point) => point.t), [100, 200]);
  assert.deepEqual(first.fingers[1].trail.map((point) => point.t), [150.25]);
  assert.equal(replay.sampleLane(0, 275).fingers[1].t, 250.5);
  assert.deepEqual(replay.seek(225, { lane: 0 }), first, 'backward seek must reconstruct the same state');
  assert.deepEqual(replay.sampleLane(0, 50).fingers, []);
});

test('noteOff, disconnect, missing XY and long gaps break trails and stale markers', () => {
  const pack = makePack([[
    { finger: 1, t: 100, x: .1, y: .2, kind: TYPE.noteOn },
    { finger: 1, t: 200, x: .2, y: .3 },
    { finger: 1, t: 250, kind: TYPE.noteOff },
    { finger: 1, t: 300, x: .3, y: .4, kind: TYPE.noteOn },
    { t: 350, kind: TYPE.disconnect },
    { finger: 1, t: 400, x: .4, y: .5 },
    { finger: 1, t: 450 },
    { finger: 1, t: 500, x: .5, y: .6 },
    { finger: 1, t: 3000, x: .6, y: .7 },
  ]]);
  const replay = createGestureReplay(pack, { gapMs: 1000 });
  assert.equal(replay.sampleLane(0, 249).fingers[0].active, true);
  assert.equal(replay.sampleLane(0, 250).fingers[0].active, false);
  assert.deepEqual(replay.sampleLane(0, 320).fingers[0].trail.map((p) => p.t), [300]);
  assert.equal(replay.sampleLane(0, 350).fingers[0].active, false);
  assert.equal(replay.sampleLane(0, 450).fingers[0].active, false);
  assert.equal(replay.sampleLane(0, 2000).fingers[0].stale, true);
  assert.equal(replay.sampleLane(0, 2000).fingers[0].active, false);
  assert.deepEqual(replay.sampleLane(0, 3100).fingers[0].trail.map((p) => p.t), [3000]);
  const segments = replay.sampleSegments();
  assert.equal(segments.totalSegments, 1);
  assert.deepEqual([...segments.pairs], [0, 1]);
});

test('looping restarts at the original timeline and trail sampling remains bounded', () => {
  const records = Array.from({ length: 500 }, (_, i) => ({ finger: 4, t: i * 10, x: i / 500, y: .2 }));
  const replay = createGestureReplay(makePack([records], { durationMs: 5000 }));
  const end = replay.sampleLane(0, 4990, { trailMs: 5000, maxTrailPoints: 12 });
  assert.equal(end.fingers[0].trail.length, 12);
  assert.equal(end.fingers[0].trail[0].t, 0);
  assert.equal(end.fingers[0].trail.at(-1).t, 4990);
  const loop = replay.sampleLane(0, 5100, { loop: true });
  assert.equal(loop.time, 100); assert.equal(loop.looped, true);
  assert.deepEqual(loop.fingers, replay.sampleLane(0, 100).fingers);
  assert.equal(replay.sampleLane(0, 5000, { loop: true }).fingers[0].t, 0);
  assert.equal(replay.sampleLane(0, -10, { loop: true }).time, 4990);
  const a = replay.sampleSegments({ limit: 12 });
  assert.equal(replay.sampleSegments({ limit: 12 }), a, 'repeated view builds reuse their bounded segment sample');
  replay.clearCache();
  const b = replay.sampleSegments({ limit: 12 });
  assert.equal(a.totalSegments, 499); assert.equal(a.sampledSegments, 12); assert.equal(a.pairs.length, 24);
  assert.deepEqual(a, b);
  for (let i = 0; i < a.pairs.length; i += 2) assert.equal(a.pairs[i + 1] - a.pairs[i], 1, 'retained segments connect actual neighbors');
});

test('a repeated noteOn starts a new finger trail, including a stable equal-time boundary', () => {
  const pack = makePack([[
    { finger: 2, t: 100, x: .1, y: .2, kind: TYPE.noteOn },
    { finger: 2, t: 200, x: .2, y: .3 },
    { finger: 2, t: 200, x: .8, y: .7, kind: TYPE.noteOn },
    { finger: 2, t: 300, x: .9, y: .8 },
    { finger: 2, t: 400, x: .4, y: .5, kind: TYPE.noteOn },
  ]]);
  const replay = createGestureReplay(pack);
  assert.deepEqual(replay.sampleLane(0, 199).fingers[0].trail.map((p) => p.index), [0]);
  assert.deepEqual(replay.sampleLane(0, 200).fingers[0].trail.map((p) => p.index), [2]);
  assert.deepEqual(replay.sampleLane(0, 350).fingers[0].trail.map((p) => p.index), [2, 3]);
  assert.deepEqual(replay.sampleLane(0, 400).fingers[0].trail.map((p) => p.index), [4]);
  assert.deepEqual([...replay.sampleSegments().pairs], [0, 1, 2, 3]);
  assert.deepEqual(replay.sampleLane(0, 200).fingers[0].trail.map((p) => p.index), [2], 'backseek preserves the contact boundary');
});

test('legacy packs disclose quantized axes and unknown fingers instead of inventing finger trails', () => {
  const pack = makePack([[{ t: 100, x: .123456, y: .789012 }, { t: 200, x: .3, y: .7 }]], { exact: false });
  const point = readGesture(pack, 0);
  assert.equal(point.exact, false); assert.equal(point.finger, null); assert.equal(point.coordinatePresenceKnown, false);
  assert.ok(Math.abs(point.x - .123456) <= 0.5 / 65535);
  assert.ok(Math.abs(point.y - .789012) <= 0.5 / 65535);
  const replay = createGestureReplay(pack);
  assert.equal(replay.sampleLane(0, 200).source, 'legacy');
  assert.equal(replay.sampleLane(0, 200).fingers[0].trail.length, 1);
  assert.equal(replay.sampleSegments().pairs.length, 0);
});
