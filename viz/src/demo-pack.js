// A repeatable, in-memory exhibition study. Never written to the recording
// library and never connected to the audience stream.
import { mulberry32 } from './prng.js';
import { EVENT_RECORD_BYTES, STROKE_RECORD_BYTES, TYPE } from './pack-loader.js';

export const DEMO_NAME = '__demo__';

export function createDemoPack({ laneCount = 2000, seed = 2000 } = {}) {
  if (!Number.isInteger(laneCount) || laneCount < 1 || laneCount > 65535) throw new Error('Invalid demo lane count');
  const durationMs = 90000;
  const random = mulberry32(seed);
  const records = 24;
  const eventCount = laneCount * records;
  const events = new DataView(new ArrayBuffer(eventCount * EVENT_RECORD_BYTES));
  const strokes = new DataView(new ArrayBuffer(laneCount * STROKE_RECORD_BYTES));
  const participants = [];
  const zones = [];
  for (let lane = 0; lane < laneCount; lane++) {
    const zoneIndex = Math.floor(lane / 200);
    const zone = String.fromCharCode(65 + zoneIndex);
    const seat = lane % 200 + 1;
    if (!zones.length || zones.at(-1).zone !== zone) zones.push({ zone, laneStart: lane, laneCount: 0 });
    zones.at(-1).laneCount++;
    participants.push({ p: `${zone}${seat}`, z: zone, s: seat, l: lane, o: lane * records, n: records });
    const phase = random() * 0.35;
    const noteIndex = 2 + Math.floor(random() * 19);
    let noteStart = 0; let noteEnd = 0;
    for (let i = 0; i < records; i++) {
      const base = (lane * records + i) * EVENT_RECORD_BYTES;
      const t = Math.round(((i + phase + random() * 0.55) / records) * durationMs);
      const kind = i === noteIndex ? TYPE.noteOn : i === noteIndex + 1 ? TYPE.noteOff : TYPE.move;
      events.setUint16(base, lane, true);
      events.setUint16(base + 2, Math.round(random() * 65535), true);
      events.setUint16(base + 4, Math.round((0.5 + Math.sin(lane * 0.021 + i * 0.6) * 0.35) * 65535), true);
      events.setUint32(base + 6, t, true);
      events.setUint8(base + 10, kind);
      events.setUint8(base + 11, lane % 10);
      if (i === noteIndex) noteStart = t;
      if (i === noteIndex + 1) noteEnd = t;
    }
    const base = lane * STROKE_RECORD_BYTES;
    strokes.setUint16(base, lane, true);
    strokes.setUint8(base + 2, lane % 10);
    strokes.setUint32(base + 4, noteStart, true);
    strokes.setUint32(base + 8, noteEnd, true);
    strokes.setUint16(base + 12, 32768, true);
    strokes.setUint16(base + 14, 32768, true);
  }
  return {
    name: DEMO_NAME, events, strokes,
    manifest: {
      formatVersion: 1, sessionId: 'simulated-constellation', label: 'Kolektif bir iz',
      durationMs, visualSeed: seed, laneCount, eventCount, strokeCount: laneCount,
      zones, participants, simulated: true,
    },
  };
}
