// viz/src/main.js
import { loadPack, EVENT_RECORD_BYTES, TYPE } from './pack-loader.js';
import { buildLayout } from './layout.js';
import { buildDisc } from './disc.js';
import { createLiveDisc, rosterLayout } from './live-disc.js';
import { createScene } from './scene.js';
import { createTransport } from './transport.js';
import { createHud, updateZoneLabels } from './hud.js';
import { exportStill } from './export-still.js';

const RECORDER = 'http://127.0.0.1:8787';
const EMPTY_LIBRARY_MSG = 'henüz kayıt yok — ● KAYIT ile başla';

async function fetchPacks() {
  try {
    const r = await fetch('/packs/index.json');
    if (!r.ok) return [];
    // Vite's SPA fallback serves index.html with 200 for missing paths
    if (!(r.headers.get('content-type') ?? '').includes('json')) return [];
    const d = await r.json();
    return d?.packs?.length ? d.packs.map((p) => p.name) : [];
  } catch { return []; }
}

let PACKS = await fetchPacks();

const canvas = document.getElementById('c');
const view = createScene(canvas);

let current = null; // pack mode: { name, pack, layout, disc, transport }
let live = null;    // record mode: { es, disc, layout, laneOf, maxT, queue, durationMs, ... }
let recPending = false; // set synchronously on KAYIT click, before any await
let switchGen = 0;      // invalidates in-flight switchPack loads

const hud = createHud({
  packs: PACKS,
  onPack: (name) => switchPack(name),
  onPlayPause: () => {
    if (!current) return;
    const t = current.transport;
    t.playing ? t.pause() : t.play();
  },
  onSeek: (ms) => { if (current) { current.transport.pause(); current.transport.seek(ms); } },
  onSpeed: (s) => current?.transport.setSpeed(s),
  onFinal: () => current?.transport.toEnd(),
  onRestart: () => current?.transport.restart(),
  onExport: () => current && exportStill({
    renderer: view.renderer, scene: view.scene,
    uniforms: current.disc.uniforms, playheadMat: current.disc.playheadMat,
    sessionId: current.pack.manifest.sessionId,
  }),
  onFit: () => view.fit(),
  onDeselect: () => (live ? selectLive(null) : select(null)),
  onRecord: () => (live ? stopRecording() : startRecording()),
  onLibrary: () => toggleLibrary(),
});

// ------------------------------------------------------------------ library
function toggleLibrary() {
  const open = !hud.isLibraryOpen();
  hud.setLibraryOpen(open);
  if (open) refreshLibrary();
}

async function refreshLibrary() {
  if (!hud.isLibraryOpen()) return;
  let lib = null;
  try {
    const r = await fetch(`${RECORDER}/api/library`);
    if (!r.ok) throw new Error('library');
    lib = await r.json();
  } catch { /* recorder offline */ }
  if (!hud.isLibraryOpen()) return; // closed during the fetch
  if (!lib) { hud.renderLibrary({ offline: true }); return; }
  hud.renderLibrary(lib, {
    onOpen: (name) => switchPack(name),
    onDeletePack: (name) => libraryOp(
      () => fetch(`${RECORDER}/api/packs/${encodeURIComponent(name)}`, { method: 'DELETE' }),
      { deletedPack: name },
    ),
    onPackSession: (file) => libraryOp(() => fetch(`${RECORDER}/api/pack`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file }),
    })),
    onDeleteSession: (file) => libraryOp(
      () => fetch(`${RECORDER}/api/sessions/${encodeURIComponent(file)}`, { method: 'DELETE' }),
    ),
  });
}

