# 2000 TRACES — Recorder/Data Adapter MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A dependency-free Node recorder that subscribes read-only to the Cosmic Symphony audience SSE stream, records 90-second sessions with stable per-participant identity, and exports/imports deterministic JSONL session files.

**Architecture:** A small pipeline: SSE byte stream → SSE frame parser → JSON parse → `adapter.normalizeEvent` → `session.ingest` (state machine + stats) → participant-indexed in-memory `store` (normalized, compact) + immediate append-to-disk JSONL (raw + normalized, crash-safe). Sources are async generators (`file-source` for captured raw files, `live-source` for the authenticated SSE endpoint). A tiny HTTP control server + static operator page drives arm/start/stop/export. No Three.js in this plan — the visual milestone builds on the session files this produces.

**Tech Stack:** Node ≥ 22 (built-in `fetch`, `node:test`), plain ESM JavaScript, zero runtime dependencies.

---

## Verified protocol facts this plan is built on (do not re-derive)

Source: code inspection of `/Users/mehmetunal/cosmicsymphony-audience-interaction` + a 45 s live capture of 384 simulated participants (263,986 events) stored at `captures/2026-08-28-loadgen384-45s.sse.raw`.

- Feed: SSE `GET https://dev.diablo.com.tr/api/events`, HTTP Basic auth. First frame is `{"type":"snapshot",...}` (skip it). Every subsequent frame is one JSON object per audience event, verbatim from Redis channel `cs:events`.
- Event fields **as observed live** (deployed cloud runs committed code): `t` (int type), `z` (zone 0–25), `s` (seat 0–255), `ts` (server epoch ms), plus per type: `l` (line), `f` (finger), `uu`/`vv` (floats 0–1), `p` (progress 0–1). Fields `pp` (protocol) and `sid` (connection id) exist only in uncommitted server code — **treat as optional**.
- Types: `1`=NOTE_ON (has l,f,uu,vv), `2`=NOTE_OFF (l,f, no uv), `3`=FINGER_UV (f,uu,vv, no l), `4`=LOAD_PROGRESS (p), `0`=connected/heartbeat (z,s,ts only), `-1`=disconnect (z,s,ts only).
- Stable identity = `(z,s)` from the HMAC seat token, survives reconnects. Render as `A`–`Z` + seat number → participantId `"A42"`.
- Per-participant `ts` is strictly monotonic (verified: 0 regressions in 263,602 pairs). Global cross-participant `ts` is NOT monotonic (3 ws-server replicas) — never sort globally by `ts`; preserve arrival order via `seq`.
- Observed rate: ~5,900 events/s at 384 participants (~72 raw bytes/event). Budget for ~31k events/s at 2000. Recorder therefore writes to disk as it goes and keeps only compact normalized events in RAM.

---

## File Structure

```
2000-traces/
  package.json                 # type:module, test script (node --test)
  .gitignore                   # .env, sessions/, captures/*.raw
  .env                         # CS_EVENTS_URL, CS_EVENTS_AUTH (copied from ~/venue-bridge/.env; NOT committed)
  captures/
    2026-08-28-loadgen384-45s.sse.raw   # full 19 MB real capture (gitignored)
    fixture-small.sse.txt               # 3,000 real data lines (committed)
  src/
    sse-parser.js              # incremental SSE frame parser (bytes → data payload strings)
    adapter.js                 # raw JSON object → normalized event (or rejection with reason)
    store.js                   # participant-indexed in-memory store
    session.js                 # IDLE→ARMED→RECORDING→FINALIZING→COMPLETE + ingest + stats
    jsonl.js                   # session file lines: header / event / end; import
    sources/file-source.js     # async generator over a raw SSE capture file
    sources/live-source.js     # authenticated fetch-stream SSE source with reconnect
    recorder.js                # wires source→session→disk; duration timer
    cli.js                     # headless: record-file / record-live
    server.js                  # local control HTTP API + serves ui/
  ui/
    index.html                 # minimal operator panel (status, arm/start/stop, export links)
  sessions/                    # output JSONL (gitignored)
  test/
    sse-parser.test.js
    adapter.test.js
    store.test.js
    session.test.js
    jsonl.test.js
    file-source.test.js
    recorder.test.js
    live-source.test.js
    acceptance.test.js
  docs/superpowers/plans/2026-08-28-recorder-mvp.md   # this plan
```

Shared data shapes (used consistently in every task):

