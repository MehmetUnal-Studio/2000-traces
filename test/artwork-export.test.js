import test from 'node:test';
import assert from 'node:assert/strict';
import { exportStill } from '../viz/src/export-still.js';

test('print composition uses the final pipeline and restores every interactive uniform on GPU failure', async () => {
  const values = { uDuration: 90000, uTime: 31000, uPointScale: 300, uPointMax: 32,
    uSelLane: 19, uReplaying: 1, uSelRow: 4, uSelColumn: 76, uHoverRow: 5,
    uHoverColumn: 10, uHoverLane: 7, uTilt: 0.5, uOrbit: 1.3, uAnimation: 13, uActivity: 0.72, uViewportHeight: 700 };
  const uniforms = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value }]));
  const playheadMat = { opacity: 0.55 };
  const previousTarget = {};
  let restoredTarget = null;
  let rendered = false;
  const renderer = {
    getRenderTarget: () => previousTarget,
    setRenderTarget: (value) => { restoredTarget = value; },
    readRenderTargetPixels: () => { throw new Error('GPU readback unavailable'); },
  };
  await assert.rejects(exportStill({ renderer, scene: {}, uniforms, playheadMat,
    sessionId: 'test', mode: 'nebula', activity: 0.35, size: 4,
    render(target, camera) {
      rendered = true;
      assert.equal(target.width, 4);
      assert.equal(target.samples, 0, 'pipeline owns antialiasing');
      assert.equal(camera.isPerspectiveCamera, true);
      assert.equal(camera.zoom, 1);
      assert.ok(camera.position.z * Math.sin(camera.fov * Math.PI / 360) >= 1.12,
        'print includes the complete spatial artwork at its standard pose');
      assert.equal(uniforms.uViewportHeight.value, 4);
      assert.equal(uniforms.uTime.value, 90000);
      assert.equal(uniforms.uAnimation.value, 0);
      assert.equal(uniforms.uActivity.value, 0.35);
      assert.equal(uniforms.uTilt.value, 0);
      assert.equal(uniforms.uOrbit.value, 0, 'print is independent of ambient orbital animation');
      assert.equal(playheadMat.opacity, 0);
      for (const key of ['uSelLane', 'uSelRow', 'uSelColumn', 'uHoverRow', 'uHoverColumn', 'uHoverLane']) {
        assert.equal(uniforms[key].value, -1);
      }
    },
  }), /GPU readback unavailable/);
  assert.equal(rendered, true);
  assert.equal(restoredTarget, previousTarget);
  assert.equal(playheadMat.opacity, 0.55);
  for (const [key, value] of Object.entries(values)) assert.equal(uniforms[key].value, value, key);
});
