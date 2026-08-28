// src/library.js
// Library metadata for the KÜTÜPHANE panel: what is on disk, cheaply.
// Session files reach ~700 MB, so per-file metadata comes from the first line
// (session header) and the last ~8 KB (end record when the take completed) —
// never a full read or parse.
import { openSync, readSync, closeSync, readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const HEAD_BYTES = 8192;
const TAIL_BYTES = 8192;

function readChunk(fd, position, length) {
  const buf = Buffer.alloc(length);
  const n = readSync(fd, buf, 0, length, position);
  return buf.toString('utf8', 0, n);
}

export function readSessionMeta(filePath) {
  const size = statSync(filePath).size;
  const fd = openSync(filePath, 'r');
  try {
    // header: the first line of the file
    const head = readChunk(fd, 0, Math.min(HEAD_BYTES, size));
    const nl = head.indexOf('\n');
    let header = null;
    try { header = JSON.parse(nl === -1 ? head : head.slice(0, nl)); }
    catch { /* torn or foreign file: no header */ }
    if (header?.kind !== 'session') header = null;

    // end record: only ever the LAST non-empty line. A crash-torn tail parses
    // as nothing, which correctly reads as an incomplete take.
    let end = null;
    const tailStart = Math.max(0, size - TAIL_BYTES);
    let tail = readChunk(fd, tailStart, Math.min(TAIL_BYTES, size));
    if (tailStart > 0) {
      // the chunk starts mid-line: drop the partial first line
      const cut = tail.indexOf('\n');
      tail = cut === -1 ? '' : tail.slice(cut + 1);
    }
    const lines = tail.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.kind === 'end') end = obj;
      } catch { /* torn EOF from a crash — not an end record */ }
      break;
    }
    return {
      sessionId: header?.sessionId ?? null,
      label: header?.label ?? null,
      complete: end !== null,
      events: end?.events ?? null,
      participants: end?.participants ?? null,
    };
  } finally {
    closeSync(fd);
  }
}

export function listPacks(packsDir) {
  if (!packsDir) return [];
  let entries;
  try { entries = JSON.parse(readFileSync(join(packsDir, 'index.json'), 'utf8')).packs ?? []; }
  catch { return []; } // no index yet (or torn): nothing to show
  const packs = [];
  for (const e of entries) {
    if (typeof e?.name !== 'string') continue;
    let bytes = 0;
    try {
      const dir = join(packsDir, e.name);
      for (const f of readdirSync(dir)) bytes += statSync(join(dir, f)).size;
    } catch { continue; } // index entry whose directory vanished — skip it
    packs.push({
      name: e.name, sessionId: e.sessionId ?? null, label: e.label ?? null,
      lanes: e.lanes ?? 0, events: e.events ?? 0, strokes: e.strokes ?? 0, bytes,
    });
  }
  return packs;
}

export function listLibrary({ sessionsDir, packsDir }) {
  const packs = listPacks(packsDir);
  const packBySession = new Map(packs.map((p) => [p.sessionId, p.name]));
  const sessions = [];
  const files = existsSync(sessionsDir)
    ? readdirSync(sessionsDir).filter((f) => f.endsWith('.jsonl'))
    : [];
  for (const file of files) {
    const p = join(sessionsDir, file);
    let st;
    try { st = statSync(p); } catch { continue; } // deleted between readdir and stat
    let meta;
    try { meta = readSessionMeta(p); }
    catch { meta = { sessionId: null, label: null, complete: false, events: null, participants: null }; }
    sessions.push({
      file, bytes: st.size, mtimeMs: st.mtimeMs, ...meta,
      packName: meta.sessionId !== null ? packBySession.get(meta.sessionId) ?? null : null,
    });
  }
  sessions.sort((a, b) => b.mtimeMs - a.mtimeMs); // freshest take on top
  return { sessions, packs };
}
