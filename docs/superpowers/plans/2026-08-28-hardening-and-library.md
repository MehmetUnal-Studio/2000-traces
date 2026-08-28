# 2000 TRACES — Hardening + Recording Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax. Task text references finding indices `[N]` — full details (file, line, scenario, corrected_fix) live in `docs/findings-2026-08-28.json`; ALWAYS read the referenced entries before implementing.

**Goal:** Fix all 46 confirmed findings from the 2026-08-28 bug hunt and add the recording library (list / pack / DELETE sessions and packs), reconnect-safe live recording, auto-attach, live seat isolation and take labels.

**Architecture:** No structural changes — targeted fixes in `src/` (recorder pipeline + control server) and `viz/src/` (viewer), plus one new server API surface (`/api/library`, `POST /api/pack`, `DELETE /api/packs/*`, `DELETE /api/sessions/*`) and one new viz panel (KÜTÜPHANE). Every server-side change gets a node test; viz changes get code-level review plus a scripted browser pass run by the controller afterwards.

**Tech stack:** unchanged (Node 22 ESM zero-dep server; Vite + three r185 viewer; `npm test` = `node --test test/*.test.js`, currently 41 green).

**Rules for every task:**
- Read `docs/findings-2026-08-28.json` entries listed for the task FIRST; implement the `corrected_fix` when present, else `fix_sketch`, adapting only where the code has moved.
- TDD for anything node-testable: failing test → implement → green. Viz-only changes: implement + make sure `npm test` stays green.
- The 90 s live recording is a one-shot show artifact — when in doubt, choose the behavior that never loses or truncates a take.
- Keep Turkish UI copy consistent with the existing style (lowercase labels, ASCII UI chrome).
- Commit per task with a descriptive message + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- `tmp-repro/` contains the hunt's repro scripts — you may reuse them for tests but do not commit them; Task 1 adds it to .gitignore.

---

### Task 1: Stream sources — never lose a live take

**Findings:** [3]/[7] clean upstream close must reconnect (CONFIRMED critical, repro exists in `tmp-repro/`), [43] backoff sleep ignores abort signal, [25] permanent 401/403 retried forever with zero diagnostics + token-over-auth silent precedence, [42] CRLF .env loads zero variables.

**Files:** `src/sources/live-source.js`, `src/env.js`, tests in `test/live-source.test.js`, `test/env.test.js` (new).

- [x] Step 1: Add failing tests: (a) mock SSE server that sends 2 events then `res.end()` cleanly — `liveSource` with `maxRetries: 2` must reconnect and yield events from the second connection; (b) abort during backoff sleep resolves promptly (< ~200 ms, not after maxRetryDelayMs); (c) HTTP 401 twice → generator throws an error mentioning auth/401 instead of retrying forever (design: 401/403 responses do NOT count as transient — retry once, then throw); (d) `loadEnv` parses a CRLF-formatted .env file.
- [x] Step 2: Implement: clean end-of-stream returns only when `signal?.aborted` or `maxRetries === 0`; otherwise it goes through the same retry/backoff path as errors. Reset `retries` (not just delay) after a successful connect that yielded at least one chunk. Backoff sleep listens to `signal` ('abort' event clears the timer). 401/403: retry once then throw `Error('SSE auth failed (HTTP 401): check CS_EVENTS_AUTH / CS_EVENTS_TOKEN')`. When BOTH auth and token are provided, `console.warn` once that token wins. env.js: strip `\r` per line.
- [x] Step 3: `npm test` green; commit `fix(sources): reconnect on clean close, abortable backoff, auth failure surfacing, CRLF env`.
- [x] Step 4: Add `tmp-repro/` to `.gitignore`.

### Task 2: Session/recorder/packer data integrity

**Findings:** [6] negative tMs accepted then packSession crashes (repro in hunt), [24] `cli.js record-live` hangs forever on a silent feed (no wall-clock abort), [22] torn last JSONL line crashes packSession/importSession, [23] disconnect closes only finger 0's stroke, [41] index.json non-atomic concurrent write.

