// A continuous field in the recorded artwork's local space. It shades real
// event footprints; it never creates events or changes a recorded point center.
export const NEBULA_VOLUME = /* glsl */ `
  float cloudHash(vec3 p) {
    p=fract(p*vec3(0.1031,0.1030,0.0973));
    p+=dot(p,p.yxz+33.33);
    return fract((p.x+p.y)*p.z);
  }
  float cloudNoise(vec3 p) {
    vec3 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);
    return mix(mix(mix(cloudHash(i),cloudHash(i+vec3(1,0,0)),f.x),
                   mix(cloudHash(i+vec3(0,1,0)),cloudHash(i+vec3(1,1,0)),f.x),f.y),
               mix(mix(cloudHash(i+vec3(0,0,1)),cloudHash(i+vec3(1,0,1)),f.x),
                   mix(cloudHash(i+vec3(0,1,1)),cloudHash(i+vec3(1,1,1)),f.x),f.y),f.z);
  }
  // Uneven knots and branching dust channels share a world-space field across
  // dust, gas and traces. Camera movement exposes the same structures.
  vec2 cloudStructure(vec3 p) {
    float radius=length(p.xy);
    vec3 warped=p*7.4+vec3(sin(p.y*9.0),sin(p.x*8.0),0.0)*0.42;
    float coarse=cloudNoise(warped);
    float medium=cloudNoise(warped*2.07+vec3(17.1,3.8,9.4));
    float ridge=abs(sin(radius*39.0+p.z*19.0+coarse*7.5+medium*1.9));
    float transmission=mix(0.10,1.0,smoothstep(0.06,0.43,ridge));
    float knots=smoothstep(0.24,0.81,coarse*0.65+medium*0.35);
    return vec2(knots,transmission);
  }
`;