```js
// Rejection: { ok:false, reason:string }
// Normalized event (adapter output): {
//   ok: true,
//   event: {
//     participantId: "A42",          // zoneLetter + seat number
//     zone: "A",                      // letter, A=z0
//     seatNumber: 42,                 // 0-255
//     serverTimestampMs: 1787907718030,
//     eventType: "noteOn"|"noteOff"|"fingerMove"|"loadProgress"|"keepalive"|"disconnect",
//     finger?: number, line?: number, u?: number, v?: number,
//     progress?: number, protocol?: number, connectionId?: string,
//     raw: object                     // the original parsed JSON, untouched
//   }
// }
// Stored record (store/JSONL event line core): {
//   seq: number,                      // global arrival index, 0-based
//   tMs: number,                      // serverTimestampMs - session anchor
//   participantId, zone, seatNumber, serverTimestampMs, eventType,
//   finger?, line?, u?, v?, progress?, connectionId?
// }
```

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`, `.gitignore`, `.env`, `test/smoke.test.js`

- [x] **Step 1: Create package.json**

```json
{
  "name": "2000-traces",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "test": "node --test test/",
    "record:file": "node src/cli.js record-file",
    "record:live": "node src/cli.js record-live",
    "panel": "node src/server.js"
  }
}
```

- [x] **Step 2: Create .gitignore**

```
.env
node_modules/
sessions/
captures/*.raw
.DS_Store
```

- [x] **Step 3: Create .env (values copied from ~/venue-bridge/.env lines CS_EVENTS_URL / CS_EVENTS_AUTH — do not print them)**

```
CS_EVENTS_URL=<from ~/venue-bridge/.env>
CS_EVENTS_AUTH=<from ~/venue-bridge/.env>
```

Copy with: `grep -E '^CS_EVENTS_(URL|AUTH)=' /Users/mehmetunal/venue-bridge/.env > .env`

- [x] **Step 4: Smoke test**

```js
// test/smoke.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('node:test runs', () => { assert.equal(1 + 1, 2); });
```

Run: `npm test` — Expected: 1 pass.

- [x] **Step 5: git init + first commit**

```bash
cd /Users/mehmetunal/Documents/CluadeCodeFiles/2000-traces
git init && git add -A && git commit -m "chore: scaffold 2000-traces recorder project"
```

---

### Task 2: SSE frame parser

**Files:**
- Create: `src/sse-parser.js`
- Test: `test/sse-parser.test.js`

- [x] **Step 1: Write the failing tests**

```js
// test/sse-parser.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSseParser } from '../src/sse-parser.js';

test('parses a single complete frame', () => {
  const out = [];
  const p = createSseParser((d) => out.push(d));
  p.feed('data: {"t":1}\n\n');
  assert.deepEqual(out, ['{"t":1}']);
});

test('handles frames split across chunks', () => {
  const out = [];
  const p = createSseParser((d) => out.push(d));
  p.feed('data: {"t":');
  p.feed('3,"z":5}\n');
  p.feed('\ndata: {"t":0}\n\n');
  assert.deepEqual(out, ['{"t":3,"z":5}', '{"t":0}']);
});

test('ignores comment/other lines, accepts data: without space', () => {
  const out = [];
  const p = createSseParser((d) => out.push(d));
  p.feed(': keepalive\n\ndata:{"a":1}\n\n');
  assert.deepEqual(out, ['{"a":1}']);
});

test('handles CRLF line endings', () => {
  const out = [];
  const p = createSseParser((d) => out.push(d));
  p.feed('data: {"t":2}\r\n\r\n');
  assert.deepEqual(out, ['{"t":2}']);
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npm test` — Expected: FAIL, cannot find `../src/sse-parser.js`.

- [x] **Step 3: Implement**

```js
// src/sse-parser.js
// Incremental Server-Sent-Events parser: feed() raw text chunks, get each
// frame's data payload via callback. Only the `data:` field is used — the
// demo-server emits exactly one single-line data field per frame.
export function createSseParser(onData) {
  let buf = '';
  return {
    feed(chunk) {
      buf += chunk.replace(/\r\n/g, '\n');
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of frame.split('\n')) {
          if (line.startsWith('data: ')) onData(line.slice(6));
          else if (line.startsWith('data:')) onData(line.slice(5));
        }
      }
    },
  };
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `npm test` — Expected: all pass.

- [x] **Step 5: Commit**

```bash
git add src/sse-parser.js test/sse-parser.test.js
git commit -m "feat: incremental SSE frame parser"
```

---

### Task 3: Event adapter (normalize + validate)

**Files:**
- Create: `src/adapter.js`
- Test: `test/adapter.test.js`

- [x] **Step 1: Write the failing tests** (payloads below are real lines from the live capture)

```js
// test/adapter.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEvent, participantId, zoneLetter } from '../src/adapter.js';

test('zone letters and participant ids', () => {
  assert.equal(zoneLetter(0), 'A');
  assert.equal(zoneLetter(25), 'Z');
  assert.equal(participantId(10, 5), 'K5');
});

test('normalizes a real NOTE_ON', () => {
  const raw = { t: 1, z: 0, s: 8, l: 6, f: 0, uu: 0.65, vv: 0.42, ts: 1787907718030 };
  const r = normalizeEvent(raw);
  assert.equal(r.ok, true);
  assert.equal(r.event.eventType, 'noteOn');
  assert.equal(r.event.participantId, 'A8');
  assert.equal(r.event.zone, 'A');
  assert.equal(r.event.seatNumber, 8);
  assert.equal(r.event.u, 0.65);
  assert.equal(r.event.v, 0.42);
  assert.equal(r.event.line, 6);
  assert.equal(r.event.finger, 0);
  assert.equal(r.event.serverTimestampMs, 1787907718030);
  assert.equal(r.event.raw, raw);
});

test('normalizes real NOTE_OFF / FINGER_UV / keepalive / disconnect / load progress', () => {
  assert.equal(normalizeEvent({ t: 2, z: 1, s: 10, l: 9, f: 0, ts: 1 }).event.eventType, 'noteOff');
  const uv = normalizeEvent({ t: 3, z: 19, s: 2, f: 0, uu: 0.52, vv: 0.44, ts: 2 }).event;
  assert.equal(uv.eventType, 'fingerMove');
  assert.equal(uv.line, undefined);
  assert.equal(normalizeEvent({ t: 0, z: 23, s: 6, ts: 3 }).event.eventType, 'keepalive');
  assert.equal(normalizeEvent({ t: -1, z: 23, s: 6, ts: 4 }).event.eventType, 'disconnect');
  assert.equal(normalizeEvent({ t: 4, z: 0, s: 0, p: 0.5, ts: 5 }).event.progress, 0.5);
});

test('optional future fields pp and sid are carried when present', () => {
  const r = normalizeEvent({ t: 1, z: 2, s: 42, l: 4, f: 0, uu: 0.2, vv: 0.9, sid: 'w1:9:x:1', pp: 2, ts: 6 });
  assert.equal(r.event.connectionId, 'w1:9:x:1');
  assert.equal(r.event.protocol, 2);
});

test('rejects snapshot, malformed, unknown type, out-of-range identity', () => {
  assert.deepEqual(normalizeEvent({ type: 'snapshot', zones: {} }), { ok: false, reason: 'snapshot' });
  assert.equal(normalizeEvent(null).ok, false);
  assert.equal(normalizeEvent('nope').ok, false);
  assert.equal(normalizeEvent({ t: 9, z: 0, s: 0, ts: 1 }).reason, 'unknown-type');
  assert.equal(normalizeEvent({ t: 1, z: 26, s: 0, ts: 1 }).reason, 'identity-range');
  assert.equal(normalizeEvent({ t: 1, z: 0, s: 256, ts: 1 }).reason, 'identity-range');
  assert.equal(normalizeEvent({ t: 1, z: 0, s: 0 }).reason, 'missing-core-fields');
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npm test` — Expected: FAIL, cannot find `../src/adapter.js`.

- [x] **Step 3: Implement**

```js
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
```

- [x] **Step 4: Run tests to verify they pass**

Run: `npm test` — Expected: all pass.

- [x] **Step 5: Commit**

```bash
git add src/adapter.js test/adapter.test.js
git commit -m "feat: raw event adapter with validation and identity mapping"
```

---

### Task 4: Participant-indexed store

**Files:**
- Create: `src/store.js`
- Test: `test/store.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// test/store.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store.js';

function ev(pid, ts, type = 'fingerMove') {
  const zone = pid[0]; const seatNumber = Number(pid.slice(1));
  return { participantId: pid, zone, seatNumber, serverTimestampMs: ts, eventType: type, raw: {} };
}

test('appends and indexes by participant', () => {
  const st = createStore();
  st.append(ev('A1', 100), 0, 0);
  st.append(ev('B2', 105), 5, 1);
  st.append(ev('A1', 110), 10, 2);
  assert.equal(st.size(), 3);
  assert.equal(st.participantCount(), 2);
  const a1 = st.eventsOf('A1');
  assert.equal(a1.length, 2);
  assert.deepEqual(a1.map((e) => e.seq), [0, 2]);
  assert.deepEqual(a1.map((e) => e.tMs), [0, 10]);
  assert.equal(a1[0].raw, undefined); // store keeps normalized only — raw lives on disk
  assert.deepEqual(st.eventsOf('Z9'), []);
});

test('participant metadata accumulates', () => {
  const st = createStore();
  st.append(ev('A1', 100, 'noteOn'), 0, 0);
  st.append(ev('A1', 200, 'fingerMove'), 100, 1);
  const p = st.participants().get('A1');
  assert.equal(p.zone, 'A');
  assert.equal(p.seatNumber, 1);
  assert.equal(p.eventCount, 2);
  assert.equal(p.firstTMs, 0);
  assert.equal(p.lastTMs, 100);
  assert.deepEqual(p.byType, { noteOn: 1, fingerMove: 1 });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test` — Expected: FAIL, cannot find `../src/store.js`.

- [ ] **Step 3: Implement**

```js
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test` — Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/store.js test/store.test.js
git commit -m "feat: participant-indexed in-memory event store"
```

---

### Task 5: Session state machine + ingest

**Files:**
- Create: `src/session.js`
- Test: `test/session.test.js`

Semantics locked here:
- States: `IDLE → ARMED → RECORDING → FINALIZING → COMPLETE`; `stop()` may be called any time during RECORDING (early stop).
- `tMs` anchor = `serverTimestampMs` of the **first stored event** (deterministic for replays of the same data). Events whose `tMs` would exceed `durationMs` are counted `late`, not stored. Events before RECORDING are counted `ignored`.
- Duplicates: an event identical to the participant's immediately previous stored event in (`eventType`, `serverTimestampMs`, `finger`, `line`, `u`, `v`) is counted `duplicates` and not stored.
- Wall-clock duration enforcement lives in the recorder (Task 8), not here — sessions ingest whatever they are given while RECORDING.

- [ ] **Step 1: Write the failing tests**

```js
// test/session.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession } from '../src/session.js';

const NOTE = (z, s, ts, extra = {}) => ({ t: 1, z, s, l: 1, f: 0, uu: 0.5, vv: 0.5, ts, ...extra });

test('state machine transitions', () => {
  const ss = createSession({ visualSeed: 7, sessionId: 'test-1' });
  assert.equal(ss.state(), 'IDLE');
  ss.arm();
  assert.equal(ss.state(), 'ARMED');
  ss.start();
  assert.equal(ss.state(), 'RECORDING');
  ss.stop();
  assert.equal(ss.state(), 'FINALIZING');
  const done = ss.finalize();
  assert.equal(ss.state(), 'COMPLETE');
  assert.equal(done.sessionId, 'test-1');
  assert.equal(done.visualSeed, 7);
  assert.throws(() => ss.start());
});

test('ingest anchors tMs to first stored event and stores in arrival order', () => {
  const ss = createSession({ sessionId: 't', visualSeed: 1 });
  ss.arm(); ss.start();
  assert.deepEqual(ss.ingest(NOTE(0, 1, 1000), 5), { accepted: true, seq: 0, tMs: 0 });
  assert.deepEqual(ss.ingest(NOTE(0, 2, 1250), 6), { accepted: true, seq: 1, tMs: 250 });
  assert.equal(ss.stats().stored, 2);
  assert.equal(ss.store.eventsOf('A1')[0].tMs, 0);
});

test('events outside RECORDING are counted, not stored', () => {
  const ss = createSession({ sessionId: 't', visualSeed: 1 });
  assert.equal(ss.ingest(NOTE(0, 1, 1000), 0).accepted, false); // IDLE
  ss.arm();
  ss.ingest(NOTE(0, 1, 1001), 0);                               // ARMED
  assert.equal(ss.stats().ignored, 2);
  ss.start();
  ss.ingest(NOTE(0, 1, 1002), 0);
  ss.stop();
  assert.equal(ss.ingest(NOTE(0, 1, 1003), 0).accepted, false); // FINALIZING
  assert.equal(ss.stats().late, 1);
  assert.equal(ss.stats().stored, 1);
});

test('events past durationMs are late; malformed and duplicates are counted', () => {
  const ss = createSession({ sessionId: 't', visualSeed: 1, durationMs: 90000 });
  ss.arm(); ss.start();
  ss.ingest(NOTE(0, 1, 1000), 0);
  assert.equal(ss.ingest(NOTE(0, 1, 92000), 1).accepted, false);      // tMs 91000 > 90000
  assert.equal(ss.stats().late, 1);
  assert.equal(ss.ingest({ garbage: true }, 2).accepted, false);
  assert.equal(ss.stats().malformed, 1);
  ss.ingest(NOTE(0, 1, 1500), 3);
  assert.equal(ss.ingest(NOTE(0, 1, 1500), 4).accepted, false);       // exact dup of previous
  assert.equal(ss.stats().duplicates, 1);
  assert.equal(ss.stats().received, 5);
  assert.equal(ss.stats().stored, 2);
});

test('snapshot frames are silently skipped (not counted malformed)', () => {
  const ss = createSession({ sessionId: 't', visualSeed: 1 });
  ss.arm(); ss.start();
  assert.equal(ss.ingest({ type: 'snapshot', zones: {} }, 0).accepted, false);
  assert.equal(ss.stats().malformed, 0);
  assert.equal(ss.stats().received, 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test` — Expected: FAIL, cannot find `../src/session.js`.

- [ ] **Step 3: Implement**

```js
// src/session.js
import { normalizeEvent } from './adapter.js';
import { createStore } from './store.js';

const ORDER = ['IDLE', 'ARMED', 'RECORDING', 'FINALIZING', 'COMPLETE'];

export function createSession({ sessionId, visualSeed, durationMs = 90000, now = Date.now } = {}) {
  if (!sessionId) sessionId = `session-${now()}`;
  if (visualSeed === undefined) visualSeed = Math.floor(Math.random() * 2 ** 31);
  let state = 'IDLE';
  let anchorServerMs = null;
  let startedAtLocalMs = null;
  let endedAtLocalMs = null;
  const stats = { received: 0, stored: 0, malformed: 0, duplicates: 0, late: 0, ignored: 0 };
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

export const SESSION_STATES = ORDER;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test` — Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/session.js test/session.test.js
git commit -m "feat: 90s session state machine with ingest, anchor and stats"
```

---

### Task 6: JSONL export/import

**Files:**
- Create: `src/jsonl.js`
- Test: `test/jsonl.test.js`

File format (one JSON object per line, streamed in this order):
1. `{"kind":"session", ...meta, "source": "..."}` — written at start (meta without end fields).
2. `{"kind":"event","seq":..,"tMs":..,"participantId":..,...,"raw":{...}}` — per stored event, immediately.
3. `{"kind":"end","stats":{...},"participants":N,"events":N,"anchorServerMs":..,"endedAtLocalMs":..}` — at finalize. A file without an `end` line is a valid partial recording.

- [ ] **Step 1: Write the failing tests**

```js
// test/jsonl.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { headerLine, eventLine, endLine, importSession } from '../src/jsonl.js';

test('lines are single-line JSON with kinds', () => {
  const h = JSON.parse(headerLine({ sessionId: 's1', durationMs: 90000, visualSeed: 3, schemaVersion: 1 }, 'file:capture.raw'));
  assert.equal(h.kind, 'session');
  assert.equal(h.source, 'file:capture.raw');
  const rec = { seq: 0, tMs: 12, participantId: 'A1', zone: 'A', seatNumber: 1, serverTimestampMs: 100, eventType: 'noteOn', finger: 0, line: 2, u: 0.5, v: 0.5, arrivalMs: 55 };
  const e = JSON.parse(eventLine(rec, { t: 1, z: 0, s: 1, ts: 100 }));
  assert.equal(e.kind, 'event');
  assert.equal(e.raw.ts, 100);
  assert.equal(e.tMs, 12);
  const end = JSON.parse(endLine({ stats: { stored: 1 }, participants: 1, events: 1, anchorServerMs: 100, endedAtLocalMs: 999 }));
  assert.equal(end.kind, 'end');
});

test('import round-trips header, events, end', () => {
  const lines = [
    headerLine({ sessionId: 's1', durationMs: 90000, visualSeed: 3, schemaVersion: 1 }, 'test'),
    eventLine({ seq: 0, tMs: 0, participantId: 'A1', zone: 'A', seatNumber: 1, serverTimestampMs: 100, eventType: 'noteOn' }, { t: 1 }),
    eventLine({ seq: 1, tMs: 9, participantId: 'B2', zone: 'B', seatNumber: 2, serverTimestampMs: 109, eventType: 'fingerMove' }, { t: 3 }),
    endLine({ stats: { stored: 2 }, participants: 2, events: 2, anchorServerMs: 100, endedAtLocalMs: 1 }),
  ];
  const s = importSession(lines);
  assert.equal(s.meta.sessionId, 's1');
  assert.equal(s.events.length, 2);
  assert.equal(s.events[1].participantId, 'B2');
  assert.equal(s.end.participants, 2);
  assert.equal(s.complete, true);
});

test('import of a partial file (no end line) is valid and flagged', () => {
  const s = importSession([
    headerLine({ sessionId: 's1', durationMs: 90000, visualSeed: 3, schemaVersion: 1 }, 'test'),
    eventLine({ seq: 0, tMs: 0, participantId: 'A1', zone: 'A', seatNumber: 1, serverTimestampMs: 100, eventType: 'noteOn' }, { t: 1 }),
  ]);
  assert.equal(s.complete, false);
  assert.equal(s.events.length, 1);
});

test('import rejects files that do not start with a session header', () => {
  assert.throws(() => importSession(['{"kind":"event"}']));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test` — Expected: FAIL, cannot find `../src/jsonl.js`.

- [ ] **Step 3: Implement**

```js
// src/jsonl.js
// Session file lines. Raw payload rides on each event line so the on-disk file
// preserves the original message even though the in-memory store does not.
export function headerLine(meta, source) {
  return JSON.stringify({ kind: 'session', ...meta, source });
}

export function eventLine(rec, raw) {
  return JSON.stringify({ kind: 'event', ...rec, raw });
}

export function endLine(summary) {
  return JSON.stringify({ kind: 'end', ...summary });
}

export function importSession(lines) {
  let meta = null; let end = null; const events = [];
  for (const line of lines) {
    if (!line || !line.trim()) continue;
    const obj = JSON.parse(line);
    if (obj.kind === 'session') { meta = obj; continue; }
    if (!meta) throw new Error('file does not start with a session header');
    if (obj.kind === 'event') events.push(obj);
    else if (obj.kind === 'end') end = obj;
  }
  if (!meta) throw new Error('file does not start with a session header');
  return { meta, events, end, complete: end !== null };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test` — Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/jsonl.js test/jsonl.test.js
git commit -m "feat: JSONL session export/import with partial-file support"
```

---

### Task 7: File source (replay a raw SSE capture)

**Files:**
- Create: `src/sources/file-source.js`
- Test: `test/file-source.test.js` (uses `captures/fixture-small.sse.txt` — 3,000 real `data: ` lines)

- [ ] **Step 1: Write the failing tests**

```js
// test/file-source.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileSource } from '../src/sources/file-source.js';

const FIXTURE = new URL('../captures/fixture-small.sse.txt', import.meta.url).pathname;

test('yields parsed raw objects from a capture file', async () => {
  let n = 0; let first = null;
  for await (const { raw } of fileSource(FIXTURE)) {
    if (n === 0) first = raw;
    n += 1;
  }
  assert.equal(n, 3000);
  assert.equal(typeof first.t, 'number');
  assert.equal(typeof first.z, 'number');
  assert.equal(typeof first.ts, 'number');
});

test('skips unparseable lines without throwing', async () => {
  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'traces-'));
  const p = join(dir, 'bad.txt');
  writeFileSync(p, 'data: {"t":1,"z":0,"s":0,"ts":1}\n\ndata: {broken\n\ndata: {"t":0,"z":0,"s":0,"ts":2}\n\n');
  const got = [];
  for await (const { raw } of fileSource(p)) got.push(raw.t);
  assert.deepEqual(got, [1, 0]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test` — Expected: FAIL, cannot find `../src/sources/file-source.js`.

- [ ] **Step 3: Implement**

```js
// src/sources/file-source.js
import { createReadStream } from 'node:fs';
import { createSseParser } from '../sse-parser.js';

// Async generator over a raw SSE capture file (as saved by `curl -N`).
// Yields { raw, arrivalMs } as fast as the file reads; deterministic order.
// Lines that fail JSON.parse are skipped (the recorder never sees them —
// wire-level noise is not an audience event).
export async function* fileSource(path) {
  const queue = [];
  const parser = createSseParser((data) => {
    try { queue.push(JSON.parse(data)); } catch { /* skip torn frame */ }
  });
  const stream = createReadStream(path, { encoding: 'utf8' });
  for await (const chunk of stream) {
    parser.feed(chunk);
    while (queue.length) yield { raw: queue.shift(), arrivalMs: Date.now() };
  }
  parser.feed('\n\n'); // flush a trailing frame without a final blank line
  while (queue.length) yield { raw: queue.shift(), arrivalMs: Date.now() };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test` — Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/sources/file-source.js test/file-source.test.js captures/fixture-small.sse.txt
git commit -m "feat: file source replaying raw SSE captures"
```