**Files:** `src/session.js`, `src/cli.js`, `src/jsonl.js`, `src/viz-pack.js`; tests in `test/session.test.js`, `test/jsonl.test.js`, `test/viz-pack.test.js`.

- [x] Step 1: Failing tests: (a) session ingest of an event whose ts precedes the anchor → rejected, counted in a new `early` stat, stats invariant updated; (b) importSession and packSession over a file whose last line is `{"kind":"event","tru` → parse succeeds, torn line skipped, counted/reported; (c) a lane with strokes open on fingers 0 AND 1 receiving `disconnect` → both strokes closed at the disconnect tMs; (d) index.json write is via temp-file + rename (assert no `.tmp`残 left and content correct after two sequential packs).
- [x] Step 2: Implement each. For (a) keep the change minimal: `if (tMs < 0) { stats.early += 1; return { accepted:false, reason:'before-anchor' } }` and add `early: 0` to stats init + endLine summary. For (c): on disconnect, close ALL open strokes of that lane (iterate the `open` map), not just `finger ?? 0`.
- [x] Step 3: cli.js record-live: create an AbortController, pass `signal` into liveSource, `setTimeout(abort, durationMs + 5000)` cleared on completion — mirrors server.js's killer. (Landed early in `a569fee` with its own test in `test/cli.test.js`; verified green here.)
- [x] Step 4: `npm test` green; commit `fix(data): early-event guard, torn-line tolerance, multi-finger disconnect, atomic index, cli wall-clock stop`.

### Task 3: Control server correctness

**Findings:** [9] packSession failure reported as 'recording failed' (successful take shown as lost), [10] lastSummary pins the whole in-memory session store, [11] one stalled /api/live client can wedge broadcast (no backpressure/cap), [12] pendingBatch never reset at session boundaries, [29] failed recording invisible in /api/status (no error field, stale stats), [30] FINALIZING reports previous session's identity, [31] ARMED cannot be disarmed, and clear `latestRoster` on /api/start (server half of [4]/[8]).

**Files:** `src/server.js`; tests in `test/server.test.js`.

- [ ] Step 1: Failing tests: (a) sourceFactory that throws after 1 event → status becomes `{state:'IDLE', lastError:...}` and live clients receive `{kind:'state', state:'IDLE', error}`; stats in status must NOT show the previous take's numbers (null them); (b) packsDir pointing at an unwritable path (e.g. a FILE named as the dir) → recording still COMPLETE, status carries `packError`, packName null; (c) POST /api/arm twice → second returns to IDLE (disarm toggle) and broadcasts; (d) second recording's hello/roster does not contain the first recording's roster (start clears it); (e) pendingBatch from take 1 (no clients connected) does not leak into take 2's first batch.
- [ ] Step 2: Implement: separate try/catch around packSession inside the .then; `const { session, ...persistable } = summary; lastSummary = { ...persistable, sessionId, packName }` (drop the live session object — keep `stats/participants/events` fields only); `lastError` variable exposed in status and cleared on start; FINALIZING keeps `finalizingSessionId` for status; `/api/arm` from ARMED → IDLE; on start: `latestRoster = null; pendingBatch = []`; broadcast(): skip-and-destroy any client whose `res.writableLength > 4 * 1024 * 1024` (add a small unit test with a mocked res object if a socket-level test is impractical).
- [ ] Step 3: `npm test` green; commit `fix(server): honest failure states, memory release, hub backpressure, roster/batch session boundaries, disarm`.

### Task 4: Library API — list, pack, delete

**Feature F1 (user request: "record etmek ve istediğimi silmek istiyorum").**

**Files:** `src/server.js` (+ small helper `src/library.js` if cleaner); tests in `test/library.test.js` (new).

