// Exact, bounded summaries for the circular atlas. This is an event atlas,
// not a social graph: every chord joins consecutive note-ons from ONE lane.
// Input scans and stable uint32 radix ordering are linear in binary records.
import { EVENT_RECORD_BYTES, STROKE_RECORD_BYTES, TYPE, validateManifest } from './pack-loader.js';

export const ATLAS_MAX_ROWS = 96;
export const ATLAS_TIME_COLUMNS = 360;
export const ATLAS_MAX_EDGES = 5000;

function assertBinary(view, records, width, label) {
  if (!(view instanceof DataView) || view.byteLength !== records * width) throw new Error(`Invalid atlas ${label} buffer`);
}

// Three stable 16-bit passes order notes by (lane, uint32 timestamp), retaining
// input order for simultaneous onsets. No comparison sort or per-event object.
function chronologicalNotes(indices, events) {
  let source = indices;
  let target = new Uint32Array(indices.length);
  const counts = new Uint32Array(65536);
  for (let pass = 0; pass < 3; pass++) {
    counts.fill(0);
    const key = (index) => {
      const base = index * EVENT_RECORD_BYTES;
      if (pass === 2) return events.getUint16(base, true);
      const time = events.getUint32(base + 6, true);
      return pass === 0 ? time & 65535 : time >>> 16;
    };
    for (let i = 0; i < source.length; i++) counts[key(source[i])]++;
    let offset = 0;
    for (let i = 0; i < counts.length; i++) {
      const size = counts[i]; counts[i] = offset; offset += size;
    }
    for (let i = 0; i < source.length; i++) {
      const index = source[i]; target[counts[key(index)]++] = index;
    }
    [source, target] = [target, source];
  }
  return source;
}

/**
 * laneEnd is exclusive; a last time column includes the duration endpoint.
 * count/events include lifecycle records. activity/energy use noteOn + move.
 * energy is relative log-density, not measured acoustic energy or velocity.
 * meanV/gestureExtent summarize normalized interactive gesture coordinates.
 * dominantLine is the exact noteOn musical-line mode (ties choose the lower
 * line), or -1 when no note exists. Motion-only regions are neutral: binary
 * packs encode a missing motion line as 0, which cannot establish voice 0.
 * first/last are all-event times in milliseconds (-1 for an empty lane).
 */
