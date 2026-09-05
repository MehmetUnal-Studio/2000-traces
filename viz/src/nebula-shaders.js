// Linear-light materials: the shared artwork pipeline owns exposure and bloom.
// Positions come from recorded X/Y; only their view transform lives on the GPU.
import { NEBULA_VOLUME } from './nebula-volume.js';
export const NEBULA_TRANSFORM = /* glsl */ `
  uniform float uTime;
  uniform float uDuration;
  uniform float uOrbit;
  uniform float uTilt;
  vec3 nebulaTransform(vec3 p) {
    float angle = uOrbit + 3.45575191895 * uTime / max(uDuration, 1.0);
    float c = cos(angle), s = sin(angle);
    p.xy = mat2(c, s, -s, c) * p.xy;
    float inclination = 0.6981317008 + uTilt;
    c = cos(inclination); s = sin(inclination);
    p.yz = mat2(c, s, -s, c) * p.yz;
    c = 0.9689124217; s = -0.2474039593;
    p.xy = mat2(c, s, -s, c) * p.xy;
    return p;
  }
  vec3 nebulaLight(float heat) {
    vec3 cold = vec3(0.115, 0.39, 0.64);
    vec3 ice = vec3(0.47, 0.72, 0.86);
    vec3 amber = vec3(1.0, 0.39, 0.105);
    float warmth=smoothstep(0.63,0.9,heat);
    return mix(mix(cold,ice,smoothstep(0.18,0.63,heat)),amber,warmth)*(1.0+warmth*0.25);
  }
`;

// World widths are measured at each primitive's camera depth. Orthographic
// print cameras keep the existing pixels-per-world scale unchanged.
export const NEBULA_PIXEL_SCALE = /* glsl */ `
  uniform float uViewportHeight;
  float nebulaPixelScale(vec3 viewPosition) {
    if(projectionMatrix[3][3]<0.5)
      return 0.5*uViewportHeight*projectionMatrix[1][1]/max(0.0001,-viewPosition.z);
    return uPointScale;
  }
`;

export const DUST_VERTEX = /* glsl */ `
  attribute vec4 aData; // event time, participant lane, note onset, light temperature
  attribute vec2 aSize; // world-space sprite diameter, radiance
  attribute vec4 aMotion; // measured speed, turn, X direction, Y direction
  uniform float uPointScale;
  uniform float uPointMax;
  uniform float uSelLane;
  uniform float uHoverLane;
  uniform float uReplaying;
  uniform float uAtmosphere;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vNote;
  varying float vRotation;
  varying float vMotionSpeed;
  ${NEBULA_TRANSFORM}
  ${NEBULA_PIXEL_SCALE}
  ${NEBULA_VOLUME}
  void main() {
    vec3 p = nebulaTransform(position);
    vec4 viewPosition=modelViewMatrix*vec4(p,1.0);
    gl_Position = projectionMatrix*viewPosition;
    float focus = 1.0-step(0.5, abs(aData.y-uSelLane));
    float hover = (1.0-step(0.5, abs(aData.y-uHoverLane)))*0.5;
    float isolation = uSelLane < -0.5 ? 1.0 : mix(0.12, 2.3, focus);
    float recent = exp(-max(0.0, uTime-aData.x)/550.0)*uReplaying;
    float diameter = aSize.x*nebulaPixelScale(viewPosition.xyz)*(1.0+focus*0.2+hover*0.15+aMotion.x*0.30);
    float rasterSize = clamp(diameter, 1.5, uPointMax);
    gl_PointSize = rasterSize;
    float coverage = min(1.0, diameter*diameter/(rasterSize*rasterSize));
    float visible = step(aData.x, uTime+0.0001);
    float depthLight = 0.67+0.55*smoothstep(-0.6, 0.6, p.z);
    vec2 cloud=cloudStructure(position);
    vAlpha = aSize.y*visible*isolation*coverage*depthLight*(1.0+recent*0.85+hover+aMotion.x*0.42);
    vAlpha *= (0.28+cloud.x*1.45)*cloud.y;
    vColor = nebulaLight(aData.w);
    vColor = mix(vColor, vec3(0.9, 0.95, 1.0), aData.z*0.5);
    vNote = aData.z;
    vec3 radial=normalize(vec3(position.xy,0.0));
    vec3 direction=vec3(-radial.y,radial.x,0.0)*aMotion.z+radial*aMotion.w;
    vec3 viewDirection=mat3(modelViewMatrix)*nebulaTransform(direction);
    vRotation = length(viewDirection.xy)>0.000001 ? atan(viewDirection.y,viewDirection.x) : 0.0;
    vMotionSpeed=aMotion.x;
  }
`;