- [ ] Step 1: Failing tests for `GET /api/library`: returns `{ sessions:[{file, bytes, mtimeMs, sessionId, label, complete, events, participants, packName}], packs:[{name, sessionId, label, lanes, events, strokes, bytes}] }`. Session metadata comes from reading ONLY the first line (header) and the last ~8 KB (end record if present) of each JSONL — never the whole file (they reach 700 MB). `packName` joined via packs index sessionId.
- [ ] Step 2: Failing tests for `POST /api/pack` body `{file}`: packs an existing session into packsDir (name `kayit-<sessionId>` — same rule as auto-pack), updates index, returns `{ok, packName}`; 409 if that file is the actively-recording session; 404 unknown file; body validated (plain object, string file, no path separators).
- [ ] Step 3: Failing tests for `DELETE /api/sessions/<file>` and `DELETE /api/packs/<name>`: happy path removes from disk (pack dir removed recursively, index.json entry removed); active recording's file → 409; name with `/`, `\`, `..`, `%2e%2e`, null byte → 400/404 and NOTHING outside the target dir is touched (test with a canary file); deleting a pack that a session references leaves the session intact and library shows packName null afterwards.
- [ ] Step 4: Implement all three surfaces with the same path-safety helper style as `sessionFilePath` (single shared helper `safeChildPath(dir, name)`). Deletion uses `fs.rmSync(p, { recursive: true, force: false })` for packs and `unlinkSync` for sessions.
- [ ] Step 5: `npm test` green; commit `feat(server): library API — list sessions/packs, pack on demand, safe delete`.

### Task 5: Take labels + start body

**Feature F5.** `POST /api/start` accepts optional JSON body `{label}` (≤ 40 chars, stripped to `[\p{L}\p{N} _-]`, may be empty). Label flows: recorder → session header meta (`label`) → JSONL → packSession manifest + index entry → `/api/library` rows → hello/state broadcasts.

**Files:** `src/server.js`, `src/session.js` (meta passthrough), `src/recorder.js` (opts.label → createSession), `src/viz-pack.js` (manifest.label + index entry), tests in existing files.

- [ ] Step 1: Failing tests: start with `{label:'prova 1'}` → session JSONL header has `label:'prova 1'`; packed manifest and index entry carry it; `/api/library` session row shows it; a hostile label (`'<script>x'`, 200 chars) is sanitized/truncated.
- [ ] Step 2: Implement; `npm test` green; commit `feat: take labels through the whole pipeline`.

### Task 6: Viz core — live mode robustness

**Findings:** [0]/[16] switchPack reentrancy (token guard), [14]/[28] KAYIT double-click re-entrancy (`recPending` set synchronously), [15] unchecked stop/start responses, [13]/[21]/[26] server death mid-live bricks the page (es.onerror + a 5 s `/api/status` watchdog during live; teardown with a clear message; do NOT dispose the current pack until the server confirms RECORDING — restructure startRecording order: status → ES connect → arm/start → on RECORDING state clear stage and build), [4]-viz half: use hello roster ONLY when attaching to an already-RECORDING session; for a new take wait for the fresh roster broadcast, [27]/[32] frame loop overwrites '■ DURDURULUYOR…' every frame (add `live.stopping` flag the frame loop respects), [35] empty-take message overwritten by auto-switch (set the message AFTER switchPack resolves), [33] remove FALLBACK_PACKS; empty library boots into a "henüz kayıt yok — ● KAYIT ile başla" idle state without errors, [2]/[40] Space/Enter must never stop a take: all HUD buttons blur on click, Space is always preventDefault'ed (toggles transport only in pack mode), [45] seat panel: honest breakdown (`N olay = nota + hareket + yaşam döngüsü` lines listed separately).

**Files:** `viz/src/main.js`, `viz/src/hud.js`; no node tests (viz), but `npm test` must stay green.

- [ ] Step 1: Implement the startRecording/state-machine restructure exactly as described (order: probe status → open ES → hello → arm+start (response-checked) → `state:RECORDING` → clear stage, build disc from fresh roster; attach path: hello.state===RECORDING → build immediately from hello.roster).
- [ ] Step 2: Implement the rest of the listed fixes.
- [ ] Step 3: `npm test` green (no regressions); commit `fix(viz): live-mode state machine, reentrancy guards, watchdog, keyboard safety, honest labels`.

