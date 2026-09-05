import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveNebula } from '../viz/src/live-nebula.js';
import { buildNebula, nebulaEventPosition, projectNebulaPoint, NEBULA_CORE_RADIUS } from '../viz/src/nebula.js';
import { createPackFlowEnergy } from '../viz/src/flow-energy.js';
import { TYPE } from '../viz/src/pack-loader.js';

const limits = { points: 64, halos: 16, segments: 32 };
const layout = (durationMs = 10000, lanes = 4) => ({ durationMs, laneRadius: new Float32Array(lanes) });
const event = (t, { k = TYPE.move, f = 0, u = .4, v = .6, ...rest } = {}) => ({ t, k, f, u, v, ...rest });

function pack(records, durationMs = 10000) {
  const events = new DataView(new ArrayBuffer(records.length * 12));
  const gestures = new DataView(new ArrayBuffer(records.length * 32));
  records.forEach((r, index) => {
    const b = index * 12, g = index * 32;
    events.setUint16(b, 0, true); events.setUint32(b + 6, Math.round(r.t), true); events.setUint8(b + 10, r.k);
    gestures.setFloat64(g, r.t, true); gestures.setFloat64(g + 8, r.u ?? NaN, true); gestures.setFloat64(g + 16, r.v ?? NaN, true); gestures.setFloat64(g + 24, r.f ?? NaN, true);
  });
  return { events, gestures, strokes: new DataView(new ArrayBuffer(0)), manifest: {
    durationMs, laneCount: 1, eventCount: records.length, strokeCount: 0,
    participants: [{ p: 'A1', z: 'A', s: 1, l: 0, o: 0, n: records.length }], zones: [{ zone: 'A', laneStart: 0, laneCount: 1 }],
    gestures: { formatVersion: 1, file: 'gestures.bin', recordBytes: 32, count: records.length },
  } };
}

test('live geometry uses both actual axes in the same coordinates as the saved archive', () => {
  const records = [event(400.25, { k: TYPE.noteOn, u: .15, v: .2 }), event(400.25, { u: .85, v: .2 }), event(400.25, { u: .15, v: .85 })];
  const live = createLiveNebula(layout(), { limits });
  const archived = buildNebula(pack(records));
  try {
    for (const record of records) live.append(0, record);
    live.commit();
    const a = live.group.getObjectByName('nebula-live-starlight').geometry;
    const b = archived.group.getObjectByName('nebula-actual-event-starlight').geometry;
    assert.equal(a.drawRange.count, 3);
    assert.deepEqual(a.attributes.position.array.slice(0, 9), b.attributes.position.array);
    const positions = a.attributes.position.array;
    assert.ok(Math.hypot(positions[0] - positions[3], positions[1] - positions[4]) > .1, 'horizontal source movement changes the artwork');
    assert.ok(Math.hypot(positions[0] - positions[6], positions[1] - positions[7]) > .05, 'vertical source movement changes the artwork');
    assert.notEqual(positions[2], positions[8]);
    assert.equal(live.sampleLane(0, 400.25).x, .15);
    assert.equal(live.sampleLane(0, 400.25).y, .85);
  } finally { live.dispose(); archived.dispose(); }
});

test('live same-finger filaments stop at release, gap, missing axes, disconnect and unknown identity', () => {
  const live = createLiveNebula(layout(), { limits });
  try {
    const add = (t, options) => live.append(0, event(t, options));
    add(100, { k: TYPE.noteOn }); add(200);
    assert.equal(live.stats.totalSegments, 1);
    add(250, { k: TYPE.noteOff });
    assert.equal(live.sampleLane(0, 250).active, false);
    add(300); add(400);
    assert.equal(live.stats.totalSegments, 2);
    add(500, { u: null });
    assert.equal(live.sampleLane(0, 500)?.active ?? false, false, 'missing position must end the displayed active gesture');
    add(600); add(700);
    assert.equal(live.stats.totalSegments, 3);
    add(2100); add(2200);
    assert.equal(live.stats.totalSegments, 4, 'long silence must not create a connecting line');
    add(2300, { k: TYPE.disconnect });
    assert.equal(live.sampleLane(0, 2300), null);
    add(2400); add(2500);
    assert.equal(live.stats.totalSegments, 5);
    add(2600, { f: null }); add(2700, { f: null });
    assert.equal(live.stats.totalSegments, 5);
    assert.equal(live.sampleLane(0, 2700).finger, null);
    assert.deepEqual(live.sampleLane(0, 2700).trail, []);
    add(2800, { f: 1.5 }); add(2900, { f: 1.5 });
    assert.equal(live.stats.totalSegments, 5, 'fractional ids are not recorded finger identities');
    add(3000, { k: TYPE.noteOn, f: 1 }); add(3100, { f: 1 });
    assert.equal(live.stats.totalSegments, 6);
    live.commit();
    assert.equal(live.group.getObjectByName('nebula-live-finger-filaments').geometry.instanceCount, 6);
    assert.equal(live.sampleLane(0, 4401).active, false);
  } finally { live.dispose(); }
});

