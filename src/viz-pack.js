// src/viz-pack.js
// Converts a recorded session JSONL into a compact binary pack the WebGL
// renderer streams straight into GPU buffers:
//   manifest.json — session meta + lane table (zone,seat -> dense laneIndex)
//   events.bin    — one 12-byte record per stored event, grouped by lane;
//                   per-lane records are in arrival order (normally ascending
//                   tMs, but upstream reorders are preserved as recorded)
//   strokes.bin   — one 16-byte record per noteOn..noteOff pair on a lane
// Lanes are ordered zone -> seat (the brief's venue ordering with the data we
// have); the same session file always produces byte-identical packs.
import { createReadStream, mkdirSync, writeFileSync, readFileSync, readdirSync, renameSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, dirname, basename } from 'node:path';

export const EVENT_RECORD_BYTES = 12;
export const STROKE_RECORD_BYTES = 16;
export const TYPE_CODES = {
  keepalive: 0, noteOn: 1, noteOff: 2, fingerMove: 3, loadProgress: 4, disconnect: 5,
};

const q16 = (x) => Math.max(0, Math.min(65535, Math.round((x ?? 0) * 65535)));
// uint32-safe time: an already-recorded take may carry a negative or fractional
// tMs (pre-guard recordings, float server clocks) — clamp instead of throwing
// so no recording on disk is ever unpackable.
const clampT = (t, durationMs) => Math.max(0, Math.min(durationMs, Math.round(t ?? 0)));

