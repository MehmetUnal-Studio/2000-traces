import { createReadStream, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { addressable, hasXY } from './osc-replay.js';

const WIDTH = 7; // Float64 t, zone, seat, finger (NaN=absent), x, y, kind.
const CHUNK = 16384;
const KINDS = { keepalive: 0, noteOn: 1, noteOff: 2, fingerMove: 3, loadProgress: 4, disconnect: 5 };
const finite = (value, fallback) => Number.isFinite(value) ? value : Number.isFinite(fallback) ? fallback : NaN;

/** Original JSONL fields, globally ordered by Float64 event time then file order. */
export async function loadReplayData(path, { maxEvents = 5000000, maxBytes = 2 * 1024 ** 3 } = {}) {
  if (statSync(path).size > maxBytes) throw new Error('Replay file exceeds the 2 GiB limit');
  const chunks = []; let chunk; let count = 0; let header = null; let end = null;
  let sourceEvents = 0; let skipped = 0; let bridgeUnsupported = 0; let valid = 0;
  const input = createReadStream(path);
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      if (line.length > 1024 * 1024) throw new Error('Replay JSONL line exceeds the 1 MiB limit');
      let item;
      try { item = JSON.parse(line); } catch { throw new Error('Replay requires a complete, valid JSONL recording'); }
      if (item.kind === 'session') {
        if (header || sourceEvents || end || item.schemaVersion !== 1 || typeof item.sessionId !== 'string' || !Number.isInteger(item.durationMs) || item.durationMs <= 0 || item.durationMs > 0xffffffff) throw new Error('Invalid replay session header');
        header = item; continue;
      }
      if (item.kind === 'end') { if (!header || end) throw new Error('Invalid replay end record'); end = item; continue; }
      if (item.kind !== 'event') continue;
      if (!header || end) throw new Error('Replay events are outside the session boundary');
      sourceEvents++;
      if (sourceEvents > maxEvents) throw new Error('Replay exceeds the event limit');
      const k = KINDS[item.eventType];
      if (k !== 1 && k !== 2 && k !== 3 && k !== 5) { skipped++; continue; }
      const e = { t: item.tMs, z: typeof item.zone === 'string' && /^[A-Z]$/.test(item.zone) ? item.zone.charCodeAt(0) - 65 : NaN,
        s: item.seatNumber, f: Number.isInteger(item.finger) ? item.finger : Number.isInteger(item.raw?.f) ? item.raw.f : NaN,
        x: finite(item.u, item.raw?.uu), y: finite(item.v, item.raw?.vv), k };
      if (!Number.isFinite(e.t) || e.t < 0 || e.t > header.durationMs) throw new Error('Replay event has an invalid source timestamp');
      if (k === 5) {
        if (!Number.isInteger(e.z) || !Number.isInteger(e.s)) { skipped++; continue; }
      } else if (!addressable(e) || (k === 1 || k === 3) && !hasXY(e)) { skipped++; continue; }
      if (e.z > 15 || k !== 5 && e.f !== 0) bridgeUnsupported++;
      if (count % CHUNK === 0) { chunk = new Float64Array(CHUNK * WIDTH); chunks.push(chunk); }
      chunk.set([e.t, e.z, e.s, e.f, e.x, e.y, e.k], (count % CHUNK) * WIDTH);
      count++; if (k !== 5) valid++;
    }
  } finally { lines.close(); input.destroy(); }
  if (!header || !end || end.events !== sourceEvents) throw new Error('Replay requires a complete session with matching event counts');
  if (!valid) throw new Error('This recording has no addressable OSC note or movement events');
  const value = (index, field) => chunks[Math.floor(index / CHUNK)][(index % CHUNK) * WIDTH + field];
  const order = Uint32Array.from({ length: count }, (_, index) => index);
  order.sort((a, b) => value(a, 0) - value(b, 0) || a - b);
  return {
    sessionId: header.sessionId, label: header.label ?? '', durationMs: header.durationMs,
    sourceEvents, eventCount: count, skipped, bridgeUnsupported,
    at(index) {
      if (index < 0 || index >= count) return null;
      const source = order[index];
      return { t: value(source, 0), z: value(source, 1), s: value(source, 2), f: value(source, 3), x: value(source, 4), y: value(source, 5), k: value(source, 6) };
    },
    lowerBound(time) {
      let lo = 0; let hi = count;
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (value(order[mid], 0) < time) lo = mid + 1; else hi = mid; }
      return lo;
    },
  };
}
