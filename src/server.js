// src/server.js
import { createServer } from 'node:http';
import { readFileSync, readdirSync, statSync, createReadStream, existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { recordFromSource } from './recorder.js';
import { loadEnv } from './env.js';
import { liveSource } from './sources/live-source.js';

export function createControlServer({ sessionsDir, sourceFactory, durationMs = 90000 }) {
  let phase = 'IDLE'; // mirrors session states between runs
  let current = null; // { sessionId, controller, session }
  let lastSummary = null;
  let server = null;

  const status = () => ({
    state: current?.session?.state?.() ?? phase,
    stats: current?.session?.stats?.() ?? lastSummary?.stats ?? null,
    participants: current?.session?.store?.participantCount?.() ?? lastSummary?.participants ?? 0,
    sessionId: current?.sessionId ?? lastSummary?.sessionId ?? null,
    durationMs,
  });

  const handlers = {
    'GET /api/status': (req, res) => json(res, status()),
    'POST /api/arm': (req, res) => {
      if (phase !== 'IDLE' && phase !== 'COMPLETE') return json(res, { error: `cannot arm from ${phase}` }, 409);
      phase = 'ARMED';
      json(res, status());
    },
    'POST /api/start': (req, res) => {
      if (phase !== 'ARMED') return json(res, { error: `cannot start from ${phase}` }, 409);
      const sessionId = `session-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      const outPath = join(sessionsDir, `${sessionId}.jsonl`);
      const controller = new AbortController();
      // current must exist before recordFromSource runs: onSession fires
      // synchronously, before the record promise is returned.
      current = { sessionId, controller, session: null };
      const record = recordFromSource(sourceFactory(controller.signal), {
        outPath, sessionId, source: 'live', durationMs, stopAfterMs: durationMs,
        onSession: (s) => { current.session = s; },
      });
      record.then((summary) => { lastSummary = { ...summary, sessionId }; current = null; phase = 'COMPLETE'; })
            .catch(() => { current = null; phase = 'IDLE'; });
      phase = 'RECORDING';
      json(res, { ok: true, sessionId });
    },
    'POST /api/stop': (req, res) => {
      if (!current) return json(res, { error: 'not recording' }, 409);
      current.controller.abort();
      json(res, { ok: true });
    },
    'GET /api/sessions': (req, res) => {
      const files = existsSync(sessionsDir) ? readdirSync(sessionsDir).filter((f) => f.endsWith('.jsonl')) : [];
      json(res, files.map((f) => ({ file: f, bytes: statSync(join(sessionsDir, f)).size })));
    },
  };

  function json(res, obj, code = 200) {
    res.writeHead(code, { 'Content-Type': 'application/json' });
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
      server = createServer((req, res) => {
        const key = `${req.method} ${req.url.split('?')[0]}`;
        if (handlers[key]) return handlers[key](req, res);
        if (req.method === 'GET' && req.url.startsWith('/sessions/')) {
          const f = sessionFilePath(req.url);
          if (f && existsSync(f)) { res.writeHead(200, { 'Content-Type': 'application/x-ndjson' }); return createReadStream(f).pipe(res); }
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
    close: () => new Promise((r) => server.close(r)),
  };
}

// Direct run: live panel
if (import.meta.url === `file://${process.argv[1]}`) {
  const env = loadEnv();
  const sessionsDir = new URL('../sessions/', import.meta.url).pathname;
  const srv = createControlServer({
    sessionsDir,
    sourceFactory: (signal) => liveSource({ url: env.CS_EVENTS_URL, auth: env.CS_EVENTS_AUTH, signal }),
  });
  await srv.listen(Number(process.env.PANEL_PORT ?? 8787));
  console.log(`2000 TRACES recorder panel: http://127.0.0.1:${srv.port()}/`);
}
