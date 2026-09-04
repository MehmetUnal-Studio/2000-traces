import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDisc } from '../viz/src/disc.js';
import { createLiveDisc } from '../viz/src/live-disc.js';
import { createDemoPack } from '../viz/src/demo-pack.js';
import { buildLayout } from '../viz/src/layout.js';
import { EVENT_RECORD_BYTES, STROKE_RECORD_BYTES } from '../viz/src/pack-loader.js';
import { projectTracePoint, unprojectTracePoint } from '../viz/src/cosmic-projection.js';

function assertGeometryPicksItsParticipants(geometry, layout, count) {
  const { aR, aT, aLane } = geometry.attributes;
  for (let i = 0; i < count; i++) {
    const lane = aLane.array[i];
    assert.ok(Math.abs(aR.array[i] - layout.laneRadius[lane]) < layout.laneWidth * 0.48,
      `gesture ${i} crossed its participant's half-lane`);
    for (const morph of [0, 0.5, 1]) {
      const point = projectTracePoint(aR.array[i], aT.array[i], layout.durationMs, morph);
      const original = unprojectTracePoint(point.x, point.y, morph);
      assert.equal(layout.pickLane(original.x, original.y), lane,
        `gesture ${i} selected another participant at morph ${morph}`);
    }
  }
}

for (const laneCount of [10, 2000]) {
  test(`extreme recorded gestures and held notes retain their participant in both views (${laneCount} lanes)`, () => {
    const pack = createDemoPack({ laneCount });
    for (let i = 0; i < pack.manifest.eventCount; i++) {
      pack.events.setUint16(i * EVENT_RECORD_BYTES + 4, i % 2 ? 65535 : 0, true);
    }
    for (let i = 0; i < pack.manifest.strokeCount; i++) {
      pack.strokes.setUint16(i * STROKE_RECORD_BYTES + 14, i % 2 ? 65535 : 0, true);
    }
    const layout = buildLayout(pack.manifest);
    const disc = buildDisc(pack, layout);
    try {
      for (const child of disc.group.children) {
        if (child.geometry.hasAttribute('aLane')) {
          assertGeometryPicksItsParticipants(child.geometry, layout, child.geometry.attributes.aLane.count);
        }
      }
      disc.updatePlayhead(30000);
      const position = disc.playhead.geometry.attributes.position;
      const version = position.version;
      disc.updatePlayhead(30000);
      assert.equal(position.version, version, 'a paused playhead must not rewrite its GPU buffer');
    } finally { disc.dispose(); }
  });
}

test('extreme streamed gestures use the same safe lane bounds and inverse projection', () => {
  const layout = buildLayout(createDemoPack({ laneCount: 10 }).manifest);
  const disc = createLiveDisc(layout);
  try {
    for (let lane = 0; lane < 10; lane++) {
      disc.append(lane, { k: 1, t: 1000 + lane, v: 0, l: lane });
      disc.append(lane, { k: 3, t: 2000 + lane, v: 1, l: lane });
    }
    disc.commit();
    const grains = disc.group.children.find((child) => child.geometry.hasAttribute('aLane'));
    assert.equal(grains.geometry.drawRange.count, 20);
    assertGeometryPicksItsParticipants(grains.geometry, layout, grains.geometry.drawRange.count);
  } finally { disc.dispose(); }
});
