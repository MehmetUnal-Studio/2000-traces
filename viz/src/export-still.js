// viz/src/export-still.js
// Renders the finished artwork (full disc, uTime = duration) into an offscreen
// 4096x4096 target and hands the viewer a PNG preview URL. The caller owns
// that URL and revokes it when the preview closes or is replaced.
import * as THREE from 'three';

export async function exportStill({ renderer, scene, uniforms, playheadMat = null, sessionId, size = 4096, render, mode = 'nebula', activity = 0 }) {
  const extent = 1.12;
  const camera = new THREE.PerspectiveCamera(45, 1, .008, 80);
  camera.position.z = extent / Math.sin(Math.PI / 8);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();

  const target = new THREE.WebGLRenderTarget(size, size, { samples: render ? 0 : 4 });
  const prevTime = uniforms.uTime.value;
  const prevScale = uniforms.uPointScale.value;
  const prevSel = uniforms.uSelLane.value;
  const prevReplaying = uniforms.uReplaying.value;
  const prevMax = uniforms.uPointMax.value;
  const prevPlayhead = playheadMat ? playheadMat.opacity : 0;
  const prevTarget = renderer.getRenderTarget();
  const inspection = ['uSelRow', 'uSelColumn', 'uHoverRow', 'uHoverColumn', 'uHoverLane']
    .filter((key) => uniforms[key]).map((key) => [key, uniforms[key].value]);
  for (const [key] of inspection) uniforms[key].value = -1;
  const prevTilt = uniforms.uTilt?.value;
  const prevOrbit = uniforms.uOrbit?.value;
  const prevAnimation = uniforms.uAnimation?.value;
  const prevActivity = uniforms.uActivity?.value;
  const prevViewport = uniforms.uViewportHeight?.value;
  if (uniforms.uViewportHeight) uniforms.uViewportHeight.value = size;
  if (uniforms.uAnimation) uniforms.uAnimation.value = 0;
  if (uniforms.uActivity) uniforms.uActivity.value = Math.max(0, Math.min(1, activity));
  if (uniforms.uTilt) uniforms.uTilt.value = 0;
  if (uniforms.uOrbit) uniforms.uOrbit.value = 0;
  uniforms.uTime.value = uniforms.uDuration.value;
  uniforms.uPointScale.value = size / (extent * 2);
  uniforms.uSelLane.value = -1;
  // finished-state render: no fresh-glow wedge, no playhead ray in the archive
  uniforms.uReplaying.value = 0;
  // Preserve the current renderer's luminous-core proportions at print size.
  uniforms.uPointMax.value = Math.max(prevMax, prevMax * uniforms.uPointScale.value / Math.max(1, prevScale));
  if (playheadMat) playheadMat.opacity = 0;

  const pixels = new Uint8Array(size * size * 4);
  try {
    if (render) render(target, camera);
    else { renderer.setRenderTarget(target); renderer.render(scene, camera); }
    renderer.readRenderTargetPixels(target, 0, 0, size, size, pixels);
  } finally {
    // a throw (e.g. context loss allocating the 4096² MSAA target) must never
    // leave the live view stuck with forced export uniforms
    renderer.setRenderTarget(prevTarget);
    target.dispose();
    uniforms.uTime.value = prevTime;
    uniforms.uPointScale.value = prevScale;
    uniforms.uSelLane.value = prevSel;
    uniforms.uReplaying.value = prevReplaying;
    uniforms.uPointMax.value = prevMax;
    for (const [key, value] of inspection) uniforms[key].value = value;
    if (uniforms.uTilt) uniforms.uTilt.value = prevTilt;
    if (uniforms.uOrbit) uniforms.uOrbit.value = prevOrbit;
    if (uniforms.uAnimation) uniforms.uAnimation.value = prevAnimation;
    if (uniforms.uActivity) uniforms.uActivity.value = prevActivity;
    if (uniforms.uViewportHeight) uniforms.uViewportHeight.value = prevViewport;
    if (playheadMat) playheadMat.opacity = prevPlayhead;
  }

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

  const blob = await new Promise((resolve, reject) => canvas.toBlob(
    (value) => value ? resolve(value) : reject(new Error('PNG oluşturulamadı. Yeniden deneyin.')), 'image/png',
  ));
  return {
    width: size, height: size, bytes: blob.size, url: URL.createObjectURL(blob),
    filename: `2000-traces-${sessionId}-${mode}-${size}px.png`,
  };
}
