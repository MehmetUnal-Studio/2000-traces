import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { CAMERA_LIMITS, createCameraRig, fittedCameraPose, cameraBasis, cameraPosition } from '../viz/src/camera-rig.js';

function cameraFor(pose, aspect = 1) {
  const camera = new THREE.PerspectiveCamera(CAMERA_LIMITS.fov, aspect, .008, 80);
  const position = cameraPosition(pose);
  camera.position.set(position.x, position.y, position.z);
  camera.lookAt(pose.target.x, pose.target.y, pose.target.z);
  camera.updateMatrixWorld();
  return camera;
}
const pose = (distance = 4) => ({ distance, yaw: 0, pitch: 0, target: { x: 0, y: 0, z: 0 } });

test('physical approach produces depth-dependent parallax with fixed FOV and zoom', () => {
  const far = cameraFor(pose(4)); const near = cameraFor(pose(.6));
  const foreground = new THREE.Vector3(.06, .03, .25);
  const background = new THREE.Vector3(.06, .03, -.4);
  const foregroundGrowth = foreground.clone().project(near).x / foreground.clone().project(far).x;
  const backgroundGrowth = background.clone().project(near).x / background.clone().project(far).x;
  assert.ok(foregroundGrowth > backgroundGrowth * 2);
  assert.equal(far.fov, near.fov); assert.equal(far.zoom, 1); assert.equal(near.zoom, 1);
  assert.equal(near.position.z, .6);
});

test('gallery fitting keeps the full unit sphere in frame across mobile and desktop', () => {
  for (const [width, height] of [[390, 844], [320, 568], [1440, 900], [1280, 720], [900, 430]]) {
    for (const presentation of [false, true]) {
      const fit = fittedCameraPose({ width, height, presentation });
      const camera = cameraFor(fit, width / height);
      for (let longitude = 0; longitude < 24; longitude++) for (let latitude = 0; latitude <= 12; latitude++) {
        const theta = longitude / 24 * Math.PI * 2; const phi = latitude / 12 * Math.PI;
        const point = new THREE.Vector3(1.1 * Math.sin(phi) * Math.cos(theta), 1.1 * Math.cos(phi), 1.1 * Math.sin(phi) * Math.sin(theta)).project(camera);
        assert.ok(Math.abs(point.x) < 1 && Math.abs(point.y) < 1 && point.z > -1 && point.z < 1, `${width}×${height}, presentation=${presentation}`);
      }
      if (presentation) assert.equal(fit.target.y, 0);
    }
  }
});

test('damping is frame-rate independent and settles without overshooting a dolly', () => {
  const a = createCameraRig(pose()); const b = createCameraRig(pose());
  for (const rig of [a, b]) rig.set({ distance: .6, yaw: .6, pitch: -.3, target: { x: .1, y: -.05, z: .03 } });
  for (let i = 0; i < 30; i++) a.tick(1000 / 60);
  for (let i = 0; i < 15; i++) b.tick(1000 / 30);
  for (const key of ['distance', 'yaw', 'pitch']) assert.ok(Math.abs(a.state[key] - b.state[key]) < 1e-10);
  let previous = a.state.distance;
  for (let i = 0; i < 200; i++) { a.tick(16); assert.ok(a.state.distance <= previous + 1e-12); assert.ok(a.state.distance >= .6 - 1e-12); previous = a.state.distance; }
  assert.ok(Math.abs(a.state.distance - .6) < 1e-8);
  assert.equal(a.tick(16), false);
});

test('dolly limits and core clearance remain safe after a target pan', () => {
  const rig = createCameraRig(pose());
  rig.setDistance(0, { immediate: true });
  assert.equal(rig.state.distance, CAMERA_LIMITS.minDistance);
  rig.setDistance(1e6, { immediate: true });
  assert.equal(rig.state.distance, CAMERA_LIMITS.maxDistance);
  rig.set({ distance: .36, target: { x: 0, y: 0, z: -1 } }, { immediate: true });
  assert.ok(Math.hypot(...Object.values(rig.position)) > CAMERA_LIMITS.coreClearance);
  rig.orbit(.18, .08);
  for (let i = 0; i < 100; i++) { rig.tick(16); assert.ok(Math.hypot(...Object.values(rig.position)) >= CAMERA_LIMITS.coreClearance); }
});

test('orbit preserves target distance; pan uses the rotated camera screen plane', () => {
  const rig = createCameraRig(pose(2));
  rig.set({ yaw: 1.1, pitch: .42 }, { immediate: true });
  assert.ok(Math.abs(Math.hypot(...Object.values(rig.position)) - 2) < 1e-12);
  const basis = cameraBasis(rig.state);
  rig.pan(30, -20, 900);
  const target = rig.desired.target;
  const dot = target.x * basis.backward.x + target.y * basis.backward.y + target.z * basis.backward.z;
  assert.ok(Math.abs(dot) < 1e-12);
  assert.ok(Math.abs(target.z) > .02); // panning is not restricted to world X/Y.
  rig.set({ pitch: Infinity, yaw: NaN, target: { x: NaN, y: Infinity } }, { immediate: true });
  for (const value of Object.values(rig.position)) assert.ok(Number.isFinite(value));
});

test('explicit journey reaches the core view after twelve seconds with a gentle physical orbit', () => {
  const rig = createCameraRig({ ...pose(4), yaw: .4, pitch: .1, target: { x: .12, y: -.3, z: 0 } });
  assert.equal(rig.journeyActive, false);
  rig.startJourney();
  rig.tick(6000);
  assert.equal(rig.journeyActive, true);
  assert.ok(rig.state.distance < 4 && rig.state.distance > .95);
  assert.ok(Math.abs(rig.state.yaw - .49) < 1e-12);
  assert.ok(Math.abs(rig.state.target.y + .15) < 1e-12);
  rig.tick(6000);
  assert.equal(rig.journeyActive, false);
  assert.ok(Math.abs(rig.state.distance - .95) < 1e-12);
  assert.ok(Math.abs(rig.state.yaw - .58) < 1e-12);
  assert.deepEqual(rig.state.target, { x: 0, y: -0, z: 0 });
  assert.equal(cameraFor(rig.state).zoom, 1);
});

test('stop and manual controls cancel the journey without resuming its old destination', () => {
  const rig = createCameraRig(pose()); rig.startJourney(); rig.tick(3000);
  rig.stopJourney(); const stopped = rig.state;
  for (let i = 0; i < 100; i++) rig.tick(16);
  assert.deepEqual(rig.state, stopped);
  for (const action of [() => rig.approach(1.2), () => rig.orbit(.02, .01), () => rig.pan(10, 3, 900), () => rig.set(fittedCameraPose({ width: 1440, height: 900 }))]) {
    rig.startJourney(); action(); assert.equal(rig.journeyActive, false);
  }
});

test('reduced-motion journey uses a short straight move, with core collision protection throughout', () => {
  const rig = createCameraRig({ ...pose(2), yaw: .7, target: { x: 0, y: 0, z: -1 } });
  rig.startJourney({ reducedMotion: true });
  for (let i = 0; i < 35; i++) {
    rig.tick(10);
    assert.equal(rig.state.yaw, .7);
    assert.ok(Math.hypot(...Object.values(rig.position)) >= CAMERA_LIMITS.coreClearance);
  }
  assert.equal(rig.journeyActive, false);
  assert.ok(Math.abs(rig.state.distance - .95) < 1e-12);
});