// Run a library mutation, then re-sync everything that mirrors the disk:
// the packs dropdown, the panel, and — if the open pack just vanished — the
// stage (fall back to the first remaining pack or the empty state).
async function libraryOp(fn, { deletedPack = null } = {}) {
  let err = null;
  try {
    const r = await fn();
    if (!r.ok) {
      const body = await r.json().catch(() => null);
      err = body?.error ?? `HTTP ${r.status}`;
    }
  } catch { err = 'kayıt sunucusuna ulaşılamadı'; }
  PACKS = await fetchPacks();
  hud.setPacks(PACKS, current?.name && PACKS.includes(current.name) ? current.name : undefined);
  refreshLibrary();
  if (err) { hud.setStats(`işlem başarısız — ${err}`); return; }
  if (deletedPack && current?.name === deletedPack) {
    if (PACKS.length) await switchPack(PACKS[0], 'açık paket silindi');
    else {
      clearStage();
      hud.setPacks(PACKS);
      hud.setStats(`açık paket silindi · ${EMPTY_LIBRARY_MSG}`);
      hud.showSeat(null);
    }
  }
}

// ---------------------------------------------------------------- pack mode
function laneInfo(lane) {
  const { manifest } = current.pack;
  const p = manifest.participants[lane];
  const { events } = current.pack;
  let moves = 0; let notes = 0; let first = Infinity; let last = -Infinity;
  for (let i = p.o; i < p.o + p.n; i++) {
    const type = events.getUint8(i * EVENT_RECORD_BYTES + 10);
    const t = events.getUint32(i * EVENT_RECORD_BYTES + 6, true);
    if (type === TYPE.move) moves += 1;
    if (type === TYPE.noteOn) notes += 1;
    // active range over interaction records only — keepalives are not activity
    if (type === TYPE.move || type === TYPE.noteOn || type === TYPE.noteOff) {
      if (t < first) first = t;
      if (t > last) last = t;
    }
  }
  const lifecycle = p.n - notes - moves; // noteOff/keepalive/progress/disconnect
  return {
    title: `${p.p}`,
    meta: `zone <b>${p.z}</b> · koltuk <b>${p.s}</b> · lane ${p.l}<br>` +
      `${p.n} olay = ${notes} nota + ${moves} hareket + ${lifecycle} yaşam döngüsü<br>` +
      (notes + moves > 0
        ? `aktif: ${(first / 1000).toFixed(1)}s → ${(last / 1000).toFixed(1)}s`
        : 'sessiz'),
  };
}

function select(lane) {
  if (!current) return;
  current.disc.uniforms.uSelLane.value = lane === null ? -1 : lane;
  hud.showSeat(lane === null ? null : laneInfo(lane));
}

// Live isolation: selection keyed by (z,s), not lane index — a derived→
// genuine roster rebuild reshuffles lanes, and the pid must survive it.
function selectLive(lane) {
  if (!live?.disc) return;
  const meta = lane === null ? null : live.laneMeta?.[lane] ?? null;
  live.sel = meta ? { z: meta.zone, s: meta.seat, pid: meta.pid } : null;
  live.selShown = null; // force the seat panel refresh in the frame loop
  live.disc.uniforms.uSelLane.value = meta ? lane : -1;
  if (!meta) hud.showSeat(null);
}

// Re-resolve the (z,s) selection against a freshly built live disc.
function applyLiveSel() {
  if (!live?.sel || !live.disc) return;
  const lane = live.laneOf(live.sel.z, live.sel.s);
  live.disc.uniforms.uSelLane.value = lane === null ? -1 : lane;
  live.selShown = null;
}

view.onCanvasClick((x, y) => {
  if (live?.disc) { selectLive(live.layout.pickLane(x, y)); return; }
  if (!current) return;
  select(current.layout.pickLane(x, y));
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') (live ? selectLive(null) : select(null));
  if (e.key === ' ') {
    // Space must NEVER reach a focused button — during a live take it would
    // stop the one-shot recording. It toggles the transport in pack mode only.
    e.preventDefault();
    if (current && !live) {
      current.transport.playing ? current.transport.pause() : current.transport.play();
    }
  }
  if (e.key === 'f' || e.key === 'F') view.fit();
});

