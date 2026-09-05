import * as THREE from 'three';
import { buildAtlasData } from './atlas-data.js';
import {
  TILE_VERTEX, TILE_FRAGMENT, THREAD_VERTEX, THREAD_FRAGMENT,
  ANNOTATION_VERTEX, ANNOTATION_FRAGMENT,
} from './atlas-shaders.js';

const TAU = Math.PI * 2;
export const ATLAS_RADII = Object.freeze({ inner: 0.332, outer: 0.828, thread: 0.309, bars: 0.884, rim: 1.026 });
const THREAD_SEGMENTS = 20;
export const ATLAS_LINE_WIDTHS = Object.freeze({ filaments: 0.0012, engraving: 0.00065 });
const format = (n) => n.toLocaleString('tr-TR');
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const palette = () => [
  [0.035, 0.78, 0.62], [1.00, 0.54, 0.075], [0.58, 0.14, 0.085],
  [0.030, 0.22, 0.34], [0.095, 0.075, 0.23], [0.80, 0.48, 0.22],
  [0.085, 0.40, 0.32], [0.040, 0.44, 0.51], [0.20, 0.14, 0.26],
  [0.43, 0.18, 0.09],
].map(([r, g, b]) => new THREE.Color().setRGB(r, g, b));
const angleAt = (fraction) => Math.PI / 2 - TAU * fraction;
const polar = (radius, angle, z = 0) => ({ x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, z });
const clockFraction = (x, y) => ((Math.PI / 2 - Math.atan2(y, x)) / TAU + 1) % 1;
const cellHeight = (energy) => 0.004 + energy * 0.016;
const barHeight = (energy) => 0.003 + energy * 0.006;
export const atlasCellEnergy = (cell, data) => Math.pow(cell.activity / Math.max(1, data.maxCellActivity), 0.60);

export function atlasCellBounds(cell, data) {
  const width = (ATLAS_RADII.outer - ATLAS_RADII.inner) / data.rowCount;
  const rowBase = ATLAS_RADII.inner + cell.row * width;
  const energy = atlasCellEnergy(cell, data);
  const gap = (cell.column % 12 === 0 ? 0.20 : 0.08) + Math.pow(1-energy,1.2)*0.50;
  const radialGap = cell.row % 8 === 0 ? 0.20 : 0.10;
  const r0 = rowBase + width * (radialGap + cell.meanV * 0.025);
  const fullR1 = rowBase + width * (0.90 + cell.meanV * 0.025);
  return {
    r0,
    r1: r0 + (fullR1-r0) * (0.08+0.92*Math.pow(energy,1.3)),
    a0: angleAt((cell.column + gap / 2) / data.columnCount),
    a1: angleAt((cell.column + 1 - gap / 2) / data.columnCount),
    gap,
    z: cellHeight(energy),
  };
}