test('late source frames remain visible points without reopening a released or disconnected finger path', () => {
  const live = createLiveNebula(layout(), { limits });
  try {
    for (const record of [event(100, { k: TYPE.noteOn }), event(200), event(300, { k: TYPE.noteOff }), event(250)]) live.append(0, record);
    assert.equal(live.sampleLane(0, 300)?.active ?? false, false);
    live.append(0, event(400));
    assert.equal(live.stats.totalSegments, 1, 'late movement must not bridge across noteOff');
    live.append(0, event(500));
    assert.equal(live.stats.totalSegments, 2);
    live.append(0, event(700, { k: TYPE.disconnect }));
    live.append(0, event(600));
    live.append(0, event(800));
    assert.equal(live.stats.totalSegments, 2, 'late movement must not bridge across disconnect');
    assert.equal(live.grainCount(), 7, 'late source positions are still retained as observations');
  } finally { live.dispose(); }
});

test('live activity matches the archive causal envelope and decreases when input stops', () => {
  const records = [event(100.125, { k: TYPE.noteOn }), event(210.5), event(300, { k: TYPE.noteOff }), event(700.75), event(800, { k: TYPE.disconnect })];
  const live = createLiveNebula(layout(), { limits }); const archive = createPackFlowEnergy(pack(records));
  try {
    live.updatePlayhead(0); assert.equal(live.uniforms.uActivity.value, 0);
    for (const record of records) {
      live.append(0, record); live.updatePlayhead(record.t);
      assert.equal(live.uniforms.uActivity.value, archive.sample(record.t).energy);
    }
    const active = live.uniforms.uActivity.value;
    live.updatePlayhead(1800);
    assert.equal(live.uniforms.uActivity.value, archive.sample(1800).energy);
    assert.ok(live.uniforms.uActivity.value < active);
    live.updatePlayhead(10000);
    assert.ok(live.uniforms.uActivity.value < active / 1000);
  } finally { live.dispose(); }
});

test('reservoir stress stays deterministic and bounds geometry, trails and pending uploads without a renderer', () => {
  const budget = { points: 128, halos: 17, segments: 23 };
  const a = createLiveNebula(layout(20000, 2), { limits: budget, visualSeed: 7 });
  const b = createLiveNebula(layout(20000, 2), { limits: budget, visualSeed: 7 });
  try {
    for (let i = 0; i < 10000; i++) {
      const record = event(i, { u: (i % 101) / 100, v: (i % 97) / 96 });
      a.append(i % 2, record); b.append(i % 2, record);
      a.commit(); b.commit(); // simulates a stalled GPU while data keeps arriving
    }
    assert.deepEqual(a.stats, { points: 128, halos: 17, segments: 23, totalSegments: 9998 });
    assert.equal(a.grainCount(), 10000);
    assert.ok(a.sampleLane(0, 10000).trail.length <= 64);
    for (const name of ['nebula-live-starlight', 'nebula-live-atmosphere', 'nebula-live-finger-filaments']) {
      const ga = a.group.getObjectByName(name).geometry, gb = b.group.getObjectByName(name).geometry;
      for (const [name, attribute] of Object.entries(ga.attributes)) {
        assert.deepEqual(attribute.array, gb.attributes[name].array, 'same seed and input retain the same source sample');
        assert.ok(attribute.updateRanges.length <= 1, 'unuploaded updates must be merged into a bounded range');
      }
    }
    const times = a.group.getObjectByName('nebula-live-starlight').geometry.attributes.aData.array.filter((_, index) => index % 4 === 0);
    assert.ok(Math.min(...times) < 2500); assert.ok(Math.max(...times) > 7500, 'reservoir spans old and recent real observations');
    for (const [lane, record] of [[-1, event(1)], [2, event(1)], [0, event(NaN)], [0, event(-1)], [0, event(20001)]]) a.append(lane, record);
    assert.equal(a.grainCount(), 10000, 'invalid lane or time cannot consume GPU slots');
  } finally { a.dispose(); b.dispose(); }
});

test('live picking returns precise source coordinates after orbit and tilt and excludes the central void', () => {
  const live = createLiveNebula(layout(), { limits });
  const record = event(500.125, { u: .12, v: .87, f: 3 });
  try {
    live.append(2, record); live.commit(); live.updatePlayhead(1000);
    for (const tilt of [-.5, 0, .5]) for (const orbit of [0, .75]) {
      live.uniforms.uTilt.value = tilt; live.uniforms.uOrbit.value = orbit;
      const p = projectNebulaPoint(nebulaEventPosition({ lane: 2, t: record.t, x: record.u, y: record.v }, layout()), { time: 1000, durationMs: 10000, tilt, orbit });
      if (Math.hypot(p.x, p.y) < NEBULA_CORE_RADIUS) continue;
      const hit = live.inspect(p.x, p.y);
      assert.equal(hit.lane, 2); assert.equal(hit.gesture.x, record.u); assert.equal(hit.gesture.y, record.v); assert.equal(hit.gesture.finger, 3);
    }
    assert.equal(live.inspect(0, 0), null); assert.equal(live.inspect(NaN, 1), null);
  } finally { live.dispose(); }
});

test('live renderer disposal releases every GPU resource exactly once', () => {
  const live = createLiveNebula(layout(), { limits });
  live.append(0, event(100)); live.append(0, event(200)); live.commit();
  const resources = new Map();
  live.group.traverse((object) => {
    for (const resource of [object.geometry, object.material]) if (resource) {
      resources.set(resource, 0);
      resource.addEventListener('dispose', () => resources.set(resource, resources.get(resource) + 1));
    }
  });
  resources.set(live.playheadMat, 0);
  live.playheadMat.addEventListener('dispose', () => resources.set(live.playheadMat, resources.get(live.playheadMat) + 1));
  live.dispose(); live.dispose();
  for (const count of resources.values()) assert.equal(count, 1);
  assert.equal(live.sampleLane(0, 200), null);
});
