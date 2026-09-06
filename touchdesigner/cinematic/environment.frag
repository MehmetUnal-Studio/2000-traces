// Original native TD environment: decorative distant dust and sparse stars.
// No recorded events are generated here. No texture assets or temporal noise.
// Linear HDR. Add to the BACKGROUND field before lensing and core occlusion.
layout(location=0) out vec4 fragColor;
uniform vec4 uCameraPos, uCameraRight, uCameraUp, uCameraForward;
uniform vec4 uCameraInfo; // tan(vertical FOV / 2), aspect, near, far
uniform vec4 uEnvironment; // nebula gain, star gain, reserved, reserved

float hash1(vec3 p) {
  p=fract(p*vec3(0.1031,0.1030,0.0973));
  p+=dot(p,p.yxz+33.33);
  return fract((p.x+p.y)*p.z);
}
vec3 hash3(vec3 p) {
  p=fract(p*vec3(0.1031,0.1030,0.0973));
  p+=dot(p,p.yxz+33.33);
  return fract((p.xxy+p.yxx)*p.zyx);
}
float noise3(vec3 p) {
  vec3 i=floor(p), f=fract(p);
  f=f*f*f*(f*(f*6.0-15.0)+10.0);
  return mix(mix(mix(hash1(i),hash1(i+vec3(1,0,0)),f.x),
                 mix(hash1(i+vec3(0,1,0)),hash1(i+vec3(1,1,0)),f.x),f.y),
             mix(mix(hash1(i+vec3(0,0,1)),hash1(i+vec3(1,0,1)),f.x),
                 mix(hash1(i+vec3(0,1,1)),hash1(i+vec3(1,1,1)),f.x),f.y),f.z);
}
float filteredNoise3(vec3 p) {
  float footprint=max(length(dFdx(p)),length(dFdy(p)));
  return mix(noise3(p),0.5,smoothstep(0.35,1.15,footprint));
}
vec3 shellPosition(vec3 origin,vec3 ray,float radius) {
  // All shells are centered in world space. Moving the real camera changes
  // their apparent projection at different rates, without moving their seeds.
  float b=dot(origin,ray);
  float q=max(0.0,b*b-dot(origin,origin)+radius*radius);
  float distance=max(0.0,-b+sqrt(q));
  return origin+ray*distance;
}
vec3 distantStars(vec3 position,float cellScale,float occupancy,float seed) {
  vec3 p=position*cellScale;
  // Evaluate derivatives before the non-uniform empty-cell branch.
  float footprint=max(length(dFdx(p)),length(dFdy(p)))*0.35;
  vec3 cell=floor(p);
  float choice=hash1(cell+seed);
  if(choice>occupancy) return vec3(0.0);
  vec3 random=hash3(cell+vec3(seed,seed+19.1,seed-8.4));
  vec3 offset=fract(p)-(vec3(0.5)+(random-0.5)*0.22);
  float sharp=0.020+random.y*0.014;
  float variance=sharp*sharp+min(0.14*0.14,footprint*footprint);
  float profile=exp(-dot(offset,offset)/variance);
  // Pixel-footprint broadening preserves point energy; no animated twinkle.
  float energy=profile*sharp*sharp/variance;
  float brightness=1.1+11.0*pow(random.z,9.0);
  vec3 color=mix(vec3(0.50,0.68,1.0),vec3(1.0,0.86,0.69),random.x);
  return color*energy*brightness;
}
void main() {
  vec2 ndc=vUV.st*2.0-1.0;
  vec3 ray=normalize(uCameraForward.xyz
    +uCameraRight.xyz*ndc.x*uCameraInfo.x*uCameraInfo.y
    +uCameraUp.xyz*ndc.y*uCameraInfo.x);
  vec3 sky=normalize(shellPosition(uCameraPos.xyz,ray,48.0));

  // Fine astronomical dust, not a few enlarged interpolated noise cells.
  // Only the band direction receives broad warp. Material starts at much
  // higher world frequency; rotated octaves remove aligned rounded cells.
  const mat3 turn=mat3(0.00,0.80,0.60,-0.80,0.36,-0.48,-0.60,-0.48,0.64);
  vec3 p=turn*sky*92.0+vec3(7.3,1.9,12.7);
  float coarse=filteredNoise3(p);
  float middle=filteredNoise3(turn*p*2.07+vec3(5.2,-8.1,3.7));
  float fine=filteredNoise3(turn*turn*p*4.13+vec3(-11.4,4.1,7.6));
  float grain=filteredNoise3(turn*p*8.31+vec3(3.7,18.4,-2.2));
  float warp=noise3(sky*3.0+vec3(8.1,-6.2,1.3));
  float gaps=filteredNoise3(turn*p*1.43+vec3(-3.4,5.1,9.3));
  float latitude=dot(sky,normalize(vec3(0.68,-0.73,0.075)));
  latitude+=(warp-0.5)*0.025;
  float band=exp(-latitude*latitude*35.0);
  float ridge=exp(-latitude*latitude*170.0);
  float structure=coarse*0.20+middle*0.31+fine*0.31+grain*0.18;
  float dustLane=1.0-smoothstep(0.035,0.19,abs(gaps-0.5+(middle-0.5)*0.46));
  float transmission=exp(-dustLane*(1.2+middle*2.8));
  float density=pow(smoothstep(0.35,0.72,structure),1.35)
    *(band*0.40+ridge*0.60)*transmission;
  vec3 cold=vec3(0.072,0.10,0.135), warm=vec3(0.145,0.12,0.10);
  vec3 gas=mix(cold,warm,smoothstep(0.42,0.73,coarse)*0.32)*density;

  vec3 stars=distantStars(shellPosition(uCameraPos.xyz,ray,64.0),2.3,0.045,37.1);
  stars+=distantStars(shellPosition(uCameraPos.xyz,ray,112.0),3.2,0.022,81.7)*0.70;
  vec3 light=gas*clamp(uEnvironment.x,0.0,2.0)+stars*clamp(uEnvironment.y,0.0,2.0);
  fragColor=TDOutputSwizzle(vec4(max(light,vec3(0.0)),1.0));
}
