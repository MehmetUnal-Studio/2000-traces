// Accumulate the data layers in linear light before the final exposure pass.
import * as THREE from 'three';
import { projectLens } from './lensing.js';

const vertexShader = `varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const material = (fragmentShader, uniforms) => new THREE.ShaderMaterial({
  vertexShader, fragmentShader, uniforms, depthTest: false, depthWrite: false,
});

export function createArtworkPipeline(renderer) {
  const options = { type: renderer.extensions.has('EXT_color_buffer_float') ? THREE.HalfFloatType : THREE.UnsignedByteType, minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter, depthBuffer: false };
  const depthTarget = () => {
    const target = new THREE.WebGLRenderTarget(1, 1, { ...options, depthBuffer: true });
    target.depthTexture = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType);
    target.depthTexture.minFilter = target.depthTexture.magFilter = THREE.NearestFilter;
    return target;
  };
  const field = depthTarget();
  const core = depthTarget();
  const composite = new THREE.WebGLRenderTarget(1, 1, options);
  const glowA = new THREE.WebGLRenderTarget(1, 1, options);
  const glowB = new THREE.WebGLRenderTarget(1, 1, options);
  const size = new THREE.Vector2();
  const scene = new THREE.Scene();
  const camera = new THREE.Camera();
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
  quad.frustumCulled = false;
  scene.add(quad);
  const lens = material(`precision highp float;
    varying vec2 vUv;
    uniform sampler2D uField, uDepth, uCore, uCoreDepth;
    uniform vec2 uCenter, uClip;
    uniform float uRadius, uAspect, uDistance, uEnabled;
    float distanceAt(float d) { return uClip.x*uClip.y/(uClip.y-d*(uClip.y-uClip.x)); }
    float inside(vec2 p) { return step(0.0,p.x)*step(p.x,1.0)*step(0.0,p.y)*step(p.y,1.0); }
    void main() {
      vec2 delta=(vUv-uCenter)*vec2(uAspect,1.0);
      float radius=length(delta), r=max(uRadius,0.000001);
      float falloff=1.0-smoothstep(3.0*r,7.0*r,radius);
      float bend=min(1.65*r,1.5*r*r/max(radius,.65*r))*falloff*uEnabled;
      vec2 warped=vUv-delta/max(radius,0.000001)*bend/vec2(uAspect,1.0);
      float foreground=1.0-step(uDistance,distanceAt(texture2D(uDepth,vUv).r));
      vec2 source=mix(warped,vUv,foreground);
      // Do not duplicate an unrelated foreground star into a background arc.
      if(distanceAt(texture2D(uDepth,source).r)<uDistance) source=vUv;
      vec3 background=texture2D(uField,source).rgb*inside(source);
      float sourceDistance=distanceAt(texture2D(uDepth,source).r);
      vec4 nucleus=texture2D(uCore,vUv);
      float coreRawDepth=texture2D(uCoreDepth,vUv).r;
      float coreDistance=coreRawDepth>.999999 ? uDistance : distanceAt(coreRawDepth);
      float front=1.0-step(coreDistance,sourceDistance);
      vec3 color=mix(background*(1.0-clamp(nucleus.a,0.0,1.0))+nucleus.rgb,
        background+nucleus.rgb*.12,front);
      gl_FragColor=vec4(color,1.0);
    }`, { uField:{value:field.texture},uDepth:{value:field.depthTexture},
      uCore:{value:core.texture},uCoreDepth:{value:core.depthTexture},
      uCenter:{value:new THREE.Vector2(.5,.5)},uClip:{value:new THREE.Vector2(.008,80)},
      uRadius:{value:0},uAspect:{value:1},uDistance:{value:3},uEnabled:{value:0} });
  const extract = material(`precision highp float;
    varying vec2 vUv; uniform sampler2D uImage;
    void main() {
      vec3 c = texture2D(uImage, vUv).rgb;
      float peak = max(c.r, max(c.g, c.b));
      gl_FragColor = vec4(c * smoothstep(0.38, 1.4, peak) * 0.5, 1.0);
    }`, { uImage: { value: composite.texture } });
  const blur = material(`precision highp float;
    varying vec2 vUv; uniform sampler2D uImage; uniform vec2 uStep;
    void main() {
      vec3 c = texture2D(uImage, vUv).rgb * 0.227027;
      c += texture2D(uImage, vUv + uStep * 1.384615).rgb * 0.316216;
      c += texture2D(uImage, vUv - uStep * 1.384615).rgb * 0.316216;
      c += texture2D(uImage, vUv + uStep * 3.230769).rgb * 0.070270;
      c += texture2D(uImage, vUv - uStep * 3.230769).rgb * 0.070270;
      gl_FragColor = vec4(c, 1.0);
    }`, { uImage: { value: glowA.texture }, uStep: { value: new THREE.Vector2() } });
  const finish = material(`precision highp float;
    varying vec2 vUv; uniform sampler2D uImage; uniform sampler2D uGlow;
    vec3 toDisplay(vec3 c) {
      return mix(c * 12.92, 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055,
        step(vec3(0.0031308), c));
    }
    void main() {
      vec3 linear = texture2D(uImage, vUv).rgb;
      vec3 light = linear + texture2D(uGlow, vUv).rgb * 0.21;
      vec3 c = vec3(1.0) - exp(-light * 1.18);
      c = toDisplay(c);
      float grain = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
      c += (grain - 0.5) * 0.003;
      gl_FragColor = vec4(c, 1.0);
    }`, { uImage: { value: composite.texture }, uGlow: { value: glowA.texture } });
  function pass(mat, target) {
    quad.material = mat;
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
  }
  function render(artwork, viewCamera, target = null) {
    if (target) size.set(target.width, target.height);
    else renderer.getDrawingBufferSize(size);
    const w = Math.max(1, size.x); const h = Math.max(1, size.y);
    if (field.width !== w || field.height !== h) {
      field.setSize(w, h);
      core.setSize(w, h);
      composite.setSize(w, h);
      glowA.setSize(Math.ceil(w / 2), Math.ceil(h / 2));
      glowB.setSize(Math.ceil(w / 2), Math.ceil(h / 2));
    }
    const previousTarget = renderer.getRenderTarget();
    const previousMask=viewCamera.layers.mask;
    const previousClear=renderer.getClearColor(new THREE.Color());
    const previousAlpha=renderer.getClearAlpha();
    const previousAutoClear=renderer.autoClear;
    const originalBackground=artwork.background;
    const depthMaterials=new Map(), depthUniforms=new Map(), heights=new Map();
    let hasCore=false;
    artwork.traverseVisible(object=>{
      if(object.userData.eventHorizon) hasCore=true;
      for(const mat of Array.isArray(object.material)?object.material:[object.material]) {
        if(!mat)continue;
        const height=mat.uniforms?.uViewportHeight;
        if(height&&!heights.has(height)){heights.set(height,height.value);height.value=h;}
        const flag=mat.uniforms?.uDepthPass;
        if(flag&&object.layers.mask&1) {
          depthMaterials.set(mat,{colorWrite:mat.colorWrite,depthWrite:mat.depthWrite});
          if(!depthUniforms.has(flag))depthUniforms.set(flag,flag.value);
        }
      }
    });
    try {
      renderer.autoClear=true;
      artwork.background=null;
      viewCamera.layers.set(0);
      renderer.setRenderTarget(field);
      renderer.render(artwork, viewCamera);
      // Reuse the exact data vertex shaders to write sparse source depth.
      // A generic override material would lose the orbit/tilt transforms.
      renderer.autoClear=false;
      for(const [mat] of depthMaterials){mat.colorWrite=false;mat.depthWrite=true;}
      for(const [flag]of depthUniforms)flag.value=1;
      renderer.render(artwork,viewCamera);
      for(const [mat,state]of depthMaterials)Object.assign(mat,state);
      for(const [flag,value]of depthUniforms)flag.value=value;
      renderer.autoClear=true;
      renderer.setClearColor(0,0);
      viewCamera.layers.set(1);
      renderer.setRenderTarget(core);
      renderer.render(artwork,viewCamera);
      const projection=projectLens(viewCamera);
      lens.uniforms.uCenter.value.set(projection.x,projection.y);
      lens.uniforms.uClip.value.set(viewCamera.near,viewCamera.far);
      lens.uniforms.uRadius.value=projection.radius;
      lens.uniforms.uAspect.value=w/h;
      lens.uniforms.uDistance.value=projection.depth;
      lens.uniforms.uEnabled.value=hasCore&&projection.enabled?1:0;
      pass(lens,composite);
      {
        pass(extract, glowA);
        for (const spread of [1.0, 2.4]) {
          blur.uniforms.uImage.value = glowA.texture;
          blur.uniforms.uStep.value.set(spread / glowA.width, 0);
          pass(blur, glowB);
          blur.uniforms.uImage.value = glowB.texture;
          blur.uniforms.uStep.value.set(0, spread / glowA.height);
          pass(blur, glowA);
        }
      }
      pass(finish, target);
    } finally {
      for(const [mat,state]of depthMaterials)Object.assign(mat,state);
      for(const [flag,value]of depthUniforms)flag.value=value;
      for(const [height,value]of heights)height.value=value;
      viewCamera.layers.mask=previousMask;
      artwork.background=originalBackground;
      renderer.autoClear=previousAutoClear;
      renderer.setClearColor(previousClear,previousAlpha);
      renderer.setRenderTarget(previousTarget);
    }
  }
  return {
    render,
    setTheme: () => {},
    dispose() { [field, core, composite, glowA, glowB, lens, extract, blur, finish, quad.geometry].forEach((v) => v.dispose()); },
  };
}
