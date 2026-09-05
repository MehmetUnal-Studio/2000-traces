import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAtlasData, ATLAS_MAX_ROWS, ATLAS_TIME_COLUMNS, ATLAS_MAX_EDGES } from '../viz/src/atlas-data.js';
import { createDemoPack } from '../viz/src/demo-pack.js';
import { EVENT_RECORD_BYTES, STROKE_RECORD_BYTES, TYPE } from '../viz/src/pack-loader.js';

function packOf(lanes, { durationMs = 36000, held = [] } = {}) {
  const eventCount = lanes.reduce((total, lane) => total + lane.length, 0);
  const events = new DataView(new ArrayBuffer(eventCount * EVENT_RECORD_BYTES));
  const strokes = new DataView(new ArrayBuffer(held.length * STROKE_RECORD_BYTES));
  const participants = [];
  let offset = 0;
  for (let lane = 0; lane < lanes.length; lane++) {
    participants.push({ l: lane, o: offset, n: lanes[lane].length, z: 'A', s: lane + 1, p: `A${lane + 1}` });
    for (const item of lanes[lane]) {
      const base = offset++ * EVENT_RECORD_BYTES;
      events.setUint16(base, lane, true);
      events.setUint16(base + 4, item.v ?? 32768, true);
      events.setUint32(base + 6, item.time, true);
      events.setUint8(base + 10, item.kind);
      events.setUint8(base + 11, item.line ?? 0);
    }
  }
  for (let i = 0; i < held.length; i++) {
    const stroke = held[i]; const base = i * STROKE_RECORD_BYTES;
    strokes.setUint16(base, stroke.lane, true);
    strokes.setUint32(base + 4, stroke.t0, true);
    strokes.setUint32(base + 8, stroke.t1, true);
  }
  return {
    manifest: { formatVersion: 1, durationMs, laneCount: lanes.length, eventCount, strokeCount: held.length,
      participants, zones: [{ zone: 'A', laneStart: 0, laneCount: lanes.length }] }, events, strokes,
  };
}
const sum = (items) => items.reduce((total, item) => total + item, 0);

test('atlas conserves exact event/gesture/note/stroke statistics without lighting lifecycle-only cells', () => {
  const pack = packOf([
    [
      { kind: TYPE.noteOn, time: 120, line: 3, v: 0 },
      { kind: TYPE.move, time: 150, line: 7, v: 65535 },
      { kind: TYPE.move, time: 150, line: 7, v: 32768 },
      { kind: TYPE.noteOn, time: 100, line: 3, v: 65535 },
      { kind: TYPE.noteOff, time: 220, line: 3 },
      { kind: TYPE.keepalive, time: 100, line: 9 },
    ],
    [
      { kind: TYPE.noteOn, time: 1000, line: 8 },
      { kind: TYPE.noteOn, time: 300, line: 2 },
      { kind: TYPE.noteOn, time: 300, line: 1 },
      { kind: TYPE.move, time: 36000, line: 9 },
    ],
    [{ kind: TYPE.disconnect, time: 50, line: 255 }],
  ], { held: [{ lane: 0, t0: 100, t1: 220 }, { lane: 1, t0: 300, t1: 1000 }] });
  const atlas = buildAtlasData(pack);
  assert.equal(atlas.totalEvents, 11);
  assert.equal(sum(atlas.cells.map((cell) => cell.count)), 11);
  assert.equal(sum(atlas.laneStats.events), 11);
  assert.deepEqual([...atlas.laneStats.events], [6, 4, 1]);
  assert.deepEqual([...atlas.laneStats.notes], [2, 3, 0]);
  assert.deepEqual([...atlas.laneStats.moves], [2, 1, 0]);
  assert.deepEqual([...atlas.laneStats.strokes], [1, 1, 0]);
  assert.deepEqual([...atlas.laneStats.heldMs], [120, 700, 0]);
  assert.deepEqual([...atlas.laneStats.first], [100, 300, 50]);
  assert.deepEqual([...atlas.laneStats.last], [220, 36000, 50]);
  assert.deepEqual([...atlas.laneStats.dominantLine], [3, 1, -1]);
  assert.equal(atlas.totalHeldMs, 820);
  assert.equal(atlas.totalNotes, 5);
  assert.equal(atlas.totalMoves, 3);
  const active = atlas.cells.find((cell) => cell.row === 0 && cell.column === 1);
  assert.equal(active.count, 5);
  assert.equal(active.activity, 4);
  assert.equal(active.noteCount, 2);
  assert.equal(active.moveCount, 2);
  assert.equal(active.dominantLine, 3, 'musical dominance follows note onsets independently of movement lines');
  assert.ok(Math.abs(active.meanV - (2 + 32768 / 65535) / 4) < 1e-12);
  assert.equal(active.energy, 1);
  const quiet = atlas.cells.find((cell) => cell.row === 2);
  assert.equal(quiet.count, 1);
  assert.equal(quiet.activity, 0);
  assert.equal(quiet.energy, 0);
  assert.equal(quiet.dominantLine, -1);
  assert.ok(atlas.cells.some((cell) => cell.row === 1 && cell.column === 359), 'duration endpoint stays in final time column');
  assert.deepEqual(atlas.edges, [
    { lane: 0, t0: 100, t1: 120, line: 3, nextLine: 3 },
    { lane: 1, t0: 300, t1: 300, line: 2, nextLine: 1 },
    { lane: 1, t0: 300, t1: 1000, line: 1, nextLine: 8 },
  ]);
  assert.deepEqual(buildAtlasData(pack), atlas, 'all summaries and edge sampling are deterministic');
});

