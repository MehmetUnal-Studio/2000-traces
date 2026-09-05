import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { projectLens, lensSourceNdc, viewDepth } from '../viz/src/lensing.js';
const camera=(z,aspect=1,x=0)=>{
  const c=new THREE.PerspectiveCamera(45,aspect,.008,80);
  c.position.set(x,0,z);c.lookAt(x,0,0);c.updateMatrixWorld();return c;
};
test('lens follows physical camera position, projection and approach',()=>{
  const far=projectLens(camera(4)),near=projectLens(camera(.65));
  assert.ok(near.radius>far.radius*6);
  const pan=projectLens(camera(4,1,.5));
  assert.ok(pan.x<.5,'world-origin hole moves across screen when camera pans');
  for(const aspect of [.5,1,2]) {
    const lens=projectLens(camera(4,aspect));
    const horizontal=lensSourceNdc(lens.radius*4/aspect,0,lens);
    const vertical=lensSourceNdc(0,lens.radius*4,lens);
    assert.ok(Math.abs(horizontal.x*aspect-vertical.y)<1e-9,'angular deflection uses aspect-correct distances');
  }
});
test('only background rays bend; center and distant rays stay finite',()=>{
  const lens=projectLens(camera(4));
  const x=lens.radius*4;
  assert.deepEqual(lensSourceNdc(x,0,lens,2),{x,y:0});
  assert.ok(lensSourceNdc(x,0,lens,8).x<x);
  assert.deepEqual(lensSourceNdc(1,1,lens),{x:1,y:1});
  assert.deepEqual(lensSourceNdc(0,0,lens),{x:0,y:0});
  assert.ok(Math.abs(viewDepth(0,.008,80)-.008)<1e-10);
  assert.ok(Math.abs(viewDepth(1,.008,80)-80)<1e-7);
});
