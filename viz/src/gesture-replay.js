// Pure access to recorded phone coordinates, plus a lazy per-participant seek
// index. Replay never invents X from time, interpolates across gaps, or assigns
// an unknown historical finger to finger zero.
import { EVENT_RECORD_BYTES, GESTURE_RECORD_BYTES, TYPE } from './pack-loader.js';
import { mulberry32 } from './prng.js';
export { TYPE } from './pack-loader.js';

export function readGesture(pack, index) {
  if (!Number.isInteger(index) || index < 0 || index >= pack.manifest.eventCount) throw new RangeError('Gesture index out of range');
  const base = index * EVENT_RECORD_BYTES;
  const kind = pack.events.getUint8(base + 10);
  const exact = pack.gestures instanceof DataView;
  if (pack.manifest.gestures && !exact) throw new Error('Declared gesture sidecar is missing');
  let t; let x; let y; let finger = null;
  if (exact) {
    const offset = index * GESTURE_RECORD_BYTES;
    const view = pack.gestures;
    t = view.getFloat64(offset, true);
    x = view.getFloat64(offset + 8, true);
    y = view.getFloat64(offset + 16, true);
    const recordedFinger = view.getFloat64(offset + 24, true);
    if (Number.isInteger(recordedFinger)) finger = recordedFinger;
  } else {
    t = pack.events.getUint32(base + 6, true);
    // Both original axes exist in legacy packs, quantized to uint16. Their
    // missing-value bits and finger ids do not; zero can mean zero or absent.
    const interactive = kind === TYPE.noteOn || kind === TYPE.move;
    x = interactive ? pack.events.getUint16(base + 2, true) / 65535 : NaN;
    y = interactive ? pack.events.getUint16(base + 4, true) / 65535 : NaN;
  }
  const hasTime = Number.isFinite(t);
  const hasXY = hasTime && Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= 1 && y >= 0 && y <= 1;
  return {
    index, lane: pack.events.getUint16(base, true), finger,
    x: Number.isFinite(x) ? x : null, y: Number.isFinite(y) ? y : null,
    t: hasTime ? t : null, kind, line: pack.events.getUint8(base + 11),
    hasXY, hasTime, exact, fingerKnown: finger !== null,
    coordinatePresenceKnown: exact,
  };
}

