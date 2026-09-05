// A repeatable in-memory ensemble study. Its pulse grid, phrase envelopes and
// smooth gesture trajectories are synthetic, never audience-capture evidence.
// No recording files or upstream connections are created by this module.
import { mulberry32 } from './prng.js';
import { EVENT_RECORD_BYTES, STROKE_RECORD_BYTES, TYPE } from './pack-loader.js';

export const DEMO_NAME = '__demo__';
const DURATION_MS = 90000;
const PULSE_MS = DURATION_MS / 24;
const ZONE_LINES = [0, 1, 2, 5, 3, 9, 4, 6, 7, 8];
const quantize = (v) => Math.round(Math.max(0, Math.min(1, v)) * 65535);

export function createDemoPack({ laneCount = 2000, seed = 2000 } = {}) {
  if (!Number.isInteger(laneCount) || laneCount < 1 || laneCount > 65535) throw new Error('Invalid demo lane count');
  const random = mulberry32(seed);
  const plans = [];
  let eventCount = 0;
  let strokeCount = 0;
  for (let lane = 0; lane < laneCount; lane++) {
    const zone = Math.floor(lane / 200);
    // Nearby performers form sections with related activity, without making
    // every outer activity bar identical or scattering palette indices at random.
    const activity = 0.5 + 0.5 * Math.sin(lane * 0.037 + zone * 0.6);
    const moves = Math.round(72 + activity * 32);
    const notes = 9 + Math.floor(activity * 5);
    plans.push({ zone, moves, notes, offset: eventCount, strokeOffset: strokeCount, activity });
    eventCount += moves + notes * 2;
    strokeCount += notes;
  }
  const events = new DataView(new ArrayBuffer(eventCount * EVENT_RECORD_BYTES));
  const strokes = new DataView(new ArrayBuffer(strokeCount * STROKE_RECORD_BYTES));
  const participants = [];
  const zones = [];
  for (let lane = 0; lane < laneCount; lane++) {
    const plan = plans[lane];
    const zone = String.fromCharCode(65 + plan.zone);
    const seat = lane % 200 + 1;
    if (!zones.length || zones.at(-1).zone !== zone) zones.push({ zone, laneStart: lane, laneCount: 0 });
    zones.at(-1).laneCount++;
    const records = [];
    const phase = random() * Math.PI * 0.2;
    const entrance = 0.12 + random() * 0.5;
    const baseLine = (ZONE_LINES[plan.zone % ZONE_LINES.length] + Math.floor((seat - 1) / 40)) % 10;
    const lineAt = (time) => {
      // A phrase change is shared by the ensemble; the home voice dominates.
      const phrase = Math.floor(time / 7500);
      return (baseLine + (phrase === 4 || phrase === 5 ? 2 : phrase === 8 ? 4 : 0)) % 10;
    };
    const gestureAt = (time) => {
      const t = time / DURATION_MS;
      const swell = 0.3 + 0.7 * Math.sin(Math.PI * t) ** 2;
      const voice = lane * 0.004 + plan.zone * 0.31 + phase;
      return {
        u: quantize(0.5 + Math.sin(t * Math.PI * 8 + voice) * 0.36 * swell),
        v: quantize(0.5 + Math.sin(t * Math.PI * (6 + plan.zone % 3) + voice) * (0.18 + plan.activity * 0.28) * swell),
      };
    };
    for (let i = 0; i < plan.moves; i++) {
      const time = Math.round((i + entrance + (random() - 0.5) * 0.16) * DURATION_MS / plan.moves);
      records.push({ time, kind: TYPE.move, line: lineAt(time), ...gestureAt(time) });
    }
    for (let i = 0; i < plan.notes; i++) {
      // Euclidean-style phrase placement on one shared 24-pulse score. Chords
      // used by the artwork therefore come from actual repeated onsets.
      const pulse = Math.floor(i * 24 / plan.notes);
      const time = Math.round(pulse * PULSE_MS + 180 + (plan.zone % 3) * 90 + entrance * 140 + random() * 70);
      const swell = Math.sin(Math.PI * time / DURATION_MS) ** 2;
      const held = Math.round(650 + swell * 1450 + (baseLine % 4) * 160 + plan.activity * 320);
      const end = Math.min(DURATION_MS, time + held);
      const line = lineAt(time);
      const uv = gestureAt(time);
      records.push({ time, kind: TYPE.noteOn, line, ...uv });
      records.push({ time: end, kind: TYPE.noteOff, line, ...gestureAt(end) });
      const base = (plan.strokeOffset + i) * STROKE_RECORD_BYTES;
      strokes.setUint16(base, lane, true);
      strokes.setUint8(base + 2, line);
      strokes.setUint32(base + 4, time, true);
      strokes.setUint32(base + 8, end, true);
      strokes.setUint16(base + 12, uv.u, true);
      strokes.setUint16(base + 14, uv.v, true);
    }
    records.sort((a, b) => a.time - b.time || a.kind - b.kind);
    participants.push({ p: `${zone}${seat}`, z: zone, s: seat, l: lane, o: plan.offset, n: records.length });
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      const base = (plan.offset + i) * EVENT_RECORD_BYTES;
      events.setUint16(base, lane, true);
      events.setUint16(base + 2, record.u, true);
      events.setUint16(base + 4, record.v, true);
      events.setUint32(base + 6, record.time, true);
      events.setUint8(base + 10, record.kind);
      events.setUint8(base + 11, record.line);
    }
  }
  return {
    name: DEMO_NAME, events, strokes,
    manifest: {
      formatVersion: 1, sessionId: 'simulated-constellation', label: 'Kolektif bir iz',
      durationMs: DURATION_MS, visualSeed: seed, laneCount, eventCount, strokeCount,
      zones, participants, simulated: true,
    },
  };
}