export async function packSession(inputPath, outDir) {
  const rl = createInterface({ input: createReadStream(inputPath), crlfDelay: Infinity });
  let meta = null;
  // pid -> { z, s, events: flat [tMs, uq, vq, type, line] tuples }
  const byPid = new Map();

  // A crash/power-cut mid-flush leaves half a JSON line at EOF. Tolerate a
  // parse failure only on the FINAL non-empty line (hold it pending; rethrow
  // if more data follows): a truncated take must still pack, a corrupt
  // mid-file line must still throw.
  let pendingParseError = null;
  for await (const line of rl) {
    if (!line.trim()) continue;
    if (pendingParseError) throw pendingParseError;
    let obj;
    try { obj = JSON.parse(line); } catch (err) { pendingParseError = err; continue; }
    if (obj.kind === 'session') { meta = obj; continue; }
    if (obj.kind !== 'event') continue;
    if (!meta) throw new Error('session header must precede events');
    let p = byPid.get(obj.participantId);
    if (!p) { p = { z: obj.zone, s: obj.seatNumber, events: [] }; byPid.set(obj.participantId, p); }
    const type = TYPE_CODES[obj.eventType];
    if (type === undefined) throw new Error(`unknown eventType ${obj.eventType}`);
    p.events.push(obj.tMs, q16(obj.u), q16(obj.v), type, obj.line ?? 0, obj.finger ?? 0);
  }
  if (!meta) throw new Error('no session header found');
  const durationMs = meta.durationMs;

  // Dense lane order: zone letter, then seat number.
  const pids = [...byPid.keys()].sort((a, b) => {
    const pa = byPid.get(a); const pb = byPid.get(b);
    return pa.z < pb.z ? -1 : pa.z > pb.z ? 1 : pa.s - pb.s;
  });

  let eventCount = 0;
  for (const pid of pids) eventCount += byPid.get(pid).events.length / 6;

  const events = Buffer.alloc(eventCount * EVENT_RECORD_BYTES);
  const strokes = [];
  const participants = [];
  const zones = [];
  let offset = 0;

  pids.forEach((pid, lane) => {
    const p = byPid.get(pid);
    const n = p.events.length / 6;
    participants.push({ p: pid, z: p.z, s: p.s, l: lane, o: offset, n });
    if (!zones.length || zones[zones.length - 1].zone !== p.z) {
      zones.push({ zone: p.z, laneStart: lane, laneCount: 0 });
    }
    zones[zones.length - 1].laneCount += 1;

    const open = new Map(); // finger -> { t0, uq, vq, line }
    for (let i = 0; i < n; i++) {
      const j = i * 6;
      const tMs = p.events[j]; const uq = p.events[j + 1]; const vq = p.events[j + 2];
      const type = p.events[j + 3]; const lineNo = p.events[j + 4]; const finger = p.events[j + 5];
      const base = (offset + i) * EVENT_RECORD_BYTES;
      events.writeUInt16LE(lane, base + 0);
      events.writeUInt16LE(uq, base + 2);
      events.writeUInt16LE(vq, base + 4);
      events.writeUInt32LE(clampT(tMs, durationMs), base + 6);
      events.writeUInt8(type, base + 10);
      events.writeUInt8(lineNo & 0xff, base + 11);

      if (type === TYPE_CODES.noteOn) {
        const prev = open.get(finger);
        if (prev) strokes.push({ lane, line: prev.line, t0: prev.t0, t1: tMs, uq: prev.uq, vq: prev.vq });
        open.set(finger, { t0: tMs, uq, vq, line: lineNo });
      } else if (type === TYPE_CODES.disconnect) {
        // disconnect carries no finger field — the whole hand left. Close every
        // open stroke of this lane at the disconnect time, or fingers 1..n would
        // paint phantom strokes clamped to durationMs.
        for (const prev of open.values()) {
          strokes.push({ lane, line: prev.line, t0: prev.t0, t1: tMs, uq: prev.uq, vq: prev.vq });
        }
        open.clear();
      } else if (type === TYPE_CODES.noteOff) {
        const prev = open.get(finger);
        if (prev) {
          strokes.push({ lane, line: prev.line, t0: prev.t0, t1: tMs, uq: prev.uq, vq: prev.vq });
          open.delete(finger);
        }
      }
    }
    for (const prev of open.values()) {
      strokes.push({ lane, line: prev.line, t0: prev.t0, t1: durationMs, uq: prev.uq, vq: prev.vq });
    }
    offset += n;
  });

  const strokeBuf = Buffer.alloc(strokes.length * STROKE_RECORD_BYTES);
  strokes.forEach((st, i) => {
    const base = i * STROKE_RECORD_BYTES;
    strokeBuf.writeUInt16LE(st.lane, base + 0);
    strokeBuf.writeUInt8(st.line & 0xff, base + 2);
    strokeBuf.writeUInt8(0, base + 3);
    strokeBuf.writeUInt32LE(clampT(st.t0, durationMs), base + 4);
    strokeBuf.writeUInt32LE(clampT(st.t1, durationMs), base + 8);
    strokeBuf.writeUInt16LE(st.uq, base + 12);
    strokeBuf.writeUInt16LE(st.vq, base + 14);
  });

  const manifest = {
    formatVersion: 1,
    sessionId: meta.sessionId,
    durationMs,
    visualSeed: meta.visualSeed,
    label: meta.label ?? null,
    laneCount: participants.length,
    eventCount,
    strokeCount: strokes.length,
    truncatedTail: pendingParseError !== null, // torn EOF line skipped (crashed take salvaged)
    zones,
    participants,
  };

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'events.bin'), events);
  writeFileSync(join(outDir, 'strokes.bin'), strokeBuf);
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest));

  // keep a directory-level index so the viewer discovers packs dynamically.
  // Never trust the previous index.json contents: a concurrent packer (server
  // auto-pack + CLI) or a torn write must not lose history — rebuild the
  // entry list from the pack directories on disk, then write via temp-file +
  // rename so readers never observe a partial index.
  const packsRoot = dirname(outDir);
  const indexPath = join(packsRoot, 'index.json');
  const entryFor = (name, m) => ({
    name, sessionId: m.sessionId, label: m.label ?? null,
    lanes: m.laneCount, events: m.eventCount, strokes: m.strokeCount,
  });
  const entry = entryFor(basename(outDir), manifest);
  const others = [];
  for (const d of readdirSync(packsRoot, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name === entry.name) continue;
    try {
      const m = JSON.parse(readFileSync(join(packsRoot, d.name, 'manifest.json'), 'utf8'));
      others.push({ ...entryFor(d.name, m), mtimeMs: statSync(join(packsRoot, d.name, 'manifest.json')).mtimeMs });
    } catch { /* not a pack directory */ }
  }
  others.sort((a, b) => (b.mtimeMs - a.mtimeMs) || (a.name < b.name ? 1 : -1)); // freshest first
  const index = { packs: [entry, ...others.map(({ mtimeMs, ...rest }) => rest)] };
  const tmpPath = `${indexPath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(index, null, 1));
  renameSync(tmpPath, indexPath); // atomic on POSIX: readers see old or new, never torn
  return manifest;
}

// CLI: node src/viz-pack.js <session.jsonl> <outDir>
if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , input, outDir] = process.argv;
  if (!input || !outDir) { console.error('usage: node src/viz-pack.js <session.jsonl> <outDir>'); process.exit(1); }
  const m = await packSession(input, outDir);
  if (m.truncatedTail) console.error('note: torn trailing line skipped — pack salvaged from a crash-truncated take');
  console.log(JSON.stringify({ outDir, lanes: m.laneCount, events: m.eventCount, strokes: m.strokeCount }));
}
