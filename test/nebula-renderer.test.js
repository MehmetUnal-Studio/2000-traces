import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildNebula, createNebulaUniforms, createNebulaCore, createNebulaCameraPicker, makePoints, makeFilamentSegments,
  nebulaEventPosition, projectNebulaPoint, unprojectNebulaPoint, NEBULA_LIMITS, NEBULA_CORE_RADIUS } from '../viz/src/nebula.js';
import { readGesture, TYPE } from '../viz/src/gesture-replay.js';
import { createPackFlowEnergy } from '../viz/src/flow-energy.js';
import { createNebulaSpace } from '../viz/src/nebula-space.js';
import { projectLens, lensSourceNdc } from '../viz/src/lensing.js';
import { createDemoPack } from '../viz/src/demo-pack.js';
import { coreDiskMatrix } from '../viz/src/core-lensing.js';
import { traceCoreRay } from '../viz/src/core-ray.js';

function fixture({exact=true}={}) {
  const count=18;
  const events=new DataView(new ArrayBuffer(count*12));
  const gestures=exact?new DataView(new ArrayBuffer(count*32)):null;
  const participants=[];
  for(let lane=0;lane<3;lane++) {
    participants.push({p:`A${lane+1}`,z:'A',s:lane+1,l:lane,o:lane*6,n:6});
    for(let i=0;i<6;i++) {
      const index=lane*6+i,b=index*12;
      const t=100.25+i*120+lane*23;
      const x=0.12+lane*0.13+i*0.04,y=0.24+i*0.06;
      events.setUint16(b,lane,true);events.setUint16(b+2,Math.round(x*65535),true);events.setUint16(b+4,Math.round(y*65535),true);
      events.setUint32(b+6,Math.round(t),true);events.setUint8(b+10,i===0?TYPE.noteOn:i===3?TYPE.noteOff:TYPE.move);events.setUint8(b+11,lane);
      if(gestures) {
        gestures.setFloat64(index*32,t,true);gestures.setFloat64(index*32+8,x,true);gestures.setFloat64(index*32+16,y,true);gestures.setFloat64(index*32+24,i===2?1:0,true);
      }
    }
  }
  return {events,gestures,strokes:new DataView(new ArrayBuffer(0)),manifest:{
    durationMs:1000,laneCount:3,eventCount:count,strokeCount:0,participants,zones:[{zone:'A',laneStart:0,laneCount:3}],visualSeed:4,
    ...(exact?{gestures:{formatVersion:1,file:'gestures.bin',recordBytes:32,count}}:{}),
  }};
}

// Locate the outer displayed image using the exact shared inverse lens map.
// This deliberately does not duplicate the renderer's thin-lens equation.
function displayedNdc(source,lens,depth=Infinity) {
  if(!lens.enabled||depth<lens.depth)return {x:source.x,y:source.y};
  const cx=lens.x*2-1,cy=lens.y*2-1;
  const dx=(source.x-cx)*lens.aspect,dy=source.y-cy,length=Math.hypot(dx,dy);
  const ux=length?dx/length:1,uy=length?dy/length:0,target=length*0.5;
  let lo=lens.radius,hi=target+lens.radius*8;
  for(let i=0;i<55;i++) {
    const distance=(lo+hi)*0.5;
    const sample=lensSourceNdc(cx+ux*distance*2/lens.aspect,cy+uy*distance*2,lens,depth);
    const mapped=((sample.x-cx)*lens.aspect*ux+(sample.y-cy)*uy)*0.5;
    if(mapped<target)lo=distance;else hi=distance;
  }
  const distance=(lo+hi)*0.5;
  return {x:cx+ux*distance*2/lens.aspect,y:cy+uy*distance*2};
}