function clearStage() {
  if (current) { view.scene.remove(current.disc.group); current.disc.dispose(); current = null; }
}

async function switchPack(name, notice = null) {
  if (live || recPending) return; // recording owns the stage
  if (!name) { hud.setStats(EMPTY_LIBRARY_MSG); return; }
  const gen = ++switchGen; // any older in-flight load is now void
  clearStage();
  hud.setStats('yükleniyor…');
  const stale = () => gen !== switchGen || live || recPending;
  let pack;
  try {
    pack = await loadPack(name);
  } catch {
    await new Promise((r) => setTimeout(r, 600)); // dev server may be settling
    if (stale()) return;
    try { pack = await loadPack(name); }
    catch (err) {
      if (!stale()) hud.setStats(`paket yüklenemedi: ${name} — ${err?.message ?? err}`);
      return;
    }
  }
  if (stale()) return; // an overlapping switch/recording won — no GPU built yet
  const layout = buildLayout(pack.manifest);
  const disc = buildDisc(pack, layout);
  const transport = createTransport(pack.manifest.durationMs);
  view.scene.add(disc.group);
  current = { name, pack, layout, disc, transport };
  hud.setPack(name);
  hud.setDuration(pack.manifest.durationMs);
  hud.setStats(
    `${pack.manifest.laneCount} katılımcı · ${pack.manifest.eventCount.toLocaleString('tr-TR')} olay · ` +
    `${pack.manifest.strokeCount.toLocaleString('tr-TR')} vuruş · seed ${pack.manifest.visualSeed}` +
    (notice ? ` · ${notice}` : ''),
  );
  select(null);
}

// -------------------------------------------------------------- record mode
// Order of a fresh take: probe status → open ES → hello → arm+start
// (response-checked) → state:RECORDING → only THEN clear the stage and build
// the live disc from the fresh roster broadcast. The loaded pack is never
// disposed before the server confirms RECORDING.
async function startRecording() {
  if (live || recPending) return; // synchronous re-entry guard (double-click)
  recPending = true;
  ++switchGen; // void any in-flight pack load
  hud.setRecState('● BAĞLANIYOR…', true);
  let st;
  try {
    const r = await fetch(`${RECORDER}/api/status`);
    if (!r.ok) throw new Error('status');
    st = await r.json();
  } catch {
    recPending = false;
    hud.setRecState('● KAYIT', false);
    hud.setStats('kayıt sunucusu kapalı — önce çalıştır: npm run panel');
    return;
  }
  live = {
    es: null, disc: null, layout: null, laneOf: null, laneMeta: null, maxT: 0, queue: [],
    laneEvents: null,    // per-lane live event counts (seat panel)
    sel: null,           // isolated seat: { z, s, pid } — survives rebuilds
    selShown: null,      // last seat-panel snapshot (avoid innerHTML churn)
    durationMs: st.durationMs ?? 90000, visualSeed: null,
    started: false,      // server confirmed RECORDING for this take
    starting: false,     // arm/start handshake in flight
    stopping: false,     // '■ DURDURULUYOR…' owns the rec label
    cancelling: false,   // operator aborted before the take started
    rosterDerived: false, // disc layout came from the batch-derived fallback
    replayBuf: null,     // events kept for a rebuild while rosterDerived
    dropped: 0,          // events skipped because every spare lane was taken
    pendingRoster: null, // roster broadcast that arrived before state:RECORDING
    prevPack: current?.name ?? null,
    staleSince: null, failedProbes: 0, watchdog: null,
  };
  recPending = false; // `live` now carries the guard
  hud.setLiveMode(true);
  hud.setDuration(live.durationMs);
  hud.showSeat(null);
  const es = new EventSource(`${RECORDER}/api/live`);
  live.es = es;
  es.onopen = () => { if (live) { live.staleSince = null; } };
  es.onmessage = (m) => {
    if (!live) return;
    live.staleSince = null;
    handleLive(JSON.parse(m.data));
  };
  es.onerror = () => {
    // EventSource auto-reconnects; mark stale and let the watchdog decide.
    if (live && live.staleSince === null) live.staleSince = performance.now();
  };
  // Watchdog: a dead recorder must never brick the page mid-live.
  live.watchdog = setInterval(async () => {
    if (!live) return;
    try {
      const r = await fetch(`${RECORDER}/api/status`);
      if (!r.ok) throw new Error('status');
      if (live) live.failedProbes = 0;
    } catch {
      if (!live) return;
      live.failedProbes += 1;
      if (live.failedProbes >= 2) exitLive('kayıt sunucusuna ulaşılamadı — kayıt yarıda kesildi');
    }
  }, 5000);
}