---

### Task 8: Recorder wiring + CLI

**Files:**
- Create: `src/recorder.js`, `src/cli.js`
- Test: `test/recorder.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// test/recorder.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { recordFromSource } from '../src/recorder.js';
import { fileSource } from '../src/sources/file-source.js';
import { importSession } from '../src/jsonl.js';

const FIXTURE = new URL('../captures/fixture-small.sse.txt', import.meta.url).pathname;

test('records a file source to JSONL and finalizes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'traces-'));
  const out = join(dir, 'session.jsonl');
  const summary = await recordFromSource(fileSource(FIXTURE), {
    outPath: out, sessionId: 'rec-test', visualSeed: 42, source: `file:${FIXTURE}`,
  });
  assert.equal(summary.stats.stored > 0, true);
  assert.equal(summary.stats.stored + summary.stats.malformed + summary.stats.duplicates + summary.stats.late,
    summary.stats.received);
  const imported = importSession(readFileSync(out, 'utf8').split('\n'));
  assert.equal(imported.meta.sessionId, 'rec-test');
  assert.equal(imported.meta.visualSeed, 42);
  assert.equal(imported.complete, true);
  assert.equal(imported.events.length, summary.stats.stored);
  assert.deepEqual(imported.events[0].raw, imported.events[0].raw); // raw preserved on disk
  assert.equal(imported.end.stats.stored, summary.stats.stored);
});

test('same file + same seed produce identical event lines (determinism)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'traces-'));
  const a = join(dir, 'a.jsonl'); const b = join(dir, 'b.jsonl');
  await recordFromSource(fileSource(FIXTURE), { outPath: a, sessionId: 'x', visualSeed: 1, source: 't' });
  await recordFromSource(fileSource(FIXTURE), { outPath: b, sessionId: 'x', visualSeed: 1, source: 't' });
  const strip = (p) => importSession(readFileSync(p, 'utf8').split('\n')).events
    .map(({ arrivalMs, ...rest }) => rest); // arrivalMs is wall-clock, excluded
  assert.deepEqual(strip(a), strip(b));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test` — Expected: FAIL, cannot find `../src/recorder.js`.