test('nebula uses both recorded axes and its CPU view projection has a stable full inverse',()=>{
  const gesture={lane:8,t:450,x:0.36,y:0.72};
  const point=nebulaEventPosition(gesture,{durationMs:1000});
  const changedX=nebulaEventPosition({...gesture,x:0.81},{durationMs:1000});
  const changedY=nebulaEventPosition({...gesture,y:0.21},{durationMs:1000});
  assert.ok(Math.hypot(point.x-changedX.x,point.y-changedX.y)>0.1);
  assert.ok(Math.hypot(point.x-changedY.x,point.y-changedY.y)>0.1);
  assert.notEqual(point.z,changedY.z);
  for(const tilt of [-0.65,0,0.65]) for(const orbit of [0,0.71,5.1]) for(const time of [0,333,1000]) {
    const context={tilt,orbit,time,durationMs:1000};
    const back=unprojectNebulaPoint(projectNebulaPoint(point,context),context);
    for(const axis of ['x','y','z']) assert.ok(Math.abs(back[axis]-point[axis])<1e-12);
  }
});

test('nebula picks the exact sampled event after orbit and inclination, excluding future events and the central void',()=>{
  const pack=fixture();const nebula=buildNebula(pack);
  try {
    for(const tilt of [-0.6,0,0.6]) for(const orbit of [0,1.1]) {
      nebula.uniforms.uTilt.value=tilt;nebula.uniforms.uOrbit.value=orbit;
      for(const index of nebula.sampledIndices) {
        const gesture=readGesture(pack,index);
        const point=nebulaEventPosition(gesture,pack.manifest);
        const p=projectNebulaPoint(point,{time:1000,durationMs:1000,tilt,orbit});
        if(Math.hypot(p.x,p.y)<NEBULA_CORE_RADIUS) continue;
        assert.equal(nebula.inspect(p.x,p.y)?.index,index);
        assert.equal(nebula.inspect(p.x,p.y)?.gesture.x,gesture.x);
      }
    }
    const firstEvent=readGesture(pack,0);
    nebula.uniforms.uTime.value=firstEvent.t-0.001;
    const futurePosition=projectNebulaPoint(nebulaEventPosition(firstEvent,pack.manifest),{
      time:nebula.uniforms.uTime.value,durationMs:1000,tilt:0.6,orbit:1.1,
    });
    assert.equal(nebula.inspect(futurePosition.x,futurePosition.y),null);
    assert.equal(nebula.inspect(0,0),null);
    assert.equal(nebula.updateHover(null,null),null);
    nebula.uniforms.uTime.value=1000;
    const gesture=readGesture(pack,0);
    const p=projectNebulaPoint(nebulaEventPosition(gesture,pack.manifest),{time:1000,durationMs:1000,tilt:0.6,orbit:1.1});
    const hit=nebula.updateHover(p.x,p.y);
    assert.equal(hit.index,0);const stamp=nebula.hoverStamp;
    nebula.updateHover(p.x,p.y);assert.equal(nebula.hoverStamp,stamp);
    nebula.setInspection(hit);assert.equal(nebula.uniforms.uSelLane.value,0);
    nebula.setInspection(null);assert.equal(nebula.uniforms.uSelLane.value,-1);
  } finally {nebula.dispose();}
});

test('nebula filaments retain real same-finger endpoints, stop at release, and legacy identities never create paths',()=>{
  const pack=fixture();const nebula=buildNebula(pack);
  try {
    assert.equal(nebula.stats.segments,6);
    const mesh=nebula.group.getObjectByName('nebula-recorded-finger-filaments');
    assert.equal(mesh.geometry.instanceCount,6);
    assert.equal(mesh.isMesh,true);
    for(let i=0;i<nebula.segmentPairs.length;i+=2) {
      const first=readGesture(pack,nebula.segmentPairs[i]),last=readGesture(pack,nebula.segmentPairs[i+1]);
      assert.equal(first.lane,last.lane);assert.equal(first.finger,last.finger);assert.equal(first.finger,0);
      assert.ok(last.t>first.t);assert.equal(last.index-first.index,1);
      const a=nebulaEventPosition(first,pack.manifest),b=nebulaEventPosition(last,pack.manifest);
      for(const [axis,name] of ['x','y','z'].map((axis,index)=>[axis,index])) {
        assert.ok(Math.abs(mesh.geometry.attributes.aStart.array[i/2*3+name]-a[axis])<1e-6);
        assert.ok(Math.abs(mesh.geometry.attributes.aEnd.array[i/2*3+name]-b[axis])<1e-6);
      }
      assert.ok(Math.abs(mesh.geometry.attributes.aData.array[i/2*4]-last.t)<0.001);
    }
  } finally {nebula.dispose();}
  const legacy=buildNebula(fixture({exact:false}));
  assert.equal(legacy.stats.segments,0);assert.ok(legacy.stats.points>0);legacy.dispose();
});

