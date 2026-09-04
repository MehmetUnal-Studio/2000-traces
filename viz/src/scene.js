// Orthographic artwork stage. The atmospheric field is decoration and is
// deliberately separate from the session's event geometry.
import * as THREE from 'three';
import { mulberry32 } from './prng.js';

function createAtmosphere() {
  const group = new THREE.Group();
  group.name = 'ambient-starfield';
  group.userData.decorative = true;
  const veil = new THREE.Mesh(new THREE.PlaneGeometry(24, 24), new THREE.ShaderMaterial({
    depthTest: false, depthWrite: false,
    vertexShader: /* glsl */ `
      varying vec2 vWorld;
      void main() {
        vWorld = position.xy;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec2 vWorld;
      void main() {
        vec2 p = vWorld;
        float blue = exp(-dot((p - vec2(0.55, -0.45)) * vec2(0.75, 0.5),
                             (p - vec2(0.55, -0.45)) * vec2(0.75, 0.5)));
        float fog = exp(-dot((p + vec2(0.8, -0.7)) * vec2(1.0, 0.7),
                            (p + vec2(0.8, -0.7)) * vec2(1.0, 0.7)));
        float voidCore = exp(-dot(p, p) * 3.0);
        vec3 color = vec3(0.006, 0.014, 0.023)
          + vec3(0.004, 0.013, 0.021) * blue
          + vec3(0.003, 0.004, 0.009) * fog;
        color *= 1.0 - voidCore * 0.42;
        float noise = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 913.713);
        color += (noise - 0.5) * 0.003;
        gl_FragColor = vec4(color, 1.0);
      }
    `,
  }));
  veil.position.z = -4;
  veil.renderOrder = -1000;
  group.add(veil);

  const random = mulberry32(20002026);
  const count = 1700;
  const positions = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    positions[i * 3] = (random() - 0.5) * 7;
    positions[i * 3 + 1] = (random() - 0.5) * 5;
    positions[i * 3 + 2] = -3;
    const brightness = random();
    sizes[i] = 0.8 + brightness ** 7 * 3.5;
    const warm = random() > 0.91;
    colors[i * 3] = warm ? 0.60 : 0.20;
    colors[i * 3 + 1] = warm ? 0.37 : 0.40;
    colors[i * 3 + 2] = warm ? 0.22 : 0.60;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, depthTest: false,
    blending: THREE.AdditiveBlending, vertexColors: true,
    uniforms: { uScale: { value: 1 } },
    vertexShader: /* glsl */ `
      attribute float aSize;
      uniform float uScale;
      varying vec3 vColor;
      varying float vSize;
      void main() {
        vColor = color;
        vSize = aSize;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = max(1.0, aSize * uScale);
      }
    `,
    fragmentShader: /* glsl */ `
      precision mediump float;
      varying vec3 vColor;
      varying float vSize;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float alpha = exp(-d * d * 32.0) * (0.24 + vSize * 0.065);
        gl_FragColor = vec4(vColor, alpha);
      }
    `,
  });
  const stars = new THREE.Points(geo, mat);
  stars.renderOrder = -900;
  // Scale with the actual target, including offscreen PNG exports.
  const targetSize = new THREE.Vector2();
  stars.onBeforeRender = (renderer) => {
    const target = renderer.getRenderTarget();
    if (target) mat.uniforms.uScale.value = target.height / 900;
    else { renderer.getDrawingBufferSize(targetSize); mat.uniforms.uScale.value = targetSize.y / 900; }
  };
  group.add(stars);
  return group;
}