function bound(values, time, upper) {
  let lo = 0; let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (values[mid] < time || (upper && values[mid] === time)) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * sampleLane(lane, time, options) / seek(time, {lane, ...options}) return the
 * latest recorded position for each observed finger and a bounded actual trail.
 * No interpolation is performed. noteOff/disconnect/missing XY and a gap larger
 * than gapMs break trails. A stale marker is explicitly inactive. Legacy packs
 * return unknown-finger points with one-point trails, never a fabricated hand.
 * Lazy LRU indexing bounds retained memory to cacheLanes selected participants.
 */
export function createGestureReplay(pack, { gapMs = 1200, cacheLanes = 8 } = {}) {
  if (!Number.isFinite(gapMs) || gapMs <= 0) throw new RangeError('Invalid replay gap');
  if (!Number.isInteger(cacheLanes) || cacheLanes < 1 || cacheLanes > 64) throw new RangeError('Invalid replay cache size');
  const { durationMs, laneCount, participants } = pack.manifest;
  const cache = new Map();
  const segmentCache = new Map();
  const exact = pack.gestures instanceof DataView;
  const timeOf = (index) => exact ? pack.gestures.getFloat64(index * GESTURE_RECORD_BYTES, true) : pack.events.getUint32(index * EVENT_RECORD_BYTES + 6, true);

  function indexLane(lane) {
    if (!Number.isInteger(lane) || lane < 0 || lane >= laneCount) throw new RangeError('Replay lane out of range');
    if (cache.has(lane)) {
      const hit = cache.get(lane); cache.delete(lane); cache.set(lane, hit); return hit;
    }
    const participant = participants[lane];
    const order = Uint32Array.from({ length: participant.n }, (_, i) => participant.o + i);
    // A sidecar retains fractional (Float64) timestamps. Stable sorting by
    // timestamp and original binary index preserves ties and upstream reorders.
    order.sort((a, b) => {
      const ta = timeOf(a); const tb = timeOf(b);
      return (Number.isFinite(ta) ? ta : Infinity) - (Number.isFinite(tb) ? tb : Infinity) || a - b;
    });
    const tracks = new Map();
    const close = (track, time) => {
      if (!track?.current) return;
      track.current.end = track.indices.length;
      track.current.endedAt = time;
      track.current = null;
    };
    const getTrack = (finger) => {
      let track = tracks.get(finger);
      if (!track) {
        track = { finger, indices: [], times: [], segmentIds: [], segments: [], current: null };
        tracks.set(finger, track);
      }
      return track;
    };
    for (const index of order) {
      const event = readGesture(pack, index);
      if (event.lane !== lane) throw new Error('Gesture event is outside its participant range');
      if (!event.hasTime || event.t < 0 || event.t > durationMs) continue;
      if (event.kind === TYPE.disconnect) {
        for (const track of tracks.values()) close(track, event.t);
        continue;
      }
      if (event.kind === TYPE.noteOff) { close(tracks.get(event.finger), event.t); continue; }
      if (event.kind !== TYPE.noteOn && event.kind !== TYPE.move) continue;
      const track = getTrack(event.finger);
      if (!event.hasXY) { close(track, event.t); continue; }
      // A fresh contact starts a new path even when a release was not received.
      // This also matches the live renderer's noteOn boundary at tied times.
      if (event.kind === TYPE.noteOn) close(track, event.t);
      const lastTime = track.times.at(-1);
      if (track.current && event.t - lastTime > gapMs) close(track, lastTime + gapMs);
      if (!track.current) {
        track.current = { start: track.indices.length, end: null, endedAt: null };
        track.segments.push(track.current);
      }
      track.indices.push(index); track.times.push(event.t); track.segmentIds.push(track.segments.length - 1);
    }
    const indexed = [...tracks.values()].filter((track) => track.indices.length).map((track) => {
      if (track.current) track.current.end = track.indices.length;
      return { finger: track.finger, indices: Uint32Array.from(track.indices), times: Float64Array.from(track.times),
        segmentIds: Uint32Array.from(track.segmentIds), segments: track.segments };
    }).sort((a, b) => a.finger === null ? 1 : b.finger === null ? -1 : a.finger - b.finger);
    cache.set(lane, indexed);
    while (cache.size > cacheLanes) cache.delete(cache.keys().next().value);
    return indexed;
  }

  function sampleLane(lane, timeMs, { loop = false, trailMs = 2500, maxTrailPoints = 128 } = {}) {
    if (!Number.isFinite(timeMs)) throw new RangeError('Invalid replay time');
    if (!Number.isFinite(trailMs) || trailMs < 0) throw new RangeError('Invalid replay trail duration');
    if (!Number.isInteger(maxTrailPoints) || maxTrailPoints < 1 || maxTrailPoints > 4096) throw new RangeError('Invalid replay trail limit');
    const time = loop ? ((timeMs % durationMs) + durationMs) % durationMs : Math.max(0, Math.min(durationMs, timeMs));
    const fingers = [];
    for (const track of indexLane(lane)) {
      const position = bound(track.times, time, true) - 1;
      if (position < 0) continue;
      const event = readGesture(pack, track.indices[position]);
      const segment = track.segments[track.segmentIds[position]];
      const stale = time - event.t > gapMs;
      const active = !stale && (segment.endedAt === null || time < segment.endedAt);
      let start = Math.max(segment.start, bound(track.times, time - trailMs, false));
      // Historical missing finger identities must never splice two real fingers.
      if (track.finger === null) start = Math.max(start, position);
      const available = Math.max(0, position - start + 1);
      const wanted = Math.min(maxTrailPoints, available);
      const trail = [];
      for (let i = 0; i < wanted; i++) {
        const sample = wanted === 1 ? position : start + Math.floor(i * (available - 1) / (wanted - 1));
        const point = readGesture(pack, track.indices[sample]);
        trail.push({ x: point.x, y: point.y, t: point.t, index: point.index });
      }
      fingers.push({ finger: track.finger, x: event.x, y: event.y, t: event.t, index: event.index,
        kind: event.kind, line: event.line, active, stale, trail });
    }
    return { time, lane, pid: participants[lane].p, exact, source: pack.manifest.simulated ? 'demo' : exact ? 'recorded' : 'legacy',
      looped: Boolean(loop && (timeMs < 0 || timeMs >= durationMs)), fingers };
  }
  function sampleSegments({ limit = 100000, gapMs: requestedGap = gapMs } = {}) {
    if (!Number.isInteger(limit) || limit < 0 || limit > 1000000) throw new RangeError('Invalid gesture segment limit');
    if (!Number.isFinite(requestedGap) || requestedGap <= 0) throw new RangeError('Invalid gesture segment gap');
    const key = `${limit}:${requestedGap}`;
    if (segmentCache.has(key)) return segmentCache.get(key);
    const remember = (result) => {
      // Loaded packs and these returned index pairs are read-only. Keep only
      // two geometry budgets so switching views does not re-sort every lane.
      segmentCache.set(key, result);
      while (segmentCache.size > 2) segmentCache.delete(segmentCache.keys().next().value);
      return result;
    };
    if (requestedGap !== gapMs) return remember(createGestureReplay(pack, { gapMs: requestedGap, cacheLanes: 1 }).sampleSegments({ limit }));
    // A legacy binary cannot prove which finger two neighboring points belong
    // to. Draw those points, but never invent a connecting finger trajectory.
    if (!exact) return remember({ pairs: new Uint32Array(0), totalSegments: 0, sampledSegments: 0, gapMs });
    const pairs = new Uint32Array(limit * 2);
    const random = mulberry32(pack.manifest.visualSeed ?? 0);
    let totalSegments = 0;
    for (let lane = 0; lane < laneCount; lane++) {
      for (const track of indexLane(lane)) {
        if (track.finger === null) continue;
        for (let i = 1; i < track.indices.length; i++) {
          if (track.segmentIds[i] !== track.segmentIds[i - 1]) continue;
          const slot = totalSegments < limit ? totalSegments : Math.floor(random() * (totalSegments + 1));
          totalSegments++;
          if (slot >= limit) continue;
          pairs[slot * 2] = track.indices[i - 1];
          pairs[slot * 2 + 1] = track.indices[i];
        }
      }
    }
    const sampledSegments = Math.min(limit, totalSegments);
    return remember({ pairs: pairs.slice(0, sampledSegments * 2), totalSegments, sampledSegments, gapMs });
  }
  return { durationMs, exact, sampleLane, sampleSegments,
    seek: (time, { lane = 0, ...options } = {}) => sampleLane(lane, time, options),
    clearCache: () => { cache.clear(); segmentCache.clear(); } };
}