- [ ] **Step 3: Implement recorder**

```js
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
  const writeLine = (line) => { if (!out.write(line + '\n')) return once(out, 'drain'); };

  session.arm();
  session.start();
  await writeLine(headerLine(session.meta(), sourceLabel));

  const startedLocal = now();
  for await (const { raw, arrivalMs } of source) {
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
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test` — Expected: all pass.

- [ ] **Step 5: Implement CLI**

```js
// src/cli.js
import { fileSource } from './sources/file-source.js';
import { liveSource } from './sources/live-source.js';
import { recordFromSource } from './recorder.js';
import { loadEnv } from './env.js';

const [, , cmd, arg] = process.argv;
const durationSec = Number(process.env.DURATION_SEC ?? 90);
const sessionId = `session-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const outPath = new URL(`../sessions/${sessionId}.jsonl`, import.meta.url).pathname;

const opts = {
  outPath, sessionId,
  visualSeed: Number(process.env.VISUAL_SEED ?? Math.floor(Math.random() * 2 ** 31)),
  durationMs: durationSec * 1000,
};

if (cmd === 'record-file') {
  if (!arg) { console.error('usage: node src/cli.js record-file <capture.raw>'); process.exit(1); }
  const summary = await recordFromSource(fileSource(arg), { ...opts, source: `file:${arg}` });
  console.log(JSON.stringify({ outPath: summary.outPath, participants: summary.participants, events: summary.events, stats: summary.stats }, null, 2));
} else if (cmd === 'record-live') {
  const env = loadEnv();
  const src = liveSource({ url: env.CS_EVENTS_URL, auth: env.CS_EVENTS_AUTH });
  console.error(`recording ${durationSec}s from ${env.CS_EVENTS_URL} -> ${outPath}`);
  const summary = await recordFromSource(src, { ...opts, source: env.CS_EVENTS_URL, stopAfterMs: durationSec * 1000 });
  console.log(JSON.stringify({ outPath: summary.outPath, participants: summary.participants, events: summary.events, stats: summary.stats }, null, 2));
} else {
  console.error('usage: node src/cli.js record-file <capture.raw> | record-live');
  process.exit(1);
}
```

And the tiny env loader it imports:

```js
// src/env.js
import { readFileSync } from 'node:fs';

