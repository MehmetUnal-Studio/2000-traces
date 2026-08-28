// src/server.js
import { createServer } from 'node:http';
import { readFileSync, readdirSync, statSync, createReadStream, existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { recordFromSource } from './recorder.js';
import { packSession, TYPE_CODES } from './viz-pack.js';
import { loadEnv } from './env.js';
import { liveSource } from './sources/live-source.js';

const LIVE_FLUSH_MS = 40;

// One stalled viewer (lid closed, wifi drop without FIN — 'close' fires only
// minutes later on retransmit timeout) must not buffer the whole show in
// server memory: past the high-water mark the client is dropped. A live view
// can simply rejoin; it does not need history.
export const LIVE_CLIENT_MAX_BUFFER = 4 * 1024 * 1024;

export function broadcastFrame(clients, frame, maxBuffer = LIVE_CLIENT_MAX_BUFFER) {
  for (const res of clients) {
    if ((res.writableLength ?? 0) > maxBuffer) {
      clients.delete(res);
      res.destroy?.();
      continue;
    }
    res.write(frame);
  }
}

export function createControlServer({
  sessionsDir, sourceFactory, durationMs = 90000,
  packsDir = null, autoPack = false,
}) {
  let phase = 'IDLE'; // mirrors session states between runs
  let current = null; // { sessionId, controller, session, killer }
  let lastSummary = null; // light summary only — never the live session object
  let finalizing = null; // { sessionId, stats, participants } while packSession runs
  let lastError = null; // { message, sessionId, at } from a failed take, until the next start
  let server = null;

  // --- live re-broadcast hub (viewer draws while the recorder records) -----
  const liveClients = new Set();
  let latestRoster = null; // [{z:'A', s:12}, ...] from the upstream snapshot
  let pendingBatch = [];
  let flushTimer = null;

  const broadcast = (obj) => broadcastFrame(liveClients, `data: ${JSON.stringify(obj)}\n\n`);
  const flushLive = () => {
    if (!pendingBatch.length || !liveClients.size) { pendingBatch = pendingBatch.length > 50000 ? [] : pendingBatch; return; }
    const events = pendingBatch;
    pendingBatch = [];
    broadcast({ kind: 'batch', events });
  };

  const compact = (rec) => ({
    z: rec.zone, s: rec.seatNumber, t: rec.tMs, k: TYPE_CODES[rec.eventType] ?? 0,
    f: rec.finger ?? 0, l: rec.line ?? 0, u: rec.u, v: rec.v,
  });

  const rosterFromSnapshot = (raw) => {
    const roster = [];
    for (const [zi, seats] of Object.entries(raw.zones ?? {})) {
      const zone = String.fromCharCode(65 + Number(zi));
      for (const s of Object.keys(seats)) roster.push({ z: zone, s: Number(s) });
    }
    return roster;
  };

  // During FINALIZING `current` is already null: the `finalizing` snapshot
  // keeps status reporting THIS session, not the previous take's lastSummary.
  const status = () => ({
    state: current?.session?.state?.() ?? phase,
    stats: current?.session?.stats?.() ?? finalizing?.stats ?? lastSummary?.stats ?? null,
    participants: current?.session?.store?.participantCount?.() ?? finalizing?.participants ?? lastSummary?.participants ?? 0,
    sessionId: current?.sessionId ?? finalizing?.sessionId ?? lastSummary?.sessionId ?? null,
    packName: finalizing ? null : lastSummary?.packName ?? null,
    packError: finalizing ? null : lastSummary?.packError ?? null,
    lastError,
    durationMs,
  });

  const handlers = {
    'GET /api/status': (req, res) => json(res, status()),
    'POST /api/arm': (req, res) => {
      if (phase === 'ARMED') {
        // second arm = disarm: an accidental arm must not force a junk take
        phase = 'IDLE';
        broadcast({ kind: 'state', state: 'IDLE' });
        return json(res, status());
      }
      if (phase !== 'IDLE' && phase !== 'COMPLETE') return json(res, { error: `cannot arm from ${phase}` }, 409);
      phase = 'ARMED';
      broadcast({ kind: 'state', state: 'ARMED' });
      json(res, status());
    },
    'POST /api/start': (req, res) => {
      if (phase !== 'ARMED') return json(res, { error: `cannot start from ${phase}` }, 409);
      // fresh session boundary: nothing from a previous take may leak into
      // this take's hello/roster or its first live batch
      latestRoster = null;
      pendingBatch = [];
      lastError = null;
      const sessionId = `session-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      const outPath = join(sessionsDir, `${sessionId}.jsonl`);
      const controller = new AbortController();
      // current must exist before recordFromSource runs: onSession fires
      // synchronously, before the record promise is returned.
      current = { sessionId, controller, session: null, killer: null };
      const record = recordFromSource(sourceFactory(controller.signal), {
        outPath, sessionId, source: 'live', durationMs, stopAfterMs: durationMs,
        onSession: (s) => {
          current.session = s;
          broadcast({ kind: 'state', state: 'RECORDING', sessionId, visualSeed: s.meta().visualSeed });
        },
        onEvent: (rec) => { pendingBatch.push(compact(rec)); },
        onSnapshot: (raw) => {
          latestRoster = rosterFromSnapshot(raw);
          broadcast({ kind: 'roster', roster: latestRoster });
        },
      });
      // stopAfterMs only fires on the next event: a stream that goes quiet
      // must still end the session on the wall clock.
      current.killer = setTimeout(() => controller.abort(), durationMs + 5000);
      record
        .then(async (summary) => {
          clearTimeout(current?.killer);
          finalizing = { sessionId, stats: summary.stats, participants: summary.participants };
          current = null;
          phase = 'FINALIZING';
          flushLive();
          pendingBatch = []; // undelivered frames die with their session (live has no history)
          latestRoster = null;
          let packName = null;
          let packError = null;
          // an empty session (stream never produced events) has nothing to pack
          if (autoPack && packsDir && summary.participants > 0) {
            packName = sessionId.replace(/^session-/, 'kayit-');
            try {
              await packSession(outPath, join(packsDir, packName));
            } catch (err) {
              // the take on disk is fine and packing is retryable — a pack
              // failure must never report a successful recording as failed
              packError = err?.message ?? String(err);
              packName = null;
              console.error('auto-pack failed:', err);
            }
          }
          // drop the live session object: keeping it pins the whole in-memory
          // event store (~600 MB per full show) for as long as the server idles
          const { session: _session, ...persistable } = summary;
          lastSummary = { ...persistable, sessionId, packName, packError };
          finalizing = null;
          phase = 'COMPLETE';
          broadcast({ kind: 'state', state: 'COMPLETE', sessionId, packName, packError, stats: summary.stats, participants: summary.participants });
        })
        .catch((err) => {
          console.error('recording failed:', err);
          clearTimeout(current?.killer);
          current = null;
          finalizing = null;
          phase = 'IDLE';
          lastError = { message: err?.message ?? 'recording failed', sessionId, at: Date.now() };
          // a dead take must not resurface the previous take's numbers
          lastSummary = null;
          pendingBatch = [];
          latestRoster = null;
          broadcast({ kind: 'state', state: 'IDLE', error: lastError.message });
        });
      phase = 'RECORDING';
      json(res, { ok: true, sessionId });
    },
    'POST /api/stop': (req, res) => {
      // phase-accurate refusal: 'not recording' during FINALIZING read as a lost take
      if (!current) return json(res, { error: `cannot stop from ${phase}` }, 409);
      current.controller.abort();
      json(res, { ok: true });
    },
    'GET /api/sessions': (req, res) => {
      const files = existsSync(sessionsDir) ? readdirSync(sessionsDir).filter((f) => f.endsWith('.jsonl')) : [];
      json(res, files.map((f) => ({ file: f, bytes: statSync(join(sessionsDir, f)).size })));
    },
    'GET /api/live': (req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
        Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*',
      });
      res.write(`data: ${JSON.stringify({
        kind: 'hello', state: status().state, durationMs,
        sessionId: current?.sessionId ?? null,
        visualSeed: current?.session?.meta?.().visualSeed ?? null,
        roster: latestRoster,
      })}\n\n`);
      liveClients.add(res);
      req.on('close', () => liveClients.delete(res));
    },
  };

  function json(res, obj, code = 200) {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(obj));
  }

  // The raw request path is attacker-controlled (curl and DNS-rebinding pages
  // bypass browser `..` normalization), so only serve plain file names that
  // resolve inside sessionsDir. Returns the safe absolute path, or null.
  function sessionFilePath(url) {
    let name;
    try { name = decodeURIComponent(url.split('?')[0].slice('/sessions/'.length)); }
    catch { return null; } // malformed percent-encoding
    if (!name || name === '.' || name === '..') return null;
    if (name.includes('/') || name.includes('\\') || name.includes('\0')) return null;
    const f = resolve(sessionsDir, name);
    return f.startsWith(resolve(sessionsDir) + sep) ? f : null;
  }

  return {
    listen(port) {
      flushTimer = setInterval(flushLive, LIVE_FLUSH_MS);
      server = createServer((req, res) => {
        if (req.method === 'OPTIONS') {
          res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST' });
          return res.end();
        }
        const key = `${req.method} ${req.url.split('?')[0]}`;
        if (handlers[key]) return handlers[key](req, res);
        if (req.method === 'GET' && req.url.startsWith('/sessions/')) {
          const f = sessionFilePath(req.url);
          if (f && existsSync(f)) { res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Access-Control-Allow-Origin': '*' }); return createReadStream(f).pipe(res); }
        }
        if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          return res.end(readFileSync(new URL('../ui/index.html', import.meta.url)));
        }
        res.writeHead(404); res.end('not found');
      });
      // Local operator panel: bind loopback only, never the venue LAN.
      return new Promise((r) => server.listen(port, '127.0.0.1', () => r()));
    },
    port: () => server.address().port,
    close: () => new Promise((r) => {
      clearInterval(flushTimer);
      for (const res of liveClients) res.end();
      liveClients.clear();
      server.close(r);
    }),
  };
}

// Direct run: live panel
if (import.meta.url === `file://${process.argv[1]}`) {
  const env = loadEnv();
  const sessionsDir = new URL('../sessions/', import.meta.url).pathname;
  const srv = createControlServer({
    sessionsDir,
    packsDir: new URL('../viz/public/packs/', import.meta.url).pathname,
    autoPack: true,
    sourceFactory: (signal) => liveSource({ url: env.CS_EVENTS_URL, auth: env.CS_EVENTS_AUTH, token: env.CS_EVENTS_TOKEN, signal }),
  });
  await srv.listen(Number(process.env.PANEL_PORT ?? 8787));
  console.log(`2000 TRACES recorder panel: http://127.0.0.1:${srv.port()}/`);
}
