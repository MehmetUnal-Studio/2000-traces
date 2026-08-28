// src/store.js
// In-memory, participant-indexed store of normalized events. Raw payloads are
// NOT kept here (they stream to disk); this stays compact at 2k participants.
export function createStore() {
  const events = [];                 // arrival order
  const byParticipant = new Map();   // pid -> event array (same objects)
  const participants = new Map();    // pid -> metadata

  return {
    append(event, tMs, seq) {
      const { raw, ...rest } = event;
      const rec = { seq, tMs, ...rest };
      events.push(rec);
      let lane = byParticipant.get(rec.participantId);
      if (!lane) { lane = []; byParticipant.set(rec.participantId, lane); }
      lane.push(rec);
      let meta = participants.get(rec.participantId);
      if (!meta) {
        meta = { zone: rec.zone, seatNumber: rec.seatNumber, eventCount: 0, firstTMs: tMs, lastTMs: tMs, byType: {} };
        participants.set(rec.participantId, meta);
      }
      meta.eventCount += 1;
      meta.lastTMs = tMs;
      meta.byType[rec.eventType] = (meta.byType[rec.eventType] ?? 0) + 1;
      return rec;
    },
    size: () => events.length,
    participantCount: () => participants.size,
    eventsOf: (pid) => byParticipant.get(pid) ?? [],
    participants: () => participants,
    all: () => events,
  };
}
