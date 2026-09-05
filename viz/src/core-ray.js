// Finite, optically thin curved-ray model for the artwork's emitting core.
// This intentionally uses a softened transverse curvature, not a GR solver.
// The CPU reference and GPU marcher share all integration constants.
export const CORE_RAY = Object.freeze({
  horizon: 0.205,
  inner: 0.235,
  outer: 0.46,
  extent: 0.76,
  halfHeight: 0.004,
  curvature: 0.105,
  steps: 128,
  minStep: 0.0045,
  maxStep: 0.047,
});

const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const add=(a,b,s=1)=>a.map((v,i)=>v+b[i]*s);
const unit=(v)=>{const n=Math.hypot(...v);return v.map(x=>x/n);};
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const fract=(v)=>v-Math.floor(v);
const mix=(a,b,t)=>a+(b-a)*t;
const smooth=(a,b,v)=>{const t=clamp((v-a)/(b-a),0,1);return t*t*(3-2*t);};
function hash(x,y) {
  x=fract(x*123.34);y=fract(y*456.21);
  const d=x*(x+45.32)+y*(y+45.32);x+=d;y+=d;
  return fract(x*y);
}
function noise(x,y) {
  const ix=Math.floor(x),iy=Math.floor(y),fx=fract(x),fy=fract(y);
  const sx=fx*fx*(3-2*fx),sy=fy*fy*(3-2*fy);
  return mix(mix(hash(ix,iy),hash(ix+1,iy),sx),mix(hash(ix,iy+1),hash(ix+1,iy+1),sx),sy);
}

// Mirror diskLight's alpha channel, not its color: selection needs the exact
// finite-slab depth-writing threshold even when the ray never crosses z=0.
export function coreDiskDensity(point,footprint=0,{
  animation=0,motionSpeed=0,motionTurn=0,motionCoherence=0,
}={}) {
  const radius=Math.hypot(point[0],point[1]);
  if(radius<=CORE_RAY.inner||radius>=CORE_RAY.outer)return 0;
  const phase=animation*(.15+clamp(motionSpeed,0,1)*.13)*(1+clamp(motionTurn,-1,1)*.20);
  const radial=(radius-CORE_RAY.inner)/(CORE_RAY.outer-CORE_RAY.inner);
  // Fixed logarithmic shear matches the GPU's advected material field. The
  // spatial frequency does not grow with elapsed performance time.
  const angle=Math.atan2(point[1],point[0])-phase*.55+Math.log(radius/CORE_RAY.inner)*4.1;
  const x=Math.cos(angle),y=Math.sin(angle);
  const warp=noise(x*3.1+radial*2,y*3.1+phase*.07);
  const qx=x*(2.8+radial*.7)+radial*15+warp*(1.7-clamp(motionCoherence,0,1)*.35);
  const qy=y*(2.8+radial*.7)+phase*.10;
  const broad=noise(qx,qy);
  const detail=noise(qx*2.03+7.2,qy*2.03-13.1);
  const fine=mix(noise(qx*4.17-11.3,qy*4.17+4.8),.5,smooth(.3,1.8,footprint*140));
  const mass=broad*.56+detail*.29+fine*.15;
  const ribbon=1-smooth(.04,.22,Math.abs(detail-.5+(broad-.5)*.48));
  const filaments=ribbon*(.18+fine*.82)*(.35+broad*.65);
  const boundary=smooth(CORE_RAY.inner,CORE_RAY.inner+.018,radius)*(1-smooth(CORE_RAY.outer-.085,CORE_RAY.outer,radius));
  return boundary*(.13+mass*.55+filaments*.34)*(.48+broad*.52);
}
export function raySphereInterval(origin,direction,radius) {
  const b=dot(origin,direction),c=dot(origin,origin)-radius*radius;
  const d=b*b-c;
  if(d<0)return null;
  const q=Math.sqrt(d);
  return [-b-q,-b+q];
}

/** Reference march in the local disk frame; useful for optical regressions. */
export function traceCoreRay(origin,direction,{
  curvature=CORE_RAY.curvature,pixelCone=0,perspective=true,
  animation=0,motionSpeed=0,motionTurn=0,motionCoherence=0,
}={}) {
  let d=unit(direction);
  const interval=raySphereInterval(origin,d,CORE_RAY.extent);
  if(!interval||interval[1]<0)return {captured:false,crossings:[],depthPoints:[],steps:0,opacity:0};
  let p=add(origin,d,Math.max(0,interval[0])+1e-5);
  const crossings=[],depthPoints=[];
  const densityOptions={animation,motionSpeed,motionTurn,motionCoherence};
  let transmittance=1;
  let minRadius=Math.hypot(...p),steps=0;
  const result=(captured,horizonPoint)=>{
    if(horizonPoint)depthPoints.push(horizonPoint);
    return {captured,crossings,depthPoints,steps,minRadius,opacity:captured?1:1-transmittance,
      ...(horizonPoint?{horizonPoint}:{}),};
  };
  for(;steps<CORE_RAY.steps;steps++) {
    const radius=Math.hypot(...p);
    if(radius<=CORE_RAY.horizon)return result(true,p);
    if(radius>CORE_RAY.extent+1e-4&&dot(p,d)>0)break;
    const ds=Math.max(CORE_RAY.minStep,Math.min(CORE_RAY.maxStep,(radius-CORE_RAY.horizon)*0.13));
    const bend=p.map((x,i)=>-curvature*(x-d[i]*dot(p,d))/Math.max(radius**3,1e-6));
    const middle=unit(add(d,bend,ds*0.5));
    const next=add(p,middle,ds);
    const horizon=raySphereInterval(p,middle,CORE_RAY.horizon);
    const hit=horizon&&horizon[0]>=0&&horizon[0]<=ds;
    const length=hit?horizon[0]:ds;
    const footprint=pixelCone*(perspective?Math.hypot(...p.map((v,i)=>v-origin[i])):1);
    const halfHeight=Math.max(CORE_RAY.halfHeight,footprint*.65);
    const zStep=middle[2]*length;
    let from=0,to=1;
    if(Math.abs(zStep)>1e-7) {
      const a=(-halfHeight-p[2])/zStep,b=(halfHeight-p[2])/zStep;
      from=clamp(Math.min(a,b),0,1);to=clamp(Math.max(a,b),0,1);
    }else if(Math.abs(p[2])>halfHeight)to=0;
    const path=Math.max(0,to-from)*length;
    if(path>1e-7) {
      const samplePoint=add(p,middle,length*(from+to)*.5);
      const density=coreDiskDensity(samplePoint,footprint,densityOptions);
      const absorb=1-Math.exp(-density*path/(2*halfHeight)*.23);
      transmittance*=1-absorb;
      if(absorb>.002)depthPoints.push(samplePoint);
    }
    if(p[2]*next[2]<=0&&Math.abs(next[2]-p[2])>1e-12) {
      const fraction=-p[2]/(next[2]-p[2]);
      if(fraction*ds<=length) {
        const point=add(p,middle,fraction*ds),r=Math.hypot(point[0],point[1]);
        if(r>=CORE_RAY.inner&&r<=CORE_RAY.outer)crossings.push({point,radius:r,direction:middle.slice()});
      }
    }
    minRadius=Math.min(minRadius,Math.hypot(...next));
    if(hit) {steps++;return result(true,add(p,middle,length));}
    d=unit(add(d,bend,ds));p=next;
    if(transmittance<.006)break;
  }
  return result(false);
}