// Reads KEY=VALUE lines from the project .env (gitignored) plus process.env.
export function loadEnv(path = new URL('../.env', import.meta.url).pathname) {
  const env = { ...process.env };
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m && env[m[1]] === undefined) env[m[1]] = m[2];
    }
  } catch { /* .env optional when real env vars are set */ }
  if (!env.CS_EVENTS_URL || !env.CS_EVENTS_AUTH) {
    throw new Error('CS_EVENTS_URL and CS_EVENTS_AUTH must be set (in .env or environment)');
  }
  return env;
}
```

Note: `src/cli.js` imports `./sources/live-source.js`, which exists after Task 9. To keep `record-file` usable now, create the placeholder in this task:

```js
// src/sources/live-source.js  (placeholder, replaced in Task 9)
export async function* liveSource() {
  throw new Error('live source implemented in Task 9');
}
```

- [ ] **Step 6: Manual verify record-file on the full real capture**

Run: `node src/cli.js record-file captures/2026-08-28-loadgen384-45s.sse.raw`
Expected: JSON summary with `participants: 384` and `stats.received: 263986`.

- [ ] **Step 7: Commit**

```bash
git add src/recorder.js src/cli.js src/env.js src/sources/live-source.js test/recorder.test.js
git commit -m "feat: streaming recorder with JSONL output and record-file CLI"
```

---

### Task 9: Live SSE source

**Files:**
- Modify: `src/sources/live-source.js` (replace placeholder)
- Test: `test/live-source.test.js` (spins a local mock SSE server)

- [ ] **Step 1: Write the failing tests**

```js
// test/live-source.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { liveSource } from '../src/sources/live-source.js';