export function buildAtlasData(pack) {
  const { manifest, events, strokes } = pack;
  validateManifest(manifest);
  assertBinary(events, manifest.eventCount, EVENT_RECORD_BYTES, 'events');
  assertBinary(strokes, manifest.strokeCount, STROKE_RECORD_BYTES, 'strokes');
  const { laneCount, durationMs, eventCount, strokeCount } = manifest;
  const rowCount = Math.min(ATLAS_MAX_ROWS, laneCount);
  const columnCount = ATLAS_TIME_COLUMNS;
  const slots = rowCount * columnCount;
  const rowOf = (lane) => Math.floor(lane * rowCount / laneCount);
  const columnOf = (time) => Math.min(columnCount - 1, Math.floor(time * columnCount / durationMs));
  const cellCounts = new Uint32Array(slots);
  const cellNotes = new Uint32Array(slots);
  const cellMoves = new Uint32Array(slots);
  const cellV = new Float64Array(slots);
  const cellExtent = new Float64Array(slots);
  const lineSeen = new Uint8Array(256);
  const laneStats = {
    events: new Uint32Array(laneCount), notes: new Uint32Array(laneCount), moves: new Uint32Array(laneCount),
    strokes: new Uint32Array(laneCount), heldMs: new Float64Array(laneCount),
    first: new Float64Array(laneCount).fill(-1), last: new Float64Array(laneCount).fill(-1),
    dominantLine: new Int16Array(laneCount).fill(-1),
  };
  let noteTotal = 0;
  let moveTotal = 0;
  let notesOrdered = true;
  let previousNoteLane = -1;
  let previousNoteTime = -1;
  let maxLaneEvents = 0;

  for (let i = 0; i < eventCount; i++) {
    const base = i * EVENT_RECORD_BYTES;
    const lane = events.getUint16(base, true);
    const time = events.getUint32(base + 6, true);
    if (lane >= laneCount || time > durationMs) throw new Error('Invalid atlas event lane or time');
    const kind = events.getUint8(base + 10);
    const slot = rowOf(lane) * columnCount + columnOf(time);
    cellCounts[slot]++;
    maxLaneEvents = Math.max(maxLaneEvents, ++laneStats.events[lane]);
    if (laneStats.first[lane] < 0 || time < laneStats.first[lane]) laneStats.first[lane] = time;
    if (time > laneStats.last[lane]) laneStats.last[lane] = time;
    if (kind === TYPE.noteOn || kind === TYPE.move) {
      const v = events.getUint16(base + 4, true) / 65535;
      cellV[slot] += v;
      cellExtent[slot] += Math.abs(v - 0.5) * 2;
      if (kind === TYPE.noteOn) {
        lineSeen[events.getUint8(base + 11)] = 1;
        cellNotes[slot]++; laneStats.notes[lane]++; noteTotal++;
        if (lane < previousNoteLane || (lane === previousNoteLane && time < previousNoteTime)) notesOrdered = false;
        previousNoteLane = lane; previousNoteTime = time;
      } else { cellMoves[slot]++; laneStats.moves[lane]++; moveTotal++; }
    }
  }

  // Allocate only actual note-on lines (normally ten). Gesture samples often
  // outnumber notes by fifty to one, and missing gesture lines become byte 0
  // in the packer. Counting them would erase the recorded musical diversity.
  // Preserve all 256 note-line byte values and deterministic frequency ties.
  const lines = [];
  const lineIndex = new Uint16Array(256);
  for (let line = 0; line < lineSeen.length; line++) if (lineSeen[line]) {
    lineIndex[line] = lines.length; lines.push(line);
  }
  const frequencies = new Uint32Array(slots * lines.length);
  const laneFrequencies = new Uint32Array(laneCount * lines.length);
  let noteIndices = new Uint32Array(noteTotal);
  let noteIndex = 0;
  for (let i = 0; i < eventCount; i++) {
    const base = i * EVENT_RECORD_BYTES;
    const kind = events.getUint8(base + 10);
    if (kind !== TYPE.noteOn) continue;
    const lane = events.getUint16(base, true);
    const time = events.getUint32(base + 6, true);
    const slot = rowOf(lane) * columnCount + columnOf(time);
    const line = lineIndex[events.getUint8(base + 11)];
    frequencies[slot * lines.length + line]++;
    laneFrequencies[lane * lines.length + line]++;
    noteIndices[noteIndex++] = i;
  }
  for (let lane = 0; lane < laneCount; lane++) {
    let maximum = 0;
    for (let line = 0; line < lines.length; line++) {
      const count = laneFrequencies[lane * lines.length + line];
      if (count > maximum) { maximum = count; laneStats.dominantLine[lane] = lines[line]; }
    }
  }

  let totalHeldMs = 0;
  for (let i = 0; i < strokeCount; i++) {
    const base = i * STROKE_RECORD_BYTES;
    const lane = strokes.getUint16(base, true);
    const t0 = strokes.getUint32(base + 4, true);
    const t1 = strokes.getUint32(base + 8, true);
    if (lane >= laneCount || t1 < t0 || t1 > durationMs) throw new Error('Invalid atlas stroke lane or time');
    laneStats.strokes[lane]++;
    laneStats.heldMs[lane] += t1 - t0;
    totalHeldMs += t1 - t0;
  }

  let zoneIndex = 0;
  const rowBands = Array.from({ length: rowCount }, (_, row) => {
    const laneStart = Math.ceil(row * laneCount / rowCount);
    const laneEnd = Math.ceil((row + 1) * laneCount / rowCount);
    while (zoneIndex + 1 < manifest.zones.length && laneStart >= manifest.zones[zoneIndex + 1].laneStart) zoneIndex++;
    const zone = manifest.zones[zoneIndex];
    return { row, laneStart, laneEnd, zone: laneEnd <= zone.laneStart + zone.laneCount ? zone.zone : null };
  });
  let maxCellCount = 0;
  let maxCellActivity = 0;
  for (let slot = 0; slot < slots; slot++) {
    maxCellCount = Math.max(maxCellCount, cellCounts[slot]);
    maxCellActivity = Math.max(maxCellActivity, cellNotes[slot] + cellMoves[slot]);
  }
  const energyScale = Math.log1p(maxCellActivity) || 1;
  const cells = [];
  for (let slot = 0; slot < slots; slot++) {
    if (!cellCounts[slot]) continue;
    const row = Math.floor(slot / columnCount);
    const column = slot % columnCount;
    const activity = cellNotes[slot] + cellMoves[slot];
    let dominantLine = -1;
    let dominantCount = 0;
    for (let line = 0; line < lines.length; line++) {
      const count = frequencies[slot * lines.length + line];
      if (count > dominantCount) { dominantLine = lines[line]; dominantCount = count; }
    }
    cells.push({
      row, column, laneStart: rowBands[row].laneStart, laneEnd: rowBands[row].laneEnd,
      t0: column * durationMs / columnCount, t1: (column + 1) * durationMs / columnCount,
      count: cellCounts[slot], noteCount: cellNotes[slot], moveCount: cellMoves[slot], activity,
      dominantLine, meanV: activity ? cellV[slot] / activity : 0,
      gestureExtent: activity ? cellExtent[slot] / activity : 0,
      energy: Math.log1p(activity) / energyScale,
    });
  }

  if (!notesOrdered) noteIndices = chronologicalNotes(noteIndices, events);
  let totalEdges = 0;
  for (let lane = 0; lane < laneCount; lane++) totalEdges += Math.max(0, laneStats.notes[lane] - 1);
  const edgeLimit = Math.min(ATLAS_MAX_EDGES, totalEdges);
  const edges = [];
  let edgeOrdinal = 0;
  let targetOrdinal = 0;
  let previousBase = -1;
  for (let i = 0; i < noteIndices.length; i++) {
    const base = noteIndices[i] * EVENT_RECORD_BYTES;
    const lane = events.getUint16(base, true);
    if (previousBase >= 0 && events.getUint16(previousBase, true) === lane) {
      // Evenly spaced deterministic samples over true consecutive transitions;
      // rendering never needs an array with one object per source transition.
      if (edges.length < edgeLimit && edgeOrdinal === targetOrdinal) {
        edges.push({ lane, t0: events.getUint32(previousBase + 6, true), t1: events.getUint32(base + 6, true),
          line: events.getUint8(previousBase + 11), nextLine: events.getUint8(base + 11) });
        targetOrdinal = Math.floor(edges.length * totalEdges / edgeLimit);
      }
      edgeOrdinal++;
    }
    previousBase = base;
  }
  return {
    laneCount, durationMs, rowCount, columnCount, rowBands, cells, laneStats, edges,
    totalEvents: eventCount, totalNotes: noteTotal, totalMoves: moveTotal, totalStrokes: strokeCount,
    totalHeldMs, totalEdges, sampledEdges: edges.length, maxCellCount, maxCellActivity, maxLaneEvents,
  };
}
