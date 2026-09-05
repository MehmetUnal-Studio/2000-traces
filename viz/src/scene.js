// A quiet, centered gallery stage. Every visible mark belongs to the dataset.
import * as THREE from 'three';
import { createArtworkPipeline } from './artwork-pipeline.js';

export function createScene(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  const scene = new THREE.Scene();
  const pipeline = createArtworkPipeline(renderer);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -10, 10);
  camera.position.z = 2;
  let viewW = 0; let viewH = 0; let fitted = true; let disposed = false;
  let revision = 0; let tilt = 0; let presentation = false;
  const clickListeners = new Set();
  const hoverListeners = new Set();
  const tiltListeners = new Set();
  const setTheme = (mode) => {
    pipeline.setTheme(mode);
    renderer.setClearColor(new THREE.Color().setRGB(0.0015, 0.0022, 0.0030));
    revision++;
  };
  setTheme('nebula');
  const fitCamera = () => {
    const aspect = viewW / viewH;
    const frame = presentation ? 70 : viewW < 700 ? 260 : 190;
    camera.zoom = Math.max(0.15, Math.min((viewH - frame) / viewH / 1.05, aspect * (presentation ? 0.90 : 0.87)));
    camera.position.set(0, presentation ? 0 : viewW < 700 ? -0.20 / camera.zoom : -0.018, 2);
    camera.updateProjectionMatrix();
  };
  const resize = () => {
    if (disposed) return;
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    if (!w || !h || (w === viewW && h === viewH)) return;
    viewW = w; viewH = h;
    renderer.setSize(w, h, false);
    const aspect = w / h;
    camera.left = -aspect; camera.right = aspect; camera.top = 1; camera.bottom = -1;
    if (fitted) fitCamera(); else camera.updateProjectionMatrix();
    revision++;
  };
  resize();
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
  observer?.observe(canvas);
  window.addEventListener('resize', resize);
  const worldFromScreen = (clientX, clientY) => {
    resize(); camera.updateMatrixWorld();
    const rect = canvas.getBoundingClientRect();
    return new THREE.Vector3(
      ((clientX - rect.left) / (rect.width || viewW || 1)) * 2 - 1,
      -((clientY - rect.top) / (rect.height || viewH || 1)) * 2 + 1, 0,
    ).unproject(camera);
  };
  const zoomAt = (factor, x, y) => {
    const before = worldFromScreen(x, y);
    fitted = false;
    camera.zoom = Math.min(48, Math.max(0.15, camera.zoom * factor));
    camera.updateProjectionMatrix();
    const after = worldFromScreen(x, y);
    camera.position.x += before.x - after.x;
    camera.position.y += before.y - after.y;
    revision++;
  };
  const setTilt = (value) => {
    const limit = 35 * Math.PI / 180;
    tilt = Math.max(-limit, Math.min(limit, value));
    tiltListeners.forEach((fn) => fn(tilt)); revision++;
  };
  const pointers = new Map();
  let moved = 0; let last = null; let pinching = false;
  const pair = () => {
    const [a, b] = [...pointers.values()];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) };
  };
  const resetDrag = () => { pointers.clear(); last = null; pinching = false; canvas.classList.remove('is-dragging'); };
  const pointerdown = (e) => {
    if (e.button !== 0) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    canvas.setPointerCapture(e.pointerId);
    if (pointers.size === 1) { moved = 0; last = { x: e.clientX, y: e.clientY }; }
    else { pinching = true; moved = 10; last = pair(); }
  };
  const pointermove = (e) => {
    if (!pointers.has(e.pointerId)) {
      const w = worldFromScreen(e.clientX, e.clientY);
      hoverListeners.forEach((fn) => fn(w.x, w.y)); return;
    }
    if (e.pointerType === 'mouse' && e.buttons === 0) { resetDrag(); return; }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size > 1) {
      const p = pair();
      zoomAt(last.d > 1 ? p.d / last.d : 1, p.x, p.y);
      camera.position.x -= (p.x - last.x) / viewH * 2 / camera.zoom;
      camera.position.y += (p.y - last.y) / viewH * 2 / camera.zoom;
      last = p; return;
    }
    const dx = e.clientX - last.x; const dy = e.clientY - last.y;
    moved += Math.abs(dx) + Math.abs(dy); last = { x: e.clientX, y: e.clientY };
    if (moved > 4) canvas.classList.add('is-dragging');
    if (e.shiftKey) setTilt(tilt + dy * 0.005);
    else {
      fitted = false;
      camera.position.x -= dx / viewH * 2 / camera.zoom;
      camera.position.y += dy / viewH * 2 / camera.zoom; revision++;
    }
  };
  const pointerup = (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    if (pointers.size) { last = pointers.size > 1 ? pair() : [...pointers.values()][0]; return; }
    const click = moved < 5 && !pinching;
    resetDrag();
    if (click) { const w = worldFromScreen(e.clientX, e.clientY); clickListeners.forEach((fn) => fn(w.x, w.y)); }
  };
  const pointerleave = () => { if (!pointers.size) hoverListeners.forEach((fn) => fn(null, null)); };
  const wheel = (e) => { e.preventDefault(); zoomAt(Math.exp(-e.deltaY * 0.0016), e.clientX, e.clientY); };
  const handlers = { pointerdown, pointermove, pointerup, pointercancel: resetDrag, pointerleave, wheel };
  for (const [name, handler] of Object.entries(handlers)) canvas.addEventListener(name, handler, name === 'wheel' ? { passive: false } : undefined);
  window.addEventListener('blur', resetDrag);
  const fit = () => { fitted = true; resize(); fitCamera(); setTilt(0); revision++; };
  return {
    renderer, scene, camera, resize, fit, worldFromScreen, setTheme, setTilt,
    setPresentation(on) { presentation = !!on; if (fitted) fitCamera(); revision++; },
    render: (target = null, exportCamera = camera) => pipeline.render(scene, exportCamera, target),
    get revision() { return revision; }, get tilt() { return tilt; },
    onCanvasClick: (fn) => { clickListeners.add(fn); return () => clickListeners.delete(fn); },
    onHover: (fn) => { hoverListeners.add(fn); return () => hoverListeners.delete(fn); },
    onTilt: (fn) => { tiltListeners.add(fn); return () => tiltListeners.delete(fn); },
    pixelsPerWorldUnit: () => (viewH / 2) * camera.zoom,
    dispose() {
      if (disposed) return; disposed = true;
      observer?.disconnect(); window.removeEventListener('resize', resize); window.removeEventListener('blur', resetDrag);
      for (const [name, handler] of Object.entries(handlers)) canvas.removeEventListener(name, handler);
      clickListeners.clear(); hoverListeners.clear(); tiltListeners.clear(); resetDrag(); pipeline.dispose(); renderer.dispose();
    },
  };
}
