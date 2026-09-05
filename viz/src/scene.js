// A physical camera moving through the artwork's three-dimensional space.
import * as THREE from 'three';
import { createArtworkPipeline } from './artwork-pipeline.js';
import { createCameraRig, fittedCameraPose, CAMERA_LIMITS } from './camera-rig.js';

export function createScene(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  const scene = new THREE.Scene();
  const pipeline = createArtworkPipeline(renderer);
  const camera = new THREE.PerspectiveCamera(CAMERA_LIMITS.fov, 1, .008, 80);
  const rig = createCameraRig();
  let viewW = 0; let viewH = 0; let fitted = true; let disposed = false;
  let revision = 0; let tilt = 0; let presentation = false;
  const clickListeners = new Set(); const hoverListeners = new Set(); const tiltListeners = new Set(); const journeyListeners = new Set();
  let journeyShown = false;
  const syncJourney = () => {
    if (journeyShown === rig.journeyActive) return;
    journeyShown = rig.journeyActive;
    journeyListeners.forEach((fn) => fn(journeyShown));
  };
  const stopJourney = () => { rig.stopJourney(); syncJourney(); };
  const startJourney = () => {
    fitted = false;
    rig.startJourney({ reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches });
    syncJourney(); revision++;
  };
  const syncCamera = () => {
    const state = rig.state; const position = rig.position;
    camera.position.set(position.x, position.y, position.z);
    camera.lookAt(state.target.x, state.target.y, state.target.z);
    camera.updateMatrixWorld();
  };
  const setTheme = (mode) => {
    pipeline.setTheme(mode);
    renderer.setClearColor(new THREE.Color().setRGB(.0015, .0022, .003));
    revision++;
  };
  setTheme('nebula');
  const fitCamera = (immediate = false) => {
    rig.set(fittedCameraPose({ width: viewW, height: viewH, presentation }), { immediate });
    syncJourney();
    if (immediate) syncCamera();
    revision++;
  };
  const resize = () => {
    if (disposed) return;
    const w = canvas.clientWidth || window.innerWidth; const h = canvas.clientHeight || window.innerHeight;
    if (!w || !h || (w === viewW && h === viewH)) return;
    viewW = w; viewH = h;
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
    if (fitted) fitCamera(true); else syncCamera();
    revision++;
  };
  resize();
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
  observer?.observe(canvas); window.addEventListener('resize', resize);
  const ndcFromScreen = (clientX, clientY) => {
    const rect = canvas.getBoundingClientRect();
    return { x: ((clientX - rect.left) / (rect.width || viewW || 1)) * 2 - 1,
      y: -((clientY - rect.top) / (rect.height || viewH || 1)) * 2 + 1 };
  };
  const raycaster = new THREE.Raycaster(); const targetPlane = new THREE.Plane();
  const direction = new THREE.Vector3(); const targetPoint = new THREE.Vector3();
  // Compatibility helper: intersection with the camera-facing target plane.
  // Picking callbacks use NDC directly and never flatten a perspective ray.
  const worldFromScreen = (clientX, clientY) => {
    const ndc = ndcFromScreen(clientX, clientY); const target = rig.state.target;
    targetPoint.set(target.x, target.y, target.z);
    camera.getWorldDirection(direction);
    targetPlane.setFromNormalAndCoplanarPoint(direction, targetPoint);
    raycaster.setFromCamera(ndc, camera);
    return raycaster.ray.intersectPlane(targetPlane, new THREE.Vector3()) ?? targetPoint.clone();
  };
  const setDistance = (distance, options) => { fitted = false; rig.setDistance(distance, options); syncJourney(); if (options?.immediate) syncCamera(); revision++; };
  const approach = (factor) => { fitted = false; rig.approach(factor); syncJourney(); revision++; };
  const orbitBy = (yaw, pitch) => { fitted = false; rig.orbit(yaw, pitch); syncJourney(); revision++; };
  const setCameraPose = (pose, options) => { fitted = false; rig.set(pose, options); syncJourney(); if (options?.immediate) syncCamera(); revision++; };
  const setTilt = (value) => {
    if (!Number.isFinite(value)) return;
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
  const resetDrag = () => {
    for (const id of pointers.keys()) if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
    pointers.clear(); last = null; pinching = false; canvas.classList.remove('is-dragging');
  };
  const pointerdown = (event) => {
    if (event.button !== 0 || pointers.size >= 2) return;
    stopJourney();
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    canvas.setPointerCapture(event.pointerId);
    if (pointers.size === 1) { moved = 0; last = { x: event.clientX, y: event.clientY }; }
    else { pinching = true; moved = 10; last = pair(); }
  };
  const pointermove = (event) => {
    if (!pointers.has(event.pointerId)) {
      if (pointers.size) return;
      const ndc = ndcFromScreen(event.clientX, event.clientY);
      hoverListeners.forEach((fn) => fn(ndc.x, ndc.y)); return;
    }
    if (event.pointerType === 'mouse' && event.buttons === 0) { resetDrag(); return; }
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size > 1) {
      const p = pair();
      if (last.d > 1 && p.d > 1) approach(p.d / last.d);
      rig.pan(p.x - last.x, p.y - last.y, viewH);
      fitted = false; last = p; revision++; return;
    }
    const dx = event.clientX - last.x; const dy = event.clientY - last.y;
    moved += Math.abs(dx) + Math.abs(dy); last = { x: event.clientX, y: event.clientY };
    if (moved > 4) canvas.classList.add('is-dragging');
    fitted = false;
    if (event.shiftKey) rig.pan(dx, dy, viewH);
    else rig.orbit(-dx * .004, dy * .004);
    revision++;
  };
  const pointerup = (event) => {
    if (!pointers.has(event.pointerId)) return;
    pointers.delete(event.pointerId);
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    if (pointers.size) { last = [...pointers.values()][0]; return; }
    const click = moved < 5 && !pinching;
    resetDrag();
    if (click) { const ndc = ndcFromScreen(event.clientX, event.clientY); clickListeners.forEach((fn) => fn(ndc.x, ndc.y)); }
  };
  const pointerleave = () => { if (!pointers.size) hoverListeners.forEach((fn) => fn(null, null)); };
  const wheel = (event) => {
    event.preventDefault();
    const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewH : 1);
    approach(Math.exp(-Math.max(-500, Math.min(500, pixels)) * .0015));
  };
  const handlers = { pointerdown, pointermove, pointerup, pointercancel: resetDrag, pointerleave, wheel };
  for (const [name, handler] of Object.entries(handlers)) canvas.addEventListener(name, handler, name === 'wheel' ? { passive: false } : undefined);
  window.addEventListener('blur', resetDrag);
  const fit = ({ immediate = false } = {}) => { fitted = true; resize(); fitCamera(immediate); setTilt(0); };
  const origin = new THREE.Vector3();
  return {
    renderer, scene, camera, resize, fit, worldFromScreen, ndcFromScreen, setTheme, setTilt, setDistance, approach, orbitBy, setCameraPose, startJourney, stopJourney,
    tick(dt) { if (!disposed && rig.tick(dt)) { syncCamera(); revision++; } syncJourney(); return revision; },
    setPresentation(on) { presentation = !!on; if (fitted) fitCamera(); revision++; },
    render: (target = null, exportCamera = camera) => pipeline.render(scene, exportCamera, target),
    get revision() { return revision; }, get tilt() { return tilt; },
    get distance() { return rig.state.distance; }, get desiredDistance() { return rig.desired.distance; },
    get minDistance() { return CAMERA_LIMITS.minDistance; }, get maxDistance() { return CAMERA_LIMITS.maxDistance; },
    get cameraRig() { return rig.state; }, get isFitted() { return fitted; },
    get journeyActive() { return rig.journeyActive; },
    onJourneyChange: (fn) => { journeyListeners.add(fn); return () => journeyListeners.delete(fn); },
    onCanvasClick: (fn) => { clickListeners.add(fn); return () => clickListeners.delete(fn); },
    onHover: (fn) => { hoverListeners.add(fn); return () => hoverListeners.delete(fn); },
    onTilt: (fn) => { tiltListeners.add(fn); return () => tiltListeners.delete(fn); },
    pixelsPerWorldUnit() {
      const depth = -origin.set(0, 0, 0).applyMatrix4(camera.matrixWorldInverse).z;
      return viewH / (2 * Math.tan(camera.fov * Math.PI / 360) * Math.max(camera.near, depth));
    },
    dispose() {
      if (disposed) return; disposed = true;
      observer?.disconnect(); window.removeEventListener('resize', resize); window.removeEventListener('blur', resetDrag);
      for (const [name, handler] of Object.entries(handlers)) canvas.removeEventListener(name, handler);
      clickListeners.clear(); hoverListeners.clear(); tiltListeners.clear(); journeyListeners.clear(); resetDrag(); rig.stopJourney(); pipeline.dispose(); renderer.dispose();
    },
  };
}