export function createScene(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x020509, 1);
  const scene = new THREE.Scene();
  const atmosphere = createAtmosphere();
  scene.add(atmosphere);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -10, 10);
  camera.position.z = 1;

  let viewH = 600;
  let viewW = 800;
  let fitted = true;
  let disposed = false;
  const fitCamera = () => {
    const aspect = viewW / viewH;
    const desktop = viewW >= 1000;
    camera.zoom = desktop ? Math.min(0.92, aspect * 0.59) : Math.min(0.86, aspect * 0.86);
    camera.position.set(desktop ? -0.24 * aspect / camera.zoom : 0, 0, 1);
    camera.updateProjectionMatrix();
  };
  const resize = () => {
    if (disposed) return;
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    if (!w || !h) return;
    if (w === viewW && h === viewH && renderer.domElement.width > 0) return;
    viewW = w; viewH = h;
    renderer.setSize(w, h, false);
    const aspect = w / h;
    camera.left = -aspect; camera.right = aspect; camera.top = 1; camera.bottom = -1;
    if (fitted) fitCamera();
    else camera.updateProjectionMatrix();
  };
  // Force the first size initialization, including an actual 800 x 600 pane.
  viewW = 0;
  resize();
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
  observer?.observe(canvas);
  window.addEventListener('resize', resize);

  const worldFromScreen = (clientX, clientY) => {
    resize();
    camera.updateMatrixWorld();
    const rect = canvas.getBoundingClientRect();
    const ndcX = ((clientX - rect.left) / (rect.width || viewW || 1)) * 2 - 1;
    const ndcY = -(((clientY - rect.top) / (rect.height || viewH || 1)) * 2 - 1);
    return new THREE.Vector3(ndcX, ndcY, 0).unproject(camera);
  };

  let dragging = false; let moved = 0; let last = null;
  const clickListeners = new Set();
  const resetDrag = () => { dragging = false; last = null; canvas.classList.remove('is-dragging'); };
  const pointerdown = (e) => {
    if (e.button !== 0) return;
    dragging = true; moved = 0; last = [e.clientX, e.clientY];
    canvas.setPointerCapture(e.pointerId);
  };
  const pointermove = (e) => {
    if (!dragging) return;
    if (e.buttons === 0) { resetDrag(); return; }
    const dx = e.clientX - last[0]; const dy = e.clientY - last[1];
    moved += Math.abs(dx) + Math.abs(dy);
    last = [e.clientX, e.clientY];
    if (moved > 4) { fitted = false; canvas.classList.add('is-dragging'); }
    camera.position.x -= (dx / viewH) * 2 / camera.zoom;
    camera.position.y += (dy / viewH) * 2 / camera.zoom;
  };
  const pointerup = (e) => {
    if (e.button !== 0) return;
    const wasDragging = dragging;
    resetDrag();
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    if (wasDragging && moved < 5) {
      const w = worldFromScreen(e.clientX, e.clientY);
      clickListeners.forEach((fn) => fn(w.x, w.y));
    }
  };
  const wheel = (e) => {
    e.preventDefault();
    const before = worldFromScreen(e.clientX, e.clientY);
    fitted = false;
    camera.zoom = Math.min(240, Math.max(0.25, camera.zoom * Math.exp(-e.deltaY * 0.0016)));
    camera.updateProjectionMatrix();
    const after = worldFromScreen(e.clientX, e.clientY);
    camera.position.x += before.x - after.x;
    camera.position.y += before.y - after.y;
  };
  const handlers = { pointerdown, pointermove, pointerup, pointercancel: resetDrag, lostpointercapture: resetDrag, wheel };
  for (const [name, handler] of Object.entries(handlers)) canvas.addEventListener(name, handler, name === 'wheel' ? { passive: false } : undefined);
  window.addEventListener('blur', resetDrag);
  const fit = () => { fitted = true; resize(); fitCamera(); };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    observer?.disconnect();
    window.removeEventListener('resize', resize);
    window.removeEventListener('blur', resetDrag);
    for (const [name, handler] of Object.entries(handlers)) canvas.removeEventListener(name, handler);
    clickListeners.clear();
    resetDrag();
    atmosphere.traverse((object) => { object.geometry?.dispose(); object.material?.dispose(); });
    scene.remove(atmosphere);
    renderer.dispose();
  };
  return {
    renderer, scene, camera, resize, fit, worldFromScreen, dispose,
    onCanvasClick: (fn) => { clickListeners.add(fn); return () => clickListeners.delete(fn); },
    pixelsPerWorldUnit: () => (viewH / 2) * camera.zoom,
  };
}
