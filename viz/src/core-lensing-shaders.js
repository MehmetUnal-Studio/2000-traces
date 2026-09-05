import { CORE_RAY } from './core-ray.js';
const f=(value)=>Number(value).toFixed(8);

export const CORE_LENS_VERTEX=/* glsl */`
  uniform vec4 uScreenRect;
  out vec2 vRayNdc;
  void main() {
    vRayNdc=mix(uScreenRect.xy,uScreenRect.zw,position.xy*0.5+0.5);
    gl_Position=vec4(vRayNdc,0.0,1.0);
  }
`;

export const CORE_LENS_FRAGMENT=/* glsl */`
  precision highp float;
  in vec2 vRayNdc;
  out vec4 fragColor;
  uniform mat4 uInverseProjection, uCameraWorld, uWorldToDisk, uDiskToClip;
  uniform float uPerspective, uPixelCone, uActive;
  uniform float uActivity, uAnimation, uMotionSpeed, uMotionTurn, uMotionCoherence;
  const float HORIZON=${f(CORE_RAY.horizon)};
  const float INNER=${f(CORE_RAY.inner)};
  const float OUTER=${f(CORE_RAY.outer)};
  const float EXTENT=${f(CORE_RAY.extent)};
  const float CURVATURE=${f(CORE_RAY.curvature)};
  const float HEIGHT=${f(CORE_RAY.halfHeight)};

  vec2 sphere(vec3 p,vec3 d,float radius) {
    float b=dot(p,d),q=b*b-dot(p,p)+radius*radius;
    if(q<0.0)return vec2(1e8,-1e8);
    q=sqrt(q);return vec2(-b-q,-b+q);
  }
  float hash(vec2 p) {
    p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);
    return fract(p.x*p.y);
  }
  float noise(vec2 p) {
    vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);
    return mix(mix(hash(i),hash(i+vec2(1.0,0.0)),f.x),
      mix(hash(i+vec2(0.0,1.0)),hash(i+vec2(1.0)),f.x),f.y);
  }
  float depthOf(vec3 p) {
    vec4 clip=uDiskToClip*vec4(p,1.0);
    if(clip.w<=0.000001)return 1.0;
    return clamp(clip.z/clip.w*0.5+0.5,0.0,1.0);
  }
  // True local disk coordinates, sampled where the curved ray enters plasma.
  // Angle is periodic: no atan branch seam in the animated turbulent field.
  vec4 diskLight(vec3 p,vec3 direction,float footprint) {
    float radius=length(p.xy);
    float flow=sqrt(clamp(uActivity,0.0,1.0));
    float speed=clamp(uMotionSpeed,0.0,1.0);
    float coherence=clamp(uMotionCoherence,0.0,1.0);
    float turn=clamp(uMotionTurn,-1.0,1.0);
    float phase=uAnimation*(0.15+speed*0.13)*(1.0+turn*0.20);
    float angle=atan(p.y,p.x)-phase*pow(0.31/max(radius,INNER),1.5);
    vec2 orbit=vec2(cos(angle),sin(angle));
    float broad=noise(orbit*4.3+vec2(radius*27.0,phase*0.11));
    float detail=noise(orbit*13.0+vec2(radius*73.0,-phase*0.2));
    float boundary=smoothstep(INNER,INNER+0.018,radius)*(1.0-smoothstep(OUTER-0.07,OUTER,radius));
    float phaseFine=radius*820.0+broad*(9.0-coherence*3.0)+sin(angle*7.0)*1.5-phase*2.0;
    float fine=pow(0.5+0.5*sin(phaseFine),14.0);
    // Integrate unresolved subpixel strands to their mean, preserving print
    // radiance and avoiding moire when the camera approaches or recedes.
    fine=mix(fine,0.149,clamp(footprint*820.0/3.14159265,0.0,1.0));
    float streams=(0.35+0.65*broad)*(0.62+0.38*detail);
    float density=boundary*streams*(0.25+fine*1.65);
    vec3 tangent=vec3(-p.y,p.x,0.0)/max(radius,0.0001);
    float approaching=clamp(dot(tangent,-direction),-1.0,1.0);
    float doppler=pow(1.0+approaching*0.34,2.0);
    float heat=clamp((OUTER-radius)/(OUTER-INNER)*0.65+fine*0.55,0.0,1.0);
    vec3 color=mix(vec3(1.0,0.28,0.035),vec3(1.45,1.24,0.91),heat);
    color=mix(color,vec3(0.075,0.27,0.50),smoothstep(0.39,OUTER,radius)*0.66);
    float light=(2.3+fine*6.0)*(0.90+flow*0.80)*doppler;
    // A thin luminous inner stream survives an idle/empty live session.
    float photon=exp(-pow((radius-(INNER+0.011))/0.006,2.0));
    color=color*light+vec3(1.65,1.37,0.88)*photon*(3.5+flow*2.0);
    return vec4(color,density);
  }
  void main() {
    if(uActive<0.5)discard;
    vec4 nearView=uInverseProjection*vec4(vRayNdc,-1.0,1.0);
    vec4 farView=uInverseProjection*vec4(vRayNdc,1.0,1.0);
    vec3 nearWorld=(uCameraWorld*vec4(nearView.xyz/nearView.w,1.0)).xyz;
    vec3 farWorld=(uCameraWorld*vec4(farView.xyz/farView.w,1.0)).xyz;
    vec3 worldOrigin=mix(nearWorld,uCameraWorld[3].xyz,uPerspective);
    vec3 origin=(uWorldToDisk*vec4(worldOrigin,1.0)).xyz;
    vec3 direction=normalize((uWorldToDisk*vec4(farWorld-nearWorld,0.0)).xyz);
    vec2 interval=sphere(origin,direction,EXTENT);
    if(interval.y<max(interval.x,0.0))discard;
    vec3 p=origin+direction*(max(0.0,interval.x)+0.00001);
    vec3 light=vec3(0.0);
    float transmittance=1.0,firstDepth=1.0;
    bool captured=false;
    for(int i=0;i<${CORE_RAY.steps};i++) {
      float radius=length(p);
      if(radius<=HORIZON) {captured=true;firstDepth=min(firstDepth,depthOf(p));break;}
      if(radius>EXTENT+0.0001&&dot(p,direction)>0.0)break;
      float ds=clamp((radius-HORIZON)*0.13,${f(CORE_RAY.minStep)},${f(CORE_RAY.maxStep)});
      vec3 bend=-CURVATURE*(p-direction*dot(p,direction))/max(radius*radius*radius,0.000001);
      vec3 middle=normalize(direction+bend*ds*0.5);
      vec3 next=p+middle*ds;
      vec2 horizon=sphere(p,middle,HORIZON);
      bool hit=horizon.x>=0.0&&horizon.x<=ds;
      float segment=hit?horizon.x:ds;
      // Analytic slab overlap prevents a thin disk disappearing between march
      // samples; exact edge-on rays integrate its volume, not a plane sprite.
      float footprint=uPixelCone*mix(1.0,length(p-origin),uPerspective);
      float halfHeight=max(HEIGHT,footprint*0.65);
      float zStep=middle.z*segment;
      float from=0.0,to=1.0;
      if(abs(zStep)>0.0000001) {
        vec2 slab=(vec2(-halfHeight,halfHeight)-p.z)/zStep;
        from=clamp(min(slab.x,slab.y),0.0,1.0);
        to=clamp(max(slab.x,slab.y),0.0,1.0);
      } else if(abs(p.z)>halfHeight)to=0.0;
      float path=max(0.0,to-from)*segment;
      if(path>0.0000001) {
        vec3 samplePoint=p+middle*(segment*(from+to)*0.5);
        float diskRadius=length(samplePoint.xy);
        if(diskRadius>INNER&&diskRadius<OUTER) {
          vec4 emission=diskLight(samplePoint,middle,footprint);
          float absorb=1.0-exp(-emission.a*path/(2.0*halfHeight)*0.23);
          light+=transmittance*emission.rgb*absorb;
          transmittance*=1.0-absorb;
          if(absorb>0.002)firstDepth=min(firstDepth,depthOf(samplePoint));
        }
      }
      if(hit) {captured=true;firstDepth=min(firstDepth,depthOf(p+middle*segment));break;}
      direction=normalize(direction+bend*ds);p=next;
      if(transmittance<0.006)break;
    }
    float alpha=captured?1.0:1.0-transmittance;
    if(alpha<0.0001&&dot(light,light)<0.000001)discard;
    // RGB is already integrated/premultiplied; the layer-1 target stores this
    // directly and the artwork compositor applies the transmitted background.
    fragColor=vec4(light,alpha);
    gl_FragDepth=firstDepth;
  }
`;