// Arm (if needed) and start the take, verifying each response.
async function beginTake(helloState) {
  if (!live || live.starting || live.started) return;
  live.starting = true;
  try {
    if (live.cancelling) { exitLive(null); return; }
    if (helloState !== 'ARMED') {
      const r = await fetch(`${RECORDER}/api/arm`, { method: 'POST' });
      if (!r.ok) throw new Error('arm');
      if (!live) return;
      if (live.cancelling) { await disarmQuietly(); exitLive(null); return; }
    }
    const r2 = await fetch(`${RECORDER}/api/start`, { method: 'POST' });
    if (!r2.ok) throw new Error('start');
    // confirmation arrives as the RECORDING state broadcast
  } catch {
    // if RECORDING was confirmed meanwhile (start race), the take is running — keep it
    if (live && !live.started) exitLive('kayıt başlatılamadı — panele bak');
  } finally {
    if (live) live.starting = false;
  }
}

async function disarmQuietly() {
  // /api/arm toggles: a second arm while ARMED disarms. Best effort.
  try {
    const st = await (await fetch(`${RECORDER}/api/status`)).json();
    if (st.state === 'ARMED') await fetch(`${RECORDER}/api/arm`, { method: 'POST' });
  } catch { /* server unreachable — nothing to disarm */ }
}

async function stopRecording() {
  if (!live || live.stopping) return;
  live.stopping = true;
  hud.setRecState('■ DURDURULUYOR…', true);
  if (!live.started) live.cancelling = true; // suppress a pending arm/start
  let res = null;
  try { res = await fetch(`${RECORDER}/api/stop`, { method: 'POST' }); }
  catch { /* server unreachable */ }
  if (!live) return;
  if (res?.ok) {
    if (live.cancelling) return; // stop landed anyway; COMPLETE will follow
    return; // wait for FINALIZING/COMPLETE; the stopping flag holds the label
  }
  if (res && !res.ok && live.cancelling) {
    // 409: take not started yet — but a RECORDING broadcast may have landed
    // during the stop round-trip; stopRecordingConfirmed already re-sent the
    // stop, and exiting now would drop the coming COMPLETE (pack invisible).
    if (live.started) return;
    await disarmQuietly();
    if (!live) return;
    if (live.started) return; // RECORDING landed during the disarm round-trip
    exitLive(null);
    return;
  }
  if (res && !res.ok) {
    // mid-take refusal: the take may have just ended on its own (finalizing)
    try {
      const st = await (await fetch(`${RECORDER}/api/status`)).json();
      if (st.state === 'FINALIZING' || st.state === 'COMPLETE') {
        hud.setRecState('■ PAKETLENIYOR…', true);
        return; // COMPLETE broadcast will land shortly
      }
    } catch { /* fall through */ }
    exitLive('kayıt durdurulamadı — panele bak');
    return;
  }
  // fetch itself failed — could be a transient blip, not a dead server:
  // probe status once (the watchdog's standard of proof) before tearing down
  try {
    const st = await (await fetch(`${RECORDER}/api/status`)).json();
    if (!live) return;
    if (st.state === 'FINALIZING' || st.state === 'COMPLETE') {
      hud.setRecState('■ PAKETLENIYOR…', true);
      return; // COMPLETE broadcast will land shortly
    }
    if (st.state === 'RECORDING' || st.state === 'ARMED') {
      // server alive, stop lost in transit: retry once
      try {
        const r2 = await fetch(`${RECORDER}/api/stop`, { method: 'POST' });
        if (r2.ok || live?.cancelling) return; // COMPLETE follows / cancel flag holds
      } catch { /* fall through to teardown */ }
    }
  } catch { /* server really unreachable */ }
  if (!live) return;
  exitLive('sunucu yanıt vermiyor — canlı mod kapatıldı');
}

