// test/viz-layout.test.js — node-testable viz logic: pickLane tolerance and
// zone-label rebuild keying (no DOM, no GPU).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLayout } from '../viz/src/layout.js';
import { updateZoneLabels } from '../viz/src/hud.js';

const manifest = {
  laneCount: 128,
  zones: [
    { zone: 'A', laneStart: 0, laneCount: 64 },
    { zone: 'B', laneStart: 64, laneCount: 64 },
  ],
  durationMs: 90000,
};

test('pickLane: gap between zones deselects across its whole width', () => {
  const layout = buildLayout(manifest);
  const gapStart = layout.zoneBands[0].r1;
  const gapEnd = layout.zoneBands[1].r0;
  // sample the gap interior beyond the 0.6-laneWidth acceptance fringe of
  // the edge lanes (lane centers sit 0.5 laneWidth inside each band)
  for (const f of [0.15, 0.35, 0.5, 0.65, 0.85]) {
    const r = gapStart + (gapEnd - gapStart) * f;
    assert.equal(layout.pickLane(0, r), null, `gap at ${f} must deselect`);
  }
});

test('pickLane: lane centers and mid-lane clicks still pick the lane', () => {
  const layout = buildLayout(manifest);
  assert.equal(layout.pickLane(0, layout.laneRadius[0]), 0);
  assert.equal(layout.pickLane(0, layout.laneRadius[70]), 70);
  // 0.4 laneWidth off-center stays within tolerance
  assert.equal(layout.pickLane(0, layout.laneRadius[10] + layout.laneWidth * 0.4), 10);
  // outside the disc
  assert.equal(layout.pickLane(0, 2), null);
  assert.equal(layout.pickLane(0, 0.01), null);
});

function layerStub() {
  const layer = {
    dataset: {},
    children: [],
    innerHTML: '',
  };
  Object.defineProperty(layer, 'childElementCount', { get: () => layer.children.length });
  // mimic innerHTML assignment producing spans with textContent + style
  let html = '';
  Object.defineProperty(layer, 'innerHTML', {
    get: () => html,
    set: (v) => {
      html = v;
      layer.children = [...v.matchAll(/<span class="zl">(.*?)<\/span>/g)]
        .map((m) => ({ textContent: m[1], style: {} }));
    },
  });
  return layer;
}

test('zone labels rebuild when zone names change at equal band count', () => {
  const project = () => ({ x: 0, y: 0, visible: true });
  const layer = layerStub();
  const l1 = buildLayout({ ...manifest, zones: [
    { zone: 'A', laneStart: 0, laneCount: 64 },
    { zone: 'C', laneStart: 64, laneCount: 64 },
  ] });
  updateZoneLabels(layer, l1, project, 1000);
  assert.deepEqual(layer.children.map((c) => c.textContent), ['A', 'C']);
  const l2 = buildLayout(manifest); // zones A,B — same count, new names
  updateZoneLabels(layer, l2, project, 1000);
  assert.deepEqual(layer.children.map((c) => c.textContent), ['A', 'B']);
});

// ---------------------------------------------------------------- rosterLayout
import { rosterLayout } from '../viz/src/layout.js';

test('rosterLayout: laneMeta carries zone/seat/pid per occupied lane', () => {
  const roster = [{ z: 'B', s: 2 }, { z: 'A', s: 7 }, { z: 'A', s: 3 }];
  const { laneMeta, laneOf, laneCount } = rosterLayout(roster, 90000, buildLayout, 4);
  assert.equal(laneCount, 3 + 4);
  // zone -> seat order
  assert.deepEqual(laneMeta.slice(0, 3), [
    { zone: 'A', seat: 3, pid: 'A3' },
    { zone: 'A', seat: 7, pid: 'A7' },
    { zone: 'B', seat: 2, pid: 'B2' },
  ]);
  // spare lanes start empty
  assert.deepEqual(laneMeta.slice(3), [null, null, null, null]);
  // existing participants resolve to their roster lanes
  assert.equal(laneOf('A', 7), 1);
  assert.equal(laneOf('B', 2), 2);
});

test('rosterLayout: spare-lane assignment fills laneMeta; overflow stays null', () => {
  const roster = [{ z: 'A', s: 1 }];
  const { laneMeta, laneOf } = rosterLayout(roster, 90000, buildLayout, 2);
  const l1 = laneOf('C', 9);
  assert.equal(l1, 1);
  assert.deepEqual(laneMeta[1], { zone: 'C', seat: 9, pid: 'C9' });
  assert.equal(laneOf('C', 9), 1); // stable on repeat lookup
  const l2 = laneOf('D', 4);
  assert.equal(l2, 2);
  assert.deepEqual(laneMeta[2], { zone: 'D', seat: 4, pid: 'D4' });
  assert.equal(laneOf('E', 5), null); // spare band full
  assert.equal(laneMeta.length, 3);
});