test('nebula stays bounded and deterministic for the 2000-participant study, and disposes each GPU resource once',()=>{
  const pack=createDemoPack();const first=buildNebula(pack),second=buildNebula(pack);
  assert.ok(first.stats.points<=NEBULA_LIMITS.points);
  assert.ok(first.stats.halos<=NEBULA_LIMITS.halos);
  assert.ok(first.stats.points+first.stats.halos<=250000);
  assert.ok(first.stats.segments<=NEBULA_LIMITS.segments);
  assert.deepEqual(first.sampledIndices,second.sampledIndices);
  assert.deepEqual(first.segmentPairs,second.segmentPairs);
  const resources=new Map();
  first.group.traverse((child)=>{
    for(const resource of [child.geometry,child.material]) if(resource) {
      resources.set(resource,0);resource.addEventListener('dispose',()=>resources.set(resource,resources.get(resource)+1));
    }
  });
  first.dispose();first.dispose();
  for(const times of resources.values()) assert.equal(times,1);
  second.dispose();
});

test('two million real event slots are sampled across the whole source within the GPU budget',()=>{
  const count=2000000;
  const events=new DataView(new ArrayBuffer(count*12));
  for(let i=0;i<count;i++) {
    events.setUint16(i*12+2,i%65536,true);events.setUint16(i*12+4,(i*17)%65536,true);
    events.setUint32(i*12+6,i,true);events.setUint8(i*12+10,i%25===0?TYPE.noteOn:TYPE.move);
  }
  const pack={events,strokes:new DataView(new ArrayBuffer(0)),manifest:{
    durationMs:count,laneCount:1,eventCount:count,strokeCount:0,
    participants:[{p:'A1',z:'A',s:1,l:0,o:0,n:count}],zones:[{zone:'A',laneStart:0,laneCount:1}],
  }};
  const nebula=buildNebula(pack);
  try {
    assert.equal(nebula.stats.points,NEBULA_LIMITS.points);
    assert.equal(nebula.stats.totalNotes,80000);
    assert.equal(nebula.stats.totalMoves,1920000);
    assert.ok(nebula.sampledIndices[0]<30);
    assert.equal(nebula.sampledIndices.at(-1),count-1);
    assert.ok(nebula.stats.points+nebula.stats.halos<=250000);
    assert.equal(nebula.stats.segments,0);
    const atmosphere=nebula.group.getObjectByName('nebula-event-atmosphere');
    assert.equal(atmosphere.isMesh,true,'haze uses world-space billboards for export fidelity');
  } finally {nebula.dispose();}
});

test('archive corona follows causal recorded activity through seek and exposes a clamped live override',()=>{
  const pack=fixture(),nebula=buildNebula(pack),flow=createPackFlowEnergy(pack);
  try {
    const geometry=nebula.group.getObjectByName('nebula-actual-event-starlight').geometry;
    const before=geometry.attributes.position.array.slice();
    for(const time of [0,100.249,100.25,350,760,999,200,0,760]) {
      nebula.updatePlayhead(time);
      assert.equal(nebula.uniforms.uActivity.value,flow.sample(time).energy);
      assert.equal(nebula.uniforms.uTime.value,time);
    }
    assert.equal(nebula.setActivity(2),1);assert.equal(nebula.setActivity(-1),0);
    assert.equal(nebula.setActivity(NaN),0);
    nebula.updatePlayhead(350);
    assert.equal(nebula.uniforms.uActivity.value,flow.sample(350).energy);
    assert.deepEqual(geometry.attributes.position.array,before,'activity only illuminates original positions');
  } finally {nebula.dispose();}
});