function buildTiles(data, uniforms) {
  const cells = data.cells.filter((cell) => cell.activity > 0);
  const activeLanes = [];
  for (let lane = 0; lane < data.laneCount; lane++) if (data.laneStats.events[lane]) activeLanes.push(lane);
  const count = cells.length + activeLanes.length * 2;
  const cellValues = new Float32Array(count * 4);
  const values = new Float32Array(count * 4);
  const meta = new Float32Array(count * 4);
  const bars = new Array(data.laneCount).fill(null);
  let index = 0;
  const put = (bounds, energy, line, time, row, laneStart, laneEnd, column, style) => {
    cellValues.set([bounds.r0, bounds.r1, bounds.a0, bounds.a1], index * 4);
    values.set([energy, line, time, row], index * 4);
    meta.set([laneStart, laneEnd, column, style], index * 4);
    index++;
  };
  for (const cell of cells) put(atlasCellBounds(cell, data), atlasCellEnergy(cell,data), cell.dominantLine, cell.t1, cell.row,
    cell.laneStart, cell.laneEnd, cell.column, 0);
  for (const lane of activeLanes) {
    const events = data.laneStats.events[lane];
    const energy = Math.pow(events / Math.max(1, data.maxLaneEvents), 2.2);
    const a0 = angleAt((lane + 0.325) / data.laneCount);
    const a1 = angleAt((lane + 0.675) / data.laneCount);
    const bounds = { r0: ATLAS_RADII.bars, r1: ATLAS_RADII.bars + 0.010 + energy * 0.120, a0, a1, z: barHeight(energy), energy };
    bars[lane] = bounds;
    const line = data.laneStats.dominantLine?.[lane] ?? -1;
    put(bounds, energy, line, data.laneStats.last[lane], -1, lane, lane + 1, -1, 1);
    const noteRatio = data.laneStats.notes[lane] / Math.max(1, events);
    const mini = { r0: 0.856, r1: 0.858 + Math.sqrt(noteRatio) * 0.018, a0, a1 };
    put(mini, Math.sqrt(noteRatio), line, data.laneStats.last[lane], -1, lane, lane + 1, -1, 2);
  }
  const box = new THREE.BoxGeometry(1, 1, 1);
  box.translate(0.5, 0.5, 0.5);
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.index = box.index;
  for (const [name, attribute] of Object.entries(box.attributes)) geometry.setAttribute(name, attribute);
  geometry.setAttribute('aCell', new THREE.InstancedBufferAttribute(cellValues, 4));
  geometry.setAttribute('aData', new THREE.InstancedBufferAttribute(values, 4));
  geometry.setAttribute('aMeta', new THREE.InstancedBufferAttribute(meta, 4));
  geometry.instanceCount = count;
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1.08);
  const material = new THREE.ShaderMaterial({ uniforms, vertexShader: TILE_VERTEX, fragmentShader: TILE_FRAGMENT,
    side: THREE.DoubleSide, depthTest: true, depthWrite: true });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'atlas-polar-cells-and-participant-bars';
  return { mesh, bars, cells, instanceCount: count };
}

