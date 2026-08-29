// viz/src/disc.js
// Builds the three render passes of the record from a binary pack:
//   grains  — every motion/note event as a soft additive point
//   strokes — noteOn..noteOff arcs engraved along the participant's lane
//   frame   — zone separator rings (structure, not data)
import * as THREE from 'three';
import { EVENT_RECORD_BYTES, STROKE_RECORD_BYTES, TYPE } from './pack-loader.js';
import { mulberry32 } from './prng.js';
import { DISC_VERTEX, POINT_FRAGMENT, LINE_FRAGMENT } from './shaders.js';

const STROKE_SEGMENT_MS = 120;

// 10 musical lines -> muted accents around warm ivory; restrained on purpose.
export function lineColors() {
  const hues = [0.115, 0.05, 0.26, 0.58, 0.76, 0.09, 0.33, 0.52, 0.68, 0.0];
  return hues.map((h) => new THREE.Color().setHSL(h, 0.38, 0.72));
}

export function laneBoost(laneCount) {
  // sparser sessions get wider lanes and less pixel overlap; lift exposure
  return Math.min(2.5, Math.pow(2000 / Math.max(1, laneCount), 0.6));
}

// Zone separator rings + outer/inner rim — structure, not data.
export function buildFrame(layout) {
  const ringVerts = [];
  const ringSegments = 256;
  const pushRing = (r) => {
    for (let s = 0; s < ringSegments; s++) {
      const a0 = (2 * Math.PI * s) / ringSegments;
      const a1 = (2 * Math.PI * (s + 1)) / ringSegments;
      ringVerts.push(Math.cos(a0) * r, Math.sin(a0) * r, 0, Math.cos(a1) * r, Math.sin(a1) * r, 0);
    }
  };
  for (const band of layout.zoneBands.slice(1)) pushRing(band.r0 - layout.laneWidth);
  pushRing(layout.zoneBands[0].r0 - layout.laneWidth * 2);
  pushRing(layout.zoneBands[layout.zoneBands.length - 1].r1 + layout.laneWidth * 2);
  const frameGeo = new THREE.BufferGeometry();
  frameGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(ringVerts), 3));
  const frameMat = new THREE.LineBasicMaterial({ color: 0x1c2027, transparent: true, opacity: 0.9 });
  return new THREE.LineSegments(frameGeo, frameMat);
}

export function buildPlayhead(layout) {
  const playheadGeo = new THREE.BufferGeometry();
  playheadGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    0, layout.zoneBands[0].r0 - layout.laneWidth * 4, 0,
    0, layout.zoneBands[layout.zoneBands.length - 1].r1 + layout.laneWidth * 4, 0,
  ]), 3));
  const playheadMat = new THREE.LineBasicMaterial({
    color: 0xf2ead8, transparent: true, opacity: 0.0,
    blending: THREE.AdditiveBlending, depthTest: false,
  });
  return { playhead: new THREE.Line(playheadGeo, playheadMat), playheadMat };
}