// Tear down live mode and put a pack back on the stage so the canvas never
// strands empty with a dropdown that cannot be re-selected.
function exitLive(err) {
  const prev = live?.prevPack ?? null;
  stopLiveUi(err);
  const name = prev ?? (PACKS.length ? PACKS[0] : null);
  if (name) switchPack(name, err ?? undefined);
  else if (!err) hud.setStats(EMPTY_LIBRARY_MSG);
}

function ensureLiveDisc(roster, { derived = false } = {}) {
  if (live.disc) return;
  // a derived roster covers only whoever acted in the first batches — give it
  // a far bigger spare band so latecomers are not silently invisible
  const spareLanes = derived ? 256 : 64;
  const { layout, laneOf, laneMeta, laneCount } = rosterLayout(roster, live.durationMs, buildLayout, spareLanes);
  live.layout = layout;
  live.laneOf = laneOf;
  live.laneMeta = laneMeta;
  live.laneEvents = new Uint32Array(laneCount);
  live.rosterDerived = derived;
  live.replayBuf = derived ? [] : null; // kept so a genuine roster can rebuild
  live.disc = createLiveDisc(layout, { visualSeed: live.visualSeed ?? 1 });
  view.scene.add(live.disc.group);
  applyLiveSel(); // a (z,s) isolation must survive the disc (re)build
  if (live.queue.length) processLiveEvents(live.queue.splice(0));
}

// A genuine roster after a derived fallback layout: rebuild and replay, so
// participants beyond the 64 spare lanes are not silently invisible.
function rebuildLiveDisc(roster) {
  const buf = live.replayBuf ?? [];
  view.scene.remove(live.disc.group);
  live.disc.dispose();
  live.disc = null;
  live.maxT = 0;
  live.dropped = 0; // genuine roster: previous overflow skips are replayed
  ensureLiveDisc(roster);
  if (buf.length) processLiveEvents(buf);
}

function processLiveEvents(events) {
  if (live.replayBuf) {
    live.replayBuf.push(...events);
    // no genuine roster in sight: stop buffering before memory becomes a risk
    if (live.replayBuf.length > 400000) { live.replayBuf = null; live.rosterDerived = false; }
  }
  for (const e of events) {
    if (e.t > live.maxT) live.maxT = e.t;
    const lane = live.laneOf(e.z, e.s);
    if (lane !== null) { live.disc.append(lane, e); live.laneEvents[lane] += 1; }
    else live.dropped += 1; // spare band full — surfaced in the rec stats line
  }
  live.disc.commit();
}