### Task 7: Viz render/interaction fixes

**Findings:** [5] live-disc commit loses GPU ranges when called twice between renders (do not `clearUpdateRanges()` per commit — verify three r185's post-upload clearing in `node_modules/three/src/renderers/webgl/WebGLAttributes.js` and implement accordingly, with an `uploadedTo` fallback if three does not auto-clear), [37] fallback-roster spare lanes: use 256 spare when built without an upstream snapshot + surface skipped-overflow count in the rec stats line, [17] export point-size: replace the literal `8.0` clamp with `uPointMax` uniform (default 8, export sets `size/170`), [18]/[39] exportStill also forces `uReplaying=0` and playhead opacity 0 during the offscreen render (restore after), [36] pack-loader validates `response.ok` and `events.bin/strokes.bin` byteLength against manifest counts (throw a Turkish-readable error switchPack can show), [1] pickLane tolerance ≤ 0.6×laneWidth (update/extend the layout picking behavior consistently), [19] scene.js: accept only `button === 0`, reset drag on `pointercancel`/`lostpointercapture`/`blur`, [20]/[34]/[38]/[44] zone labels rebuild keyed on a zone-name signature (`bands.map(b=>b.zone+b.laneStart).join()`), not just count.

**Files:** `viz/src/live-disc.js`, `viz/src/export-still.js`, `viz/src/shaders.js`, `viz/src/disc.js`, `viz/src/pack-loader.js`, `viz/src/layout.js`, `viz/src/scene.js`, `viz/src/hud.js`.

- [ ] Step 1: Implement all; keep shader changes minimal and dual-used by disc + live-disc (shared uniforms object gains `uPointMax`).
- [ ] Step 2: `npm test` green; commit `fix(viz): GPU update ranges, export fidelity, loader validation, picking and pointer edge cases, label rebuilds`.

### Task 8: Library panel (KÜTÜPHANE) + auto-attach + live isolation

**Features F2, F3, F4.**

**Files:** `viz/src/main.js`, `viz/src/hud.js`, `viz/index.html` (styles), maybe `viz/src/library.js`.

- [ ] Step 1: KÜTÜPHANE button in the top panel toggles a right-side panel listing, from `GET /api/library` (RECORDER origin): each pack row → name/label, `lanes · events`, buttons `AÇ` (switchPack) and `SİL`; each un-packed session row → file, size, `PAKETLE` and `SİL`. `SİL` is two-step: first click turns the button into `EMİN MİSİN?` for 4 s, second click calls the DELETE endpoint. After any op: re-fetch library + packs index; if the currently-open pack was deleted, fall back to the first remaining pack or the empty state. Panel refresh also after every completed recording. Recorder offline → panel shows 'kayıt sunucusu kapalı (npm run panel)'.
- [ ] Step 2: Auto-attach: on boot, `GET /api/status`; if RECORDING → enter live mode attach path automatically (same code path as Task 6's attach).
- [ ] Step 3: Live isolation: clicking a lane during live sets `uSelLane` on the live disc (laneOf lookup via layout.pickLane); seat panel shows `pid` (compute zone letter + seat from the live layout's lane table — extend rosterLayout to return `laneMeta` array) and a live-updating event count; Esc / empty-click clears.
- [ ] Step 4: `npm test` green; commit `feat(viz): recording library with delete, auto-attach, live seat isolation`.

### Task 9: Docs + final sweep

- [ ] Step 1: Update `docs/superpowers/plans/` checkboxes; write `docs/OPERATOR.md`: nasıl kayıt alınır (panel + viz), kütüphane/silme, canlı izolasyon, ortam değişkenleri (AUTH vs TOKEN önceliği dahil), bilinen sınırlar.
- [ ] Step 2: Run the FULL suite; `git status` clean; commit `docs: operator guide`.

---

## Out of scope
- OSC remote record trigger, prova/replay auto-mode, seat-map venue ordering (future).
- Browser-level E2E: the controller (main session) runs it interactively after Task 9.
