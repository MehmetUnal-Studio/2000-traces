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
    float radial=(radius-INNER)/(OUTER-INNER);
    // A sheared, advecting material field replaces the equally spaced sine
    // rings. Periodic angular coordinates keep its seam invisible. Fixed
    // shear avoids winding the texture ever tighter over a long performance.
    float angle=atan(p.y,p.x)-phase*0.55+log(radius/INNER)*4.1;
    vec2 orbit=vec2(cos(angle),sin(angle));
    float warp=noise(orbit*3.1+vec2(radial*2.0,phase*0.07));
    vec2 field=orbit*(2.8+radial*0.7)+vec2(radial*15.0+warp*(1.7-coherence*0.35),phase*0.10);
    float broad=noise(field);
    float detail=noise(field*2.03+vec2(7.2,-13.1));
    float fine=noise(field*4.17+vec2(-11.3,4.8));
    // Unresolved turbulence fades to its mean rather than sparkling or
    // becoming engraved circles when viewed from far away.
    fine=mix(fine,0.5,smoothstep(0.3,1.8,footprint*140.0));
    float mass=broad*0.56+detail*0.29+fine*0.15;
    float ribbon=1.0-smoothstep(0.04,0.22,abs(detail-0.5+(broad-0.5)*0.48));
    float filaments=ribbon*(0.18+fine*0.82)*(0.35+broad*0.65);
    float boundary=smoothstep(INNER,INNER+0.018,radius)*(1.0-smoothstep(OUTER-0.085,OUTER,radius));
    float density=boundary*(0.13+mass*0.55+filaments*0.34)*(0.48+broad*0.52);
    vec3 tangent=vec3(-p.y,p.x,0.0)/max(radius,0.0001);
    float approaching=clamp(dot(tangent,-direction),-1.0,1.0);
    float doppler=pow(1.0+approaching*0.22,2.0);
    // Small thermal eddies use Cartesian coordinates rather than sharing
    // the stretched density ribbons: gas has texture across the flow too.
    float spin=atan(p.y,p.x)-phase*0.55;
    vec2 gas=radius*vec2(cos(spin),sin(spin))+p.z*vec2(0.71,-0.43);
    gas+=vec2(noise(gas*43.0+phase*0.06),noise(gas*43.0+17.3-phase*0.05))*0.009;
    float thermal=noise(gas*126.0+vec2(0.0,phase*0.08));
    float grain=noise(gas*317.0+vec2(7.2,-13.1));
    float dust=noise(gas*791.0+vec2(-11.3,4.8));
    grain=mix(grain,0.5,smoothstep(0.45,1.6,footprint*317.0));
    dust=mix(dust,0.5,smoothstep(0.45,1.6,footprint*791.0));
    float gaseous=thermal*0.46+grain*0.34+dust*0.20;
    float hot=smoothstep(0.47,0.77,gaseous);
    float heat=clamp((1.0-radial)*0.50+hot*0.50,0.0,1.0);
    vec3 color=mix(vec3(0.65,0.115,0.035),vec3(1.18,0.52,0.22),smoothstep(0.15,0.57,heat));
    color=mix(color,vec3(1.30,1.17,1.02),smoothstep(0.55,0.85,heat));
    color=mix(color,vec3(0.09,0.15,0.20),smoothstep(0.65,1.0,radial)*0.65);
    float light=(1.7+mass*1.4)*(0.15+gaseous*0.55+hot*1.35)*(0.85+flow*0.65)*doppler;
    float photon=exp(-pow((radius-(INNER+0.011))/0.008,2.0));
    color=color*light+vec3(0.72,0.58,0.36)*photon*(0.25+hot*0.75)*(0.85+flow*0.55);
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
