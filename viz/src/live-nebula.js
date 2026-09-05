// The live take uses the archive's coordinate system and GPU materials.
// Reservoirs bound display memory; the recorder retains every original event.
import * as THREE from 'three';
import { createNebulaUniforms, makePoints, makeFilamentSegments, createNebulaCore, createNebulaCameraPicker,
  nebulaEventPosition, projectNebulaPoint, lightTemperature, cloudEnvelope, NEBULA_LIMITS, NEBULA_CORE_RADIUS } from './nebula.js';
import { createLiveFlowEnergy } from './flow-energy.js';
import { createLiveMotionSignals } from './motion-signals.js';
import { mulberry32 } from './prng.js';

function reservoir(mesh, capacity, names, random) {
  let seen=0, count=0, dirtyStart=capacity, dirtyEnd=0;
  const attributes=names.map((name)=>mesh.geometry.attributes[name]);
  attributes.forEach((attribute)=>attribute.setUsage(THREE.DynamicDrawUsage));
  const resize=()=>mesh.geometry.isInstancedBufferGeometry
    ? mesh.geometry.instanceCount=count : mesh.geometry.setDrawRange(0,count);
  resize();
  return {
    mesh,
    get count(){return count;},
    put(values) {
      seen++;
      const slot=count<capacity?count++:Math.floor(random()*seen);
      if(slot>=capacity) return -1;
      attributes.forEach((attribute,i)=>attribute.array.set(values[i],slot*attribute.itemSize));
      dirtyStart=Math.min(dirtyStart,slot);dirtyEnd=Math.max(dirtyEnd,slot+1);
      return slot;
    },
    commit() {
      if(dirtyEnd<=dirtyStart) return;
      for(const attribute of attributes) {
        // Coalesce with pending uploads: hidden tabs may commit thousands of
        // batches without a render. Preserve every pending byte in one range.
        let start=dirtyStart*attribute.itemSize,end=dirtyEnd*attribute.itemSize;
        for(const range of attribute.updateRanges) {start=Math.min(start,range.start);end=Math.max(end,range.start+range.count);}
        attribute.clearUpdateRanges();attribute.addUpdateRange(start,end-start);
        attribute.needsUpdate=true;
      }
      resize();dirtyStart=capacity;dirtyEnd=0;
    },
  };
}