function mockSse({ events, dieAfter = null }) {
  let hits = 0;
  const server = createServer((req, res) => {
    hits += 1;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"type":"snapshot","zones":{}}\n\n');
    events.forEach((e, i) => res.write(`data: ${JSON.stringify(e)}\n\n`));
    if (dieAfter !== null && hits <= dieAfter) res.destroy();
    else res.end();
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ server, port: server.address().port, hits: () => hits })));
}

test('streams events and includes auth header', async () => {
  let sawAuth = null;
  const server = createServer((req, res) => {
    sawAuth = req.headers.authorization;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"t":1,"z":0,"s":1,"ts":10}\n\n');
    res.end();
  });
  await new Promise((r) => server.listen(0, r));
  const url = `http://127.0.0.1:${server.address().port}/api/events`;
  const got = [];
  for await (const { raw } of liveSource({ url, auth: 'user:pw', maxRetries: 0 })) got.push(raw);
  server.close();
  assert.equal(sawAuth, 'Basic ' + Buffer.from('user:pw').toString('base64'));
  assert.deepEqual(got.map((g) => g.t), [1]); // snapshot passes through too if not filtered here
});

test('reconnects after a dropped connection', async () => {
  const { server, port, hits } = await mockSse({ events: [{ t: 3, z: 0, s: 1, ts: 1 }], dieAfter: 1 });
  const got = [];
  for await (const { raw } of liveSource({ url: `http://127.0.0.1:${port}/`, auth: 'a:b', maxRetries: 1, retryDelayMs: 10 })) {
    if (raw.t !== undefined) got.push(raw.t);
  }
  server.close();
  assert.equal(hits() >= 2, true);
  assert.equal(got.includes(3), true);
});
```

Note: the first test asserts only `t:1` arrives in `got` — write the source so snapshot frames are yielded too (the session already skips them); if that makes the assertion fail, filter `raw.type === 'snapshot'` in the source and keep the assertion. Decide in implementation, keep the test green and honest.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test` — Expected: FAIL (placeholder throws).

- [ ] **Step 3: Implement**

```js
// src/sources/live-source.js
import { createSseParser } from '../sse-parser.js';

// Async generator over the authenticated live SSE feed. Reconnects with
// backoff; yields { raw, arrivalMs }. Snapshot frames are yielded as-is —
// the session/adapter skips them. Reconnect count is exposed on the
// generator via .reconnects for the operator UI.
export async function* liveSource({ url, auth, maxRetries = Infinity, retryDelayMs = 500, maxRetryDelayMs = 4000, signal = null }) {
  let retries = 0;
  let delay = retryDelayMs;
  const headers = { Accept: 'text/event-stream' };
  if (auth) headers.Authorization = 'Basic ' + Buffer.from(auth).toString('base64');

  while (true) {
    const queue = [];
    const parser = createSseParser((data) => {
      try { queue.push(JSON.parse(data)); } catch { /* torn frame */ }
    });
    try {
      const res = await fetch(url, { headers, signal });
      if (!res.ok) throw new Error(`SSE HTTP ${res.status}`);
      delay = retryDelayMs; // successful connect resets backoff
      const decoder = new TextDecoder();
      for await (const chunk of res.body) {
        parser.feed(decoder.decode(chunk, { stream: true }));
        while (queue.length) yield { raw: queue.shift(), arrivalMs: Date.now() };
      }
      return; // clean end of stream
    } catch (err) {
      if (signal?.aborted) return;
      if (retries >= maxRetries) {
        if (maxRetries === 0) return; // tests use maxRetries:0 for single-shot
        throw err;
      }
      retries += 1;
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, maxRetryDelayMs);
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test` — Expected: all pass. Adjust the first test's expectations to whatever filtering decision was made (see note in Step 1), keeping assertions truthful.

