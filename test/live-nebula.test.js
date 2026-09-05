import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveNebula } from '../viz/src/live-nebula.js';
import { buildNebula, nebulaEventPosition, projectNebulaPoint, NEBULA_CORE_RADIUS } from '../viz/src/nebula.js';
import { createPackFlowEnergy } from '../viz/src/flow-energy.js';
import { createPackMotionSignals } from '../viz/src/motion-signals.js';
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

test('motion attributes and uniforms agree in live/archive geometry, including end-event filaments', () => {
  const records = [event(0, { k: TYPE.noteOn, u: .1, v: .2 }), event(100, { u: .2, v: .2 }),
    event(300, { u: .2, v: .4 }), event(400, { k: TYPE.noteOff }), event(600, { u: .3, v: .4 }), event(700, { u: .4, v: .4 })];
  const source = pack(records); const analysis = createPackMotionSignals(source);
  const archive = buildNebula(source, undefined, { motionSignals: analysis });
  const live = createLiveNebula(layout(), { limits });
  try {
    for (const record of records) {
      live.append(0, record); live.updatePlayhead(record.t); archive.updatePlayhead(record.t);
      for (const name of ['uMotionSpeed', 'uMotionTurn', 'uMotionCoherence', 'uMotionEnergy']) assert.equal(live.uniforms[name].value, archive.uniforms[name].value);
    }
    live.commit();
    for (const [liveName, archiveName, kind] of [
      ['nebula-live-starlight', 'nebula-actual-event-starlight', 'points'],
      ['nebula-live-atmosphere', 'nebula-event-atmosphere', 'instances'],
      ['nebula-live-finger-filaments', 'nebula-recorded-finger-filaments', 'instances'],
    ]) {
      const a = live.group.getObjectByName(liveName).geometry, b = archive.group.getObjectByName(archiveName).geometry;
      const count = kind === 'points' ? a.drawRange.count : a.instanceCount;
      assert.deepEqual(a.attributes.aMotion.array.slice(0, count * 4), b.attributes.aMotion.array);
    }
    const state = archive.motionAt(700);
    archive.updatePlayhead(50); assert.equal(archive.uniforms.uMotionEnergy.value, 0);
    archive.updatePlayhead(700); assert.equal(archive.uniforms.uMotionEnergy.value, state.energy);
    const point = nebulaEventPosition({ lane: 0, t: 700, x: .4, y: .4 }, source.manifest);
    const projected = projectNebulaPoint(point, { time: 700, durationMs: source.manifest.durationMs });
    const hit = archive.inspect(projected.x, projected.y);
    assert.equal(hit.gesture.index, 5); assert.equal(hit.gesture.motion.valid, true);
    assert.equal(hit.gesture.motion.speed, analysis.attributes.speed[5]);
    assert.deepEqual(hit.gesture.motion, archive.motionForEvent(5));
    const liveHit = live.inspect(projected.x, projected.y);
    assert.deepEqual(liveHit.gesture.motion, hit.gesture.motion);
  } finally { live.dispose(); archive.dispose(); }
});

