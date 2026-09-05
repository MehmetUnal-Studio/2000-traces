import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createNebulaCameraPicker, createNebulaUniforms } from '../viz/src/nebula.js';
import { coreDiskMatrix } from '../viz/src/core-lensing.js';
import { CORE_RAY, traceCoreRay } from '../viz/src/core-ray.js';
import { projectLens, lensSourceNdc } from '../viz/src/lensing.js';

test('captured rays outside the straight horizon hide rear data while retaining exact foreground identity', () => {
  for (const aspect of [.75, 1.6, 2.4]) for (const eye of [[0, 0, 3], [2.4, .8, 1.8], [-1.8, .6, -2.2]]) {
    const camera = new THREE.PerspectiveCamera(45, aspect, .008, 80);
    const object = new THREE.Group();
    object.position.set(.07, -.03, .04); object.scale.setScalar(1.15); object.updateMatrixWorld();
    camera.position.set(...eye); camera.lookAt(object.position); camera.updateMatrixWorld();
    const uniforms = createNebulaUniforms(1000);
    uniforms.uTime.value = 700; uniforms.uTilt.value = .31; uniforms.uOrbit.value = .47;
    const disk = coreDiskMatrix(uniforms, object.matrixWorld), inverse = disk.clone().invert();
    const sphere = new THREE.Sphere(object.position, CORE_RAY.horizon * 1.15);
    const lens = projectLens(camera, sphere.center, sphere.radius);
    const ray = new THREE.Raycaster();
    let capturedPixel = null;
    for (let scale = 1.01; scale < 1.8; scale += .02) {
      const pixel = new THREE.Vector2(lens.x * 2 - 1 + lens.radius * 2 * scale / aspect, lens.y * 2 - 1);
      ray.setFromCamera(pixel, camera);
      const origin = ray.ray.origin.clone().applyMatrix4(inverse);
      const direction = ray.ray.direction.clone().transformDirection(inverse);
      if (!ray.ray.intersectsSphere(sphere) && traceCoreRay(origin.toArray(), direction.toArray()).captured) {
        capturedPixel = pixel; break;
      }
    }
    assert.ok(capturedPixel, 'fixture must lie in the curved captured annulus, beyond the geometric sphere');
    const source = lensSourceNdc(capturedPixel.x, capturedPixel.y, lens);
    ray.setFromCamera(new THREE.Vector2(source.x, source.y), camera);
    const rear = ray.ray.at(camera.position.distanceTo(object.position) + 1, new THREE.Vector3()).applyMatrix4(inverse);
    const rearOnly = createNebulaCameraPicker(uniforms, new Float32Array(rear.toArray()), { object });
    rearOnly.setCamera(camera, 1200);
    assert.equal(rearOnly.inspectNdc(capturedPixel.x, capturedPixel.y), null, 'captured background cannot be selected through the visible shadow');

    ray.setFromCamera(capturedPixel, camera);
    const front = ray.ray.at(camera.position.distanceTo(object.position) * .35, new THREE.Vector3()).applyMatrix4(inverse);
    const sourceIdentity = { lane: 17, finger: 3, index: 81, x: .123456789, y: .987654321 };
    const positions = new Float32Array([...front.toArray(), ...rear.toArray()]);
    const picker = createNebulaCameraPicker(uniforms, positions, { object, makeHit: (index) => index === 0 ? sourceIdentity : null });
    picker.setCamera(camera, 1200);
    assert.equal(picker.inspectNdc(capturedPixel.x, capturedPixel.y), sourceIdentity, 'foreground preserves the original event identity, including precise XY');
  }
});

test('edge-on finite plasma hides a point between its near surface and the horizon at display and print resolution', () => {
  for (const viewportHeight of [720, 4096]) for (const animation of [0, 17.5]) {
    const uniforms = createNebulaUniforms(1000);
    uniforms.uTime.value = 1000; uniforms.uAnimation.value = animation;
    uniforms.uMotionSpeed.value = .6; uniforms.uMotionTurn.value = .3; uniforms.uMotionCoherence.value = .7;
    const disk = coreDiskMatrix(uniforms);
    const camera = new THREE.PerspectiveCamera(45, 1.6, .008, 80);
    camera.position.set(0, -2.5, 0).applyMatrix4(disk);
    camera.up.set(0, 0, 1).transformDirection(disk);
    camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
    const ray = traceCoreRay([0, -2.5, 0], [0, 1, 0], {
      pixelCone: 2 / (Math.abs(camera.projectionMatrix.elements[5]) * viewportHeight),
      animation, motionSpeed: .6, motionTurn: .3, motionCoherence: .7,
    });
    assert.equal(ray.captured, true);
    assert.equal(ray.crossings.length, 0, 'middle-plane intersection cannot represent an edge-on finite slab');
    assert.ok(ray.depthPoints.some((point) => point[1] < -.35), 'near plasma writes depth before the source at radius .30');
    const hidden = createNebulaCameraPicker(uniforms, new Float32Array([0, -.3, 0]));
    hidden.setCamera(camera, viewportHeight);
    assert.equal(hidden.inspectNdc(0, 0), null, 'a source in front of the horizon but behind near plasma is hidden');
    const foreground = createNebulaCameraPicker(uniforms, new Float32Array([0, -.6, 0, 0, -.3, 0]));
    foreground.setCamera(camera, viewportHeight);
    assert.equal(foreground.inspectNdc(0, 0), 0, 'the actual foreground remains selectable');
  }
});
