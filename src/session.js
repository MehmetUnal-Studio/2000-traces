// src/session.js
import { normalizeEvent } from './adapter.js';
import { createStore } from './store.js';

// States: IDLE -> ARMED -> RECORDING -> FINALIZING -> COMPLETE

export function createSession({ sessionId, visualSeed, durationMs = 90000, now = Date.now } = {}) {
  if (!sessionId) sessionId = `session-${now()}`;
  if (visualSeed === undefined) visualSeed = Math.floor(Math.random() * 2 ** 31);
  let state = 'IDLE';
  let anchorServerMs = null;
  let startedAtLocalMs = null;
  let endedAtLocalMs = null;
  const stats = { received: 0, stored: 0, malformed: 0, duplicates: 0, late: 0, early: 0, ignored: 0 };
  const store = createStore();
  const lastStored = new Map(); // pid -> last stored rec (duplicate check)

  const assertState = (from, to) => {
    if (state !== from) throw new Error(`cannot ${to} from ${state}`);
    state = to;
  };

  return {
    store,
    sessionId,
    state: () => state,
    stats: () => ({ ...stats }),
    meta: () => ({
      schemaVersion: 1, sessionId, durationMs, visualSeed,
      anchorServerMs, startedAtLocalMs, endedAtLocalMs,
    }),
    arm: () => assertState('IDLE', 'ARMED'),
    start: () => { assertState('ARMED', 'RECORDING'); startedAtLocalMs = now(); },
    stop: () => { assertState('RECORDING', 'FINALIZING'); endedAtLocalMs = now(); },
    finalize() {
      assertState('FINALIZING', 'COMPLETE');
      return { ...this.meta(), stats: { ...stats }, participants: store.participantCount(), events: store.size() };
    },
    ingest(raw, arrivalMs) {
      const r = normalizeEvent(raw);
      if (!r.ok && r.reason === 'snapshot') return { accepted: false, reason: 'snapshot' };
      if (state !== 'RECORDING') {
        if (state === 'IDLE' || state === 'ARMED') { stats.ignored += 1; return { accepted: false, reason: 'not-recording' }; }
        stats.late += 1;
        return { accepted: false, reason: 'after-stop' };
      }
      stats.received += 1;
      if (!r.ok) { stats.malformed += 1; return { accepted: false, reason: r.reason }; }
      const ev = r.event;
      if (anchorServerMs === null) anchorServerMs = ev.serverTimestampMs;
      const tMs = ev.serverTimestampMs - anchorServerMs;
      // An upstream shard stamped before the anchor would yield a negative tMs
      // that the packer cannot encode (uint32) — reject and count it instead.
      if (tMs < 0) { stats.early += 1; return { accepted: false, reason: 'before-anchor' }; }
      if (tMs > durationMs) { stats.late += 1; return { accepted: false, reason: 'past-duration' }; }
      const prev = lastStored.get(ev.participantId);
      if (prev && prev.eventType === ev.eventType && prev.serverTimestampMs === ev.serverTimestampMs
          && prev.finger === ev.finger && prev.line === ev.line && prev.u === ev.u && prev.v === ev.v) {
        stats.duplicates += 1;
        return { accepted: false, reason: 'duplicate' };
      }
      const seq = store.size();
      const rec = store.append(ev, tMs, seq);
      rec.arrivalMs = arrivalMs;
      lastStored.set(ev.participantId, rec);
      stats.stored += 1;
      return { accepted: true, seq, tMs };
    },
  };
}