test('live material helpers share activity and animation state even before the first source event',()=>{
  const uniforms=createNebulaUniforms(180000);
  const points=makePoints(new Float32Array(3),new Float32Array(4),new Float32Array(2),uniforms,'test-live-points');
  const haze=makePoints(new Float32Array(3),new Float32Array(4),new Float32Array(2),uniforms,'test-live-haze',true);
  const lines=makeFilamentSegments(new Float32Array(3),new Float32Array(3),new Float32Array(4),uniforms);
  const core=createNebulaCore(uniforms);
  try {
    assert.equal(uniforms.uHasData.value,0);
    assert.equal(uniforms.uTime.value,0);
    assert.equal(core.isGroup,true);
    const surfaces=[];
    core.traverse((object)=>{if(object.material)surfaces.push(object);});
    assert.ok(surfaces.length>0);
    for(const object of [points,haze,lines,...surfaces]) {
      assert.equal(object.material.uniforms.uActivity,uniforms.uActivity);
      assert.equal(object.material.uniforms.uAnimation,uniforms.uAnimation);
    }
    uniforms.uActivity.value=0.42;uniforms.uAnimation.value=2.5;
    const surface=core.getObjectByName('nebula-ray-integrated-core');
    assert.ok(surface,'archive/live core factory uses the same curved world-ray renderer');
    assert.equal(surface.material.uniforms.uActivity.value,0.42);
    assert.equal(surface.material.uniforms.uAnimation.value,2.5);
    assert.equal(surface.material.uniforms.uMotionSpeed,uniforms.uMotionSpeed);
    assert.equal(surface.material.uniforms.uMotionTurn,uniforms.uMotionTurn);
    assert.equal(surface.material.uniforms.uMotionCoherence,uniforms.uMotionCoherence);
    core.traverse((object)=>assert.equal(object.layers.mask,2,'all core surfaces belong to the separate core layer'));
    assert.equal(core.userData.horizonRadius,NEBULA_CORE_RADIUS);
    assert.equal(surface.material.depthWrite,true,'emission writes its actual depth for foreground compositing');
    const camera=new THREE.PerspectiveCamera(45,1.6,.008,80);
    camera.position.set(.4,.1,2);camera.lookAt(0,0,0);camera.updateMatrixWorld();
    surface.onBeforeRender({getCurrentViewport:(v)=>v.set(0,0,1600,1000)},new THREE.Scene(),camera);
    assert.deepEqual(surface.material.uniforms.uCameraWorld.value.elements,camera.matrixWorld.elements);
    assert.equal(surface.material.uniforms.uActivity.value,.42,'camera preparation does not overwrite source activity');
  } finally {
    for(const object of [points,haze,lines,core]) object.traverse((child)=>{child.geometry?.dispose();child.material?.dispose();});
  }
});

