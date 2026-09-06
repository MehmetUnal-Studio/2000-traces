import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { packSession } from '../src/viz-pack.js';
import { readGesture, createGestureReplay } from '../viz/src/gesture-replay.js';
import { nebulaEventPosition } from '../viz/src/nebula.js';
import { createPackMotionSignals } from '../viz/src/motion-signals.js';
import { createPackFlowEnergy } from '../viz/src/flow-energy.js';
import { exportAssets, readLocalPack } from '../touchdesigner/export-assets.mjs';

async function fixture(t, { legacy = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'traces-td-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source'), output = join(root, 'native');
  const records = [{ kind: 'session', sessionId: 'td-exact-fixture', durationMs: 1001, visualSeed: 71 }];
  const add = (participantId, zone, seatNumber, tMs, eventType, u, v, finger) => records.push({
    kind: 'event', participantId, zone, seatNumber, tMs, eventType, u, v, finger, line: 2,
  });
  // Arrival and seat order intentionally differ; output retains original
  // packed indices while the proven same-finger paths are chronological.
  add('B:2', 'B', 2, 100, 'noteOn', 0.1234567890123, 0.7890123456789, 3);
  add('B:2', 'B', 2, 250.125, 'fingerMove', 0.41, 0.62, 3);
  add('A:1', 'A', 1, 40.125, 'noteOn', 0, 1, 7);
  add('A:1', 'A', 1, 300, 'fingerMove', 0.3, 0.2, 7);
  add('A:1', 'A', 1, 175.5, 'fingerMove', 0.2, 0.7, 7);
  add('A:1', 'A', 1, 310, 'noteOff', null, null, 7);
  add('A:1', 'A', 1, 330, 'fingerMove', null, null, 7);
  add('B:2', 'B', 2, 1000.25, 'fingerMove', 0.8, 0.9, 3);
  const input = join(root, 'session.jsonl');
  writeFileSync(input, records.map((r) => JSON.stringify(r)).join('\n'));
  await packSession(input, source);
  if (legacy) {
    const manifest = JSON.parse(readFileSync(join(source, 'manifest.json')));
    delete manifest.gestures;
    writeFileSync(join(source, 'manifest.json'), JSON.stringify(manifest));
    rmSync(join(source, 'gestures.bin'));
  }
  return { source, output, pack: readLocalPack(source) };
}

const indexArray = (output, spec) => {
  const buffer = readFileSync(join(output, spec.file));
  return Array.from({ length: spec.count * spec.components }, (_, i) => buffer.readUInt32LE(i * 4));
};
const rgbaAt = (output, spec, index) => {
  const buffer = readFileSync(join(output, spec.file));
  return Array.from({ length: 4 }, (_, channel) => buffer.readFloatLE((index * 4 + channel) * 4));
};

test('TouchDesigner export preserves raw XY/finger precision and every native point source index', async (t) => {
  const { source, output, pack } = await fixture(t);
  const layout = exportAssets(source, output);
  assert.equal(layout.exactGestures, true);
  assert.equal(layout.durationMs, 1001);
  for (const [name, spec] of Object.entries(layout.source.files)) {
    assert.deepEqual(readFileSync(join(output, spec.file)), readFileSync(join(source, name)));
    assert.equal(spec.sha256.length, 64);
  }
  const dust = layout.groups.dust;
  const sourceIndices = indexArray(output, dust.sourceIndices);
  const validEvents = Array.from({ length: pack.manifest.eventCount }, (_, i) => readGesture(pack, i))
    .filter((event) => [1, 3].includes(event.kind) && event.hasXY);
  assert.deepEqual(sourceIndices, validEvents.map((event) => event.index));
  for (let i = 0; i < dust.count; i++) {
    const event = readGesture(pack, sourceIndices[i]);
    const position = nebulaEventPosition(event, pack.manifest);
    assert.deepEqual(rgbaAt(output, dust.attributes.position, i), [Math.fround(position.x), Math.fround(position.y), Math.fround(position.z), 1]);
    const data = rgbaAt(output, dust.attributes.data, i);
    assert.equal(data[0], Math.fround(event.t));
    assert.equal(data[1], event.lane);
    assert.equal(data[2], event.kind === 1 ? 1 : 0);
  }
  for (const group of Object.values(layout.groups)) {
    assert.equal(group.width, 512);
    for (const spec of Object.values(group.attributes)) {
      const buffer = readFileSync(join(output, spec.file));
      assert.equal(buffer.length, group.width * group.height * 16);
      assert.ok(buffer.subarray(group.count * 16).every((byte) => byte === 0));
    }
  }
  assert.equal(layout.groups.stars.recordedData, false);
  assert.equal(layout.groups.clouds.recordedData, false);
});