export const DUST_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform float uAtmosphere;
  uniform float uDepthPass;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vNote;
  varying float vRotation;
  varying float vMotionSpeed;
  void main() {
    vec2 q = gl_PointCoord*2.0-1.0;
    float c=cos(vRotation), s=sin(vRotation);
    q = mat2(c,s,-s,c)*q;
    q.y *= 1.0+vMotionSpeed*1.15;
    q.y *= mix(1.0, 1.65, uAtmosphere);
    float r2=dot(q,q);
    if(r2>1.0 || vAlpha<0.00001) discard;
    float envelope = exp(-r2*mix(5.5,3.5,uAtmosphere));
    envelope *= 1.0-smoothstep(0.60,1.0,r2);
    if(uDepthPass>0.5) {
      if(uAtmosphere>0.5 || r2>0.16 || vAlpha*envelope<0.03) discard;
      gl_FragColor=vec4(0.0); return;
    }
    float core=exp(-r2*42.0)*(1.0-uAtmosphere);
    float star=exp(-abs(q.x)*55.0-abs(q.y)*5.0)+exp(-abs(q.x)*5.0-abs(q.y)*55.0);
    vec3 radiance=vColor*envelope;
    radiance+=vec3(0.68,0.85,1.0)*core*(0.3+vNote*1.5);
    radiance+=vec3(0.45,0.65,0.8)*star*vNote*0.08*(1.0-uAtmosphere);
    gl_FragColor=vec4(radiance, vAlpha);
  }
`;

// Broad atmosphere uses world-space billboards, never a device's capped
// gl_PointSize. Its weight and footprint therefore survive a 4K export.
export const ATMOSPHERE_VERTEX = /* glsl */ `
  attribute vec3 aCenter;
  attribute vec4 aData;
  attribute vec2 aSize;
  attribute vec4 aMotion;
  uniform float uSelLane;
  uniform float uHoverLane;
  varying vec2 vUv;
  varying vec3 vColor;
  varying float vAlpha;
  varying vec3 vVolumePosition;
  varying vec3 vVolumeRay;
  varying float vFootprint;
  varying vec2 vMotion;
  ${NEBULA_TRANSFORM}
  void main() {
    vec3 p=nebulaTransform(aCenter);
    vec4 viewPosition=modelViewMatrix*vec4(p,1.0);
    vec3 radial=normalize(vec3(aCenter.xy,0.0));
    vec3 movement=vec3(-radial.y,radial.x,0.0)*aMotion.z+radial*aMotion.w;
    vec3 direction=mat3(modelViewMatrix)*nebulaTransform(movement);
    float angle=length(direction.xy)>0.000001 ? atan(direction.y,direction.x) : 0.0;
    float c=cos(angle),s=sin(angle);
    vec2 offset=mat2(c,s,-s,c)*(position.xy*vec2(1.0+aMotion.x*0.55,1.0-aMotion.x*0.22))*aSize.x;
    viewPosition.xy+=offset;
    mat3 basis=mat3(modelViewMatrix)*mat3(nebulaTransform(vec3(1,0,0)),nebulaTransform(vec3(0,1,0)),nebulaTransform(vec3(0,0,1)));
    // Dot products transpose the rotation without requiring GLSL inverse().
    vVolumePosition=aCenter+vec3(dot(basis[0].xy,offset),dot(basis[1].xy,offset),dot(basis[2].xy,offset));
    vVolumeRay=vec3(basis[0].z,basis[1].z,basis[2].z);
    vFootprint=aSize.x;
    vMotion=aMotion.xy;
    gl_Position=projectionMatrix*viewPosition;
    float focus=1.0-step(0.5,abs(aData.y-uSelLane));
    float hover=(1.0-step(0.5,abs(aData.y-uHoverLane)))*0.5;
    float isolation=uSelLane < -0.5 ? 1.0 : mix(0.15,2.3,focus);
    vAlpha=aSize.y*step(aData.x,uTime+0.0001)*isolation*(1.0+hover);
    vColor=nebulaLight(aData.w);
    vUv=uv;
  }