test('perspective picker keeps real foreground gestures visible and rejects the sphere-occluded rear from every side',()=>{
  for(const eye of [new THREE.Vector3(0,0,2),new THREE.Vector3(2,0,0),new THREE.Vector3(-1,1,-1),new THREE.Vector3(0.36,0,0)]) {
    const camera=new THREE.PerspectiveCamera(45,1.6,0.008,80);
    camera.position.copy(eye);camera.lookAt(0,0,0);camera.updateMatrixWorld();
    const uniforms=createNebulaUniforms(1000);uniforms.uTime.value=1000;
    const context={time:1000,durationMs:1000,orbit:0,tilt:0};
    const foreground=eye.clone().normalize().multiplyScalar(0.25);
    const background=foreground.clone().negate();
    const a=unprojectNebulaPoint(foreground,context),b=unprojectNebulaPoint(background,context);
    const positions=new Float32Array([a.x,a.y,a.z,b.x,b.y,b.z]);
    const picker=createNebulaCameraPicker(uniforms,positions);
    picker.setCamera(camera,1200);
    assert.equal(uniforms.uViewportHeight.value,1200);
    assert.equal(picker.inspectNdc(0,0),0,'foreground point can cross the horizon silhouette');
    const rearOnly=createNebulaCameraPicker(uniforms,positions.subarray(3));
    rearOnly.setCamera(camera,1200);
    assert.equal(rearOnly.inspectNdc(0,0),null,'rear point is hidden by the physical sphere');
    assert.equal(picker.inspectNdc(null,null),null);
  }
});

test('archive NDC picking follows camera orbit, dolly and pan without changing exact event identity',()=>{
  const pack=fixture(),nebula=buildNebula(pack);
  try {
    const camera=new THREE.PerspectiveCamera(45,1.6,0.008,80);
    const ray=new THREE.Raycaster();
    let checked=0;
    for(const eye of [[0,0,2.8],[2.2,0.8,1.4],[-1.8,0.6,-1.8]]) {
      camera.position.set(...eye);camera.lookAt(0.06,-0.03,0);camera.updateMatrixWorld();nebula.setCamera(camera,1200);
      for(const index of nebula.sampledIndices) {
        const gesture=readGesture(pack,index);
        const source=nebulaEventPosition(gesture,pack.manifest);
        const p=projectNebulaPoint(source,{time:1000,durationMs:1000,orbit:0,tilt:0});
        const world=new THREE.Vector3(p.x,p.y,p.z),sourceNdc=world.clone().project(camera);
        const depth=-world.clone().applyMatrix4(camera.matrixWorldInverse).z;
        const screen=displayedNdc(sourceNdc,projectLens(camera),depth);
        if(Math.abs(sourceNdc.x)>1||Math.abs(sourceNdc.y)>1||Math.abs(screen.x)>1||Math.abs(screen.y)>1)continue;
        ray.setFromCamera(new THREE.Vector2(screen.x,screen.y),camera);
        const disk=coreDiskMatrix(nebula.uniforms),inverse=disk.clone().invert();
        const captured=traceCoreRay(ray.ray.origin.clone().applyMatrix4(inverse).toArray(),ray.ray.direction.clone().transformDirection(inverse).toArray(),{
          pixelCone:2/(Math.abs(camera.projectionMatrix.elements[5])*1200),animation:nebula.uniforms.uAnimation.value,
          motionSpeed:nebula.uniforms.uMotionSpeed.value,motionTurn:nebula.uniforms.uMotionTurn.value,motionCoherence:nebula.uniforms.uMotionCoherence.value,
        });
        const captureDepth=captured.captured?Math.min(...captured.depthPoints
          .map((p)=>-new THREE.Vector3(...p).applyMatrix4(disk).applyMatrix4(camera.matrixWorldInverse).z).filter((z)=>z>0)):Infinity;
        const blocked=depth>=captureDepth-0.0001;
        if(blocked)continue;
        assert.equal(nebula.inspectNdc(screen.x,screen.y)?.index,index);checked++;
      }
    }
    assert.ok(checked>20);
  } finally {nebula.dispose();}
});

