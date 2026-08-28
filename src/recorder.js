// src/recorder.js
import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { once } from 'node:events';
import { createSession } from './session.js';
import { headerLine, eventLine, endLine } from './jsonl.js';

// Drains an async source ({raw, arrivalMs}) into a session, streaming every
// stored event to disk immediately. Recording is authoritative on disk: a
// crash mid-run leaves a valid partial JSONL file.
// durationMs wall-clock stop: pass stopAfterMs to cut a live source; a file
// source just runs to completion (its data is already bounded).
export async function recordFromSource(source, {
  outPath, sessionId, visualSeed, source: sourceLabel = 'unknown',
  durationMs = 90000, stopAfterMs = null, now = Date.now, onProgress = null,
} = {}) {
  mkdirSync(dirname(outPath), { recursive: true });
  const session = createSession({ sessionId, visualSeed, durationMs, now });
  const out = createWriteStream(outPath, { flags: 'w' });
  // Persistent listener: an async write error (ENOSPC, EACCES) arriving while
  // we are not awaiting the stream must reject this promise, not crash the
  // process as an uncaught 'error' event. writeLine rethrows it on next use.
  let writeError = null;
  out.on('error', (err) => { writeError = err; });
  const writeLine = (line) => {
    if (writeError) throw writeError;
    if (!out.write(line + '\n')) return once(out, 'drain');
  };

  session.arm();
  session.start();
  try {
    await writeLine(headerLine(session.meta(), sourceLabel));

    const startedLocal = now();
    for await (const { raw, arrivalMs } of source) {
      if (writeError) throw writeError;
      if (stopAfterMs !== null && now() - startedLocal >= stopAfterMs) break;
      const r = session.ingest(raw, arrivalMs);
      if (r.accepted) {
        const rec = session.store.all()[r.seq];
        const p = writeLine(eventLine(rec, raw));
        if (p) await p; // backpressure: recording must not balloon memory
      }
      if (onProgress && session.stats().received % 10000 === 0) onProgress(session.stats());
    }

    session.stop();
    const summary = session.finalize();
    await writeLine(endLine({ stats: summary.stats, participants: summary.participants, events: summary.events, anchorServerMs: summary.anchorServerMs, endedAtLocalMs: summary.endedAtLocalMs }));
    out.end();
    await once(out, 'finish');
    return { ...summary, outPath, session };
  } finally {
    // A throwing source must not leak the fd or strand buffered lines: flush
    // and close, keeping the valid partial file on disk. A stream that already
    // errored has destroyed itself (fd released); the success path finished.
    if (!out.destroyed && !out.writableFinished) {
      out.end();
      await once(out, 'close').catch(() => {});
    }
  }
}
