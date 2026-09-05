import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { CORE_RAY, raySphereInterval, traceCoreRay } from '../viz/src/core-ray.js';
import { createLensedCore, coreDiskMatrix, coreScreenBounds } from '../viz/src/core-lensing.js';

const close=(a,b,epsilon=1e-9)=>assert.ok(Math.abs(a-b)<epsilon,`${a} != ${b}`);

test('curved camera rays reveal the actual far side above and below the horizon',()=>{
  for(const side of [-1,1]) {
    const origin=[0,-2.5,side*.09],direction=[0,2.5,side*(.32-.09)];
    const bent=traceCoreRay(origin,direction),straight=traceCoreRay(origin,direction,{curvature:0});
    assert.equal(straight.crossings.length,0,'the ray without gravity cannot see the disk');
    assert.equal(bent.captured,false);
    assert.equal(bent.crossings.length,1);
    assert.ok(bent.crossings[0].point[1]>.30,'light comes from the actual far side, not a copied near-side image');
    assert.ok(bent.crossings[0].radius<CORE_RAY.outer);
    close(bent.crossings[0].point[2],0);
    assert.ok(bent.steps<=CORE_RAY.steps);
  }
});

test('horizon terminates rays while nearer disk emission remains visible in front',()=>{
  const center=traceCoreRay([0,0,2],[0,0,-1]);
  assert.equal(center.captured,true);assert.deepEqual(center.crossings,[]);
  close(Math.hypot(...center.horizonPoint),CORE_RAY.horizon,1e-8);
  const front=traceCoreRay([0,-2.5,.09],[0,2.15,-.09]);
  assert.ok(front.crossings.length>0);
  assert.ok(front.crossings[0].point[1]<0,'the crossing is between the observer and the horizon');
  assert.equal(front.captured,true,'near-side emission is collected before capture');
  const miss=traceCoreRay([2,0,2],[0,0,-1]);
  assert.equal(miss.captured,false);assert.equal(miss.steps,0);
  assert.equal(raySphereInterval([2,0,2],[0,0,-1],CORE_RAY.extent),null);
});

test('exactly edge-on captured rays expose the near slab depth even without a plane crossing',()=>{
  const options={pixelCone:2*Math.tan(Math.PI/8)/720,perspective:true,animation:32,
    motionSpeed:.7,motionTurn:-.4,motionCoherence:.6};
  for(const z of [0,.001,-.003]) {
    const ray=traceCoreRay([0,-2.5,z],[0,1,0],options);
    assert.equal(ray.captured,true);
    assert.equal(ray.crossings.length,0,'lying in/along the finite slab does not create a z=0 crossing');
    assert.ok(ray.depthPoints.length>1,'emitting slab samples must precede the horizon');
    assert.ok(ray.depthPoints[0][1]<-.38,'the first emitting depth is the near disk, not the later horizon');
    assert.equal(ray.depthPoints.at(-1),ray.horizonPoint);
    const firstDepth=Math.min(...ray.depthPoints.map(point=>point[1]+2.5));
    const markBetweenDiskAndHorizon=2.2;
    assert.ok(firstDepth<markBetweenDiskAndHorizon,'a point hidden behind the near plasma is excluded by the compositor depth');
    assert.ok(ray.horizonPoint[1]+2.5>markBetweenDiskAndHorizon,'horizon-only picking would incorrectly allow that point');
    assert.equal(ray.opacity,1);
  }
});

test('slab depth honors physical thickness and the same subpixel footprint as the material',()=>{
  const origin=[0,-2.5,.01],direction=[0,1,0];
  const print=traceCoreRay(origin,direction,{pixelCone:2*Math.tan(Math.PI/8)/4096});
  assert.equal(print.captured,true);
  assert.deepEqual(print.depthPoints,[print.horizonPoint],'a ray outside the resolved thin disk creates no false foreground depth');
  const thumbnail=traceCoreRay(origin,direction,{pixelCone:2*Math.tan(Math.PI/8)/64});
  assert.equal(thumbnail.captured,true);
  assert.ok(thumbnail.depthPoints.length>1,'a widened unresolved slab writes depth at the same samples used by its GPU coverage');
  assert.ok(thumbnail.depthPoints[0][1]<-.38);
  const repeated=traceCoreRay(origin,direction,{pixelCone:2*Math.tan(Math.PI/8)/64});
  assert.deepEqual(thumbnail,repeated,'seeking/picking the same camera and frame is deterministic');
});

test('ray integration is continuous for neighboring pixels and bounded near the critical ring',()=>{
  let previous=null;
  for(let h=.294;h<=.342;h+=.001) {
    const trace=traceCoreRay([0,-2.5,.09],[0,2.5,h-.09]);
    assert.ok(trace.steps<=CORE_RAY.steps);
    assert.equal(trace.crossings.length,1);
    const r=trace.crossings[0].radius;
    if(previous!==null)assert.ok(r>previous&&r-previous<.006,'far-side samples vary continuously, with no UV-cut seam');
    previous=r;
  }
});

