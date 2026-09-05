import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAtlas, atlasCellBounds, ATLAS_RADII, ATLAS_LINE_WIDTHS } from '../viz/src/atlas.js';
import { buildLayout } from '../viz/src/layout.js';
import { createDemoPack } from '../viz/src/demo-pack.js';
import { EVENT_RECORD_BYTES } from '../viz/src/pack-loader.js';

function fixture() {
  const laneCount = 6;
  const durationMs = 1000;
  const events = new DataView(new ArrayBuffer(laneCount * 3 * EVENT_RECORD_BYTES));
  const participants = [];
  for (let lane = 0; lane < laneCount; lane++) {
    participants.push({ p: `A${lane + 1}`, z: 'A', s: lane + 1, l: lane, o: lane * 3, n: 3 });
    for (let i = 0; i < 3; i++) {
      const base = (lane * 3 + i) * EVENT_RECORD_BYTES;
      events.setUint16(base, lane, true);
      events.setUint16(base + 4, 32768, true);
      events.setUint32(base + 6, [100, 350, 700][i] + lane, true);
      events.setUint8(base + 10, i === 1 ? 3 : 1);
      events.setUint8(base + 11, lane);
    }
  }
  return { events, strokes: new DataView(new ArrayBuffer(0)), manifest: {
    formatVersion: 1, sessionId: 'atlas-renderer-fixture', visualSeed: 1,
    laneCount, durationMs, eventCount: laneCount * 3, strokeCount: 0,
    participants, zones: [{ zone: 'A', laneStart: 0, laneCount }],
  } };
}

function cellPoint(cell, atlas, tilt = 0) {
  const bounds = atlasCellBounds(cell, atlas.data);
  const angle = (bounds.a0 + bounds.a1) / 2;
  const radius = (bounds.r0 + bounds.r1) / 2;
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius * Math.cos(tilt) - bounds.z * Math.sin(tilt) };
}

test('atlas cells and participant bars pick exact data through both tilt directions and print mode', () => {
  const pack = fixture();
  const atlas = buildAtlas(pack, buildLayout(pack.manifest));
  try {
    for (const mode of ['atlas', 'ink']) for (const tilt of [-0.6, 0, 0.6]) {
      atlas.setViewMode(mode);
      atlas.uniforms.uTilt.value = tilt;
      for (const cell of atlas.data.cells) {
        const p = cellPoint(cell, atlas, tilt);
        const hit = atlas.inspect(p.x, p.y);
        assert.equal(hit?.key, `cell:${cell.row}:${cell.column}`);
        assert.equal(hit.lane, cell.laneStart);
      }
      for (let lane = 0; lane < pack.manifest.laneCount; lane++) {
        const energy = Math.pow(atlas.data.laneStats.events[lane] / atlas.data.maxLaneEvents, 2.2);
        const radius = ATLAS_RADII.bars + (0.010 + energy * 0.120) / 2;
        const angle = Math.PI / 2 - Math.PI * 2 * (lane + 0.5) / pack.manifest.laneCount;
        const z = 0.003 + energy * 0.006;
        const x = Math.cos(angle) * radius;
        const y = Math.sin(angle) * radius * Math.cos(tilt) - z * Math.sin(tilt);
        assert.equal(atlas.inspect(x, y)?.lane, lane);
      }
    }
  } finally { atlas.dispose(); }
});

test('atlas replay and inspection never reveal future aggregate counts or future note endpoints', () => {
  const pack = fixture();
  const atlas = buildAtlas(pack, buildLayout(pack.manifest));
  try {
    const cell = atlas.data.cells[0];
    const p = cellPoint(cell, atlas);
    atlas.uniforms.uTime.value = cell.t1 - 0.1;
    assert.equal(atlas.inspect(p.x, p.y), null);
    atlas.uniforms.uTime.value = cell.t1;
    assert.equal(atlas.inspect(p.x, p.y)?.key, `cell:${cell.row}:${cell.column}`);
    const mesh = atlas.group.getObjectByName('atlas-consecutive-note-filaments');
    const { aTime, aLane, aStart, aEnd } = mesh.geometry.attributes;
    const segmentsPerEdge = mesh.geometry.instanceCount / atlas.data.edges.length;
    assert.ok(Number.isInteger(segmentsPerEdge) && segmentsPerEdge > 0);
    for (let edgeIndex = 0; edgeIndex < atlas.data.edges.length; edgeIndex++) {
      const edge = atlas.data.edges[edgeIndex];
      const first = edgeIndex * segmentsPerEdge;
      const last = first + segmentsPerEdge - 1;
      for (let segment = first; segment <= last; segment++) {
        assert.equal(aTime.array[segment], edge.t1, 'filament must wait for its second note');
        assert.equal(aLane.array[segment], edge.lane, 'filament cannot connect different participants');
        if (segment < last) {
          for (const axis of ['X', 'Y', 'Z']) assert.equal(aEnd[`get${axis}`](segment), aStart[`get${axis}`](segment + 1));
        }
      }
      const startAngle = Math.PI / 2 - Math.PI * 2 * edge.t0 / pack.manifest.durationMs;
      const endAngle = Math.PI / 2 - Math.PI * 2 * edge.t1 / pack.manifest.durationMs;
      assert.ok(Math.abs(aStart.getX(first) - Math.cos(startAngle) * ATLAS_RADII.thread) < 1e-7);
      assert.ok(Math.abs(aStart.getY(first) - Math.sin(startAngle) * ATLAS_RADII.thread) < 1e-7);
      assert.ok(Math.abs(aEnd.getX(last) - Math.cos(endAngle) * ATLAS_RADII.thread) < 1e-7);
      assert.ok(Math.abs(aEnd.getY(last) - Math.sin(endAngle) * ATLAS_RADII.thread) < 1e-7);
    }
    atlas.uniforms.uTime.value = 699;
    assert.equal(atlas.inspect(0, ATLAS_RADII.bars + 0.065), null);
    assert.equal(atlas.updateHover(null, null), null);
  } finally { atlas.dispose(); }
});

