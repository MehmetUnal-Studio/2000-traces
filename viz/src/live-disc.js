// viz/src/live-disc.js
// A record that engraves itself while the audience plays: grains stream in
// over the recorder's local SSE tap and append into chunked GPU buffers —
// no geometry rebuilds, just draw-range growth. Held-note arcs belong to the
// finished pack; live shows every gesture as a luminous grain.
import * as THREE from 'three';
import { DISC_VERTEX, POINT_FRAGMENT } from './shaders.js';
import { mulberry32 } from './prng.js';
import { lineColors, laneBoost, buildFrame, buildPlayhead } from './disc.js';

const CHUNK = 1 << 17; // 131,072 grains per buffer

export function createLiveDisc(layout, { visualSeed = 1 } = {}) {
  const uniforms = {
    uDuration: { value: layout.durationMs },
    uTime: { value: 0 },
    uReplaying: { value: 1 },
    uSelLane: { value: -1 },
    uPointScale: { value: 400 },
    uPointMax: { value: 8 },
    uLaneBoost: { value: laneBoost(layout.laneRadius.length) },
    uLineColors: { value: lineColors() },
  };
  const material = new THREE.ShaderMaterial({
    vertexShader: DISC_VERTEX, fragmentShader: POINT_FRAGMENT, uniforms,
    blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, transparent: true,
  });

  const group = new THREE.Group();
  group.add(buildFrame(layout));
  const { playhead, playheadMat } = buildPlayhead(layout);
  group.add(playhead);

  const rand = mulberry32((visualSeed >>> 0) || 1);
  const dispScale = layout.laneWidth * 0.85;
  const chunks = [];
  let grainCount = 0;

  const newChunk = () => {
    const attrs = {};
    const geo = new THREE.BufferGeometry();
    for (const name of ['aR', 'aT', 'aLane', 'aKind', 'aLine']) {
      attrs[name] = new THREE.BufferAttribute(new Float32Array(CHUNK), 1);
      attrs[name].setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute(name, attrs[name]);
    }
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(CHUNK * 3), 3));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 2);
    geo.setDrawRange(0, 0);
    const points = new THREE.Points(geo, material);
    points.frustumCulled = false;
    group.add(points);
    const chunk = { geo, attrs, count: 0, dirtyFrom: 0 };
    chunks.push(chunk);
    return chunk;
  };

  return {
    group, uniforms, playhead, playheadMat,
    grainCount: () => grainCount,

    // ev: {t (tMs), k (type code), l (line), v (0-1)}; lane already resolved
    append(lane, ev) {
      if (ev.k !== 1 && ev.k !== 3) return; // grains: noteOn + motion only
      let chunk = chunks[chunks.length - 1];
      if (!chunk || chunk.count === CHUNK) chunk = newChunk();
      const i = chunk.count;
      if (i < chunk.dirtyFrom) chunk.dirtyFrom = i;
      const disp = Math.tanh(((ev.v ?? 0.5) - 0.5) * 2.4) * dispScale + (rand() - 0.5) * 0.3 * dispScale;
      chunk.attrs.aR.array[i] = layout.laneRadius[lane] + disp;
      chunk.attrs.aT.array[i] = ev.t;
      chunk.attrs.aLane.array[i] = lane;
      chunk.attrs.aKind.array[i] = ev.k === 1 ? 1 : 0;
      chunk.attrs.aLine.array[i] = ev.l ?? 0;
      chunk.count = i + 1;
      grainCount += 1;
    },

    // push appended ranges to the GPU. Safe to call multiple times between
    // renders: ranges ACCUMULATE on the attribute — never clearUpdateRanges()
    // here, or a not-yet-rendered commit's range would be lost forever (three
    // r185's WebGLAttributes.updateBuffer merges the listed ranges, uploads
    // them, then clears the list itself after the upload).
    commit() {
      for (const chunk of chunks) {
        if (chunk.dirtyFrom >= chunk.count) continue;
        for (const attr of Object.values(chunk.attrs)) {
          attr.addUpdateRange(chunk.dirtyFrom, chunk.count - chunk.dirtyFrom);
          attr.needsUpdate = true;
        }
        chunk.geo.setDrawRange(0, chunk.count);
        chunk.dirtyFrom = chunk.count;
      }
    },

    dispose() {
      for (const child of group.children) {
        child.geometry.dispose();
        if (child.material !== material) child.material.dispose();
      }
      material.dispose();
    },
  };
}

// rosterLayout moved to layout.js (node-testable, no three import);
// re-exported here so existing importers keep working.
export { rosterLayout } from './layout.js';