function buildRibbons(positions, times, lanes, lines, weights, uniforms, worldWidth) {
  const count = positions.length / 6;
  const starts = new Float32Array(count * 3);
  const ends = new Float32Array(count * 3);
  const segmentTimes = new Float32Array(count);
  const segmentLanes = new Float32Array(count);
  const segmentLines = new Float32Array(count);
  const segmentWeights = new Float32Array(count);
  for (let segment = 0; segment < count; segment++) {
    for (let component = 0; component < 3; component++) {
      starts[segment * 3 + component] = positions[segment * 6 + component];
      ends[segment * 3 + component] = positions[segment * 6 + 3 + component];
    }
    segmentTimes[segment] = times[segment * 2];
    segmentLanes[segment] = lanes[segment * 2];
    segmentLines[segment] = lines[segment * 2];
    segmentWeights[segment] = weights[segment * 2];
  }
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    0,-1,0, 1,-1,0, 1,1,0, 0,1,0,
  ]), 3));
  geometry.setIndex([0,1,2,0,2,3]);
  geometry.setAttribute('aStart', new THREE.InstancedBufferAttribute(starts, 3));
  geometry.setAttribute('aEnd', new THREE.InstancedBufferAttribute(ends, 3));
  geometry.setAttribute('aTime', new THREE.InstancedBufferAttribute(segmentTimes, 1));
  geometry.setAttribute('aLane', new THREE.InstancedBufferAttribute(segmentLanes, 1));
  geometry.setAttribute('aLine', new THREE.InstancedBufferAttribute(segmentLines, 1));
  geometry.setAttribute('aWeight', new THREE.InstancedBufferAttribute(segmentWeights, 1));
  geometry.instanceCount = count;
  const material = new THREE.ShaderMaterial({
    uniforms: { ...uniforms, uWorldWidth: { value: worldWidth } },
    vertexShader: THREAD_VERTEX, fragmentShader: THREAD_FRAGMENT,
    transparent: true, depthTest: true, depthWrite: false,
    blending: THREE.AdditiveBlending, side: THREE.DoubleSide, forceSinglePass: true,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false; // unit-quad bounds do not contain instanced endpoints
  return mesh;
}

function buildThreads(data, uniforms) {
  const edges = data.edges;
  const vertices = edges.length * THREAD_SEGMENTS * 2;
  const positions = new Float32Array(vertices * 3);
  const times = new Float32Array(vertices);
  const lanes = new Float32Array(vertices);
  const lines = new Float32Array(vertices);
  const weights = new Float32Array(vertices);
  const density = Math.min(1.8, Math.sqrt(5000 / Math.max(1, edges.length)));
  let cursor = 0;
  for (let ei = 0; ei < edges.length; ei++) {
    const edge = edges[ei];
    const p0 = polar(ATLAS_RADII.thread, angleAt(edge.t0 / data.durationMs));
    const p3 = polar(ATLAS_RADII.thread, angleAt(edge.t1 / data.durationMs));
    // The endpoints are real consecutive note times from ONE participant.
    // Its seat ordinal only assigns a stable route through the inner field.
    const route = angleAt((edge.lane + 0.5) / data.laneCount) + edge.line*0.13 + edge.t0/data.durationMs*1.7;
    const routeRadius = 0.10 + 0.13*Math.sqrt(Math.min(1,(edge.t1-edge.t0)/data.durationMs*20));
    const p1 = polar(routeRadius, route);
    const p2 = polar(routeRadius, route + Math.PI * 0.72);
    const weight = density * (ei % 17 === 0 ? 0.032 : 0.007)
      * (0.65 + Math.min(1, (edge.t1 - edge.t0) / data.durationMs * 20));
    const at = (t) => {
      const q = 1 - t;
      return {
        x: q*q*q*p0.x + 3*q*q*t*p1.x + 3*q*t*t*p2.x + t*t*t*p3.x,
        y: q*q*q*p0.y + 3*q*q*t*p1.y + 3*q*t*t*p2.y + t*t*t*p3.y,
        z: Math.sin(Math.PI*t) * (0.006 + (edge.lane % 11) * 0.001),
      };
    };
    for (let segment = 0; segment < THREAD_SEGMENTS; segment++) {
      for (const t of [segment / THREAD_SEGMENTS, (segment + 1) / THREAD_SEGMENTS]) {
        const p = at(t);
        positions.set([p.x, p.y, p.z], cursor * 3);
        times[cursor] = edge.t1; // no connection appears before its second note
        lanes[cursor] = edge.lane;
        lines[cursor] = edge.line;
        weights[cursor] = weight;
        cursor++;
      }
    }
  }
  const mesh = buildRibbons(positions, times, lanes, lines, weights, uniforms, ATLAS_LINE_WIDTHS.filaments);
  mesh.name = 'atlas-consecutive-note-filaments';
  mesh.renderOrder = 2;
  return mesh;
}

function buildEngraving(data, uniforms) {
  const positions = [];
  const weights = [];
  const segment = (a, b, alpha) => {
    positions.push(a.x, a.y, a.z ?? 0, b.x, b.y, b.z ?? 0);
    weights.push(alpha, alpha);
  };
  const ring = (r, alpha, parts = 720) => {
    for (let i = 0; i < parts; i++) segment(polar(r, i/parts*TAU), polar(r, (i+1)/parts*TAU), alpha);
  };
  for (const r of [0.309, 0.316, 0.324, 0.837, 0.844, 0.850, 0.879, ATLAS_RADII.rim]) ring(r, r === ATLAS_RADII.rim ? 0.45 : 0.26);
  for (let column = 0; column < data.columnCount; column++) {
    const a = angleAt(column / data.columnCount);
    segment(polar(column % 30 === 0 ? 0.292 : column % 5 === 0 ? 0.302 : 0.307, a), polar(0.313, a), column % 30 === 0 ? 0.7 : 0.3);
    if (column % 30 === 0) segment(polar(0.829, a), polar(0.845, a), 0.38);
  }
  // Outer tick density follows the actual participant count.
  for (let lane = 0; lane < data.laneCount; lane++) {
    const a = angleAt(lane / data.laneCount);
    segment(polar(1.016, a), polar(lane % 10 === 0 ? 1.025 : 1.020, a), lane % 10 === 0 ? 0.42 : 0.18);
  }
  const count = weights.length;
  // Guides are structure, unaffected by participant isolation.
  const guideUniforms = { ...uniforms, uSelLane: { value: -1 } };
  const mesh = buildRibbons(positions, new Float32Array(count), new Float32Array(count).fill(-100),
    new Float32Array(count).fill(-1), weights, guideUniforms, ATLAS_LINE_WIDTHS.engraving);
  mesh.material.depthTest = false;
  mesh.name = 'atlas-time-and-participant-graduations';
  mesh.renderOrder = 3;
  return mesh;
}

function buildAnnotations(manifest, data, uniforms) {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 2048; canvas.height = 2048;
  const context = canvas.getContext('2d');
  if (!context) return null;
  const scale = canvas.width / 2.08;
  context.translate(canvas.width/2, canvas.height/2);
  context.fillStyle = 'rgba(255,255,255,0.78)';
  context.textAlign = 'center'; context.textBaseline = 'middle';
  context.font = '500 12px ui-monospace, SFMono-Regular, monospace';
  for (let i = 0; i < 12; i++) {
    const seconds = data.durationMs * i / 12 / 1000;
    const a = angleAt(i/12);
    const p = polar(0.279, a);
    const label = `${Math.floor(seconds/60).toString().padStart(2,'0')}:${Math.floor(seconds%60).toString().padStart(2,'0')}`;
    context.fillText(label, p.x*scale, -p.y*scale);
  }
  context.font = '500 11px ui-monospace, SFMono-Regular, monospace';
  for (const zone of manifest.zones) {
    const a = angleAt((zone.laneStart + zone.laneCount/2) / data.laneCount);
    const p = polar(1.034, a);
    context.save();
    context.translate(p.x*scale, -p.y*scale);
    let turn = Math.PI/2-a;
    if (Math.cos(a) < 0) turn += Math.PI;
    context.rotate(turn);
    context.fillText(`${String(zone.zone).slice(0,12)} / ${zone.laneCount}`, 0, 0);
    context.restore();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.NoColorSpace;
  const geometry = new THREE.PlaneGeometry(2.08, 2.08);
  geometry.translate(0,0,0.025);
  const material = new THREE.ShaderMaterial({ uniforms: { ...uniforms, uMap: { value: texture } },
    vertexShader: ANNOTATION_VERTEX, fragmentShader: ANNOTATION_FRAGMENT,
    transparent: true, depthTest: false, depthWrite: false });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'atlas-session-annotations';
  mesh.renderOrder = 4;
  mesh.userData.texture = texture;
  return mesh;
}

export function buildAtlas(pack, layout) {
  const data = buildAtlasData(pack);
  const uniforms = {
    uDuration: { value: data.durationMs }, uTime: { value: data.durationMs }, uReplaying: { value: 0 },
    uSelLane: { value: -1 }, uPointScale: { value: 400 }, uPointMax: { value: 32 },
    uInk: { value: 0 }, uTilt: { value: 0 }, uSelRow: { value: -1 }, uSelColumn: { value: -1 },
    uHoverRow: { value: -1 }, uHoverColumn: { value: -1 }, uHoverLane: { value: -1 },
    uPalette: { value: palette() },
  };
  const group = new THREE.Group();
  group.name = '2000-traces-data-atlas';
  const tiles = buildTiles(data, uniforms);
  const threads = buildThreads(data, uniforms);
  const engraving = buildEngraving(data, uniforms);
  group.add(tiles.mesh, threads, engraving);
  const annotations = buildAnnotations(pack.manifest, data, uniforms);
  if (annotations) group.add(annotations);

  const playheadGeo = new THREE.BufferGeometry();
  playheadGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
  const playheadMat = new THREE.LineBasicMaterial({ color: 0xbacbc8, transparent: true, opacity: 0,
    depthTest: false, depthWrite: false });
  const playhead = new THREE.Line(playheadGeo, playheadMat);
  playhead.frustumCulled = false;
  playhead.renderOrder = 5;
  group.add(playhead);
  let lastPlayheadTime = NaN; let lastPlayheadTilt = NaN;
  const updatePlayhead = (time) => {
    const tilt = uniforms.uTilt.value;
    if (time === lastPlayheadTime && tilt === lastPlayheadTilt) return;
    lastPlayheadTime = time; lastPlayheadTilt = tilt;
    const a = angleAt(time/data.durationMs);
    const attr = playheadGeo.attributes.position;
    for (let i=0;i<2;i++) {
      const p=polar(i ? 0.846 : 0.316,a,0.026);
      attr.setXYZ(i,p.x,p.y*Math.cos(tilt)-p.z*Math.sin(tilt),p.y*Math.sin(tilt)+p.z*Math.cos(tilt));
    }
    attr.needsUpdate = true;
  };
  const cellMap = new Map(tiles.cells.map((cell) => [cell.row*data.columnCount+cell.column,cell]));
  const cellAt = (x,y) => {
    const r=Math.hypot(x,y);
    const row=Math.floor((r-ATLAS_RADII.inner)/(ATLAS_RADII.outer-ATLAS_RADII.inner)*data.rowCount);
    const column=Math.min(data.columnCount-1,Math.floor(clockFraction(x,y)*data.columnCount));
    if(row<0||row>=data.rowCount) return null;
    return cellMap.get(row*data.columnCount+column)??null;
  };
  const cellHit = (cell, x, y) => {
    if(!cell || cell.t1>uniforms.uTime.value+0.01) return false;
    const bounds=atlasCellBounds(cell,data);
    const radius=Math.hypot(x,y);
    const columnPosition=clockFraction(x,y)*data.columnCount-cell.column;
    return radius>=bounds.r0 && radius<=bounds.r1 && columnPosition>=bounds.gap/2 && columnPosition<=1-bounds.gap/2;
  };
  const makeCellHit = (cell) => {
    const first=pack.manifest.participants[cell.laneStart];
    const last=pack.manifest.participants[cell.laneEnd-1];
    const lane=cell.laneEnd-cell.laneStart===1?cell.laneStart:null;
    return {
      key:`cell:${cell.row}:${cell.column}`, kind:'cell', lane, row:cell.row, column:cell.column,
      title:lane===null?`${first.p} — ${last.p}`:String(first.p),
      meta:`<b>${format(cell.laneEnd-cell.laneStart)}</b> katılımcı · ${(cell.t0/1000).toFixed(2)}–${(cell.t1/1000).toFixed(2)} sn<br>`+
        `<b>${format(cell.count)}</b> olay · ${format(cell.noteCount)} nota · ${format(cell.moveCount)} hareket<br>`+
        `${cell.dominantLine<0?'Nota başlangıcı yok':`Baskın nota hattı ${cell.dominantLine+1}`} · log yoğunluk %${Math.round(cell.energy*100)}`,
    };
  };
  const makeLaneHit = (lane) => {
    const participant=pack.manifest.participants[lane];
    return {
      key:`lane:${lane}`,kind:'participant',lane,row:null,column:null,title:String(participant.p),
      meta:`Bölge <b>${escapeHtml(participant.z)}</b> · koltuk <b>${escapeHtml(participant.s)}</b><br>`+
        `<b>${format(data.laneStats.events[lane])}</b> olay · ${format(data.laneStats.notes[lane])} nota · ${format(data.laneStats.moves[lane])} hareket<br>`+
        `Tutulan nota süresi ${(data.laneStats.heldMs[lane]/1000).toFixed(1)} sn · ${format(data.laneStats.strokes[lane])} nota yayı`,
    };
  };
  const inspect = (x,y) => {
    if(!Number.isFinite(x)||!Number.isFinite(y)) return null;
    const tilt=uniforms.uTilt.value, c=Math.cos(tilt), s=Math.sin(tilt);
    const sourceY=y/c;
    const radius=Math.hypot(x,sourceY);
    if(radius>0.845 && radius<1.04) {
      const guess=Math.floor(clockFraction(x,sourceY)*data.laneCount);
      // Account for the small embossed height when inspecting tilted bars.
      for(let shift=0;shift<=6;shift++) for(const sign of shift===0?[1]:[-1,1]) {
        const lane=(guess+sign*shift+data.laneCount)%data.laneCount;
        const bounds=tiles.bars[lane];
        if(!bounds||data.laneStats.last[lane]>uniforms.uTime.value+0.01) continue;
        const yy=(y+bounds.z*s)/c;
        const rr=Math.hypot(x,yy);
        const f=clockFraction(x,yy)*data.laneCount-lane;
        if(f<0.325||f>0.675) continue;
        const ratio=data.laneStats.notes[lane]/Math.max(1,data.laneStats.events[lane]);
        const onMini=rr>=0.856 && rr<=0.858+Math.sqrt(ratio)*0.018;
        if(onMini || (rr>=bounds.r0 && rr<=bounds.r1)) return makeLaneHit(lane);
      }
      return null;
    }
    if(radius<ATLAS_RADII.inner-0.025 || radius>ATLAS_RADII.outer+0.025) return null;
    const guess=cellAt(x,sourceY);
    if(Math.abs(tilt)<0.00001) return cellHit(guess,x,sourceY)?makeCellHit(guess):null;
    if(!guess) {
      // The unprojected plane can fall in an empty neighbour of a raised tile.
      const row=Math.floor((radius-ATLAS_RADII.inner)/(ATLAS_RADII.outer-ATLAS_RADII.inner)*data.rowCount);
      const column=Math.floor(clockFraction(x,sourceY)*data.columnCount);
      for(let dr=-3;dr<=3;dr++) for(let dc=-3;dc<=3;dc++) {
        const col=(column+dc+data.columnCount)%data.columnCount;
        const cell=cellMap.get((row+dr)*data.columnCount+col);
        if(!cell) continue;
        const yy=(y+cellHeight(atlasCellEnergy(cell,data))*s)/c;
        if(cellHit(cell,x,yy)) return makeCellHit(cell);
      }
      return null;
    }
    // Search the exact raised front faces around the plane estimate. No
    // neighbouring participant is selected merely due to a tilt displacement.
    let best=null; let bestDepth=-Infinity;
    for(let dr=-3;dr<=3;dr++) for(let dc=-3;dc<=3;dc++) {
      const col=(guess.column+dc+data.columnCount)%data.columnCount;
      const row=guess.row+dr;
      if(row<0||row>=data.rowCount) continue;
      const cell=cellMap.get(row*data.columnCount+col);
      if(!cell) continue;
      const z=cellHeight(atlasCellEnergy(cell,data)), yy=(y+z*s)/c;
      if(cellHit(cell,x,yy)) {
        const depth=yy*s+z*c;
        if(depth>bestDepth) {best=cell;bestDepth=depth;}
      }
    }
    return best?makeCellHit(best):null;
  };
  let hoverKey=''; let hoverStamp=0;
  const updateHover = (x,y) => {
    const hit=inspect(x,y); const key=hit?.key??'';
    if(key!==hoverKey) {
      hoverKey=key; hoverStamp++;
      uniforms.uHoverRow.value=hit?.row??-1;
      uniforms.uHoverColumn.value=hit?.column??-1;
      uniforms.uHoverLane.value=hit?.kind==='participant'?hit.lane:-1;
    }
    return hit;
  };
  const setInspection = (hit) => {
    uniforms.uSelRow.value=hit?.kind==='cell'?hit.row:-1;
    uniforms.uSelColumn.value=hit?.kind==='cell'?hit.column:-1;
  };
  const setViewMode = (mode) => {
    uniforms.uInk.value=mode==='ink'?1:0;
    for(const mesh of [threads,engraving]) mesh.material.blending=mode==='ink'?THREE.NormalBlending:THREE.AdditiveBlending;
    playheadMat.color.set(mode==='ink'?0x25271f:0xbacbc8);
  };
  let disposed=false;
  const dispose = () => {
    if(disposed) return;
    disposed=true;
    group.traverse((child) => {
      child.geometry?.dispose();
      child.material?.dispose();
      child.userData.texture?.dispose();
    });
    cellMap.clear();
  };
  updatePlayhead(data.durationMs);
  return {
    group, uniforms, playhead, playheadMat, updatePlayhead, setViewMode, setInspection, inspect, updateHover, dispose,
    data, layout, kind:'atlas', grainCount:tiles.cells.length, strokeSegments:data.edges.length*THREAD_SEGMENTS,
    stats:{cells:tiles.cells.length,rows:data.rowCount,columns:data.columnCount,filaments:data.edges.length,totalEdges:data.totalEdges,instances:tiles.instanceCount},
    get hoverStamp(){return hoverStamp;},
  };
}
