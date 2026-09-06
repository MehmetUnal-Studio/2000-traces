// Native cinematic HDR composition. Only the background field is lensed.
// Inputs: 0 background, 1 foreground (Render Select index1), 2 core emission, 3 decorative galactic environment.
layout(location=0) out vec4 fragColor;
uniform vec4 uCameraPos, uCameraRight, uCameraUp, uCameraForward;
uniform vec4 uCameraInfo; // tan(verticalFov/2), aspect, near, far
uniform vec4 uLensOptics; // focus distance, aperture, lens strength, reserved

vec3 worldToView(vec3 p) {
  vec3 q=p-uCameraPos.xyz;
  return vec3(dot(q,uCameraRight.xyz),dot(q,uCameraUp.xyz),-dot(q,uCameraForward.xyz));
}
float insideFrame(vec2 uv) {
  return step(0.0,uv.x)*step(uv.x,1.0)*step(0.0,uv.y)*step(uv.y,1.0);
}
void main() {
  vec2 uv=vUV.st;
  vec3 coreView=worldToView(vec3(0.0));
  float distance=-coreView.z;
  float aspect=uCameraInfo.y;
  const float horizon=0.205;
  float enabled=distance>horizon ? 1.0 : 0.0;
  vec2 center=vec2(0.5);
  float radius=0.0;
  if(enabled>0.5) {
    center+=coreView.xy/vec2(uCameraInfo.x*aspect,uCameraInfo.x)/distance*0.5;
    radius=0.5*horizon/uCameraInfo.x/sqrt(max(0.00000001,distance*distance-horizon*horizon));
  }
  vec2 delta=(uv-center)*vec2(aspect,1.0);
  float r=length(delta), shadow=max(radius,0.000001);
  float falloff=1.0-smoothstep(3.0*shadow,7.0*shadow,r);
  float bend=min(1.65*shadow,1.5*shadow*shadow/max(r,0.65*shadow))
    *falloff*enabled*clamp(uLensOptics.z,0.0,2.0);
  vec2 warped=uv-delta/max(r,0.000001)*bend/vec2(aspect,1.0);
  vec3 background=(texture(sTD2DInputs[0],warped).rgb+texture(sTD2DInputs[3],warped).rgb)*insideFrame(warped);
  vec3 foreground=texture(sTD2DInputs[1],uv).rgb;
  vec4 core=texture(sTD2DInputs[2],uv);
  // Core RGB is already premultiplied integrated emission. Field targets are
  // accumulated radiance after their own source-alpha additive blending.
  vec3 light=foreground+core.rgb+background*(1.0-clamp(core.a,0.0,1.0));
  fragColor=TDOutputSwizzle(vec4(max(light,vec3(0.0)),1.0));
}
