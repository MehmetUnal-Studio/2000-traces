// Linear-light materials: the shared artwork pipeline owns exposure and bloom.
// Positions come from recorded X/Y; only their view transform lives on the GPU.
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

export const DUST_VERTEX = /* glsl */ `
  attribute vec4 aData; // event time, participant lane, note onset, light temperature
  attribute vec2 aSize; // world-space sprite diameter, radiance
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
  ${NEBULA_TRANSFORM}
  void main() {
    vec3 p = nebulaTransform(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
    float focus = 1.0-step(0.5, abs(aData.y-uSelLane));
    float hover = (1.0-step(0.5, abs(aData.y-uHoverLane)))*0.5;
    float isolation = uSelLane < -0.5 ? 1.0 : mix(0.12, 2.3, focus);
    float recent = exp(-max(0.0, uTime-aData.x)/550.0)*uReplaying;
    float diameter = aSize.x*uPointScale*(1.0+focus*0.2+hover*0.15);
    float rasterSize = clamp(diameter, 1.5, uPointMax);
    gl_PointSize = rasterSize;
    float coverage = min(1.0, diameter*diameter/(rasterSize*rasterSize));
    float visible = step(aData.x, uTime+0.0001);
    float depthLight = 0.67+0.55*smoothstep(-0.6, 0.6, p.z);
    vAlpha = aSize.y*visible*isolation*coverage*depthLight*(1.0+recent*0.85+hover);
    vColor = nebulaLight(aData.w);
    vColor = mix(vColor, vec3(0.9, 0.95, 1.0), aData.z*0.5);
    vNote = aData.z;
    vRotation = atan(p.y,p.x)+0.5;
  }
`;

export const DUST_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform float uAtmosphere;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vNote;
  varying float vRotation;
  void main() {
    vec2 q = gl_PointCoord*2.0-1.0;
    float c=cos(vRotation), s=sin(vRotation);
    q = mat2(c,s,-s,c)*q;
    q.y *= mix(1.0, 1.65, uAtmosphere);
    float r2=dot(q,q);
    if(r2>1.0 || vAlpha<0.00001) discard;
    float envelope = exp(-r2*mix(5.5,3.5,uAtmosphere));
    envelope *= 1.0-smoothstep(0.60,1.0,r2);
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
  uniform float uSelLane;
  uniform float uHoverLane;
  varying vec2 vUv;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vNote;
  varying float vRotation;
  ${NEBULA_TRANSFORM}
  void main() {
    vec3 p=nebulaTransform(aCenter);
    vRotation=atan(p.y,p.x)+0.5;
    p.xy+=position.xy*aSize.x;
    gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.0);
    float focus=1.0-step(0.5,abs(aData.y-uSelLane));
    float hover=(1.0-step(0.5,abs(aData.y-uHoverLane)))*0.5;
    float isolation=uSelLane < -0.5 ? 1.0 : mix(0.15,2.3,focus);
    vAlpha=aSize.y*step(aData.x,uTime+0.0001)*isolation*(1.0+hover);
    vColor=nebulaLight(aData.w);
    vNote=0.0;
    vUv=uv;
  }
`;
export const ATMOSPHERE_FRAGMENT = DUST_FRAGMENT
  .replace('precision highp float;', 'precision highp float;\nvarying vec2 vUv;')
  .replace('gl_PointCoord', 'vUv');

export const FILAMENT_VERTEX = /* glsl */ `
  attribute vec3 aStart;
  attribute vec3 aEnd;
  attribute vec4 aData; // second event time, lane, heat, real X/Y displacement
  uniform float uPointScale;
  uniform float uSelLane;
  uniform float uHoverLane;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vAcross;
  varying float vCoverage;
  ${NEBULA_TRANSFORM}
  void main() {
    vec3 start=nebulaTransform(aStart), end=nebulaTransform(aEnd);
    vec2 delta=end.xy-start.xy;
    vec2 perpendicular=vec2(-delta.y,delta.x)/max(length(delta),0.0000001);
    float width=0.00055+aData.w*0.0008;
    float expanded=max(width,1.5/max(uPointScale,1.0));
    vec3 p=mix(start,end,position.x);
    p.xy+=perpendicular*position.y*expanded;
    gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.0);
    vAcross=position.y*2.0;
    vCoverage=width/expanded;
    float focus=1.0-step(0.5,abs(aData.y-uSelLane));
    float isolation=uSelLane < -0.5 ? 1.0 : mix(0.08,4.0,focus);
    float hover=1.0-step(0.5,abs(aData.y-uHoverLane));
    vColor=nebulaLight(aData.z);
    vAlpha=step(aData.x,uTime+0.0001)*isolation*(0.022+aData.w*0.040)*(1.0+hover*0.5);
  }
`;

export const FILAMENT_FRAGMENT = /* glsl */ `
  precision highp float;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vAcross;
  varying float vCoverage;
  void main() {
    float aa=max(fwidth(vAcross)*0.5,0.0001);
    float coverage=1.0-smoothstep(1.0-aa,1.0+aa,abs(vAcross));
    gl_FragColor=vec4(vColor,coverage*vCoverage*vAlpha);
  }
`;

export const CORE_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv=uv;
    gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);
  }
`;

export const CORE_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform float uTime;
  uniform float uDuration;
  uniform float uOrbit;
  uniform float uHasData;
  varying vec2 vUv;
  void main() {
    vec2 p=vUv-0.5;
    float radius=length(p);
    float angle=atan(p.y,p.x);
    float phase=uOrbit+uTime/max(uDuration,1.0)*3.45575191895;
    float core=1.0-smoothstep(0.195,0.206,radius);
    float rim=exp(-pow((radius-0.208)/0.0028,2.0));
    float haze=exp(-pow((radius-0.216)/0.023,2.0));
    float crescent=pow(0.5+0.5*sin(angle+0.7),3.0);
    float striation=0.83+0.17*sin(angle*9.0-phase*0.8);
    float light=(rim*(0.16+crescent*0.65)+haze*0.10)*striation*uHasData;
    light*=smoothstep(0.200,0.209,radius);
    vec3 color=mix(vec3(0.12,0.38,0.64),vec3(1.0,0.52,0.17),crescent);
    float alpha=max(core,clamp(light,0.0,0.92));
    if(alpha<0.0005) discard;
    gl_FragColor=vec4(color*light*1.4,alpha);
  }
`;
