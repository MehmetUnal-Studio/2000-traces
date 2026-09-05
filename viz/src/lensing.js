// Camera-projected, finite thin-lens approximation. Angles are measured in
// viewport-height units so the lens is circular on every aspect ratio.
import * as THREE from 'three';
export const HORIZON_RADIUS = 0.205;
export function projectLens(camera, center = new THREE.Vector3(), radius = HORIZON_RADIUS) {
  camera.updateMatrixWorld();
  const view = center.clone().applyMatrix4(camera.matrixWorldInverse);
  const ndc = center.clone().project(camera);
  const depth = -view.z;
  const aspect = camera.aspect || 1;
  const r = depth > radius ? 0.5 * camera.projectionMatrix.elements[5] * radius /
    Math.sqrt(Math.max(1e-8, depth * depth - radius * radius)) : 0;
  return { x: Number.isFinite(ndc.x) ? ndc.x * .5 + .5 : .5, y: Number.isFinite(ndc.y) ? ndc.y * .5 + .5 : .5, radius: r,
    aspect, depth, enabled: depth > radius && Number.isFinite(r), near: camera.near, far: camera.far };
}
const smooth = (a,b,x) => { const t=Math.max(0,Math.min(1,(x-a)/(b-a)));return t*t*(3-2*t); };
export function lensSourceNdc(x, y, lens, sourceDepth = Infinity) {
  if (!lens.enabled || sourceDepth < lens.depth) return {x,y};
  const dx=((x+1)*.5-lens.x)*lens.aspect, dy=(y+1)*.5-lens.y;
  const distance=Math.hypot(dx,dy), r=lens.radius;
  if(distance < 1e-8 || r <= 0) return {x,y};
  const fade=1-smooth(3*r,7*r,distance);
  const bend=Math.min(1.65*r,1.5*r*r/Math.max(distance,.65*r))*fade;
  return {x:x-2*dx/distance*bend/lens.aspect,y:y-2*dy/distance*bend};
}
export function viewDepth(depth, near, far) {
  return near*far/(far-depth*(far-near));
}
