// Causal input activity, shared by live view and archived playback. Every
// observed noteOn/move contributes one event to a decaying rate in events/s.
// Neither playback time nor a disconnected source can create new activity.
import { EVENT_RECORD_BYTES, GESTURE_RECORD_BYTES, TYPE } from './pack-loader.js';

function configuration({ tauMs = 1000, referenceRate = 20000 } = {}) {
  if (!Number.isFinite(tauMs) || tauMs <= 0) throw new RangeError('Invalid flow decay time');
  if (!Number.isFinite(referenceRate) || referenceRate <= 0) throw new RangeError('Invalid flow reference rate');
  return { tauMs, referenceRate };
}

function interactive(kind) {
  return kind === TYPE.noteOn || kind === TYPE.move || kind === 'noteOn' || kind === 'move';
}

function validTime(time) { return Number.isFinite(time) && time >= 0; }

function result(weight, time, lastEventTime, eventCount, tauMs, referenceRate) {
  const rate = lastEventTime === null ? 0 : weight * Math.exp(-(time - lastEventTime) / tauMs) * 1000 / tauMs;
  // Fixed calibration across live and archive: individual movements remain
  // visible while a large ensemble can still become brighter as input grows.
  const energy = Math.min(1, Math.log1p(rate / 5) / Math.log1p(referenceRate / 5));
  return { rate, energy, eventCount, lastEventTime };
}

/**
 * O(1) live memory. ingest(tMs, kind) accepts finite, nonnegative noteOn/move
 * times, including late arrivals weighted at their actual timestamps. sample
 * is read-only and must be at/after the latest ingested timestamp; historical
 * seeking belongs to createPackFlowEnergy. Call reset at a new session.
 */
export function createLiveFlowEnergy(options) {
  const { tauMs, referenceRate } = configuration(options);
  let weight = 0; let lastEventTime = null; let eventCount = 0;
  return {
    tauMs, referenceRate,
    ingest(time, kind) {
      if (!validTime(time) || !interactive(kind)) return false;
      if (lastEventTime === null) { weight = 1; lastEventTime = time; }
      else if (time >= lastEventTime) {
        weight = weight * Math.exp(-(time - lastEventTime) / tauMs) + 1;
        lastEventTime = time;
      } else weight += Math.exp(-(lastEventTime - time) / tauMs);
      eventCount++;
      return true;
    },
    sample(time) {
      if (!validTime(time)) throw new RangeError('Invalid flow sample time');
      if (lastEventTime !== null && time < lastEventTime) throw new RangeError('Live flow cannot seek before its latest event');
      return result(weight, time, lastEventTime, eventCount, tauMs, referenceRate);
    },
    reset() { weight = 0; lastEventTime = null; eventCount = 0; },
  };
}

/**
 * Two Float64 arrays, with no per-event objects: sorted timestamps and the
 * exponential sum at each timestamp. Binary-search sampling is O(log N),
 * stateless and identical for forward/backward seek. A loop samples its local
 * playhead time again; energy from the previous loop never leaks through.
 * Exact Float64 sidecar timestamps take precedence over legacy uint32 time.
 */
export function createPackFlowEnergy(pack, options) {
  const { tauMs, referenceRate } = configuration(options);
  const { eventCount, durationMs } = pack.manifest;
  const exact = pack.gestures instanceof DataView;
  if (pack.manifest.gestures && !exact) throw new Error('Declared gesture sidecar is missing');
  const timestamps = new Float64Array(eventCount);
  let count = 0;
  for (let index = 0; index < eventCount; index++) {
    const base = index * EVENT_RECORD_BYTES;
    if (!interactive(pack.events.getUint8(base + 10))) continue;
    const time = exact ? pack.gestures.getFloat64(index * GESTURE_RECORD_BYTES, true) : pack.events.getUint32(base + 6, true);
    if (!validTime(time) || time > durationMs) continue;
    timestamps[count++] = time;
  }
  const times = timestamps.subarray(0, count).sort();
  const weights = new Float64Array(count);
  for (let i = 0; i < count; i++) weights[i] = i ? weights[i - 1] * Math.exp(-(times[i] - times[i - 1]) / tauMs) + 1 : 1;
  return {
    tauMs, referenceRate, eventCount: count,
    sample(time) {
      if (!validTime(time)) throw new RangeError('Invalid flow sample time');
      let lo = 0; let hi = count;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (times[mid] <= time) lo = mid + 1;
        else hi = mid;
      }
      const index = lo - 1;
      return result(index < 0 ? 0 : weights[index], time, index < 0 ? null : times[index], lo, tauMs, referenceRate);
    },
  };
}