async function handleLive(msg) {
  if (!live) return;
  if (msg.kind === 'hello') {
    live.durationMs = msg.durationMs ?? live.durationMs;
    hud.setDuration(live.durationMs);
    if (msg.visualSeed) live.visualSeed = msg.visualSeed;
    if (msg.state === 'RECORDING') {
      // attaching to an already-running session: the hello roster is current
      live.started = true;
      clearStage();
      if (msg.roster?.length) ensureLiveDisc(msg.roster);
      hud.setRecState('■ KAYIT', true);
    } else if (live.started) {
      // reconnect hello after the recorder restarted mid-take: the take is gone
      if (msg.state === 'IDLE' || msg.state === 'COMPLETE') {
        exitLive('kayıt sunucusu yeniden başladı — kayıt kesildi');
      }
    } else {
      // fresh take: NEVER trust a hello roster outside RECORDING (may be stale)
      await beginTake(msg.state);
    }
  } else if (msg.kind === 'roster') {
    if (!live.started) {
      // pre-RECORDING roster: the pack disc still owns the stage — hold the
      // roster until the RECORDING confirmation clears the stage
      live.pendingRoster = msg.roster;
      return;
    }
    if (live.disc && live.rosterDerived) rebuildLiveDisc(msg.roster);
    else ensureLiveDisc(msg.roster);
  } else if (msg.kind === 'batch') {
    if (!live.started) return; // pre-take noise (should not happen)
    if (!live.disc) {
      live.queue.push(...msg.events);
      if (live.queue.length > 12000) {
        // no snapshot arrived; derive the roster from what we heard
        const seen = new Map();
        for (const e of live.queue) seen.set(`${e.z}${e.s}`, { z: e.z, s: e.s });
        ensureLiveDisc([...seen.values()], { derived: true });
      }
      return;
    }
    processLiveEvents(msg.events);
  } else if (msg.kind === 'state') {
    if (msg.state === 'RECORDING') {
      if (msg.visualSeed) live.visualSeed = msg.visualSeed;
      live.started = true;
      if (live.cancelling) { stopRecordingConfirmed(); return; }
      // server confirmed the take: NOW the stage belongs to the live disc
      clearStage();
      if (live.pendingRoster) {
        ensureLiveDisc(live.pendingRoster);
        live.pendingRoster = null;
      }
      hud.setRecState('■ KAYIT', true);
    } else if (msg.state === 'FINALIZING') {
      live.stopping = true;
      hud.setRecState('■ PAKETLENIYOR…', true);
    } else if (msg.state === 'COMPLETE') {
      const packName = msg.packName;
      stopLiveUi(null);
      if (!packName) {
        // empty take: keep the notice visible AFTER the auto-switch resolves
        if (PACKS.length) await switchPack(PACKS[0], 'kayıt boş kaldı — akışta hiç olay yoktu');
        else hud.setStats(`kayıt boş kaldı — akışta hiç olay yoktu · ${EMPTY_LIBRARY_MSG}`);
        refreshLibrary(); // the empty take still left a session file behind
        return;
      }
      PACKS = await fetchPacks();
      if (!PACKS.includes(packName)) PACKS.push(packName);
      hud.setPacks(PACKS, packName);
      await switchPack(packName);
      refreshLibrary(); // a finished take is new library content
    } else if (msg.state === 'IDLE' && msg.error) {
      exitLive('kayıt hatası — sunucu loguna bak');
    }
  }
}

// The operator cancelled but the take started anyway (stop lost the race):
// stop it now that the server is provably recording.
function stopRecordingConfirmed() {
  fetch(`${RECORDER}/api/stop`, { method: 'POST' }).catch(() => {});
  hud.setRecState('■ DURDURULUYOR…', true);
}

function stopLiveUi(err) {
  if (live?.watchdog) clearInterval(live.watchdog);
  live?.es?.close();
  if (live?.disc) { view.scene.remove(live.disc.group); live.disc.dispose(); }
  if (live?.sel) hud.showSeat(null); // a live isolation panel must not linger
  live = null;
  hud.setLiveMode(false);
  hud.setRecState('● KAYIT', false);
  if (err) hud.setStats(err);
}