test('musical line dominance prefers genuine note onsets over abundant default-line motion', () => {
  const motions = Array.from({ length: 200 }, () => ({ kind: TYPE.move, time: 150, line: 0 }));
  const pack = packOf([
    [...motions, { kind: TYPE.noteOn, time: 160, line: 7 }, { kind: TYPE.noteOn, time: 170, line: 7 }],
    [...motions, { kind: TYPE.noteOn, time: 160, line: 7 }, { kind: TYPE.noteOn, time: 170, line: 3 }],
    motions,
  ]);
  const atlas = buildAtlasData(pack);
  assert.deepEqual([...atlas.laneStats.dominantLine], [7, 3, -1]);
  assert.deepEqual(atlas.cells.map((cell) => cell.dominantLine), [7, 3, -1]);
  assert.deepEqual(atlas.cells.map((cell) => cell.count), [202, 202, 200]);
  assert.deepEqual(atlas.cells.map((cell) => cell.moveCount), [200, 200, 200]);
  assert.equal(sum(atlas.cells.map((cell) => cell.count)), pack.manifest.eventCount);
  assert.equal(atlas.totalMoves, 600);
  assert.equal(atlas.totalNotes, 4);
  assert.ok(atlas.cells[2].energy > 0, 'neutral motion still contributes genuine gesture activity');
});

test('radial rows partition every adjacent lane once, including empty lanes and boundary timestamps', () => {
  const lanes = Array.from({ length: 2001 }, () => []);
  lanes[0].push({ kind: TYPE.move, time: 0 });
  lanes[2000].push({ kind: TYPE.noteOn, time: 36000 });
  const atlas = buildAtlasData(packOf(lanes));
  assert.equal(atlas.rowCount, ATLAS_MAX_ROWS);
  assert.equal(atlas.columnCount, ATLAS_TIME_COLUMNS);
  let cursor = 0;
  for (const band of atlas.rowBands) {
    assert.equal(band.laneStart, cursor);
    assert.ok(band.laneEnd > band.laneStart);
    cursor = band.laneEnd;
  }
  assert.equal(cursor, 2001);
  assert.equal(atlas.cells[0].row, 0);
  assert.equal(atlas.cells[0].column, 0);
  assert.equal(atlas.cells.at(-1).row, 95);
  assert.equal(atlas.cells.at(-1).column, 359);
  assert.equal(atlas.laneStats.first[1], -1);
  assert.equal(atlas.laneStats.last[1], -1);
  assert.equal(atlas.laneStats.dominantLine[1], -1);
});

test('onset ordering handles high uint32 timestamps and lane ids without signed truncation', () => {
  const lanes = Array.from({ length: 300 }, () => []);
  lanes[0] = [0xffffffff, 65536, 0, 65535].map((time, line) => ({ kind: TYPE.noteOn, time, line }));
  lanes[299] = [131072, 1].map((time) => ({ kind: TYPE.noteOn, time, line: 255 }));
  const atlas = buildAtlasData(packOf(lanes, { durationMs: 0xffffffff }));
  assert.deepEqual(atlas.edges.map(({ lane, t0, t1 }) => ({ lane, t0, t1 })), [
    { lane: 0, t0: 0, t1: 65535 }, { lane: 0, t0: 65535, t1: 65536 },
    { lane: 0, t0: 65536, t1: 0xffffffff }, { lane: 299, t0: 1, t1: 131072 },
  ]);
  assert.equal(atlas.laneStats.dominantLine[299], 255);
});

