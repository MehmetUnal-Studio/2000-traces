import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createArtworkPipeline } from '../viz/src/artwork-pipeline.js';

function fixture(failAt=0) {
  const scene=new THREE.Scene();scene.background=new THREE.Color(0x102030);
  const camera=new THREE.PerspectiveCamera(45,1.6,.008,80);
  camera.position.z=3;camera.lookAt(0,0,0);camera.layers.mask=5;
  const flag={value:0.25},height={value:912};
  const makeMaterial=()=>new THREE.ShaderMaterial({uniforms:{uDepthPass:flag,uViewportHeight:height},depthWrite:false});
  const a=makeMaterial(),b=makeMaterial(),core=makeMaterial();
  b.colorWrite=false;b.depthWrite=true;
  const geometry=new THREE.PlaneGeometry(1,1);
  const first=new THREE.Mesh(geometry,a),second=new THREE.Mesh(geometry,b),horizon=new THREE.Mesh(geometry,core);
  horizon.layers.set(1);horizon.userData.eventHorizon=true;
  scene.add(first,second,horizon);
  const previousTarget={name:'user-owned-target'};
  const originalBackground=scene.background;
  const originalColor=new THREE.Color().setRGB(.015,.03,.055);
  const clearColor=originalColor.clone();let clearAlpha=.43,currentTarget=previousTarget;
  const calls=[];
  const renderer={
    autoClear:false,
    extensions:{has:()=>true},
    getDrawingBufferSize:(target)=>target.set(1280,720),
    getRenderTarget:()=>currentTarget,
    setRenderTarget:(target)=>{currentTarget=target;},
    getClearColor:(target)=>target.copy(clearColor),
    getClearAlpha:()=>clearAlpha,
    setClearColor:(color,alpha)=>{clearColor.set(color);clearAlpha=alpha;},
    render(renderedScene,renderedCamera) {
      calls.push({scene:renderedScene,target:currentTarget,mask:renderedCamera.layers.mask,
        background:scene.background,autoClear:this.autoClear,flag:flag.value,height:height.value,
        aColor:a.colorWrite,aDepth:a.depthWrite,bColor:b.colorWrite,bDepth:b.depthWrite,
        coreColor:core.colorWrite,coreDepth:core.depthWrite});
      if(calls.length===failAt)throw new Error(`simulated render failure ${failAt}`);
    },
  };
  const pipeline=createArtworkPipeline(renderer);
  const assertRestored=()=>{
    assert.equal(currentTarget,previousTarget);
    assert.equal(camera.layers.mask,5);
    assert.equal(scene.background,originalBackground);
    assert.equal(renderer.autoClear,false);
    assert.equal(clearAlpha,.43);
    assert.deepEqual(clearColor.toArray(),originalColor.toArray());
    assert.equal(flag.value,.25,'one shared uniform must be restored once, not to a later captured depth-pass value');
    assert.equal(height.value,912);
    assert.equal(a.colorWrite,true);assert.equal(a.depthWrite,false);
    assert.equal(b.colorWrite,false);assert.equal(b.depthWrite,true);
    assert.equal(core.colorWrite,true);assert.equal(core.depthWrite,false);
  };
  return {scene,camera,renderer,pipeline,calls,assertRestored,dispose(){pipeline.dispose();a.dispose();b.dispose();core.dispose();geometry.dispose();}};
}

test('pipeline restores shared uniforms, materials, camera layers and renderer state after every render-stage failure',()=>{
  for(const failAt of [1,2,3,4,6,10]) {
    const f=fixture(failAt);
    const printTarget=new THREE.WebGLRenderTarget(4096,4096);
    try {
      assert.throws(()=>f.pipeline.render(f.scene,f.camera,printTarget),new RegExp(`render failure ${failAt}`));
      f.assertRestored();
      assert.equal(f.calls[0].height,4096,'print target supplies the physical viewport for perspective widths');
      if(failAt>=2) {
        const depth=f.calls[1];
        assert.equal(depth.mask,1);assert.equal(depth.autoClear,false);
        assert.equal(depth.flag,1);assert.equal(depth.aColor,false);assert.equal(depth.aDepth,true);
        assert.equal(depth.coreColor,true,'separate core material is not changed during the data depth pass');
      }
      if(failAt>=3) {
        const core=f.calls[2];
        assert.equal(core.mask,2);assert.equal(core.flag,.25);
        assert.equal(core.aColor,true);assert.equal(core.aDepth,false);
      }
    } finally {f.dispose();printTarget.dispose();}
  }
});

test('successful print and next viewport render restore state and resize their own buffers independently',()=>{
  const f=fixture(),printTarget=new THREE.WebGLRenderTarget(4096,4096);
  try {
    f.pipeline.render(f.scene,f.camera,printTarget);
    f.assertRestored();
    assert.equal(f.calls.length,10);
    assert.equal(f.calls[0].target.width,4096);
    assert.equal(f.calls.at(-1).target,printTarget);
    const printHeight=f.calls[0].height;
    f.calls.length=0;
    f.pipeline.render(f.scene,f.camera);
    f.assertRestored();
    assert.equal(printHeight,4096);
    assert.equal(f.calls[0].height,720);
    assert.equal(f.calls[0].target.width,1280);assert.equal(f.calls[0].target.height,720);
    assert.equal(f.calls.at(-1).target,null);
    assert.equal(printTarget.width,4096,'a pipeline resize never mutates the caller-owned print target');
  } finally {f.dispose();printTarget.dispose();}
});
