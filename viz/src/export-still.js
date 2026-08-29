// viz/src/export-still.js
// Renders the finished artwork (full disc, uTime = duration) into an offscreen
// 4096x4096 target and hands the viewer a PNG — print/archive quality.
import * as THREE from 'three';

export function exportStill({ renderer, scene, uniforms, playheadMat = null, sessionId, size = 4096 }) {
  const camera = new THREE.OrthographicCamera(-1.02, 1.02, 1.02, -1.02, -10, 10);
  camera.position.z = 1;

  const target = new THREE.WebGLRenderTarget(size, size, { samples: 4 });
  const prevTime = uniforms.uTime.value;
  const prevScale = uniforms.uPointScale.value;
  const prevSel = uniforms.uSelLane.value;
  const prevReplaying = uniforms.uReplaying.value;
  const prevMax = uniforms.uPointMax.value;
  const prevPlayhead = playheadMat ? playheadMat.opacity : 0;
  uniforms.uTime.value = uniforms.uDuration.value;
  uniforms.uPointScale.value = size / 2.04;
  uniforms.uSelLane.value = -1;
  // finished-state render: no fresh-glow wedge, no playhead ray in the archive
  uniforms.uReplaying.value = 0;
  // scale the point-size cap with the target so marks keep their on-screen
  // proportion (8px cap at ~screen scale -> ~24px at 4096)
  uniforms.uPointMax.value = size / 170;
  if (playheadMat) playheadMat.opacity = 0;

  renderer.setRenderTarget(target);
  renderer.render(scene, camera);
  const pixels = new Uint8Array(size * size * 4);
  renderer.readRenderTargetPixels(target, 0, 0, size, size, pixels);
  renderer.setRenderTarget(null);
  target.dispose();

  uniforms.uTime.value = prevTime;
  uniforms.uPointScale.value = prevScale;
  uniforms.uSelLane.value = prevSel;
  uniforms.uReplaying.value = prevReplaying;
  uniforms.uPointMax.value = prevMax;
  if (playheadMat) playheadMat.opacity = prevPlayhead;

  // flip vertically into a canvas
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(size, size);
  const rowBytes = size * 4;
  for (let y = 0; y < size; y++) {
    image.data.set(pixels.subarray((size - 1 - y) * rowBytes, (size - y) * rowBytes), y * rowBytes);
  }
  ctx.putImageData(image, 0, 0);

  canvas.toBlob((blob) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `2000-traces-${sessionId}-${size}px.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }, 'image/png');
}
