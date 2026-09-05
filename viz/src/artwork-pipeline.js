// Accumulate the data layers in linear light before the final exposure pass.
import * as THREE from 'three';

const vertexShader = `varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const material = (fragmentShader, uniforms) => new THREE.ShaderMaterial({
  vertexShader, fragmentShader, uniforms, depthTest: false, depthWrite: false,
});

export function createArtworkPipeline(renderer) {
  const options = { type: renderer.extensions.has('EXT_color_buffer_float') ? THREE.HalfFloatType : THREE.UnsignedByteType, minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter, depthBuffer: false };
  const field = new THREE.WebGLRenderTarget(1, 1, { ...options, depthBuffer: true, samples: 4 });
  const glowA = new THREE.WebGLRenderTarget(1, 1, options);
  const glowB = new THREE.WebGLRenderTarget(1, 1, options);
  const size = new THREE.Vector2();
  const scene = new THREE.Scene();
  const camera = new THREE.Camera();
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
  quad.frustumCulled = false;
  scene.add(quad);
  const extract = material(`precision highp float;
    varying vec2 vUv; uniform sampler2D uImage;
    void main() {
      vec3 c = texture2D(uImage, vUv).rgb;
      float peak = max(c.r, max(c.g, c.b));
      gl_FragColor = vec4(c * smoothstep(0.38, 1.4, peak) * 0.5, 1.0);
    }`, { uImage: { value: field.texture } });
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
    varying vec2 vUv; uniform sampler2D uImage; uniform sampler2D uGlow; uniform float uInk;
    vec3 toDisplay(vec3 c) {
      return mix(c * 12.92, 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055,
        step(vec3(0.0031308), c));
    }
    void main() {
      vec3 linear = texture2D(uImage, vUv).rgb;
      vec3 light = linear + texture2D(uGlow, vUv).rgb * 0.21;
      vec3 c = mix(vec3(1.0) - exp(-light * 1.18), clamp(linear, 0.0, 1.0), uInk);
      c = toDisplay(c);
      float grain = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
      c += (grain - 0.5) * mix(0.003, 0.009, uInk);
      gl_FragColor = vec4(c, 1.0);
    }`, { uImage: { value: field.texture }, uGlow: { value: glowA.texture }, uInk: { value: 0 } });
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
      // Print resolution supplies the antialiasing without four extra 4K HDR buffers.
      field.samples = Math.max(w, h) > 3000 ? 0 : 4;
      field.setSize(w, h);
      glowA.setSize(Math.ceil(w / 2), Math.ceil(h / 2));
      glowB.setSize(Math.ceil(w / 2), Math.ceil(h / 2));
    }
    const previousTarget = renderer.getRenderTarget();
    try {
      renderer.setRenderTarget(field);
      renderer.render(artwork, viewCamera);
      if (finish.uniforms.uInk.value < 0.5) {
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
    } finally { renderer.setRenderTarget(previousTarget); }
  }
  return {
    render,
    setTheme: (mode) => { finish.uniforms.uInk.value = mode === 'ink' ? 1 : 0; },
    dispose() { [field, glowA, glowB, extract, blur, finish, quad.geometry].forEach((v) => v.dispose()); },
  };
}