// ------------------------------------------------------------------- render
const projectToScreen = (x, y) => {
  const cam = view.camera;
  const w = canvas.clientWidth || window.innerWidth;
  const h = canvas.clientHeight || window.innerHeight;
  const ndcX = ((x - cam.position.x) * cam.zoom) / (cam.right - cam.left) * 2;
  const ndcY = ((y - cam.position.y) * cam.zoom) / (cam.top - cam.bottom) * 2;
  return { x: (ndcX * 0.5 + 0.5) * w, y: (1 - (ndcY * 0.5 + 0.5)) * h, visible: Math.abs(ndcX) < 1.05 && Math.abs(ndcY) < 1.05 };
};

let prev = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(100, now - prev);
  prev = now;
  const px = view.pixelsPerWorldUnit();
  const devicePx = px * view.renderer.getPixelRatio();

  if (live?.disc) {
    const d = live.disc;
    d.uniforms.uTime.value = live.maxT;
    d.uniforms.uPointScale.value = devicePx;
    d.playheadMat.opacity = 0.55;
    d.playhead.rotation.z = -(2 * Math.PI * live.maxT) / live.durationMs;
    hud.setTime(live.maxT, true);
    if (live.sel) {
      // live-updating event count for the isolated seat, DOM-churn-free
      const lane = d.uniforms.uSelLane.value;
      const count = lane >= 0 ? live.laneEvents[lane] : 0;
      const snap = `${live.sel.pid}:${count}`;
      if (live.selShown !== snap) {
        live.selShown = snap;
        hud.showSeat({
          title: live.sel.pid,
          meta: `zone <b>${live.sel.z}</b> · koltuk <b>${live.sel.s}</b><br>` +
            `${count.toLocaleString('tr-TR')} olay · canlı`,
        });
      }
    }
    if (!live.stopping) {
      // '■ DURDURULUYOR…' / '■ PAKETLENIYOR…' own the label while stopping
      hud.setRecState(
        live.staleSince !== null
          ? '⚠ BAĞLANTI KOPTU — yeniden bağlanıyor'
          : `■ ${(live.maxT / 1000).toFixed(1)}s · ${d.grainCount().toLocaleString('tr-TR')} tane` +
            (live.dropped ? ` · ⚠ ${live.dropped.toLocaleString('tr-TR')} olay şerit dışı` : ''),
        true,
      );
    }
    updateZoneLabels(hud.labelLayer, live.layout, projectToScreen, px);
    view.renderer.render(view.scene, view.camera);
    return;
  }

  if (!current) return;
  const { disc, transport, layout } = current;
  transport.tick(dt);
  disc.uniforms.uTime.value = transport.time;
  disc.uniforms.uPointScale.value = devicePx;

  const replaying = transport.time < layout.durationMs;
  disc.uniforms.uReplaying.value = replaying ? 1 : 0;
  disc.playheadMat.opacity = replaying ? 0.55 : 0;
  disc.playhead.rotation.z = -(2 * Math.PI * transport.time) / layout.durationMs;

  hud.setTime(transport.time, transport.playing);
  updateZoneLabels(hud.labelLayer, layout, projectToScreen, px);
  view.renderer.render(view.scene, view.camera);
}

// Boot: if the recorder is already mid-take, auto-attach through the exact
// same path as a manual KAYIT press (startRecording probes status, opens the
// SSE tap, and the hello's state:RECORDING takes the attach branch).
async function boot() {
  requestAnimationFrame(frame); // frame() no-ops until a disc exists
  try {
    const r = await fetch(`${RECORDER}/api/status`);
    if (r.ok && (await r.json()).state === 'RECORDING') { startRecording(); return; }
  } catch { /* recorder offline: normal pack-mode boot */ }
  if (PACKS.length) await switchPack(PACKS[0]);
  else hud.setStats(EMPTY_LIBRARY_MSG); // fresh install: idle state, no errors
}
boot();

// debug hook for driving the app programmatically
import * as THREE from 'three';
window.__traces = {
  THREE,
  select, view, startRecording, stopRecording, stopLiveUi,
  get current() { return current; },
  get live() { return live; },
};