test('sampled archive points, halos and filaments retain the original event motion index', () => {
  // Exceed the separate 26k note budget so draw index != source index.
  const records = Array.from({ length: 54000 }, (_, index) => event(index * .1, {
    k: index % 2 ? TYPE.move : TYPE.noteOn, u: .2 + index % 5 / 10, v: .2 + index % 7 / 10,
  }));
  const source = pack(records); const analysis = createPackMotionSignals(source);
  const archive = buildNebula(source, undefined, { motionSignals: analysis });
  try {
    assert.ok(archive.sampledIndices.length < records.length);
    const sampledSet = new Set(archive.sampledIndices);
    const omitted = records.findIndex((_, index) => !sampledSet.has(index));
    assert.ok(omitted >= 0);
    assert.equal(archive.motionForEvent(omitted).valid, !!analysis.attributes.valid[omitted]);
    assert.equal(archive.motionForEvent(omitted).speed, analysis.attributes.speed[omitted]);
    for (const index of [-1, records.length, .5, NaN, null]) assert.equal(archive.motionForEvent(index), null);
    const a = archive.group.getObjectByName('nebula-actual-event-starlight').geometry.attributes.aMotion.array;
    const halo = archive.group.getObjectByName('nebula-event-atmosphere').geometry.attributes.aMotion.array;
    const stride = Math.max(1, Math.ceil(archive.sampledIndices.length / 7000));
    for (let draw = 0; draw < archive.sampledIndices.length; draw++) {
      const sourceIndex = archive.sampledIndices[draw];
      const expected = Float32Array.of(analysis.attributes.speed01[sourceIndex], analysis.attributes.turn01[sourceIndex], analysis.attributes.directionX[sourceIndex], analysis.attributes.directionY[sourceIndex]);
      assert.deepEqual(a.slice(draw * 4, draw * 4 + 4), expected);
      if (draw % stride === 0) assert.deepEqual(halo.slice(draw / stride * 4, draw / stride * 4 + 4), expected);
    }
    const filament = archive.group.getObjectByName('nebula-recorded-finger-filaments').geometry.attributes.aMotion.array;
    for (let draw = 0; draw < archive.segmentPairs.length / 2; draw++) {
      const sourceIndex = archive.segmentPairs[draw * 2 + 1];
      assert.equal(filament[draw * 4], analysis.attributes.speed01[sourceIndex]);
      assert.equal(filament[draw * 4 + 3], analysis.attributes.directionY[sourceIndex]);
    }
  } finally { archive.dispose(); }
});

test('live selection follows the explicitly chosen finger and retains release without identity fallback', () => {
  const live = createLiveNebula(layout(), { limits });
  try {
    live.append(0, event(100, { f: 1, u: .1 }));
    live.append(0, event(200, { f: 2, u: .9 }));
    assert.equal(live.sampleLane(0, 200).finger, 2);
    assert.equal(live.sampleLane(0, 200, 1).finger, 1);
    assert.equal(live.sampleLane(0, 200, 1).x, .1);
    assert.equal(live.sampleLane(0, 200, 3), null);
    assert.equal(live.sampleLane(0, 50, 1), null, 'no future sample');
    live.append(0, event(300, { k: TYPE.noteOff, f: 1 }));
    assert.equal(live.sampleLane(0, 300, 1).active, false);
    assert.equal(live.sampleLane(0, 300, 2).active, true);
    live.append(0, event(400, { f: null }));
    assert.equal(live.sampleLane(0, 400, null).finger, null);
    assert.deepEqual(live.sampleLane(0, 400, null).trail, []);
    live.append(0, event(500, { k: TYPE.disconnect }));
    assert.equal(live.sampleLane(0, 500, 1), null); assert.equal(live.sampleLane(0, 500, null), null);
  } finally { live.dispose(); }
});

test('legacy and unknown-finger geometry always supplies a neutral motion attribute', () => {
  const source = pack([event(100), event(200, { u: .8 })]);
  delete source.manifest.gestures; source.gestures = null;
  const archive = buildNebula(source); const live = createLiveNebula(layout(), { limits });
  try {
    live.append(0, event(100, { f: null })); live.append(0, event(200, { f: null, u: .8 })); live.commit();
    live.updatePlayhead(200);
    for (const group of [archive.group, live.group]) group.traverse((object) => {
      const attr = object.geometry?.attributes.aMotion;
      if (attr) assert.equal(attr.array.some((value) => value !== 0), false);
    });
    assert.equal(archive.motionAt(10000).energy, 0); assert.equal(live.motionAt(200).energy, 0);
    assert.equal(live.sampleLane(0, 200, null).motion.valid, false);
  } finally { live.dispose(); archive.dispose(); }
});
