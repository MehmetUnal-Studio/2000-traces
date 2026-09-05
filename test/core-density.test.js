import test from 'node:test';
import assert from 'node:assert/strict';
import { CORE_RAY, coreDiskDensity, traceCoreRay } from '../viz/src/core-ray.js';

const phases=[0,17.5,180,3600,86400];
const footprints=[0,0.0001,0.002,0.02];
const radii=[0.24,0.27,0.32,0.39,0.45];
const motion={motionSpeed:0.7,motionTurn:-0.4,motionCoherence:0.6};

test('turbulent density joins continuously across the polar angle seam during animation',()=>{
  for(const animation of phases)for(const footprint of footprints)for(const radius of radii) {
    const options={animation,...motion};
    const above=coreDiskDensity([-radius,1e-9,0],footprint,options);
    const below=coreDiskDensity([-radius,-1e-9,0],footprint,options);
    assert.ok(Math.abs(above-below)<1e-5,`visible atan seam at radius ${radius}, phase ${animation}`);
    // Signed zero exercises the atan(+PI)/atan(-PI) branch itself.
    const edgeAbove=coreDiskDensity([-radius,0,0],footprint,options);
    const edgeBelow=coreDiskDensity([-radius,-0,0],footprint,options);
    assert.ok(Math.abs(edgeAbove-edgeBelow)<1e-7);
  }
});

test('density remains finite and bounded across phase, radius, motion and output footprint',()=>{
  let litSamples=0;
  const motions=[{},motion,{motionSpeed:1,motionTurn:1,motionCoherence:1},
    {motionSpeed:-10,motionTurn:-10,motionCoherence:10}];
  for(const animation of phases)for(const footprint of footprints)for(const state of motions) {
    const options={animation,...state};
    for(const radius of [0,CORE_RAY.inner-1e-6,CORE_RAY.inner,CORE_RAY.outer,CORE_RAY.outer+1e-6,2]) {
      assert.equal(coreDiskDensity([radius,0,0],footprint,options),0,'no opacity outside the physical emitting disk');
    }
    for(const radius of radii)for(let i=0;i<24;i++) {
      const angle=i*Math.PI/12;
      const density=coreDiskDensity([radius*Math.cos(angle),radius*Math.sin(angle),0],footprint,options);
      assert.ok(Number.isFinite(density)&&density>=0&&density<=1.02,`invalid density ${density}`);
      if(density>0.01)litSamples++;
    }
  }
  assert.ok(litSamples>1000,'a finite-density regression must not pass by extinguishing the entire disk');
});

test('motion normalization and small phase or footprint changes cannot create density jumps',()=>{
  for(const animation of phases)for(const footprint of footprints)for(const radius of radii)for(let i=0;i<12;i++) {
    const angle=i*Math.PI/6,point=[radius*Math.cos(angle),radius*Math.sin(angle),0];
    const options={animation,...motion};
    const density=coreDiskDensity(point,footprint,options);
    const advanced=coreDiskDensity(point,footprint,{...options,animation:animation+1e-5});
    const resized=coreDiskDensity(point,footprint+1e-8,options);
    assert.ok(Math.abs(density-advanced)<0.002,'a tiny clock advance must not create a visible phase cut');
    assert.ok(Math.abs(density-resized)<0.002,'coverage filtering must remain continuous while dollying');
    assert.equal(coreDiskDensity(point,footprint,{animation,motionSpeed:20,motionTurn:-20,motionCoherence:20}),
      coreDiskDensity(point,footprint,{animation,motionSpeed:1,motionTurn:-1,motionCoherence:1}));
  }
});

test('radial detail does not wind into unresolved bands during a long performance',()=>{
  for(const animation of phases)for(const radius of radii)for(let i=0;i<24;i++) {
    const angle=i*Math.PI/12,options={animation,...motion};
    const point=[radius*Math.cos(angle),radius*Math.sin(angle),0];
    const adjacent=[(radius+1e-6)*Math.cos(angle),(radius+1e-6)*Math.sin(angle),0];
    const difference=Math.abs(coreDiskDensity(point,0,options)-coreDiskDensity(adjacent,0,options));
    assert.ok(difference<0.001,`spatial detail grew too fine after ${animation} seconds: ${difference}`);
  }
});

test('animated turbulence preserves edge-on near-plasma occlusion at display and print resolution',()=>{
  for(const animation of phases)for(const height of [720,4096]) {
    const options={animation,...motion,pixelCone:2*Math.tan(Math.PI/8)/height};
    const ray=traceCoreRay([0,-2.5,0],[0,1,0],options);
    assert.equal(ray.captured,true);
    assert.equal(ray.crossings.length,0);
    assert.ok(ray.depthPoints.some(point=>point[1]<-0.35),'the animated near disk must hide a mark at radius .30');
    assert.ok(ray.depthPoints.every(point=>point.every(Number.isFinite)));
    assert.deepEqual(traceCoreRay([0,-2.5,0],[0,1,0],options),ray,'archive seek reconstructs the same material depth');
  }
});