test('lensed arcs select their real background source across camera pan and aspect, while direct foreground wins overlap',()=>{
  for(const aspect of [0.75,1.6,2.4]) for(const pan of [0,0.18]) {
    const camera=new THREE.PerspectiveCamera(45,aspect,0.008,80);
    camera.position.set(0.3+pan,0.15,3);camera.lookAt(pan,-0.08,0);camera.updateMatrixWorld();
    const lens=projectLens(camera);
    const uniforms=createNebulaUniforms(1000);uniforms.uTime.value=1000;
    const context={time:1000,durationMs:1000,orbit:0,tilt:0};
    // This outer image escapes the curved-ray shadow; a perfectly central
    // source's old thin-lens ring now falls inside the captured annulus.
    const sourceWorld=camera.position.clone().multiplyScalar(-0.3)
      .addScaledVector(new THREE.Vector3(1,0,0).transformDirection(camera.matrixWorld),0.2);
    const source=sourceWorld.clone().project(camera);
    const image=displayedNdc(source,lens);
    const remapped=lensSourceNdc(image.x,image.y,lens);
    assert.ok(Math.hypot(remapped.x-source.x,remapped.y-source.y)<1e-10);
    const angularDistance=Math.hypot(((image.x+1)*0.5-lens.x)*lens.aspect,(image.y+1)*0.5-lens.y);
    assert.ok(angularDistance>lens.radius,'the visible arc lies outside the horizon silhouette');
    const local=unprojectNebulaPoint(sourceWorld,context);
    const sourcePosition=new Float32Array([local.x,local.y,local.z]);
    const picker=createNebulaCameraPicker(uniforms,sourcePosition,{makeHit:()=>({index:81})});
    picker.setCamera(camera,1200);
    assert.equal(picker.inspectNdc(source.x,source.y),null,'straight source ray is hidden');
    assert.equal(picker.inspectNdc(image.x,image.y)?.index,81,'bent displayed arc resolves to the source event');

    const ray=new THREE.Raycaster();ray.setFromCamera(new THREE.Vector2(image.x,image.y),camera);
    const foreground=ray.ray.at(camera.position.length()*0.45,new THREE.Vector3());
    const frontLocal=unprojectNebulaPoint(foreground,context);
    const positions=new Float32Array([frontLocal.x,frontLocal.y,frontLocal.z,local.x,local.y,local.z]);
    const both=createNebulaCameraPicker(uniforms,positions);
    both.setCamera(camera,1200);
    assert.equal(both.inspectNdc(image.x,image.y),0,'direct foreground remains in front of the lensed background');
  }
});

test('decorative space has deterministic noncoplanar depth strata separate from recorded events',()=>{
  const a=createNebulaSpace({seed:42,starCount:240}),b=createNebulaSpace({seed:42,starCount:240});
  try {
    const points=a.group.getObjectByName('decorative-stars-four-depth-strata');
    const positions=points.geometry.attributes.position.array;
    assert.deepEqual(positions,b.group.getObjectByName(points.name).geometry.attributes.position.array);
    let front=0,rear=0;
    const shells=[[],[],[],[]];
    for(let i=0;i<positions.length/3;i++) {
      const x=positions[i*3],y=positions[i*3+1],z=positions[i*3+2];
      shells[i%4].push(Math.hypot(x,y,z));if(z>0)front++;else rear++;
    }
    assert.ok(front>50&&rear>50);
    for(let layer=1;layer<4;layer++)assert.ok(Math.min(...shells[layer])>Math.max(...shells[layer-1]));
    a.group.traverse((object)=>{assert.equal(object.layers.mask,1);assert.equal(object.userData.recordedData,false);});
    assert.equal(points.material.uniforms.uDepthPass,a.uniforms.uDepthPass);
    const before=positions.slice();
    const camera=new THREE.PerspectiveCamera(45,1,0.008,80);camera.position.set(0,0,2);camera.lookAt(0,0,0);camera.updateMatrixWorld();
    const star=new THREE.Vector3(positions[0],positions[1],positions[2]);
    const initial=star.clone().project(camera);
    camera.position.x+=0.2;camera.updateMatrixWorld();
    assert.notEqual(star.clone().project(camera).x,initial.x,'camera translation produces true geometric parallax');
    assert.deepEqual(positions,before,'background remains fixed in world space');
  } finally {a.dispose();a.dispose();b.dispose();}
});
