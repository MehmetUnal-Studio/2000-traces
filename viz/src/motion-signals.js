// Motion character from recorded screen-space geometry, never message counts.
// Only a known (participant lane, finger) can establish a velocity. Raw capture,
// replay positions and OSC output are not changed by this optional analysis.
import { readGesture, TYPE } from './gesture-replay.js';
import { EVENT_RECORD_BYTES, GESTURE_RECORD_BYTES } from './pack-loader.js';

const COMPONENTS = 6;
const SPEED = 0; const TURN = 1; const DX = 2; const DY = 3; const ACTIVE = 4; const ENERGY = 5;
const FLOAT32_MAX = 3.4028234663852886e38;
const ATTRIBUTES = ['speed', 'speed01', 'turn', 'turn01', 'directionX', 'directionY', 'energy'];
const clamp01 = (value) => Math.max(0, Math.min(1, value));
const validTime = (time) => Number.isFinite(time) && time >= 0;
const eventKind = (kind) => typeof kind === 'string' ? TYPE[kind] : kind;
const relevant = (kind) => kind === TYPE.noteOn || kind === TYPE.move || kind === TYPE.noteOff || kind === TYPE.disconnect;
const blank = () => ({ valid: false, speed: 0, speed01: 0, turn: 0, turn01: 0, directionX: 0, directionY: 0, energy: 0 });

function configuration({ tauMs = 800, gapMs = 1200, referenceSpeed = 1, referenceTurnRate = Math.PI,
  maxFingersPerLane = 16, maxLanes = 65536 } = {}) {
  for (const [name, value] of Object.entries({ tauMs, gapMs, referenceSpeed, referenceTurnRate })) {
    if (!Number.isFinite(value) || value <= 0) throw new RangeError(`Invalid motion ${name}`);
  }
  if (!Number.isInteger(maxFingersPerLane) || maxFingersPerLane < 1 || maxFingersPerLane > 16) throw new RangeError('Invalid motion finger capacity');
  if (!Number.isInteger(maxLanes) || maxLanes < 1 || maxLanes > 65536) throw new RangeError('Invalid motion lane capacity');
  return { tauMs, gapMs, referenceSpeed, referenceTurnRate, maxFingersPerLane, maxLanes };
}

function output(values, scale, trackedFingers, config) {
  const denominator = Math.max(1, trackedFingers);
  const speed = Math.max(0, values[SPEED] * scale / denominator);
  const turn = Math.max(0, values[TURN] * scale / denominator);
  const active = Math.max(0, Math.min(trackedFingers, values[ACTIVE] * scale));
  // Equal finger weights with a time-domain EMA: a 60 Hz phone does not get
  // twice a 30 Hz phone's vote. Alignment is meaningful only while active.
  const coherence = active > 1e-8 ? clamp01(Math.hypot(values[DX], values[DY]) * scale / active) : 0;
  return { speed, speed01: clamp01(speed / config.referenceSpeed), turn,
    turn01: clamp01(turn / config.referenceTurnRate), coherence,
    energy: clamp01(values[ENERGY] * scale / denominator), active, trackedFingers };
}

/**
 * ingest({lane,t,x,y,finger,kind}) returns a per-event measurement. speed is
 * normalized-screen units/second; turn is unsigned radians/second between
 * successive segment midpoints. speed01/turn01 use fixed reference values.
 * energy is this finger's causal, time-weighted normalized-speed envelope.
 * A stationary segment is valid and has zero speed, direction and turn.
 *
 * sample(t) is read-only and returns equally weighted per-finger aggregate
 * envelopes plus directional coherence. active is an effective recent moving
 * finger count, not a packet count. Silence exponentially decays all activity;
 * coherence describes the remaining directional agreement, not new activity.
 *
 * A noteOn establishes a fresh anchor; release/disconnect/missing XY reset it.
 * dt <= 0 clears the anchor rather than guessing an order. A gap > gapMs starts
 * a fresh anchor. Unknown fingers never contribute inferred motion. A globally
 * reordered stream is supported while each finger remains chronological; a
 * late event for that same finger cannot revise an already emitted velocity.
 * Live sampling cannot seek before the latest accepted source timestamp.
 *
 * Memory is bounded to maxLanes * maxFingersPerLane states (at most 16 per
 * lane). Capacity overflow evicts the least recently touched identity and its
 * envelope; stats() discloses evictions. reset() starts a new session.
 */
