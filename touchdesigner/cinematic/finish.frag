// Linear HDR optics -> filmic highlight rolloff -> one sRGB display encoding.
layout(location=0) out vec4 fragColor;
uniform vec4 uGrade; // exposure stops, saturation, bloom, anamorphic scattering
uniform vec4 uFilm; // grain, vignette, animation seconds, reserved
vec3 filmic(vec3 x) {
  // Luminance-preserving shoulder avoids clipping individual hot RGB channels.
  float y=dot(x,vec3(.2126,.7152,.0722));
  float mapped=(y*(2.51*y+.03))/(y*(2.43*y+.59)+.14);
  return x*(mapped/max(y,.00001));
}
vec3 toSRGB(vec3 x) {
  return mix(12.92*x,1.055*pow(max(x,vec3(0)),vec3(1./2.4))-.055,step(vec3(.0031308),x));
}
float hash(vec2 p) { return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453); }
void main() {
  vec2 uv=vUV.st;
  vec3 light=texture(sTD2DInputs[0],uv).rgb;
  light+=texture(sTD2DInputs[1],uv).rgb*uGrade.z;
  light+=texture(sTD2DInputs[2],uv).rgb*uGrade.w;
  light*=exp2(uGrade.x);
  float y=dot(light,vec3(.2126,.7152,.0722));
  light=mix(vec3(y),light,uGrade.y);
  float radius=length((uv-.5)*vec2(1.1,1));
  light*=1.-uFilm.y*smoothstep(.2,.8,radius);
  vec3 color=toSRGB(filmic(max(light,vec3(0))));
  float grain=(hash(gl_FragCoord.xy+fract(uFilm.z)*83.1)-.5)*uFilm.x/255.;
  color+=grain*smoothstep(.005,.2,max(color.r,max(color.g,color.b)));
  fragColor=TDOutputSwizzle(vec4(clamp(color,0.,1.),1));
}