export function buildDisc(pack, layout) {
  const { manifest, events, strokes } = pack;
  const rand = mulberry32(manifest.visualSeed);
  const uniforms = {
    uDuration: { value: manifest.durationMs },
    uTime: { value: manifest.durationMs },
    uReplaying: { value: 0 },
    uSelLane: { value: -1 },
    uPointScale: { value: 400 },
    uPointMax: { value: 8 },
    uLaneBoost: { value: laneBoost(manifest.laneCount) },
    uLineColors: { value: lineColors() },
  };

  const group = new THREE.Group();

  // ---- grains: one point per noteOn / move event -------------------------
  let grainCount = 0;
  const n = manifest.eventCount;
  for (let i = 0; i < n; i++) {
    const t = events.getUint8(i * EVENT_RECORD_BYTES + 10);
    if (t === TYPE.noteOn || t === TYPE.move) grainCount += 1;
  }
  const gR = new Float32Array(grainCount);
  const gT = new Float32Array(grainCount);
  const gLane = new Float32Array(grainCount);
  const gKind = new Float32Array(grainCount);
  const gLine = new Float32Array(grainCount);
  const dispScale = layout.laneWidth * 0.85;
  let gi = 0;
  for (let i = 0; i < n; i++) {
    const base = i * EVENT_RECORD_BYTES;
    const type = events.getUint8(base + 10);
    // consume one deterministic random per event so the grain pattern is a
    // pure function of (session file, visualSeed) regardless of event types
    const jitter = (rand() - 0.5) * 0.3;
    if (type !== TYPE.noteOn && type !== TYPE.move) continue;
    const lane = events.getUint16(base + 0, true);
    const vq = events.getUint16(base + 4, true);
    const v = vq / 65535;
    // gesture -> radial displacement, soft-compressed so a violent gesture
    // stays inside its own groove and never erases a neighbour
    const disp = Math.tanh((v - 0.5) * 2.4) * dispScale + jitter * dispScale;
    gR[gi] = layout.laneRadius[lane] + disp;
    gT[gi] = events.getUint32(base + 6, true);
    gLane[gi] = lane;
    gKind[gi] = type === TYPE.noteOn ? 1 : 0;
    gLine[gi] = events.getUint8(base + 11);
    gi += 1;
  }
  const grainGeo = new THREE.BufferGeometry();
  grainGeo.setAttribute('aR', new THREE.BufferAttribute(gR, 1));
  grainGeo.setAttribute('aT', new THREE.BufferAttribute(gT, 1));
  grainGeo.setAttribute('aLane', new THREE.BufferAttribute(gLane, 1));
  grainGeo.setAttribute('aKind', new THREE.BufferAttribute(gKind, 1));
  grainGeo.setAttribute('aLine', new THREE.BufferAttribute(gLine, 1));
  grainGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(grainCount * 3), 3)); // unused, three requires it
  grainGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 2);
  const grainMat = new THREE.ShaderMaterial({
    vertexShader: DISC_VERTEX, fragmentShader: POINT_FRAGMENT, uniforms,
    blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, transparent: true,
  });
  group.add(new THREE.Points(grainGeo, grainMat));

  // ---- strokes: tessellated arcs for held notes --------------------------
  const sCount = manifest.strokeCount;
  let segTotal = 0;
  for (let i = 0; i < sCount; i++) {
    const t0 = strokes.getUint32(i * STROKE_RECORD_BYTES + 4, true);
    const t1 = strokes.getUint32(i * STROKE_RECORD_BYTES + 8, true);
    segTotal += Math.max(1, Math.ceil((t1 - t0) / STROKE_SEGMENT_MS));
  }
  const sR = new Float32Array(segTotal * 2);
  const sT = new Float32Array(segTotal * 2);
  const sLane = new Float32Array(segTotal * 2);
  const sKind = new Float32Array(segTotal * 2);
  const sLine = new Float32Array(segTotal * 2);
  let si = 0;
  for (let i = 0; i < sCount; i++) {
    const base = i * STROKE_RECORD_BYTES;
    const lane = strokes.getUint16(base + 0, true);
    const line = strokes.getUint8(base + 2);
    const t0 = strokes.getUint32(base + 4, true);
    const t1 = strokes.getUint32(base + 8, true);
    const vq = strokes.getUint16(base + 14, true);
    const disp = Math.tanh((vq / 65535 - 0.5) * 2.4) * dispScale;
    const r = layout.laneRadius[lane] + disp;
    const segs = Math.max(1, Math.ceil((t1 - t0) / STROKE_SEGMENT_MS));
    for (let s = 0; s < segs; s++) {
      const ta = t0 + ((t1 - t0) * s) / segs;
      const tb = t0 + ((t1 - t0) * (s + 1)) / segs;
      sR[si] = r; sT[si] = ta; sLane[si] = lane; sKind[si] = 1; sLine[si] = line; si += 1;
      sR[si] = r; sT[si] = tb; sLane[si] = lane; sKind[si] = 1; sLine[si] = line; si += 1;
    }
  }
  const strokeGeo = new THREE.BufferGeometry();
  strokeGeo.setAttribute('aR', new THREE.BufferAttribute(sR, 1));
  strokeGeo.setAttribute('aT', new THREE.BufferAttribute(sT, 1));
  strokeGeo.setAttribute('aLane', new THREE.BufferAttribute(sLane, 1));
  strokeGeo.setAttribute('aKind', new THREE.BufferAttribute(sKind, 1));
  strokeGeo.setAttribute('aLine', new THREE.BufferAttribute(sLine, 1));
  strokeGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(segTotal * 6), 3));
  strokeGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 2);
  const strokeMat = new THREE.ShaderMaterial({
    vertexShader: DISC_VERTEX, fragmentShader: LINE_FRAGMENT, uniforms,
    blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, transparent: true,
  });
  group.add(new THREE.LineSegments(strokeGeo, strokeMat));

  // ---- frame + playhead --------------------------------------------------
  group.add(buildFrame(layout));
  const { playhead, playheadMat } = buildPlayhead(layout);
  group.add(playhead);

  const dispose = () => {
    for (const child of group.children) { child.geometry.dispose(); child.material.dispose(); }
  };

  return { group, uniforms, playhead, playheadMat, grainCount, strokeSegments: segTotal, dispose };
}
