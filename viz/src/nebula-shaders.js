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
  ${NEBULA_PIXEL_SCALE}
  void main() {
    vec3 p = nebulaTransform(position);
    vec4 viewPosition=modelViewMatrix*vec4(p,1.0);
    gl_Position = projectionMatrix*viewPosition;
    float focus = 1.0-step(0.5, abs(aData.y-uSelLane));
    float hover = (1.0-step(0.5, abs(aData.y-uHoverLane)))*0.5;
    float isolation = uSelLane < -0.5 ? 1.0 : mix(0.12, 2.3, focus);
    float recent = exp(-max(0.0, uTime-aData.x)/550.0)*uReplaying;
    float diameter = aSize.x*nebulaPixelScale(viewPosition.xyz)*(1.0+focus*0.2+hover*0.15);
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
  uniform float uDepthPass;
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
    vec4 viewPosition=modelViewMatrix*vec4(p,1.0);
    viewPosition.xy+=position.xy*aSize.x;
    gl_Position=projectionMatrix*viewPosition;
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
  ${NEBULA_PIXEL_SCALE}
  void main() {
    vec3 start=(modelViewMatrix*vec4(nebulaTransform(aStart),1.0)).xyz;
    vec3 end=(modelViewMatrix*vec4(nebulaTransform(aEnd),1.0)).xyz;
    vec2 delta=end.xy-start.xy;
    vec2 perpendicular=vec2(-delta.y,delta.x)/max(length(delta),0.0000001);
    float width=0.00055+aData.w*0.0008;
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
    vAlpha=step(aData.x,uTime+0.0001)*isolation*(0.022+aData.w*0.040)*(1.0+hover*0.5);
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

// Every core surface is actual world geometry. These varyings provide camera-
// space normals and directions, so changing viewpoint changes its silhouette,
// occlusion and emission coherently instead of merely rotating a screen quad.
export const CORE_VERTEX = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vLocal;
  varying vec3 vNormal;
  varying vec3 vView;
  ${NEBULA_TRANSFORM}
  void main() {
    vUv=uv;
    vLocal=position;
    vec4 viewPosition=modelViewMatrix*vec4(nebulaTransform(position),1.0);
    vNormal=normalize(normalMatrix*nebulaTransform(normal));
    vView=-viewPosition.xyz;
    gl_Position=projectionMatrix*viewPosition;
  }
`;

export const HORIZON_FRAGMENT = /* glsl */ `
  precision highp float;
  void main() { gl_FragColor=vec4(0.0,0.0,0.0,1.0); }
`;

const PLASMA_NOISE = /* glsl */ `
  float hash(vec2 p) {
    p=fract(p*vec2(123.34,456.21));
    p+=dot(p,p+45.32);
    return fract(p.x*p.y);
  }
  float noise(vec2 p) {
    vec2 cell=floor(p),f=fract(p);
    f=f*f*(3.0-2.0*f);
    return mix(mix(hash(cell),hash(cell+vec2(1.0,0.0)),f.x),
      mix(hash(cell+vec2(0.0,1.0)),hash(cell+vec2(1.0,1.0)),f.x),f.y);
  }
  float plasma(vec2 p) {
    return noise(p)*0.57+noise(p*2.07+17.4)*0.29+noise(p*4.13-8.2)*0.14;
  }
`;

export const CORE_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform float uActivity;
  uniform float uAnimation;
  uniform float uCoronaLayer;
  varying vec2 vUv;
  varying vec3 vLocal;
  varying vec3 vNormal;
  varying vec3 vView;
  ${PLASMA_NOISE}
  void main() {
    float flow=sqrt(clamp(uActivity,0.0,1.0));
    float angle=atan(vLocal.y,vLocal.x)-uAnimation*0.18;
    float radius=length(vLocal.xy);
    vec2 orbit=vec2(cos(angle),sin(angle));
    float cloud=plasma(orbit*4.5+vec2(radius*31.0-uAnimation*0.11,uAnimation*0.07));
    float detail=plasma(orbit*13.0+vec2(radius*80.0+uAnimation*0.08,-uAnimation*0.06));
    vec3 n=normalize(vNormal)*(gl_FrontFacing?1.0:-1.0);
    vec3 view=normalize(vView);
    float facing=max(0.0,dot(n,view));
    float fresnel=pow(1.0-facing,2.3);
    float approaching=pow(0.5+0.5*sin(angle+uAnimation*0.18+0.7),2.0);
    float phase=radius*930.0+cloud*19.0+sin(angle*7.0)*1.7-uAnimation*1.25;
    float fine=pow(0.5+0.5*sin(phase),18.0);
    // Preserve integrated filament light when radial strands become subpixel,
    // instead of letting a distant view turn into a moire pattern.
    float strands=mix(fine,0.132,clamp(fwidth(phase)/3.14159265,0.0,1.0));
    float broad=pow(0.5+0.5*sin(radius*270.0+cloud*3.0-angle*1.8),5.0);
    float boundary=smoothstep(0.224,0.238,radius)*(1.0-smoothstep(0.355,0.397,radius));
    float streams=(0.32+smoothstep(0.16,0.78,cloud)*0.68)*(0.65+detail*0.35);
    float density=boundary*streams;
    float radiance=(0.055+broad*0.24+strands*11.8)*density*(0.95+flow*1.30)*(0.55+approaching*0.90);
    float heat=clamp((0.395-radius)/0.172*0.7+strands*0.55,0.0,1.0);
    vec3 color=mix(vec3(1.0,0.32,0.045),vec3(1.55,1.32,0.97),heat);
    float alpha=(0.012+strands*0.11)*density;
    if(uCoronaLayer>0.5 && uCoronaLayer<1.5) {
      // A larger translucent toroidal shell supplies true spatial haze.
      radiance=(0.004+flow*0.009)*cloud*pow(facing,2.0);
      color=vec3(0.055,0.21,0.48);
      alpha=0.001*cloud*pow(facing,2.0);
    }
    else if(uCoronaLayer>1.5) {
      radiance=(2.0+flow*1.6)*(0.6+cloud*0.45)*(0.65+approaching*0.60);
      color=mix(vec3(1.0,0.57,0.18),vec3(1.45,1.16,0.73),approaching);
      alpha=0.08;
    }
    else {
      // Empty intervals are genuinely transparent, including depth. The disk
      // reads as emitted plasma streams rather than a lit opaque brown tube.
      if(density<0.002)discard;
    }
    gl_FragColor=vec4(color*radiance,alpha);
  }
`;

export const PHOTON_SHELL_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform float uActivity;
  uniform float uAnimation;
  varying vec3 vNormal;
  varying vec3 vView;
  varying vec3 vLocal;
  void main() {
    vec3 n=normalize(vNormal),view=normalize(vView);
    float rim=pow(1.0-max(0.0,dot(n,view)),24.0);
    float angle=atan(vLocal.y,vLocal.x);
    float warmth=0.5+0.5*sin(angle+0.6);
    float striation=0.85+0.15*sin(angle*13.0-uAnimation*0.65);
    float emission=rim*striation*(0.82+sqrt(clamp(uActivity,0.0,1.0))*0.95);
    vec3 color=mix(vec3(1.0,0.51,0.14),vec3(1.35,1.04,0.60),warmth);
    gl_FragColor=vec4(color*emission,0.0);
  }
`;