test('filaments and graduations use instanced triangle ribbons with world widths shared by screen and export', () => {
  const pack = fixture();
  const atlas = buildAtlas(pack, buildLayout(pack.manifest));
  try {
    for (const [name, worldWidth] of [
      ['atlas-consecutive-note-filaments', ATLAS_LINE_WIDTHS.filaments],
      ['atlas-time-and-participant-graduations', ATLAS_LINE_WIDTHS.engraving],
    ]) {
      const mesh = atlas.group.getObjectByName(name);
      assert.equal(mesh.isMesh, true, 'native one-pixel GL lines lose weight in print exports');
      assert.equal(mesh.geometry.isInstancedBufferGeometry, true);
      assert.equal(mesh.geometry.index.count, 6);
      assert.equal(mesh.geometry.attributes.aStart.count, mesh.geometry.instanceCount);
      assert.equal(mesh.geometry.attributes.aEnd.count, mesh.geometry.instanceCount);
      assert.equal(mesh.material.uniforms.uPointScale, atlas.uniforms.uPointScale);
      assert.equal(mesh.material.uniforms.uTilt, atlas.uniforms.uTilt);
      for (const scale of [100, 675, 4096 / 2.24]) {
        atlas.uniforms.uPointScale.value = scale;
        atlas.setViewMode('ink');
        assert.equal(mesh.material.uniforms.uWorldWidth.value, worldWidth);
        atlas.setViewMode('atlas');
        assert.equal(mesh.material.uniforms.uWorldWidth.value, worldWidth);
      }
    }
  } finally { atlas.dispose(); }
});

test('dense atlas exposes participant groups honestly and keeps print geometry unchanged', () => {
  const pack = createDemoPack({ laneCount: 300 });
  const atlas = buildAtlas(pack, buildLayout(pack.manifest));
  try {
    const mesh = atlas.group.getObjectByName('atlas-polar-cells-and-participant-bars');
    const positions = mesh.geometry.attributes.aCell.array.slice();
    for (let i = 0; i < atlas.data.cells.length; i += 47) {
      const cell = atlas.data.cells[i];
      if (!cell.activity) continue;
      const p = cellPoint(cell, atlas);
      const hit = atlas.inspect(p.x, p.y);
      assert.equal(hit?.row, cell.row);
      assert.equal(hit.column, cell.column);
      assert.equal(hit.lane, cell.laneEnd - cell.laneStart === 1 ? cell.laneStart : null);
    }
    const cell = atlas.data.cells.find((c) => c.activity);
    const p = cellPoint(cell, atlas);
    const hit = atlas.updateHover(p.x, p.y);
    const stamp = atlas.hoverStamp;
    atlas.updateHover(p.x, p.y);
    assert.equal(atlas.hoverStamp, stamp);
    atlas.setInspection(hit);
    assert.equal(atlas.uniforms.uSelRow.value, cell.row);
    assert.equal(atlas.uniforms.uSelColumn.value, cell.column);
    atlas.setViewMode('ink');
    assert.equal(atlas.uniforms.uInk.value, 1);
    assert.deepEqual(mesh.geometry.attributes.aCell.array, positions);
    atlas.setInspection(null);
    assert.equal(atlas.uniforms.uSelRow.value, -1);
    atlas.updatePlayhead(20000);
    const version = atlas.playhead.geometry.attributes.position.version;
    atlas.updatePlayhead(20000);
    assert.equal(atlas.playhead.geometry.attributes.position.version, version);
  } finally { atlas.dispose(); }
});

test('atlas disposes each GPU geometry and material once', () => {
  const pack = fixture();
  const atlas = buildAtlas(pack, buildLayout(pack.manifest));
  const geometryEvents = new Map();
  const materialEvents = new Map();
  atlas.group.traverse((object) => {
    if (object.geometry) {
      geometryEvents.set(object.geometry, 0);
      object.geometry.addEventListener('dispose', () => geometryEvents.set(object.geometry, geometryEvents.get(object.geometry) + 1));
    }
    if (object.material) {
      materialEvents.set(object.material, 0);
      object.material.addEventListener('dispose', () => materialEvents.set(object.material, materialEvents.get(object.material) + 1));
    }
  });
  atlas.dispose(); atlas.dispose();
  for (const count of [...geometryEvents.values(), ...materialEvents.values()]) assert.equal(count, 1);
});
