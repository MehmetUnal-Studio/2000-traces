import * as THREE from 'three';
import { createGestureReplay, readGesture, TYPE } from './gesture-replay.js';
import { createPackFlowEnergy } from './flow-energy.js';
import { createPackMotionSignals } from './motion-signals.js';
import { projectLens, lensSourceNdc } from './lensing.js';
import { traceCoreRay } from './core-ray.js';
import { DUST_VERTEX, DUST_FRAGMENT, ATMOSPHERE_VERTEX, ATMOSPHERE_FRAGMENT, FILAMENT_VERTEX, FILAMENT_FRAGMENT,
  } from './nebula-shaders.js';
import { createLensedCore } from './core-lensing.js';

const TAU=Math.PI*2;
export const NEBULA_LIMITS=Object.freeze({ points:230000, notes:26000, halos:7000, segments:100000 });
export const NEBULA_INCLINATION=Math.PI*40/180;
export const NEBULA_CORE_RADIUS=0.205;
const ROLL=-0.25;
const GRID=48;
const EXTENT=1.28;
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
const fract=(v)=>v-Math.floor(v);
const lanePhase=(lane)=>fract((lane+1)*0.6180339887498949);
const escapeHtml=(s)=>String(s).replace(/[&<>"']/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

/** Shared archive/live material state. Time is milliseconds; animation is seconds. */
export function createNebulaUniforms(durationMs=1) {
  return {
    uDuration:{value:Math.max(1,durationMs)},uTime:{value:0},uOrbit:{value:0},uTilt:{value:0},
    uActivity:{value:0},uAnimation:{value:0},uDepthPass:{value:0},
    uMotionSpeed:{value:0},uMotionTurn:{value:0},uMotionCoherence:{value:0},uMotionEnergy:{value:0},
    uReplaying:{value:0},uSelLane:{value:-1},uHoverLane:{value:-1},
    uPointScale:{value:500},uPointMax:{value:128},uViewportHeight:{value:1000},uHasData:{value:0},
    uSelRow:{value:-1},uSelColumn:{value:-1},uHoverRow:{value:-1},uHoverColumn:{value:-1},
  };
}

// A fixed, openly artistic coordinate system, not a physical galaxy model.
// Time winds inward; the recorded horizontal gesture bends an orbit while
// the vertical gesture changes its radius and height. Lane assigns a braid.
export function nebulaEventPosition(gesture,{durationMs=1}={}) {
  const time=clamp(gesture.t/Math.max(1,durationMs),0,1);
  const x=clamp(gesture.x??0.5,0,1), y=clamp(gesture.y??0.5,0,1);
  const lane=gesture.lane;
  const seed=lanePhase(lane);
  // Unequal braid spacing leaves one open shoulder instead of a threefold
  // emblem. Each participant still has the same fixed, reproducible route.
  const arm=[0,2.21,4.49][lane%3];
  const baseRadius=0.255+0.765*Math.pow(1-time,0.78);
  const branch=Math.sin(seed*TAU+time*8.3+x*1.6)*(0.018+0.057*(1-time));
  const radius=baseRadius+(y-0.5)*(0.065+0.12*(1-time))+branch;
  const angle=arm+2.7*Math.log(radius/0.255)+(seed-0.5)*0.84+(x-0.5)*1.15;
  const height=(y-0.5)*0.11*radius+Math.sin(time*TAU+seed*TAU)*0.022*radius;
  return {x:Math.cos(angle)*radius,y:Math.sin(angle)*radius,z:height};
}

export function projectNebulaPoint(point,{time=0,durationMs=1,orbit=0,tilt=0}={}) {
  const angle=orbit+TAU*0.55*time/Math.max(1,durationMs);
  const c=Math.cos(angle),s=Math.sin(angle);
  const x=point.x*c-point.y*s, y=point.x*s+point.y*c;
  const inclination=NEBULA_INCLINATION+tilt, ci=Math.cos(inclination),si=Math.sin(inclination);
  const yy=y*ci-(point.z??0)*si, z=y*si+(point.z??0)*ci;
  return {x:x*Math.cos(ROLL)-yy*Math.sin(ROLL),y:x*Math.sin(ROLL)+yy*Math.cos(ROLL),z};
}

// Full 3D inverse, also used as the plane estimate for the spatial picker.
export function unprojectNebulaPoint(point,{time=0,durationMs=1,orbit=0,tilt=0}={}) {
  const x=point.x*Math.cos(ROLL)+point.y*Math.sin(ROLL);
  const yy=-point.x*Math.sin(ROLL)+point.y*Math.cos(ROLL);
  const inclination=NEBULA_INCLINATION+tilt,ci=Math.cos(inclination),si=Math.sin(inclination);
  const y=yy*ci+(point.z??0)*si, z=-yy*si+(point.z??0)*ci;
  const angle=orbit+TAU*0.55*time/Math.max(1,durationMs),c=Math.cos(angle),s=Math.sin(angle);
  return {x:x*c+y*s,y:-x*s+y*c,z};
}

/** Camera-aware picker shared by immutable archive arrays and live reservoirs. */
export function createNebulaCameraPicker(uniforms,positions,{
  getCount=()=>positions.length/3,getTime=()=>0,makeHit=(index)=>index,object=null,
}={}) {
  let camera=null;
  const rotation=new THREE.Matrix4(),scratch=new THREE.Matrix4(),world=new THREE.Matrix4();
  const view=new THREE.Matrix4(),clip=new THREE.Matrix4(),identity=new THREE.Matrix4(),inverseWorld=new THREE.Matrix4();
  const raycaster=new THREE.Raycaster(),pointer=new THREE.Vector2();
  const sphere=new THREE.Sphere(new THREE.Vector3(),NEBULA_CORE_RADIUS);
  const rayOrigin=new THREE.Vector3(),rayDirection=new THREE.Vector3(),corePoint=new THREE.Vector3();
  const setCamera=(value,viewportHeight)=>{
    camera=value;
    if(Number.isFinite(viewportHeight)&&viewportHeight>0) uniforms.uViewportHeight.value=viewportHeight;
  };
  const inspectNdc=(x,y)=>{
    if(!camera||!Number.isFinite(x)||!Number.isFinite(y)) return null;
    camera.updateMatrixWorld();object?.updateWorldMatrix(true,false);
    const angle=uniforms.uOrbit.value+TAU*0.55*uniforms.uTime.value/Math.max(1,uniforms.uDuration.value);
    rotation.makeRotationZ(ROLL).multiply(scratch.makeRotationX(NEBULA_INCLINATION+uniforms.uTilt.value))
      .multiply(scratch.makeRotationZ(angle));
    const objectMatrix=object?.matrixWorld??identity;
    world.multiplyMatrices(objectMatrix,rotation);
    view.multiplyMatrices(camera.matrixWorldInverse,world);
    clip.multiplyMatrices(camera.projectionMatrix,view);
    pointer.set(x,y);raycaster.setFromCamera(pointer,camera);
    sphere.center.setFromMatrixPosition(objectMatrix);
    sphere.radius=NEBULA_CORE_RADIUS*objectMatrix.getMaxScaleOnAxis();
    const lens=projectLens(camera,sphere.center,sphere.radius);
    // The postprocess maps a displayed pixel to the source field, rather
    // than moving source points forward. Cache its two depth-dependent cases.
    const backgroundSource=lensSourceNdc(x,y,lens);
    const foregroundSource={x,y};
    // The curved ray's captured shadow is wider than a straight sphere hit.
    // Trace the actual displayed ray in the same disk frame as the core shader.
    inverseWorld.copy(world).invert();
    rayOrigin.copy(raycaster.ray.origin).applyMatrix4(inverseWorld);
    rayDirection.copy(raycaster.ray.direction).transformDirection(inverseWorld);
    const perspective=!!camera.isPerspectiveCamera;
    const pixelCone=2/(Math.abs(camera.projectionMatrix.elements[5])*Math.max(1,uniforms.uViewportHeight.value))/
      (perspective?1:world.getMaxScaleOnAxis());
    const coreRay=traceCoreRay(rayOrigin.toArray(),rayDirection.toArray(),{
      pixelCone,perspective,animation:uniforms.uAnimation?.value??0,
      motionSpeed:uniforms.uMotionSpeed?.value??0,motionTurn:uniforms.uMotionTurn?.value??0,
      motionCoherence:uniforms.uMotionCoherence?.value??0,
    });
    let occlusionDepth=Infinity;
    if(coreRay.captured) {
      // Finite plasma thickness writes depth even for exactly edge-on rays
      // that never cross the disk's mathematical middle plane.
      for(const point of coreRay.depthPoints) {
        corePoint.fromArray(point).applyMatrix4(view);
        if(corePoint.z<0)occlusionDepth=Math.min(occlusionDepth,-corePoint.z);
      }
    }
    rayOrigin.copy(raycaster.ray.origin).applyMatrix4(camera.matrixWorldInverse);
    rayDirection.copy(raycaster.ray.direction).transformDirection(camera.matrixWorldInverse);
    const aspect=camera.isPerspectiveCamera?camera.aspect:(camera.right-camera.left)/(camera.top-camera.bottom);
    const threshold=16/Math.max(1,uniforms.uViewportHeight.value);
    const tieTolerance=(0.5/Math.max(1,uniforms.uViewportHeight.value))**2;
    const m=clip.elements,v=view.elements;
    let best=threshold*threshold,nearest=-1,bestDepth=Infinity;
    for(let index=0,count=getCount();index<count;index++) {
      if(getTime(index)>uniforms.uTime.value+0.0001)continue;
      const offset=index*3,px=positions[offset],py=positions[offset+1],pz=positions[offset+2];
      const w=m[3]*px+m[7]*py+m[11]*pz+m[15];
      if(w<=0)continue;
      const zz=m[2]*px+m[6]*py+m[10]*pz+m[14];
      if(zz < -w || zz > w)continue;
      const sourceX=(m[0]*px+m[4]*py+m[8]*pz+m[12])/w;
      const sourceY=(m[1]*px+m[5]*py+m[9]*pz+m[13])/w;
      // Offscreen geometry never entered the source texture and cannot be
      // selected via its clamped texture border after lensing.
      if(Math.abs(sourceX)>1 || Math.abs(sourceY)>1)continue;
      const vz=v[2]*px+v[6]*py+v[10]*pz+v[14];
      const background=lens.enabled && -vz>=lens.depth;
      const target=background?backgroundSource:foregroundSource;
      const dx=(sourceX-target.x)*aspect;
      const dy=sourceY-target.y;
      const distance=dx*dx+dy*dy;
      if(distance>best+tieTolerance)continue;
      const vx=v[0]*px+v[4]*py+v[8]*pz+v[12];
      const vy=v[1]*px+v[5]*py+v[9]*pz+v[13];
      const depth=(vx-rayOrigin.x)*rayDirection.x+(vy-rayOrigin.y)*rayDirection.y+(vz-rayOrigin.z)*rayDirection.z;
      // Captured rear images are opaque, but a real point in front of the
      // emitting core remains visible even inside that screen silhouette.
      if(coreRay.captured&&-vz>=occlusionDepth-0.0001)continue;
      if(Math.abs(distance-best)<=tieTolerance&&depth>=bestDepth)continue;
      best=distance;bestDepth=depth;nearest=index;
    }
    return nearest<0?null:makeHit(nearest);
  };
  return {setCamera,inspectNdc};
}

function sampleEvents(pack) {
  const eventCount=pack.manifest.eventCount;
  let totalMoves=0,totalNotes=0;
  for(let index=0;index<eventCount;index++) {
    const kind=pack.events.getUint8(index*12+10);
    if(kind===TYPE.move) totalMoves++;
    else if(kind===TYPE.noteOn) totalNotes++;
  }
  const noteLimit=Math.min(NEBULA_LIMITS.notes,totalNotes);
  const moveLimit=Math.min(NEBULA_LIMITS.points-noteLimit,totalMoves);
  const indices=[];
  let noteRank=0,moveRank=0;
  for(let index=0;index<eventCount;index++) {
    const kind=pack.events.getUint8(index*12+10);
    let take=false;
    if(kind===TYPE.noteOn) {take=Math.floor((noteRank+1)*noteLimit/Math.max(1,totalNotes))>Math.floor(noteRank*noteLimit/Math.max(1,totalNotes));noteRank++;}
    else if(kind===TYPE.move) {take=Math.floor((moveRank+1)*moveLimit/Math.max(1,totalMoves))>Math.floor(moveRank*moveLimit/Math.max(1,totalMoves));moveRank++;}
    if(take) {
      const gesture=readGesture(pack,index);
      if(gesture.hasXY && gesture.t>=0 && gesture.t<=pack.manifest.durationMs) indices.push(index);
    }
  }
  return {indices:Uint32Array.from(indices),totalMoves,totalNotes};
}

export function makePointMaterial(uniforms,atmosphere=false) {
  return new THREE.ShaderMaterial({uniforms:{...uniforms,uAtmosphere:{value:atmosphere?1:0}},
    vertexShader:atmosphere?ATMOSPHERE_VERTEX:DUST_VERTEX,
    fragmentShader:atmosphere?ATMOSPHERE_FRAGMENT:DUST_FRAGMENT,transparent:true,
    depthWrite:false,depthTest:true,blending:THREE.AdditiveBlending,
    side:THREE.DoubleSide,forceSinglePass:true});
}

// data = [timeMs, lane, isNoteOn, heat], sizes = [worldDiameter, radiance].
// Atmosphere uses instanced quads; its other attributes share the same contract.
export function makePoints(positions,data,sizes,uniforms,name,atmosphere=false,motion=null) {
  const motionData=motion??new Float32Array(positions.length/3*4);
  if(atmosphere) {
    const quad=new THREE.PlaneGeometry(1,1);
    const geometry=new THREE.InstancedBufferGeometry();geometry.index=quad.index;
    for(const [name,attribute] of Object.entries(quad.attributes)) geometry.setAttribute(name,attribute);
    geometry.setAttribute('aCenter',new THREE.InstancedBufferAttribute(positions,3));
    geometry.setAttribute('aData',new THREE.InstancedBufferAttribute(data,4));
    geometry.setAttribute('aSize',new THREE.InstancedBufferAttribute(sizes,2));
    geometry.setAttribute('aMotion',new THREE.InstancedBufferAttribute(motionData,4));
    geometry.instanceCount=positions.length/3;
    const mesh=new THREE.Mesh(geometry,makePointMaterial(uniforms,true));mesh.name=name;mesh.frustumCulled=false;mesh.renderOrder=0;
    return mesh;
  }
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.BufferAttribute(positions,3));
  geometry.setAttribute('aData',new THREE.BufferAttribute(data,4));
  geometry.setAttribute('aSize',new THREE.BufferAttribute(sizes,2));
  geometry.setAttribute('aMotion',new THREE.BufferAttribute(motionData,4));
  geometry.boundingSphere=new THREE.Sphere(new THREE.Vector3(),1.2);
  const points=new THREE.Points(geometry,makePointMaterial(uniforms,atmosphere));
  points.name=name;
  points.frustumCulled=false;
  points.renderOrder=atmosphere?0:2;
  return points;
}

export function makeFilaments(pack,pairs,uniforms,motionAttributes=null) {
  const count=pairs.length/2;
  const starts=new Float32Array(count*3),ends=new Float32Array(count*3),data=new Float32Array(count*4),motion=new Float32Array(count*4);
  for(let i=0;i<count;i++) {
    const first=readGesture(pack,pairs[i*2]),last=readGesture(pack,pairs[i*2+1]);
    const a=nebulaEventPosition(first,pack.manifest),b=nebulaEventPosition(last,pack.manifest);
    starts.set([a.x,a.y,a.z],i*3);ends.set([b.x,b.y,b.z],i*3);
    data.set([last.t,last.lane,lightTemperature(last,pack.manifest.durationMs),Math.min(1,Math.hypot(last.x-first.x,last.y-first.y)*4)],i*4);
    if(motionAttributes)motion.set([motionAttributes.speed01[pairs[i*2+1]],motionAttributes.turn01[pairs[i*2+1]],
      motionAttributes.directionX[pairs[i*2+1]],motionAttributes.directionY[pairs[i*2+1]]],i*4);
  }
  return makeFilamentSegments(starts,ends,data,uniforms,'nebula-recorded-finger-filaments',motion);
}

// The live renderer can fill these bounded arrays directly without inventing
// a pack. data = [secondEventTimeMs, lane, heat, normalizedXyDisplacement].
export function makeFilamentSegments(starts,ends,data,uniforms,name='nebula-recorded-finger-filaments',motion=null) {
  const count=starts.length/3;
  const geometry=new THREE.InstancedBufferGeometry();
  geometry.setAttribute('position',new THREE.BufferAttribute(new Float32Array([0,-1,0,1,-1,0,1,1,0,0,1,0]),3));
  geometry.setIndex([0,1,2,0,2,3]);
  geometry.setAttribute('aStart',new THREE.InstancedBufferAttribute(starts,3));
  geometry.setAttribute('aEnd',new THREE.InstancedBufferAttribute(ends,3));
  geometry.setAttribute('aData',new THREE.InstancedBufferAttribute(data,4));
  geometry.setAttribute('aMotion',new THREE.InstancedBufferAttribute(motion??new Float32Array(count*4),4));
  geometry.instanceCount=count;
  const material=new THREE.ShaderMaterial({uniforms,vertexShader:FILAMENT_VERTEX,fragmentShader:FILAMENT_FRAGMENT,
    transparent:true,depthWrite:false,depthTest:true,side:THREE.DoubleSide,forceSinglePass:true,blending:THREE.AdditiveBlending});
  const mesh=new THREE.Mesh(geometry,material);
  mesh.frustumCulled=false;mesh.name=name;mesh.renderOrder=1;
  return mesh;
}

export function createNebulaCore(uniforms) {
  return createLensedCore(uniforms);
}

export function lightTemperature(gesture,durationMs) {
  // A blue/gold light treatment, deliberately not the pack's musical line.
  // Older movement events have no reliable musical identity in that byte.
  const time=clamp(gesture.t/Math.max(1,durationMs),0,1);
  return clamp(0.18+0.67*Math.pow(time,1.65)+((gesture.x??0.5)-0.5)*0.18+((gesture.y??0.5)-0.5)*0.10+Math.sin(gesture.lane*0.13)*0.055,0,1);
}

export function cloudEnvelope(gesture,durationMs) {
  const time=gesture.t/Math.max(1,durationMs);
  const cloud=0.5+0.5*Math.sin(lanePhase(gesture.lane)*TAU*2+time*9.0+gesture.x*4.0);
  const shoulder=0.84+0.16*Math.sin((gesture.lane%3)*1.9+time*3.0+gesture.x*2.0+gesture.y);
  return (0.08+0.92*cloud*cloud)*shoulder;
}

export function buildNebula(pack,layout,{segmentPairs,replay,motionSignals}={}) {
  const durationMs=Math.max(1,pack.manifest.durationMs);
  const sampled=sampleEvents(pack),count=sampled.indices.length;
  const flow=createPackFlowEnergy(pack);
  const motion=motionSignals??createPackMotionSignals(pack),motionAttributes=motion.attributes;
  const uniforms=createNebulaUniforms(durationMs);
  uniforms.uTime.value=durationMs;uniforms.uHasData.value=count?1:0;
  const group=new THREE.Group();group.name='nebula-recorded-gesture-field';
  const positions=new Float32Array(count*3),data=new Float32Array(count*4),sizes=new Float32Array(count*2),exactTimes=new Float64Array(count),motionData=new Float32Array(count*4);
  const grid=Array.from({length:GRID*GRID},()=>[]);
  const bin=(coordinate)=>clamp(Math.floor((coordinate+EXTENT)/(2*EXTENT)*GRID),0,GRID-1);
  const haloPositions=[],haloData=[],haloSizes=[],haloMotion=[];
  const haloStride=Math.max(1,Math.ceil(count/NEBULA_LIMITS.halos));
  const moveDensity=Math.min(3,Math.sqrt(70000/Math.max(1,Math.min(sampled.totalMoves,NEBULA_LIMITS.points))));
  const noteDensity=Math.min(2,Math.sqrt(7500/Math.max(1,Math.min(sampled.totalNotes,NEBULA_LIMITS.notes))));
  for(let i=0;i<count;i++) {
    const gesture=readGesture(pack,sampled.indices[i]);
    const p=nebulaEventPosition(gesture,pack.manifest);
    const note=gesture.kind===TYPE.noteOn?1:0;
    const heat=lightTemperature(gesture,durationMs);
    const bright=note&&fract((sampled.indices[i]+1)*0.754877666)<0.015;
    const extent=Math.abs(gesture.x-0.5)+Math.abs(gesture.y-0.5);
    const cloud=cloudEnvelope(gesture,durationMs);
    const diameter=note?(bright?0.034:0.011):0.004+extent*0.004;
    const radiance=note?noteDensity*(bright?1.2:0.40)*(0.25+cloud*0.75):moveDensity*(0.13+extent*0.13)*cloud;
    positions.set([p.x,p.y,p.z],i*3);data.set([gesture.t,gesture.lane,note,heat],i*4);sizes.set([diameter,radiance],i*2);exactTimes[i]=gesture.t;
    const sourceIndex=sampled.indices[i];
    motionData.set([motionAttributes.speed01[sourceIndex],motionAttributes.turn01[sourceIndex],motionAttributes.directionX[sourceIndex],motionAttributes.directionY[sourceIndex]],i*4);
    grid[bin(p.y)*GRID+bin(p.x)].push(i);
    if(i%haloStride===0) {
      haloPositions.push(p.x,p.y,p.z);haloData.push(gesture.t,gesture.lane,0,heat);
      haloSizes.push(0.08+extent*0.14,0.013*cloud*Math.min(2,Math.sqrt(7000/Math.max(1,count/haloStride))));
      haloMotion.push(...motionData.subarray(i*4,i*4+4));
    }
  }
  const dust=makePoints(positions,data,sizes,uniforms,'nebula-actual-event-starlight',false,motionData);group.add(dust);
  const haze=makePoints(Float32Array.from(haloPositions),Float32Array.from(haloData),Float32Array.from(haloSizes),uniforms,'nebula-event-atmosphere',true,Float32Array.from(haloMotion));group.add(haze);
  let totalSegments=segmentPairs?.length/2??0;
  if(!segmentPairs) {
    const index=replay??createGestureReplay(pack,{cacheLanes:1});
    const sampledSegments=index.sampleSegments({limit:NEBULA_LIMITS.segments});
    segmentPairs=sampledSegments.pairs;totalSegments=sampledSegments.totalSegments;
    if(!replay) index.clearCache();
  }
  const pairs=segmentPairs.subarray(0,NEBULA_LIMITS.segments*2);
  const filaments=makeFilaments(pack,pairs,uniforms,motionAttributes);group.add(filaments);
  group.add(createNebulaCore(uniforms));
  const playheadMat=new THREE.LineBasicMaterial({transparent:true,opacity:0});
  const playhead=new THREE.Group();playhead.name='nebula-playback';playhead.visible=false;group.add(playhead);
  const context=()=>({time:uniforms.uTime.value,durationMs,orbit:uniforms.uOrbit.value,tilt:uniforms.uTilt.value});
  const inspect=(x,y)=>{
    if(!Number.isFinite(x)||!Number.isFinite(y)||Math.hypot(x,y)<NEBULA_CORE_RADIUS) return null;
    const view=context();
    const yy=-x*Math.sin(ROLL)+y*Math.cos(ROLL),xx=x*Math.cos(ROLL)+y*Math.sin(ROLL);
    const inclination=NEBULA_INCLINATION+view.tilt;
    const ci=Math.cos(inclination);
    if(Math.abs(ci)<0.08) return null;
    const angle=view.orbit+TAU*0.55*view.time/durationMs,c=Math.cos(angle),s=Math.sin(angle);
    const planeY=yy/ci;
    const baseX=xx*c+planeY*s,baseY=-xx*s+planeY*c;
    const threshold=Math.max(0.009,7/Math.max(1,uniforms.uPointScale.value));
    const reach=threshold/Math.abs(ci)+0.092*Math.abs(Math.tan(inclination));
    const minX=bin(baseX-reach),maxX=bin(baseX+reach),minY=bin(baseY-reach),maxY=bin(baseY+reach);
    let nearest=-1,best=threshold*threshold;
    for(let row=minY;row<=maxY;row++) for(let col=minX;col<=maxX;col++) for(const i of grid[row*GRID+col]) {
      if(data[i*4]>view.time+0.0001) continue;
      const p=projectNebulaPoint({x:positions[i*3],y:positions[i*3+1],z:positions[i*3+2]},view);
      const d=(p.x-x)**2+(p.y-y)**2;
      if(d<best) {best=d;nearest=i;}
    }
    return nearest<0?null:hitAt(nearest);
  };
  const motionForEvent=(index)=>{
    if(!Number.isInteger(index)||index<0||index>=pack.manifest.eventCount)return null;
    return {valid:!!motionAttributes.valid[index],speed:motionAttributes.speed[index],speed01:motionAttributes.speed01[index],
      turn:motionAttributes.turn[index],turn01:motionAttributes.turn01[index],directionX:motionAttributes.directionX[index],directionY:motionAttributes.directionY[index],energy:motionAttributes.energy[index]};
  };
  const hitAt=(nearest)=>{
    const index=sampled.indices[nearest],gesture=readGesture(pack,index),participant=pack.manifest.participants[gesture.lane];
    gesture.motion=motionForEvent(index);
    return {key:`gesture:${index}`,kind:'gesture',lane:gesture.lane,row:null,column:null,index,gesture,
      title:String(participant.p),meta:`${gesture.kind===TYPE.noteOn?'Nota başlangıcı':'Parmak hareketi'} · <b>${(gesture.t/1000).toFixed(3)} sn</b><br>`+
        `X ${gesture.x.toFixed(4)} · Y ${gesture.y.toFixed(4)} · ${gesture.finger===null?'Parmak kimliği kaydedilmemiş':`Parmak ${escapeHtml(gesture.finger)}`}<br>`+
        `${gesture.exact?'Özgün X/Y kaydı':'16 bit arşiv koordinatı'} · Bölge ${escapeHtml(participant.z)} / ${escapeHtml(participant.s)}`};
  };
  const cameraPicker=createNebulaCameraPicker(uniforms,positions,{
    getTime:(index)=>exactTimes[index],makeHit:hitAt,object:group,
  });
  let hoverKey='',hoverStamp=0;
  const rememberHover=(hit)=>{const key=hit?.key??'';if(key!==hoverKey){hoverKey=key;hoverStamp++;uniforms.uHoverLane.value=hit?.lane??-1;}return hit;};
  const updateHover=(x,y)=>rememberHover(inspect(x,y));
  const updateHoverNdc=(x,y)=>rememberHover(cameraPicker.inspectNdc(x,y));
  const setInspection=(hit)=>{uniforms.uSelRow.value=-1;uniforms.uSelColumn.value=-1;uniforms.uSelLane.value=hit?.lane??-1;};
  const setActivity=(value)=>{
    uniforms.uActivity.value=Number.isFinite(value)?clamp(value,0,1):0;
    return uniforms.uActivity.value;
  };
  const updatePlayhead=(time)=>{
    uniforms.uTime.value=clamp(time,0,durationMs);
    // The same causal activity function drives live input and archive seeks.
    // Sampling has no history, so reversing or looping cannot retain a flare.
    setActivity(flow.sample(uniforms.uTime.value).energy);
    const signals=motion.sample(uniforms.uTime.value);
    uniforms.uMotionSpeed.value=signals.speed01;uniforms.uMotionTurn.value=signals.turn01;
    uniforms.uMotionCoherence.value=signals.coherence;uniforms.uMotionEnergy.value=signals.energy;
  };
  let disposed=false;
  const dispose=()=>{if(disposed)return;disposed=true;group.traverse((child)=>{child.geometry?.dispose();child.material?.dispose();});playheadMat.dispose();grid.length=0;cameraPicker.setCamera(null);};
  updatePlayhead(durationMs);
  return {group,uniforms,playhead,playheadMat,updatePlayhead,activityAt:(time)=>flow.sample(time).energy,motionAt:(time)=>motion.sample(time),motionForEvent,setActivity,inspect,updateHover,setInspection,dispose,
    setCamera:cameraPicker.setCamera,inspectNdc:cameraPicker.inspectNdc,updateHoverNdc,
    setViewMode:()=>{},layout,kind:'nebula',grainCount:count,strokeSegments:pairs.length/2,
    sampledIndices:sampled.indices,segmentPairs:pairs,stats:{points:count,halos:haloPositions.length/3,segments:pairs.length/2,totalSegments,totalNotes:sampled.totalNotes,totalMoves:sampled.totalMoves},
    get hoverStamp(){return hoverStamp;}};
}