test('two million unsorted onsets retain exact counts with bounded cells and true sampled edges', () => {
  const laneCount = 2000; const perLane = 1000; const eventCount = laneCount * perLane;
  const events = new DataView(new ArrayBuffer(eventCount * EVENT_RECORD_BYTES));
  const participants = [];
  for (let lane = 0; lane < laneCount; lane++) {
    participants.push({ l: lane, o: lane * perLane, n: perLane });
    for (let i = 0; i < perLane; i++) {
      const base = (lane * perLane + i) * EVENT_RECORD_BYTES;
      events.setUint16(base, lane, true);
      events.setUint32(base + 6, 90000 - i * 90, true); // intentionally reverse chronological
      events.setUint8(base + 10, TYPE.noteOn);
      events.setUint8(base + 11, Math.floor(lane / 200));
    }
  }
  const atlas = buildAtlasData({ events, strokes: new DataView(new ArrayBuffer(0)), manifest: {
    formatVersion: 1, laneCount, durationMs: 90000, eventCount, strokeCount: 0,
    participants, zones: [{ zone: 'A', laneStart: 0, laneCount }],
  } });
  assert.equal(atlas.totalEvents, 2_000_000);
  assert.equal(sum(atlas.cells.map((cell) => cell.count)), 2_000_000);
  assert.equal(sum(atlas.laneStats.notes), 2_000_000);
  assert.ok(atlas.cells.length <= ATLAS_MAX_ROWS * ATLAS_TIME_COLUMNS);
  assert.equal(atlas.edges.length, ATLAS_MAX_EDGES);
  assert.equal(atlas.totalEdges, laneCount * (perLane - 1));
  assert.equal(atlas.maxLaneEvents, 1000);
  for (const edge of atlas.edges) {
    assert.equal(edge.t1 - edge.t0, 90, 'sampling joins true neighbors; it must not connect two arbitrary retained points');
    assert.equal(edge.line, Math.floor(edge.lane / 200));
    assert.ok(edge.lane >= 0 && edge.lane < laneCount);
  }
  for (const cell of atlas.cells) assert.ok(Number.isFinite(cell.energy) && cell.energy > 0 && cell.energy <= 1);
});

test('invalid binary bounds and impossible event/stroke coordinates fail before producing an atlas', () => {
  const pack = packOf([[{ kind: TYPE.noteOn, time: 100 }]]);
  assert.throws(() => buildAtlasData({ ...pack, events: new DataView(new ArrayBuffer(0)) }), /buffer/);
  pack.events.setUint16(0, 1, true);
  assert.throws(() => buildAtlasData(pack), /lane or time/);
  pack.events.setUint16(0, 0, true);
  pack.events.setUint32(6, 36001, true);
  assert.throws(() => buildAtlasData(pack), /lane or time/);
  const brokenStroke = packOf([[]], { held: [{ lane: 0, t0: 100, t1: 50 }] });
  assert.throws(() => buildAtlasData(brokenStroke), /stroke lane or time/);
});

test('ensemble demo supplies varied activity, multiple real held notes and dense meaningful polar coverage', () => {
  const pack = createDemoPack();
  const atlas = buildAtlasData(pack);
  assert.equal(pack.manifest.simulated, true);
  assert.ok(pack.manifest.eventCount >= 150_000 && pack.manifest.eventCount <= 250_000);
  assert.ok(new Set(atlas.laneStats.events).size > 20, 'participant activity bars must reflect varied sample counts');
  assert.ok(Math.min(...atlas.laneStats.notes) >= 9);
  assert.ok(atlas.cells.filter((cell) => cell.activity > 0).length > atlas.rowCount * atlas.columnCount * 0.9);
  assert.ok(new Set(atlas.cells.map((cell) => cell.dominantLine)).size >= 8);
  assert.equal(atlas.totalNotes, atlas.totalStrokes);
  const onsets = new Set(); const offsets = new Set();
  for (let i = 0; i < pack.manifest.eventCount; i++) {
    const base = i * EVENT_RECORD_BYTES;
    const key = `${pack.events.getUint16(base, true)}:${pack.events.getUint32(base + 6, true)}:${pack.events.getUint8(base + 11)}`;
    const type = pack.events.getUint8(base + 10);
    if (type === TYPE.noteOn) onsets.add(key);
    if (type === TYPE.noteOff) offsets.add(key);
  }
  for (let i = 0; i < pack.manifest.strokeCount; i++) {
    const base = i * STROKE_RECORD_BYTES;
    const lane = pack.strokes.getUint16(base, true);
    const line = pack.strokes.getUint8(base + 2);
    const start = pack.strokes.getUint32(base + 4, true);
    const end = pack.strokes.getUint32(base + 8, true);
    assert.ok(end > start && end <= pack.manifest.durationMs);
    assert.ok(onsets.has(`${lane}:${start}:${line}`));
    assert.ok(offsets.has(`${lane}:${end}:${line}`));
  }
});
