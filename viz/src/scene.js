// viz/src/scene.js
// Renderer + orthographic camera with cursor-anchored zoom and drag pan.
import * as THREE from 'three';

export function createScene(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x0a0b0e, 1);

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -10, 10);
  camera.position.z = 1;
  camera.zoom = 0.92;

  let viewH = 600; // last non-zero height; a hidden pane reports 0x0
  const resize = () => {
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    if (!w || !h) return; // pane hidden — keep the last valid camera
    viewH = h;
    renderer.setSize(w, h, false);
    const aspect = w / h;
    camera.left = -aspect; camera.right = aspect; camera.top = 1; camera.bottom = -1;
    camera.updateProjectionMatrix();
  };
  window.addEventListener('resize', resize);
  resize();

  const worldFromScreen = (clientX, clientY) => {
    resize(); // pick up real dimensions if the pane was just unhidden
    const rect = canvas.getBoundingClientRect();
    const w = rect.width || window.innerWidth || 1;
    const h = rect.height || viewH;
    const ndcX = ((clientX - rect.left) / w) * 2 - 1;
    const ndcY = -(((clientY - rect.top) / h) * 2 - 1);
    return new THREE.Vector3(ndcX, ndcY, 0).unproject(camera);
  };

  // --- interaction ---------------------------------------------------------
  let dragging = false; let moved = 0; let last = null;
  const listeners = { click: [] };

  const resetDrag = () => { dragging = false; last = null; };

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return; // right/middle click must not start a pan
    dragging = true; moved = 0; last = [e.clientX, e.clientY];
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    // self-heal: a swallowed pointerup (native context menu etc.) leaves the
    // flag stuck — no button held means no drag
    if (e.buttons === 0) { resetDrag(); return; }
    const dx = e.clientX - last[0]; const dy = e.clientY - last[1];
    moved += Math.abs(dx) + Math.abs(dy);
    last = [e.clientX, e.clientY];
    camera.position.x -= (dx / viewH) * 2 / camera.zoom;
    camera.position.y += (dy / viewH) * 2 / camera.zoom;
  });
  canvas.addEventListener('pointerup', (e) => {
    if (e.button !== 0) return; // mirror pointerdown: only the primary button
    const wasDragging = dragging;
    resetDrag();
    if (wasDragging && moved < 5) {
      const w = worldFromScreen(e.clientX, e.clientY);
      listeners.click.forEach((fn) => fn(w.x, w.y));
    }
  });
  canvas.addEventListener('pointercancel', resetDrag);
  canvas.addEventListener('lostpointercapture', resetDrag);
  window.addEventListener('blur', resetDrag);
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const before = worldFromScreen(e.clientX, e.clientY);
    const factor = Math.exp(-e.deltaY * 0.0016);
    camera.zoom = Math.min(240, Math.max(0.5, camera.zoom * factor));
    camera.updateProjectionMatrix();
    const after = worldFromScreen(e.clientX, e.clientY);
    camera.position.x += before.x - after.x;
    camera.position.y += before.y - after.y;
  }, { passive: false });

  const fit = () => { camera.position.set(0, 0, 1); camera.zoom = 0.92; camera.updateProjectionMatrix(); };

  return {
    renderer, scene, camera, resize, fit, worldFromScreen,
    onCanvasClick: (fn) => listeners.click.push(fn),
    pixelsPerWorldUnit: () => (viewH / 2) * camera.zoom,
  };
}