export function createLiveNebula(layout,{visualSeed=1,limits=NEBULA_LIMITS}={}) {
  const durationMs=layout.durationMs;
  const uniforms=createNebulaUniforms(durationMs);
  const group=new THREE.Group();group.name='nebula-live-gesture-field';
  const random=mulberry32(visualSeed);
  const points=reservoir(makePoints(new Float32Array(limits.points*3),new Float32Array(limits.points*4),
    new Float32Array(limits.points*2),uniforms,'nebula-live-starlight'),limits.points,['position','aData','aSize','aMotion'],random);
  const halos=reservoir(makePoints(new Float32Array(limits.halos*3),new Float32Array(limits.halos*4),
    new Float32Array(limits.halos*2),uniforms,'nebula-live-atmosphere',true),limits.halos,['aCenter','aData','aSize','aMotion'],random);
  const segments=reservoir(makeFilamentSegments(new Float32Array(limits.segments*3),new Float32Array(limits.segments*3),
    new Float32Array(limits.segments*4),uniforms,'nebula-live-finger-filaments'),limits.segments,['aStart','aEnd','aData','aMotion'],random);
  group.add(points.mesh,halos.mesh,segments.mesh,createNebulaCore(uniforms));
  const playheadMat=new THREE.LineBasicMaterial({transparent:true,opacity:0});
  const playhead=new THREE.Group();playhead.visible=false;group.add(playhead);
  const flow=createLiveFlowEnergy();
  const motion=createLiveMotionSignals({maxLanes:Math.max(1,Math.min(65536,layout.laneRadius.length))});
  const lastByLane=new Map(), selectedByLane=new Map(), laneWatermark=new Map(), displayedByLane=new Map();
  const pointRecords=new Array(limits.points);
  // Inspection-only scalars stay in bounded typed arrays. No extra motion
  // object is retained for every reservoir event; hits materialize it on demand.
  const pointMotionRaw=new Float32Array(limits.points*3),pointMotionValid=new Uint8Array(limits.points);
  let grainCount=0,totalSegments=0,index=0,maxT=0,disposed=false;
  const valid=(v)=>Number.isFinite(v)&&v>=0&&v<=1;
  const context=()=>({time:uniforms.uTime.value,durationMs,orbit:uniforms.uOrbit.value,tilt:uniforms.uTilt.value});
  function append(lane,event) {
    if(!Number.isInteger(lane)||lane<0||lane>=layout.laneRadius.length||!Number.isFinite(event.t)||event.t<0||event.t>durationMs) return;
    const kind=event.k;
    maxT=Math.max(maxT,event.t);flow.ingest(event.t,kind);
    const finger=Number.isInteger(event.f)&&event.f>=0&&event.f<=65535?event.f:null;
    const measured=motion.ingest({lane,t:event.t,x:event.u,y:event.v,finger,kind});
    const ordered=event.t>=(laneWatermark.get(lane)??-Infinity);
    if(ordered)laneWatermark.set(lane,event.t);
    let fingers=lastByLane.get(lane);
    if(kind===5) {if(ordered){lastByLane.delete(lane);selectedByLane.delete(lane);displayedByLane.delete(lane);}return;}
    if(kind===2) {if(ordered){fingers?.delete(finger);const last=selectedByLane.get(lane);if(last?.finger===finger)last.active=false;
      const displayed=displayedByLane.get(lane)?.get(finger);if(displayed)displayed.active=false;}return;}
    if(kind!==1&&kind!==3)return;
    if(!valid(event.u)||!valid(event.v)) {if(ordered){fingers?.delete(finger);selectedByLane.delete(lane);
      const displayed=displayedByLane.get(lane)?.get(finger);if(displayed)displayed.active=false;}return;}
    const gesture={lane,t:event.t,x:event.u,y:event.v,finger,kind,index:index++,active:true};
    const p=nebulaEventPosition(gesture,{durationMs}),heat=lightTemperature(gesture,durationMs);
    const note=kind===1?1:0, extent=Math.abs(gesture.x-0.5)+Math.abs(gesture.y-0.5);
    const cloud=cloudEnvelope(gesture,durationMs),bright=note&&((gesture.index+1)*0.754877666)%1<0.015;
    const diameter=note?(bright?0.034:0.011):0.004+extent*0.004;
    // Fixed dense-field exposure prevents early marks from changing character.
    const radiance=note?(bright?1.2:0.40)*(0.25+cloud*0.75):(0.13+extent*0.13)*cloud*0.59;
    const vector=[measured.speed01,measured.turn01,measured.directionX,measured.directionY];
    const slot=points.put([[p.x,p.y,p.z],[gesture.t,lane,note,heat],[diameter,radiance],vector]);
    if(slot>=0) {
      pointRecords[slot]={...gesture};pointMotionValid[slot]=Number(measured.valid);
      pointMotionRaw.set([measured.speed,measured.turn,measured.energy],slot*3);
    }
    grainCount++;uniforms.uHasData.value=1;
    // Only actual gestures create atmospheric samples, also uniformly retained.
    halos.put([[p.x,p.y,p.z],[gesture.t,lane,0,heat],[0.08+extent*0.14,0.013*cloud],vector]);
    if(!ordered)return; // late input still becomes a real point, never a new live path
    const previous=fingers?.get(finger);
    const connects=finger!==null&&previous&&kind!==1&&gesture.t>=previous.t&&gesture.t-previous.t<=1200;
    if(connects) {
      const a=nebulaEventPosition(previous,{durationMs});
      segments.put([[a.x,a.y,a.z],[p.x,p.y,p.z],[gesture.t,lane,heat,Math.min(1,Math.hypot(gesture.x-previous.x,gesture.y-previous.y)*4)],vector]);
      totalSegments++;
    }
    if(!fingers) {fingers=new Map();lastByLane.set(lane,fingers);}
    // Honest unknown identities produce points, never a fabricated finger path.
    // Bound per-lane retained identities even if a malformed source changes IDs.
    if(fingers.size>=16&&!fingers.has(finger))fingers.delete(fingers.keys().next().value);
    gesture.trail=connects?[...(previous.trail??[]).slice(-63),{x:gesture.x,y:gesture.y,t:gesture.t}]:[{x:gesture.x,y:gesture.y,t:gesture.t}];
    gesture.motion=measured;
    fingers.set(finger,gesture);selectedByLane.set(lane,gesture);
    let displayed=displayedByLane.get(lane);
    if(!displayed){displayed=new Map();displayedByLane.set(lane,displayed);}
    if(displayed.size>=16&&!displayed.has(finger))displayed.delete(displayed.keys().next().value);
    displayed.set(finger,gesture);
  }
  function hitAt(index) {
    const recorded=pointRecords[index];if(!recorded)return null;
    const values=points.mesh.geometry.attributes.aMotion.array;
    const gesture={...recorded,motion:{valid:!!pointMotionValid[index],speed:pointMotionRaw[index*3],turn:pointMotionRaw[index*3+1],energy:pointMotionRaw[index*3+2],
      speed01:values[index*4],turn01:values[index*4+1],directionX:values[index*4+2],directionY:values[index*4+3]}};
    return {lane:gesture.lane,gesture};
  }
  function inspect(x,y) {
    if(!Number.isFinite(x)||!Number.isFinite(y)||Math.hypot(x,y)<NEBULA_CORE_RADIUS)return null;
    const transform=context();let nearest=-1,best=Math.max(0.009,7/Math.max(1,uniforms.uPointScale.value))**2;
    const position=points.mesh.geometry.attributes.position.array;
    for(let i=0;i<points.count;i++) {
      const p=projectNebulaPoint({x:position[i*3],y:position[i*3+1],z:position[i*3+2]},transform);
      const distance=(p.x-x)**2+(p.y-y)**2;
      if(distance<best) {best=distance;nearest=i;}
    }
    return nearest<0?null:hitAt(nearest);
  }
  const cameraPicker=createNebulaCameraPicker(uniforms,points.mesh.geometry.attributes.position.array,{
    getCount:()=>points.count,getTime:(index)=>pointRecords[index]?.t??Infinity,object:group,
    makeHit:hitAt,
  });
  return {group,uniforms,playhead,playheadMat,kind:'nebula',append,inspect,
    setCamera:cameraPicker.setCamera,inspectNdc:cameraPicker.inspectNdc,
    grainCount:()=>grainCount,
    get stats(){return {points:points.count,halos:halos.count,segments:segments.count,totalSegments};},
    sampleLane(lane,time,finger=undefined) {
      const gesture=finger===undefined?selectedByLane.get(lane):displayedByLane.get(lane)?.get(finger);
      return gesture&&gesture.t<=time?{...gesture,active:gesture.active&&time-gesture.t<=1200,trail:gesture.finger===null?[]:gesture.trail}:null;
    },
    motionAt:(time)=>motion.sample(Math.max(maxT,time)),
    commit(){points.commit();halos.commit();segments.commit();},
    updatePlayhead(time) {
      const clock=Math.max(maxT,Math.min(durationMs,time));
      uniforms.uTime.value=clock;uniforms.uActivity.value=flow.sample(clock).energy;
      const signals=motion.sample(clock);
      uniforms.uMotionSpeed.value=signals.speed01;uniforms.uMotionTurn.value=signals.turn01;
      uniforms.uMotionCoherence.value=signals.coherence;uniforms.uMotionEnergy.value=signals.energy;
    },
    dispose(){if(disposed)return;disposed=true;group.traverse(child=>{child.geometry?.dispose();child.material?.dispose();});playheadMat.dispose();lastByLane.clear();selectedByLane.clear();laneWatermark.clear();displayedByLane.clear();motion.reset();pointRecords.length=0;cameraPicker.setCamera(null);},
  };
}
