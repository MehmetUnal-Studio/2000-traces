import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLayout } from '../viz/src/layout.js';
import { projectTracePoint, unprojectTracePoint } from '../viz/src/cosmic-projection.js';
import { createDemoPack } from '../viz/src/demo-pack.js';

test('both artwork projections preserve participant picking across the complete timeline', () => {
  const { manifest } = createDemoPack();
  const layout = buildLayout(manifest);
  for (const morph of [0, 0.5, 1]) {
    for (let lane = 0; lane < manifest.laneCount; lane += 7) {
      for (const fraction of [0, 0.125, 0.5, 0.875, 1]) {
        const radius = layout.laneRadius[lane];
        const point = projectTracePoint(radius, fraction * manifest.durationMs, manifest.durationMs, morph);
        const original = unprojectTracePoint(point.x, point.y, morph);
        assert.ok(Math.abs(Math.hypot(original.x, original.y) - radius) < 1e-10);
        assert.equal(layout.pickLane(original.x, original.y), lane);
      }
    }
  }
});

test('cosmic picking remains invertible near the core and outside the artwork', () => {
  for (const morph of [0, 0.2, 0.8, 1]) {
    for (const radius of [0, 0.01, 0.29, 0.3, 0.31, 0.95, 1.5]) {
      const point = projectTracePoint(radius, 42000, 90000, morph);
      const original = unprojectTracePoint(point.x, point.y, morph);
      assert.ok(Math.abs(Math.hypot(original.x, original.y) - radius) < 1e-10);
    }
  }
});

test('record view keeps the original clockwise full-turn time mapping', () => {
  const radius = 0.65;
  const duration = 90000;
  const start = projectTracePoint(radius, 0, duration, 0);
  const quarter = projectTracePoint(radius, duration / 4, duration, 0);
  const end = projectTracePoint(radius, duration, duration, 0);
  assert.ok(Math.abs(start.x) < 1e-10 && Math.abs(start.y - radius) < 1e-10);
  assert.ok(Math.abs(quarter.x - radius) < 1e-10 && Math.abs(quarter.y) < 1e-10);
  assert.ok(Math.abs(start.x - end.x) < 1e-10 && Math.abs(start.y - end.y) < 1e-10);
});