test('local disk frame matches Nebula orbit, inclination and parent placement',()=>{
  const uniforms={uTime:{value:721},uDuration:{value:1000},uOrbit:{value:.6},uTilt:{value:-.24}};
  const parent=new THREE.Matrix4().compose(new THREE.Vector3(.4,-.2,.1),new THREE.Quaternion().setFromEuler(new THREE.Euler(.1,.2,.3)),new THREE.Vector3(1.2,1.2,1.2));
  const actual=coreDiskMatrix(uniforms,parent);
  const expected=parent.clone().multiply(new THREE.Matrix4().makeRotationZ(-.25))
    .multiply(new THREE.Matrix4().makeRotationX(.6981317008-.24))
    .multiply(new THREE.Matrix4().makeRotationZ(.6+3.45575191895*.721));
  actual.elements.forEach((value,i)=>close(value,expected.elements[i]));
  const point=new THREE.Vector3(.24,-.17,.03);
  assert.ok(point.clone().applyMatrix4(actual).applyMatrix4(actual.clone().invert()).distanceTo(point)<1e-12);
});

test('projected ray bounds enclose the world core when panning, orbiting, and approaching',()=>{
  const center=new THREE.Vector3(.15,-.1,.05);
  for(const aspect of [.6,1,2.4])for(const distance of [.36,1.2,3]) {
    const camera=new THREE.PerspectiveCamera(45,aspect,.008,80);
    camera.position.set(distance*.7,-distance*.2,distance*.8);camera.lookAt(center);camera.updateMatrixWorld();
    const rect=coreScreenBounds(camera,center);
    for(let i=0;i<300;i++) {
      const phi=i*2.3999632297,z=1-2*(i+.5)/300,r=Math.sqrt(1-z*z);
      const point=new THREE.Vector3(r*Math.cos(phi),r*Math.sin(phi),z).multiplyScalar(CORE_RAY.extent).add(center);
      if(point.clone().applyMatrix4(camera.matrixWorldInverse).z>=-camera.near)continue;
      point.project(camera);
      if(Math.abs(point.x)>1||Math.abs(point.y)>1)continue;
      assert.ok(point.x>=rect.x-1e-9&&point.x<=rect.z+1e-9);
      assert.ok(point.y>=rect.y-1e-9&&point.y<=rect.w+1e-9);
    }
  }
});

test('camera and physical pixel uniforms refresh for a 4K export without changing shared animation or activity',()=>{
  const shared={uActivity:{value:.7},uAnimation:{value:32},uTime:{value:45},uDuration:{value:100},uTilt:{value:.2}};
  const core=createLensedCore(shared),mesh=core.children[0],u=mesh.material.uniforms;
  let height=720;
  const renderer={getCurrentViewport:(v)=>v.set(0,0,height*1.6,height)};
  const scene=new THREE.Scene();scene.add(core);core.position.set(.1,.05,-.02);core.scale.setScalar(1.4);
  const camera=new THREE.PerspectiveCamera(45,1.6,.008,80);camera.position.set(.5,.1,2);camera.lookAt(0,0,0);
  try {
    mesh.onBeforeRender(renderer,scene,camera);
    const initialCone=u.uPixelCone.value;
    assert.equal(u.uActivity,shared.uActivity);assert.equal(u.uAnimation,shared.uAnimation);
    assert.equal(u.uMotionSpeed.value,0);assert.equal(u.uMotionTurn.value,0);assert.equal(u.uMotionCoherence.value,0);
    height=4096;camera.aspect=1;camera.position.set(0,0,3);camera.updateProjectionMatrix();
    mesh.onBeforeRender(renderer,scene,camera);
    close(u.uPixelCone.value/initialCone,720/4096);
    assert.deepEqual(u.uInverseProjection.value.elements,camera.projectionMatrixInverse.elements);
    assert.deepEqual(u.uCameraWorld.value.elements,camera.matrixWorld.elements);
    assert.equal(shared.uAnimation.value,32);assert.equal(shared.uActivity.value,.7);
    assert.equal(core.userData.horizonRadius,.205);assert.equal(mesh.userData.eventHorizon,true);
    core.traverse(object=>assert.equal(object.layers.mask,2));
    assert.equal(mesh.material.depthWrite,true);assert.equal(mesh.material.blending,THREE.NoBlending);
    assert.equal(mesh.material.glslVersion,THREE.GLSL3);
    assert.match(mesh.material.fragmentShader,/gl_FragDepth=firstDepth/);
    assert.doesNotMatch(mesh.material.fragmentShader,/sampler2D/,'core light is sampled in world space without a second UV image');
    let geometryDisposals=0,materialDisposals=0;
    mesh.geometry.addEventListener('dispose',()=>geometryDisposals++);mesh.material.addEventListener('dispose',()=>materialDisposals++);
    core.userData.dispose();core.userData.dispose();
    assert.equal(geometryDisposals,1);assert.equal(materialDisposals,1);
  }finally {core.userData.dispose();}
});
