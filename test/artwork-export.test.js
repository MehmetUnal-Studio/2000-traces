import test from 'node:test';
import assert from 'node:assert/strict';
import { exportStill } from '../viz/src/export-still.js';

test('print composition uses the final pipeline and restores every interactive uniform on GPU failure', async () => {
  const values = { uDuration: 90000, uTime: 31000, uPointScale: 300, uPointMax: 32,
    uSelLane: 19, uReplaying: 1, uSelRow: 4, uSelColumn: 76, uHoverRow: 5,
    uHoverColumn: 10, uHoverLane: 7, uTilt: 0.5, uOrbit: 1.3, uAnimation: 13, uActivity: 0.72, uViewportHeight: 700,
    uMotionSpeed: .12, uMotionTurn: .23, uMotionCoherence: .34, uMotionEnergy: .45 };
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
    motion: { speed01: .8, turn01: .4, coherence: .7, energy: .5 },
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
      assert.equal(uniforms.uMotionSpeed.value, .8);
      assert.equal(uniforms.uMotionTurn.value, .4);
      assert.equal(uniforms.uMotionCoherence.value, .7);
      assert.equal(uniforms.uMotionEnergy.value, .5);
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

test('successful still export applies final motion and restores the live frame before PNG encoding', async (t) => {
  const values = { uDuration: 180000, uTime: 42000, uPointScale: 300, uPointMax: 32,
    uSelLane: -1, uReplaying: 1, uMotionSpeed: .21, uMotionTurn: .32, uMotionCoherence: .43, uMotionEnergy: .54 };
  const uniforms = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value }]));
  const priorDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const assertRestored = () => { for (const [key, value] of Object.entries(values)) assert.equal(uniforms[key].value, value, key); };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createElement: () => ({
      getContext: () => ({ createImageData: (width, height) => ({ data: new Uint8ClampedArray(width * height * 4) }), putImageData() {} }),
      toBlob(callback) { assertRestored(); callback(new Blob([new Uint8Array(16)], { type: 'image/png' })); },
    }),
  } });
  t.after(() => priorDocument ? Object.defineProperty(globalThis, 'document', priorDocument) : delete globalThis.document);
  const previousTarget = {}; let restored = false;
  const renderer = { getRenderTarget: () => previousTarget, setRenderTarget: (target) => { restored = target === previousTarget; }, readRenderTargetPixels() {} };
  const result = await exportStill({ renderer, scene: {}, uniforms, sessionId: 'motion-finished', size: 2,
    motion: { speed01: .91, turn01: .82, coherence: .73, energy: .64 },
    render() {
      assert.equal(uniforms.uTime.value, 180000);
      assert.equal(uniforms.uMotionSpeed.value, .91); assert.equal(uniforms.uMotionTurn.value, .82);
      assert.equal(uniforms.uMotionCoherence.value, .73); assert.equal(uniforms.uMotionEnergy.value, .64);
    },
  });
  try { assertRestored(); assert.equal(restored, true); assert.equal(result.width, 2); assert.match(result.url, /^blob:/); }
  finally { URL.revokeObjectURL(result.url); }
});

test('omitted motion is neutral and every motion uniform restores even when GPU cleanup fails', async () => {
  const values = { uDuration: 90000, uTime: 123, uPointScale: 300, uPointMax: 32, uSelLane: -1, uReplaying: 1,
    uMotionSpeed: .1, uMotionTurn: .2, uMotionCoherence: .3, uMotionEnergy: .4 };
  const uniforms = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value }]));
  let disposed = false;
  const renderer = { getRenderTarget: () => null, setRenderTarget: () => { throw new Error('Target context lost'); }, readRenderTargetPixels() {} };
  await assert.rejects(exportStill({ renderer, scene: {}, uniforms, sessionId: 'neutral', size: 2,
    render(target) {
      target.addEventListener('dispose', () => { disposed = true; });
      for (const key of ['uMotionSpeed', 'uMotionTurn', 'uMotionCoherence', 'uMotionEnergy']) assert.equal(uniforms[key].value, 0);
    },
  }), /Target context lost/);
  assert.equal(disposed, true);
  for (const [key, value] of Object.entries(values)) assert.equal(uniforms[key].value, value, key);
});
