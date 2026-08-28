// src/adapter.js
// Converts one raw cs:events JSON object into the normalized internal event.
// The raw object is preserved untouched on .raw — mappings added later may use
// fields the first prototype ignores.
const EVENT_TYPES = new Map([
  [-1, 'disconnect'], [0, 'keepalive'], [1, 'noteOn'],
  [2, 'noteOff'], [3, 'fingerMove'], [4, 'loadProgress'],
]);

export function zoneLetter(z) { return String.fromCharCode(65 + z); }
export function participantId(z, s) { return `${zoneLetter(z)}${s}`; }

export function normalizeEvent(raw) {
  if (raw === null || typeof raw !== 'object') return { ok: false, reason: 'not-object' };
  if (raw.type === 'snapshot') return { ok: false, reason: 'snapshot' };
  const { t, z, s, ts } = raw;
  if (!Number.isInteger(t) || !Number.isInteger(z) || !Number.isInteger(s) || !Number.isFinite(ts)) {
    return { ok: false, reason: 'missing-core-fields' };
  }
  if (z < 0 || z > 25 || s < 0 || s > 255) return { ok: false, reason: 'identity-range' };
  const eventType = EVENT_TYPES.get(t);
  if (!eventType) return { ok: false, reason: 'unknown-type' };
  const event = {
    participantId: participantId(z, s),
    zone: zoneLetter(z),
    seatNumber: s,
    serverTimestampMs: ts,
    eventType,
    raw,
  };
  if (Number.isInteger(raw.f)) event.finger = raw.f;
  if (Number.isInteger(raw.l)) event.line = raw.l;
  if (typeof raw.uu === 'number') event.u = raw.uu;
  if (typeof raw.vv === 'number') event.v = raw.vv;
  if (typeof raw.p === 'number') event.progress = raw.p;
  if (Number.isInteger(raw.pp)) event.protocol = raw.pp;
  if (typeof raw.sid === 'string') event.connectionId = raw.sid;
  return { ok: true, event };
}