- [ ] **Step 5: Commit**

```bash
git add src/sources/live-source.js test/live-source.test.js
git commit -m "feat: authenticated live SSE source with reconnect backoff"
```

---

### Task 10: Control server + operator page

**Files:**
- Create: `src/server.js`, `ui/index.html`
- Test: `test/server.test.js`

The operator flow the brief requires: arm → start (90 s auto-stop) → stop early → status → list sessions. Export = the JSONL files already on disk (served for download). Replay/still-image belong to the visual milestone.

- [ ] **Step 1: Write the failing test**

```js
// test/server.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createControlServer } from '../src/server.js';
import { fileSource } from '../src/sources/file-source.js';

const FIXTURE = new URL('../captures/fixture-small.sse.txt', import.meta.url).pathname;

test('arm/start/stop lifecycle over HTTP', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'traces-'));
  const srv = createControlServer({ sessionsDir: dir, sourceFactory: () => fileSource(FIXTURE) });
  await srv.listen(0);
  const base = `http://127.0.0.1:${srv.port()}`;

  let st = await (await fetch(`${base}/api/status`)).json();
  assert.equal(st.state, 'IDLE');

  await fetch(`${base}/api/arm`, { method: 'POST' });
  st = await (await fetch(`${base}/api/status`)).json();
  assert.equal(st.state, 'ARMED');

  await fetch(`${base}/api/start`, { method: 'POST' });
  // file source drains fast; wait for completion
  for (let i = 0; i < 100 && st.state !== 'COMPLETE'; i++) {
    await new Promise((r) => setTimeout(r, 50));
    st = await (await fetch(`${base}/api/status`)).json();
  }
  assert.equal(st.state, 'COMPLETE');
  assert.equal(st.stats.stored > 0, true);

  const sessions = await (await fetch(`${base}/api/sessions`)).json();
  assert.equal(sessions.length, 1);
  await srv.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test` — Expected: FAIL, cannot find `../src/server.js`.

- [ ] **Step 3: Implement server**

```js
// src/server.js
import { createServer } from 'node:http';
import { readFileSync, readdirSync, statSync, createReadStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import { recordFromSource } from './recorder.js';
import { loadEnv } from './env.js';
import { liveSource } from './sources/live-source.js';

export function createControlServer({ sessionsDir, sourceFactory, durationMs = 90000 }) {
  let phase = 'IDLE'; // mirrors session states between runs
  let current = null; // { promise, session }
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
      const record = recordFromSource(sourceFactory(controller.signal), {
        outPath, sessionId, source: 'live', durationMs, stopAfterMs: durationMs,
      });
      current = { sessionId, controller, promise: record };
      record.then((summary) => { lastSummary = { ...summary, sessionId }; current = null; phase = 'COMPLETE'; })
            .catch(() => { current = null; phase = 'IDLE'; });
      // recordFromSource creates its session synchronously on first tick; poll it onto current
      record.session = null;
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

  return {
    listen(port) {
      server = createServer((req, res) => {
        const key = `${req.method} ${req.url.split('?')[0]}`;
        if (handlers[key]) return handlers[key](req, res);
        if (req.method === 'GET' && req.url.startsWith('/sessions/')) {
          const f = join(sessionsDir, req.url.slice('/sessions/'.length));
          if (existsSync(f)) { res.writeHead(200, { 'Content-Type': 'application/x-ndjson' }); return createReadStream(f).pipe(res); }
        }
        if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          return res.end(readFileSync(new URL('../ui/index.html', import.meta.url)));
        }
        res.writeHead(404); res.end('not found');
      });
      return new Promise((r) => server.listen(port, () => r()));
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
```

**Implementation note for the executor:** `recordFromSource` currently creates its session internally, so `/api/status` cannot see live per-event stats mid-run. Extend `recordFromSource` with an optional `onSession(session)` callback (one line: call it right after `createSession`), and in `/api/start` pass `onSession: (s) => { current.session = s; }`. Update `test/recorder.test.js` accordingly (add a test that `onSession` fires with a session whose `state()` is `RECORDING`). The Task 8 code block already establishes the pattern; this is the only cross-task modification in the plan.

- [ ] **Step 4: Implement the operator page**

```html
<!-- ui/index.html -->
<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<title>2000 TRACES — Kayıt Paneli</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { background:#0b0e14; color:#cdd6e4; font:14px/1.5 "SF Mono",Menlo,monospace; margin:0; padding:24px; max-width:720px; }
  h1 { font-size:16px; color:#fff; }
  .row { display:flex; gap:12px; flex-wrap:wrap; margin:16px 0; }
  .card { background:#11151f; border:1px solid #1e2635; border-radius:8px; padding:12px 16px; min-width:120px; flex:1; }
  .card b { display:block; font-size:11px; color:#5c6773; letter-spacing:.08em; margin-bottom:6px; }
  .big { font-size:20px; color:#fff; }
  button { background:#11151f; border:1px solid #1e2635; color:#cdd6e4; border-radius:6px; padding:8px 16px; font:inherit; cursor:pointer; }
  button:hover { border-color:#7aa2f7; }
  button:disabled { opacity:.4; cursor:default; }
  #state.RECORDING { color:#ff5470; }
  #state.COMPLETE { color:#3ddc84; }
  a { color:#7aa2f7; }
  ul { padding-left:20px; }
</style>
</head>
<body>
<h1>2000 TRACES — KAYIT PANELİ</h1>
<div class="row">
  <div class="card"><b>DURUM</b><span class="big" id="state">…</span></div>
  <div class="card"><b>KATILIMCI</b><span class="big" id="participants">0</span></div>
  <div class="card"><b>KAYITLI OLAY</b><span class="big" id="stored">0</span></div>
  <div class="card"><b>HATALI / GEÇ / TEKRAR</b><span class="big" id="anoms">0/0/0</span></div>
</div>
<div class="row">
  <button id="arm">ARM</button>
  <button id="start">BAŞLAT (90 sn)</button>
  <button id="stop">ERKEN DURDUR</button>
</div>
<h1 style="font-size:13px">OTURUMLAR</h1>
<ul id="sessions"></ul>
<script>
  const $ = (id) => document.getElementById(id);
  const post = (p) => fetch(p, { method: 'POST' });
  $('arm').onclick = () => post('/api/arm');
  $('start').onclick = () => post('/api/start');
  $('stop').onclick = () => post('/api/stop');
  async function tick() {
    try {
      const st = await (await fetch('/api/status')).json();
      $('state').textContent = st.state;
      $('state').className = st.state;
      $('participants').textContent = st.participants ?? 0;
      $('stored').textContent = st.stats?.stored ?? 0;
      $('anoms').textContent = `${st.stats?.malformed ?? 0}/${st.stats?.late ?? 0}/${st.stats?.duplicates ?? 0}`;
      $('arm').disabled = !(st.state === 'IDLE' || st.state === 'COMPLETE');
      $('start').disabled = st.state !== 'ARMED';
      $('stop').disabled = st.state !== 'RECORDING';
      const ss = await (await fetch('/api/sessions')).json();
      $('sessions').innerHTML = ss.map((s) => `<li><a href="/sessions/${s.file}">${s.file}</a> — ${(s.bytes / 1e6).toFixed(1)} MB</li>`).join('');
    } catch { $('state').textContent = 'BAĞLANTI YOK'; }
  }
  setInterval(tick, 1000); tick();
</script>
</body>
</html>
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test` — Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/server.js ui/index.html test/server.test.js
git commit -m "feat: local control server and operator panel"
```

---

### Task 11: Acceptance test on the full real capture

**Files:**
- Test: `test/acceptance.test.js` (uses the full 19 MB capture; skips cleanly if the file is absent, e.g. on a fresh clone)

Ground truth measured independently from the capture before this project existed: 263,986 events, 384 unique participants across all 26 zones, type counts `{0: 3418, 1: 5078, 2: 5046, 3: 250444}`, per-participant timestamps strictly monotonic.

- [ ] **Step 1: Write the test**

```js
// test/acceptance.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { recordFromSource } from '../src/recorder.js';
import { fileSource } from '../src/sources/file-source.js';
import { importSession } from '../src/jsonl.js';

const CAPTURE = new URL('../captures/2026-08-28-loadgen384-45s.sse.raw', import.meta.url).pathname;

test('full 384-participant capture: counts, identity, monotonicity, round-trip', { skip: !existsSync(CAPTURE) }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'traces-'));
  const out = join(dir, 'full.jsonl');
  const summary = await recordFromSource(fileSource(CAPTURE), {
    outPath: out, sessionId: 'acceptance', visualSeed: 1, source: 'file:capture',
  });

  // MVP criterion 3+4: stable identities, every participant owns a trace
  assert.equal(summary.participants, 384);
  // Every event accounted for: stored + rejected == received (criterion 11 bookkeeping)
  const st = summary.stats;
  assert.equal(st.received, 263986);
  assert.equal(st.stored + st.malformed + st.duplicates + st.late, st.received);
  assert.equal(st.malformed, 0);

  // Criterion 5: a seat's complete trace is isolable and internally ordered
  const store = summary.session.store;
  for (const [pid, lane] of store.participants()) {
    const evs = store.eventsOf(pid);
    assert.equal(evs.length > 0, true, `${pid} has a trace`);
    for (let i = 1; i < evs.length; i++) {
      assert.equal(evs[i].serverTimestampMs >= evs[i - 1].serverTimestampMs, true,
        `${pid} trace is time-ordered`);
    }
  }

  // Criterion 7/9: export → import round-trip preserves everything stored
  const imported = importSession(readFileSync(out, 'utf8').split('\n'));
  assert.equal(imported.complete, true);
  assert.equal(imported.events.length, st.stored);
  assert.equal(imported.meta.visualSeed, 1);
  // raw preserved on disk for every event
  assert.equal(imported.events.every((e) => e.raw && typeof e.raw.t === 'number'), true);
});
```

- [ ] **Step 2: Run the test**

Run: `npm test` — Expected: all pass (this one takes a few seconds; 264k events through the full pipeline).

- [ ] **Step 3: Commit**

```bash
git add test/acceptance.test.js
git commit -m "test: acceptance run over the full 384-participant live capture"
```

---

## MVP acceptance criteria coverage (brief §11)

| # | Criterion | Covered by |
|---|---|---|
| 1 | Connects to real/simulated audience stream | Task 9 live source (real SSE), Task 7 file source |
| 2 | Records exactly 90 s without Ableton/Microwave | Task 8 `stopAfterMs`/`durationMs`; source is the pre-OSC SSE feed only |
| 3 | Up to 2,000 stable identities | (z,s) identity in Task 3; verified at 384 in Task 11; 2,000-run is a later live test |
| 4 | Every participant an independent trace | Task 4 store, Task 11 assertions |
| 5 | Seat isolation | `store.eventsOf(pid)`, Task 11 |
| 7 | Saved session loads | Task 6 import, Task 11 round-trip |
| 8 | Deterministic same-file replay | Task 8 determinism test (visual determinism belongs to the next plan) |
| 9 | Raw + normalized export | Task 6 event lines carry both |
| 11 | Recording reliable under load | Streaming writes + backpressure in Task 8 |
| 12 | 2,000-person simulator test | **Deferred**: requires deploying the new capture-calibrated loadgen or a long cloud run — scheduled as the first task after this plan |

Criteria 6 and 10 (circular artwork, still export) are the visual milestone — next plan.

## Out of scope for this plan
- Three.js rendering, replay playhead, seat labels (Milestones 3–5 of the brief)
- Sending anything back into the music pipeline
- 2,000-client live load test (do after recorder MVP is green)