test('TouchDesigner filaments refer to proven same-finger source pairs and halo links remain exact', async (t) => {
  const { source, output, pack } = await fixture(t);
  const layout = exportAssets(source, output);
  const expected = createGestureReplay(pack).sampleSegments().pairs;
  const pairs = indexArray(output, layout.groups.filaments.sourcePairs);
  assert.deepEqual(pairs, Array.from(expected));
  assert.ok(pairs.length > 0);
  for (let i = 0; i < pairs.length; i += 2) {
    const first = readGesture(pack, pairs[i]), last = readGesture(pack, pairs[i + 1]);
    assert.equal(first.finger, last.finger);
    assert.equal(first.lane, last.lane);
    assert.ok(first.t <= last.t);
    for (const [name, event] of [['start', first], ['end', last]]) {
      const p = nebulaEventPosition(event, pack.manifest);
      assert.deepEqual(rgbaAt(output, layout.groups.filaments.attributes[name], i / 2), [Math.fround(p.x), Math.fround(p.y), Math.fround(p.z), 1]);
    }
  }
  assert.deepEqual(indexArray(output, layout.groups.halos.sourceIndices), indexArray(output, layout.groups.dust.sourceIndices));
});

test('TouchDesigner control timeline matches causal source envelopes and preserves exact final duration', async (t) => {
  const { source, output, pack } = await fixture(t);
  const layout = exportAssets(source, output);
  const times = readFileSync(join(output, layout.timeline.exactTimes));
  const flow = createPackFlowEnergy(pack), motion = createPackMotionSignals(pack);
  const timeline = layout.groups.timeline;
  assert.equal(times.readDoubleLE(times.length - 8), 1001);
  assert.equal(layout.timeline.hz, 60);
  assert.equal(layout.timeline.count, 62);
  for (let i = 0; i < timeline.count; i++) {
    const time = times.readDoubleLE(i * 8), signals = motion.sample(time);
    assert.deepEqual(rgbaAt(output, timeline.attributes.flow, i), [Math.fround(time), Math.fround(flow.sample(time).energy), 0, 0]);
    assert.deepEqual(rgbaAt(output, timeline.attributes.motion, i), [signals.speed01, signals.turn01, signals.coherence, signals.energy].map(Math.fround));
    if (i) assert.ok(time > times.readDoubleLE((i - 1) * 8));
  }
  assert.deepEqual(rgbaAt(output, timeline.attributes.motion, 0), [0, 0, 0, 0]);
  assert.equal(rgbaAt(output, timeline.attributes.flow, 2)[1], 0); // Before the first recorded contact.
});

test('TouchDesigner legacy export never invents historical fingers, connecting paths or motion', async (t) => {
  const { source, output } = await fixture(t, { legacy: true });
  const layout = exportAssets(source, output);
  assert.equal(layout.exactGestures, false);
  assert.equal(layout.groups.filaments.count, 0);
  assert.equal(existsSync(join(output, 'raw/gestures.bin')), false);
  assert.ok(readFileSync(join(output, layout.groups.timeline.attributes.motion.file)).every((byte) => byte === 0));
});

test('TouchDesigner export rejects truncated raw data and cannot overwrite a source pack', async (t) => {
  const { source, output } = await fixture(t);
  assert.throws(() => exportAssets(source, source), /outside the source pack/);
  assert.throws(() => exportAssets(source, join(source, 'native')), /outside the source pack/);
  writeFileSync(join(source, 'gestures.bin'), Buffer.alloc(32));
  assert.throws(() => exportAssets(source, output), /gestures.bin: expected/);
  assert.equal(existsSync(output), false);
});