export function createLiveMotionSignals(options) {
  const config = configuration(options);
  const lanes = new Map(); const sums = new Float64Array(COMPONENTS);
  let time = null; let trackedFingers = 0; let evictedFingers = 0;

  function advance(t) {
    if (time === null) time = t;
    else if (t > time) {
      const decay = Math.exp(-(t - time) / config.tauMs);
      for (let i = 0; i < COMPONENTS; i++) sums[i] *= decay;
      time = t;
    }
  }
  function contribution(track, sign) {
    const age = Math.exp(-((time ?? track.time) - track.time) / config.tauMs) * sign;
    for (let i = 0; i < COMPONENTS; i++) sums[i] += track.values[i] * age;
  }
  function evict(track) { contribution(track, -1); trackedFingers--; evictedFingers++; }
  function getTrack(lane, finger, t, create) {
    let fingers = lanes.get(lane);
    if (!fingers && !create) return null;
    if (!fingers) {
      if (lanes.size >= config.maxLanes) {
        const oldest = lanes.keys().next().value;
        for (const track of lanes.get(oldest).values()) evict(track);
        lanes.delete(oldest);
      }
      fingers = new Map(); lanes.set(lane, fingers);
    } else { lanes.delete(lane); lanes.set(lane, fingers); }
    let track = fingers.get(finger);
    if (!track && create) {
      if (fingers.size >= config.maxFingersPerLane) {
        const oldest = fingers.keys().next().value;
        evict(fingers.get(oldest)); fingers.delete(oldest);
      }
      track = { values: new Float64Array(COMPONENTS), time: t, watermark: t, anchor: null, direction: null };
      trackedFingers++;
    }
    if (track) { fingers.delete(finger); fingers.set(finger, track); }
    return track;
  }
  function clear(track, t) {
    if (!track) return;
    track.anchor = null; track.direction = null; track.watermark = Math.max(track.watermark, t);
  }
  const api = {
    ...config,
    ingest(event) {
      const { lane, t, x, y, finger } = event ?? {};
      const kind = eventKind(event?.kind);
      const result = blank();
      if (!validTime(t) || !Number.isInteger(lane) || lane < 0 || lane >= 65536) return result;
      if (!relevant(kind)) return result;
      advance(t);
      if (kind === TYPE.disconnect) {
        for (const track of lanes.get(lane)?.values() ?? []) clear(track, t);
        return result;
      }
      if (!Number.isInteger(finger) || finger < 0 || finger > 65535) return result;
      const hasXY = Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= 1 && y >= 0 && y <= 1;
      const track = getTrack(lane, finger, t, hasXY && (kind === TYPE.noteOn || kind === TYPE.move));
      if (!track) return result;
      if (t < track.watermark || (track.anchor && t === track.anchor.t)) { clear(track, t); return result; }
      track.watermark = t;
      if (kind === TYPE.noteOff || !hasXY) { clear(track, t); return result; }
      const previous = track.anchor;
      track.anchor = { x, y, t };
      if (kind === TYPE.noteOn || !previous || t - previous.t > config.gapMs) { track.direction = null; return result; }
      const dt = (t - previous.t) / 1000;
      if (dt <= 0) { clear(track, t); return result; }
      const dx = x - previous.x; const dy = y - previous.y;
      const distance = Math.hypot(dx, dy); const speed = distance / dt;
      const directionX = distance > 0 ? dx / distance : 0; const directionY = distance > 0 ? dy / distance : 0;
      const prior = track.direction;
      const angle = prior && distance > 0 ? Math.atan2(Math.abs(prior.x * directionY - prior.y * directionX), prior.x * directionX + prior.y * directionY) : 0;
      const turn = prior ? angle / ((dt + prior.dt) / 2) : 0;
      if (!Number.isFinite(speed) || !Number.isFinite(turn) || speed > FLOAT32_MAX || turn > FLOAT32_MAX) { clear(track, t); return result; }
      track.direction = distance > 0 ? { x: directionX, y: directionY, dt } : null;
      const speed01 = clamp01(speed / config.referenceSpeed); const turn01 = clamp01(turn / config.referenceTurnRate);
      contribution(track, -1);
      const decay = Math.exp(-(t - track.time) / config.tauMs);
      const alpha = -Math.expm1(-dt * 1000 / config.tauMs);
      const measured = [speed, turn, directionX, directionY, distance > 0 ? 1 : 0, speed01];
      for (let i = 0; i < COMPONENTS; i++) track.values[i] = track.values[i] * decay + measured[i] * alpha;
      track.time = t; contribution(track, 1);
      return { valid: true, speed, speed01, turn, turn01, directionX, directionY, energy: clamp01(track.values[ENERGY]) };
    },
    sample(t) {
      if (!validTime(t)) throw new RangeError('Invalid motion sample time');
      if (time !== null && t < time) throw new RangeError('Live motion cannot seek before its latest event');
      return output(sums, time === null ? 1 : Math.exp(-(t - time) / config.tauMs), trackedFingers, config);
    },
    stats() { return { trackedLanes: lanes.size, trackedFingers, evictedFingers, latestTime: time }; },
    reset() { lanes.clear(); sums.fill(0); time = null; trackedFingers = 0; evictedFingers = 0; },
  };
  // Internal prefix capture keeps archive seeking O(log N), without retaining
  // live event objects or exposing mutable aggregate state to callers.
  Object.defineProperty(api, '_capture', { value: (target, offset) => {
    for (let i = 0; i < COMPONENTS; i++) target[offset + i] = sums[i];
    return trackedFingers;
  } });
  return api;
}