`;
export const ATMOSPHERE_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform float uDepthPass;
  uniform float uAnimation;
  uniform float uMotionCoherence;
  varying vec2 vUv;
  varying vec3 vColor;
  varying float vAlpha;
  varying vec3 vVolumePosition;
  varying vec3 vVolumeRay;
  varying float vFootprint;
  varying vec2 vMotion;
  ${NEBULA_VOLUME}
  void main() {
    if(uDepthPass>0.5||vAlpha<0.00001) discard;
    vec2 q=vUv*2.0-1.0;
    float radius=dot(q,q);
    if(radius>1.0)discard;
    vec3 p=vVolumePosition;
    vec2 structure=cloudStructure(p);
    // Three samples through the footprint soften gas into a volume. The fine
    // field is revealed by approach rather than a screen-space noise overlay.
    vec3 drift=vec3(0.013,-0.008,0.004)*uAnimation*(0.08+vMotion.x*0.30);
    float fine=cloudNoise(p*69.0+drift);
    fine+=cloudNoise((p+vVolumeRay*vFootprint*0.16)*69.0+drift);
    fine+=cloudNoise((p-vVolumeRay*vFootprint*0.16)*69.0+drift);
    fine/=3.0;
    float curls=cloudNoise(p*(124.0+vMotion.y*48.0)-drift);
    float gas=smoothstep(0.23,0.77,fine*0.75+curls*0.25);
    gas=mix(gas,fine,uMotionCoherence*0.24);
    float envelope=exp(-radius*2.4)*(1.0-smoothstep(0.45,1.0,radius));
    float density=(0.07+structure.x*2.2)*structure.y*gas*envelope;
    vec3 lit=mix(vColor*0.40,vColor*1.55,smoothstep(0.35,0.75,fine));
    lit=mix(lit,vec3(0.58,0.69,0.72),smoothstep(0.71,0.94,structure.x)*0.28);
    gl_FragColor=vec4(lit,vAlpha*density*(1.9+vMotion.x*0.55));
  }
`;

export const FILAMENT_VERTEX = /* glsl */ `
  attribute vec3 aStart;
  attribute vec3 aEnd;
  attribute vec4 aData; // second event time, lane, heat, real X/Y displacement
  attribute vec4 aMotion;
  uniform float uPointScale;
  uniform float uSelLane;
  uniform float uHoverLane;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vAcross;
  varying float vCoverage;
  ${NEBULA_TRANSFORM}
  ${NEBULA_PIXEL_SCALE}
  ${NEBULA_VOLUME}
  void main() {
    vec3 start=(modelViewMatrix*vec4(nebulaTransform(aStart),1.0)).xyz;
    vec3 end=(modelViewMatrix*vec4(nebulaTransform(aEnd),1.0)).xyz;
    vec2 delta=end.xy-start.xy;
    vec2 perpendicular=vec2(-delta.y,delta.x)/max(length(delta),0.0000001);
    float width=(0.00055+aData.w*0.0008)*(1.0+aMotion.x*0.65);
    vec3 p=mix(start,end,position.x);
    float expanded=max(width,1.5/max(nebulaPixelScale(p),1.0));
    p.xy+=perpendicular*position.y*expanded;
    gl_Position=projectionMatrix*vec4(p,1.0);
    vAcross=position.y*2.0;
    vCoverage=width/expanded;
    float focus=1.0-step(0.5,abs(aData.y-uSelLane));
    float isolation=uSelLane < -0.5 ? 1.0 : mix(0.08,4.0,focus);
    float hover=1.0-step(0.5,abs(aData.y-uHoverLane));
    vColor=nebulaLight(aData.z);
    vec2 cloud=cloudStructure(mix(aStart,aEnd,position.x));
    vAlpha=step(aData.x,uTime+0.0001)*isolation*(0.022+aData.w*0.040)*(1.0+hover*0.5+aMotion.x*0.6);
    vAlpha *= (0.30+cloud.x*1.1)*cloud.y;
  }
`;

export const FILAMENT_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform float uDepthPass;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vAcross;
  varying float vCoverage;
  void main() {
    if(uDepthPass>0.5) {
      if(vAlpha<0.02 || abs(vAcross)>0.30) discard;
      gl_FragColor=vec4(0.0); return;
    }
    float aa=max(fwidth(vAcross)*0.5,0.0001);
    float coverage=1.0-smoothstep(1.0-aa,1.0+aa,abs(vAcross));
    gl_FragColor=vec4(vColor,coverage*vCoverage*vAlpha);
  }
`;
