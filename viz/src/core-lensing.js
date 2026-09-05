import * as THREE from 'three';
import { CORE_RAY } from './core-ray.js';
import { CORE_LENS_VERTEX, CORE_LENS_FRAGMENT } from './core-lensing-shaders.js';

/** The same local-to-world rotation as recorded Nebula points and filaments. */
export function coreDiskMatrix(uniforms,worldMatrix=new THREE.Matrix4(),target=new THREE.Matrix4()) {
  const angle=(uniforms.uOrbit?.value??0)+3.45575191895*(uniforms.uTime?.value??0)/Math.max(1,uniforms.uDuration?.value??1);
  const rotation=new THREE.Matrix4().makeRotationZ(-0.25);
  rotation.multiply(new THREE.Matrix4().makeRotationX(0.6981317008+(uniforms.uTilt?.value??0)));
  rotation.multiply(new THREE.Matrix4().makeRotationZ(angle));
  return target.multiplyMatrices(worldMatrix,rotation);
}

/** Conservative view-space cube projection bounds all curved-ray entry rays. */
export function coreScreenBounds(camera,center,radius=CORE_RAY.extent,target=new THREE.Vector4()) {
  const view=center.clone().applyMatrix4(camera.matrixWorldInverse),depth=-view.z;
  if(depth+radius<=camera.near)return target.set(0,0,0,0);
  if(depth-radius<=camera.near)return target.set(-1,-1,1,1);
  let minX=1,minY=1,maxX=-1,maxY=-1;
  const point=new THREE.Vector3();
  for(const x of [-1,1])for(const y of [-1,1])for(const z of [-1,1]) {
    point.set(view.x+x*radius,view.y+y*radius,view.z+z*radius).applyMatrix4(camera.projectionMatrix);
    minX=Math.min(minX,point.x);maxX=Math.max(maxX,point.x);
    minY=Math.min(minY,point.y);maxY=Math.max(maxY,point.y);
  }
  return target.set(Math.max(-1,minX),Math.max(-1,minY),Math.min(1,maxX),Math.min(1,maxY));
}

/** A world-ray emitting disk: no screen-space copy of another core image. */
export function createLensedCore(shared={}) {
  const defaults={uTime:0,uDuration:1,uOrbit:0,uTilt:0,uAnimation:0,uActivity:0,
    uMotionSpeed:0,uMotionTurn:0,uMotionCoherence:0};
  const uniforms={...Object.fromEntries(Object.entries(defaults).map(([key,value])=>[key,{value}])),...shared,
    uScreenRect:{value:new THREE.Vector4(-1,-1,1,1)},
    uInverseProjection:{value:new THREE.Matrix4()},uCameraWorld:{value:new THREE.Matrix4()},
    uWorldToDisk:{value:new THREE.Matrix4()},uDiskToClip:{value:new THREE.Matrix4()},
    uPerspective:{value:1},uPixelCone:{value:0.001},uActive:{value:1},
  };
  const material=new THREE.ShaderMaterial({uniforms,vertexShader:CORE_LENS_VERTEX,fragmentShader:CORE_LENS_FRAGMENT,
    glslVersion:THREE.GLSL3,depthTest:true,depthWrite:true,blending:THREE.NoBlending,toneMapped:false});
  const mesh=new THREE.Mesh(new THREE.PlaneGeometry(2,2),material);
  mesh.name='nebula-ray-integrated-core';mesh.userData.eventHorizon=true;
  const group=new THREE.Group();group.name='nebula-lensed-core';group.add(mesh);
  group.userData.horizonRadius=CORE_RAY.horizon;
  group.userData.lensing='finite curved world-ray approximation';
  const viewport=new THREE.Vector4(),center=new THREE.Vector3(),diskWorld=new THREE.Matrix4();
  mesh.onBeforeRender=(renderer,scene,camera)=>{
    renderer.getCurrentViewport(viewport);
    const height=Math.max(1,viewport.w);
    camera.updateMatrixWorld();mesh.updateWorldMatrix(true,false);
    coreDiskMatrix(uniforms,mesh.matrixWorld,diskWorld);
    uniforms.uWorldToDisk.value.copy(diskWorld).invert();
    uniforms.uDiskToClip.value.multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse).multiply(diskWorld);
    uniforms.uInverseProjection.value.copy(camera.projectionMatrixInverse);
    uniforms.uCameraWorld.value.copy(camera.matrixWorld);
    uniforms.uPerspective.value=camera.isPerspectiveCamera?1:0;
    uniforms.uPixelCone.value=2/(Math.abs(camera.projectionMatrix.elements[5])*height)/
      (camera.isPerspectiveCamera?1:diskWorld.getMaxScaleOnAxis());
    center.setFromMatrixPosition(diskWorld);
    coreScreenBounds(camera,center,CORE_RAY.extent*diskWorld.getMaxScaleOnAxis(),uniforms.uScreenRect.value);
    const rect=uniforms.uScreenRect.value;
    uniforms.uActive.value=rect.z>rect.x&&rect.w>rect.y?1:0;
  };
  group.traverse(object=>{object.layers.set(1);object.frustumCulled=false;object.userData.nebulaCore=true;});
  let disposed=false;
  group.userData.dispose=()=>{if(disposed)return;disposed=true;mesh.geometry.dispose();material.dispose();};
  return group;
}