/**
 * Exact sidecar timestamps and original binary index define chronological tie
 * order. Attributes retain ORIGINAL event indices and never reorder/mutate the
 * pack. Each is Float32Array(eventCount), except valid: Uint8Array(eventCount).
 * Timeline prefixes are Float64; sample/seek is stateless, causal and equivalent
 * to feeding the same sorted events to createLiveMotionSignals. Past/future
 * seeks and loops carry no state from a previous playhead. Legacy packs have no
 * finger identity, so their inferred motion attributes remain zero.
 *
 * O(N log N) construction, O(N) typed-array memory, O(log N) samples. Retained
 * storage is at most 89 bytes/event, plus bounded per-finger construction state.
 */
export function createPackMotionSignals(pack, options) {
  const config = configuration(options);
  const { eventCount, durationMs } = pack.manifest;
  const exact = pack.gestures instanceof DataView;
  if (pack.manifest.gestures && !exact) throw new Error('Declared gesture sidecar is missing');
  const attributes = { valid: new Uint8Array(eventCount) };
  for (const name of ATTRIBUTES) attributes[name] = new Float32Array(eventCount);
  if (!exact) {
    // A legacy pack cannot recover finger identity. Avoid sorting millions of
    // known-unusable records merely to produce an all-zero motion analysis.
    const zero = new Float64Array(COMPONENTS);
    const sample = (t) => {
      if (!validTime(t)) throw new RangeError('Invalid motion sample time');
      return output(zero, 1, 0, config);
    };
    return { ...config, attributes, eventCount, sample, seek: sample,
      stats: () => ({ trackedLanes: 0, trackedFingers: 0, evictedFingers: 0, latestTime: null }),
      byteLength: Object.values(attributes).reduce((sum, value) => sum + value.byteLength, 0) };
  }
  const originalTimes = new Float64Array(eventCount); const order = new Uint32Array(eventCount);
  let count = 0;
  for (let index = 0; index < eventCount; index++) {
    const t = exact ? pack.gestures.getFloat64(index * GESTURE_RECORD_BYTES, true) : pack.events.getUint32(index * EVENT_RECORD_BYTES + 6, true);
    originalTimes[index] = t;
    if (validTime(t) && t <= durationMs && relevant(pack.events.getUint8(index * EVENT_RECORD_BYTES + 10))) order[count++] = index;
  }
  const sorted = order.subarray(0, count);
  sorted.sort((a, b) => originalTimes[a] - originalTimes[b] || a - b);
  const times = new Float64Array(count); const prefixes = new Float64Array(count * COMPONENTS); const tracked = new Uint32Array(count);
  const live = createLiveMotionSignals(config);
  for (let i = 0; i < count; i++) {
    const index = sorted[i]; const event = readGesture(pack, index);
    const measured = live.ingest(event);
    if (measured.valid) {
      attributes.valid[index] = 1;
      for (const name of ATTRIBUTES) attributes[name][index] = measured[name];
    }
    times[i] = event.t;
    tracked[i] = live._capture(prefixes, i * COMPONENTS);
  }
  const stats = live.stats();
  const zero = new Float64Array(COMPONENTS);
  function sample(t) {
    if (!validTime(t)) throw new RangeError('Invalid motion sample time');
    let lo = 0; let hi = count;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (times[mid] <= t) lo = mid + 1;
      else hi = mid;
    }
    if (!lo) return output(zero, 1, 0, config);
    const i = lo - 1;
    return output(prefixes.subarray(i * COMPONENTS, (i + 1) * COMPONENTS), Math.exp(-(t - times[i]) / config.tauMs), tracked[i], config);
  }
  return { ...config, attributes, eventCount, sample, seek: sample, stats: () => ({ ...stats }),
    byteLength: Object.values(attributes).reduce((sum, value) => sum + value.byteLength, 0) + times.byteLength + prefixes.byteLength + tracked.byteLength };
}
