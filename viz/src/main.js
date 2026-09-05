// viz/src/main.js
import { loadPack, EVENT_RECORD_BYTES, TYPE } from './pack-loader.js';
import { buildLayout, rosterLayout } from './layout.js';
import { createCover } from './cover.js';
import { createUdpReplayClient, replayErrorMessage } from './udp-replay-client.js';
import { DEFAULT_DURATION_MS } from '../../src/constants.js';
import { buildNebula } from './nebula.js';
import { createGestureReplay, readGesture } from './gesture-replay.js';
import { createLiveNebula } from './live-nebula.js';
import { createScene } from './scene.js';
import { createNebulaSpace } from './nebula-space.js';
import { createTransport } from './transport.js';
import { createHud } from './hud.js';
import { exportStill } from './export-still.js';
import { createDemoPack, DEMO_NAME } from './demo-pack.js';

const RECORDER = 'http://127.0.0.1:8787';
const EMPTY_LIBRARY_MSG = 'henüz kayıt yok — ● KAYIT ile başla';
// A disconnected local service must settle every action and watchdog probe.
const recorderFetch = (path, options = {}) => fetch(`${RECORDER}${path}`, {
  ...options, signal: options.signal ?? AbortSignal.timeout(8000),
});
let packEntries = [];

async function fetchPacks() {
  try {
    const r = await fetch('/packs/index.json', { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return [];
    // Vite's SPA fallback serves index.html with 200 for missing paths
    if (!(r.headers.get('content-type') ?? '').includes('json')) return [];
    const d = await r.json();
    packEntries = Array.isArray(d?.packs) ? d.packs.filter((p) => typeof p?.name === 'string' && p.name) : [];
    return packEntries.map((p) => p.name);
  } catch { return []; }
}

let PACKS = [];

const canvas = document.getElementById('c');
const view = createScene(canvas);
const space = createNebulaSpace();
view.scene.add(space.group);

let current = null; // pack mode: { name, pack, layout, disc, transport }
let live = null;    // record mode: { es, disc, layout, laneOf, maxT, queue, durationMs, ... }
let recPending = false; // set synchronously on KAYIT click, before any await
let switchGen = 0;      // invalidates in-flight switchPack loads
let packAbort = null;
const viewMode = 'nebula';
let playbackSpeed = 1;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
let orbitMotion = !reducedMotion.matches;
let orbitPhase = 0;
let animationTime = 0;

function rememberArtwork(name = current?.name) {
  if (!name || cover.visible) return;
  const url = new URL(location.href);
  if (name === DEMO_NAME) { url.searchParams.set('demo', '1'); url.searchParams.delete('pack'); }
  else { url.searchParams.set('pack', name); url.searchParams.delete('demo'); }
  url.searchParams.delete('style');
  history.replaceState(null, '', url);
}

const hud = createHud({
  packs: PACKS,
  onPack: (name) => switchPack(name),
  onPlayPause: transportPlayPause,
  onSeek: transportSeek,
  onSpeed: transportSpeed,
  onFinal: () => transportSeek(current?.pack.manifest.durationMs ?? 0),
  onRestart: transportRestart,
  onUdpEnable: enableUdpOutput,
  onUdpDisable: disableUdpOutput,
  onExport: () => {
    if (!current) throw new Error('Önce dışa aktarılacak bir eser açın.');
    return exportStill({
      renderer: view.renderer, scene: view.scene,
      uniforms: current.disc.uniforms, playheadMat: current.disc.playheadMat,
      sessionId: current.pack.manifest.sessionId,
      render: (target, camera) => view.render(target, camera),
      mode: viewMode, activity: current.disc.activityAt(current.pack.manifest.durationMs),
      motion: current.disc.motionAt?.(current.pack.manifest.durationMs),
    }).finally(() => { lastRenderStamp = null; }); // release print-sized intermediate GPU targets
  },
  onFit: () => view.fit(),
  onTilt: (radians) => view.setTilt(radians),
  onJourney: () => view.journeyActive ? view.stopJourney() : view.startJourney(),
  onOrbitMotion: (on) => { orbitMotion = on; },
  onFocusMode: (on) => view.setPresentation(on),
  onDeselect: () => (live ? selectLive(null) : select(null)),
  onRecord: () => (live ? stopRecording() : startRecording()),
  onLibrary: () => toggleLibrary(),
  onDemo: () => switchPack(DEMO_NAME),
  onHome: () => showEntrance(),
});
const udpReplay = createUdpReplayClient({ request: recorderFetch, onState: (state) => hud.setUdpState(state) });
view.onJourneyChange((active) => hud.setJourneyState(active));

// Called by the frame loop before local tick. The server owns the source time
// whenever UDP is opted in; local playback never races a second clock.
function syncUdpTransport() {
  if (!udpReplay.enabled || !current) return false;
  const state = udpReplay.snapshot();
  hud.setUdpState(state);
  current.transport.pause();
  current.transport.seek(state.positionMs);
  if (state.playing && state.positionMs < current.pack.manifest.durationMs) current.transport.play();
  return true;
}
async function udpAction(action) {
  try { await action(); syncUdpTransport(); }
  catch (error) { current?.transport.pause(); hud.setStats(replayErrorMessage(error)); }
}
async function enableUdpOutput() {
  if (!current || live || recPending) return;
  current.transport.pause();
  await udpAction(() => udpReplay.enable({ sessionId: current.pack.manifest.sessionId, durationMs: current.pack.manifest.durationMs,
    simulated: current.name === DEMO_NAME || current.pack.manifest.simulated === true }));
  if (udpReplay.enabled) { playbackSpeed = udpReplay.snapshot().status?.speed ?? 1; current.transport.setSpeed(playbackSpeed); }
}
async function disableUdpOutput() {
  const position = current?.transport.time;
  await udpAction(() => udpReplay.disable());
  if (!udpReplay.enabled && current) {
    current.transport.pause(); if (Number.isFinite(position)) current.transport.seek(position);
    hud.setStats('UDP çıkışı kapalı · Görsel oynatım sessiz.');
  }
}
async function transportPlayPause() {
  if (!current) return;
  if (udpReplay.enabled) return udpAction(() => udpReplay.snapshot().status?.state === 'PLAYING' ? udpReplay.pause() : udpReplay.play({ speed: Math.min(4, playbackSpeed) }));
  current.transport.playing ? current.transport.pause() : current.transport.play();
}
async function transportSeek(ms) {
  if (!current) return;
  if (udpReplay.enabled) return udpAction(() => udpReplay.seek(ms));
  current.transport.pause(); current.transport.seek(ms);
}
async function transportSpeed(speed) {
  if (udpReplay.enabled) {
    await udpAction(() => udpReplay.setSpeed(Math.min(4, speed)));
    playbackSpeed = udpReplay.snapshot().status?.speed ?? playbackSpeed;
  } else playbackSpeed = speed;
  current?.transport.setSpeed(playbackSpeed);
}
async function transportRestart() {
  if (!current) return;
  if (udpReplay.enabled) return udpAction(() => udpReplay.play({ positionMs: 0, speed: Math.min(4, playbackSpeed) }));
  current.transport.restart();
}
hud.setOrbitMotion(orbitMotion);
reducedMotion.addEventListener('change', (event) => {
  if (event.matches) { orbitMotion = false; hud.setOrbitMotion(false); }
});

const cover = createCover({
  onEnter: async () => {
    if (!current && !live) await switchPack(PACKS[0] ?? DEMO_NAME);
    cover.hide(); rememberArtwork();
  },
  onRecord: async () => { cover.hide(); await startRecording(); },
  onArchive: () => { cover.hide(); hud.setLibraryOpen(true); refreshLibrary(); },
});

function clearArtworkAddress() {
  const url = new URL(location.href);
  for (const key of ['pack', 'demo', 'style']) url.searchParams.delete(key);
  history.replaceState(null, '', url);
}
function showEntrance() { clearArtworkAddress(); cover.show(); }
const syncPacks = (selected) => hud.setPacks(PACKS.map((name) => packEntries.find((p) => p.name === name) ?? name), selected);

canvas.addEventListener('webglcontextlost', (event) => {
  event.preventDefault();
  current?.transport.pause();
  hud.setStats('Grafik bağlantısı kesildi. Görüntü kurtarılana kadar bekleyin; canlı kayıt durumunu operatör panelinden izleyebilirsiniz.');
});
canvas.addEventListener('webglcontextrestored', () => {
  lastRenderStamp = null;
  hud.setStats('Grafik bağlantısı yeniden kuruldu.');
});

// ------------------------------------------------------------------ library
// Seat-panel meta reaches the DOM via innerHTML (for the <b> emphasis), and
// zone/seat values come from outside (SSE stream, pack manifest) — escape.
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

let libBusy = false; // one library mutation at a time (double-click guard)

function toggleLibrary() {
  const open = !hud.isLibraryOpen();
  hud.setLibraryOpen(open);
  if (open) refreshLibrary();
}

async function refreshLibrary() {
  if (!hud.isLibraryOpen()) return;
  let lib = null;
  try {
    const r = await recorderFetch(`/api/library`);
    if (!r.ok) throw new Error('library');
    lib = await r.json();
  } catch { /* recorder offline */ }
  if (!hud.isLibraryOpen()) return; // closed during the fetch
  if (!lib) { hud.renderLibrary({ offline: true }); return; }
  hud.renderLibrary(lib, {
    onOpen: (name) => switchPack(name),
    onDeletePack: (name) => libraryOp(
      () => recorderFetch(`/api/packs/${encodeURIComponent(name)}`, { method: 'DELETE' }),
      { deletedPack: name },
    ),
    onPackSession: (file) => libraryOp(() => recorderFetch(`/api/pack`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file }),
    })),
    onDeleteSession: (file) => libraryOp(
      () => recorderFetch(`/api/sessions/${encodeURIComponent(file)}`, { method: 'DELETE' }),
    ),
  });
}

// Run a library mutation, then re-sync everything that mirrors the disk:
// the packs dropdown, the panel, and — if the open pack just vanished — the
// stage (fall back to the first remaining pack or the empty state).
async function libraryOp(fn, { deletedPack = null } = {}) {
  if (libBusy) return; // a second click while the first op is in flight
  libBusy = true;
  try {
    let err = null;
    try {
      const r = await fn();
      if (!r.ok) {
        const body = await r.json().catch(() => null);
        err = body?.error ?? `HTTP ${r.status}`;
      }
    } catch { err = 'kayıt sunucusuna ulaşılamadı'; }
    PACKS = await fetchPacks();
    syncPacks(current?.name);
    refreshLibrary();
    if (err) { hud.setStats(`işlem başarısız — ${err}`); return; }
    if (deletedPack && current?.name === deletedPack) {
      if (PACKS.length) await switchPack(PACKS[0], 'açık paket silindi');
      else {
        clearStage();
        hud.setEmpty();
        syncPacks();
        hud.setStats(`açık paket silindi · ${EMPTY_LIBRARY_MSG}`);
        hud.showSeat(null);
      }
    }
  } finally { libBusy = false; }
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
    meta: `zone <b>${esc(p.z)}</b> · koltuk <b>${esc(p.s)}</b> · lane ${esc(p.l)}<br>` +
      `${p.n} olay = ${notes} nota + ${moves} hareket + ${lifecycle} yaşam döngüsü<br>` +
      (notes + moves > 0
        ? `aktif: ${(first / 1000).toFixed(1)}s → ${(last / 1000).toFixed(1)}s`
        : 'sessiz'),
  };
}

function select(lane) {
  if (!current) return;
  current.gestureSelection = lane === null ? null : { lane, finger: undefined, previewTime: null };
  current.gestureStamp = null;
  current.disc.setInspection?.(null);
  current.disc.uniforms.uSelLane.value = lane === null ? -1 : lane;
  hud.showSeat(lane === null ? null : laneInfo(lane));
  syncGesture();
}

function syncGesture() {
  if (!current?.gestureSelection) return;
  const selected = current.gestureSelection;
  const time = selected.previewTime ?? current.transport.time;
  const state = current.replay.sampleLane(selected.lane, time, { maxTrailPoints: 64 });
  let finger = selected.finger === undefined
    ? state.fingers.find((f) => f.active) ?? state.fingers.at(-1)
    : state.fingers.find((f) => f.finger === selected.finger);
  if (selected.previewTime !== null && Number.isInteger(selected.previewIndex)) {
    const point = readGesture(current.pack, selected.previewIndex);
    finger = { ...point, active: false,
      trail: (finger?.trail ?? []).filter((p) => p.t < point.t || (p.t === point.t && p.index <= point.index)) };
  }
  const stamp = `${selected.lane}:${finger?.finger}:${finger?.index}:${finger?.active}:${finger?.trail[0]?.index}`;
  if (current.gestureStamp === stamp) return;
  current.gestureStamp = stamp;
  const motion = Number.isInteger(finger?.index) ? current.disc.motionForEvent?.(finger.index) : null;
  hud.setGestureState({ lane: selected.lane, pid: state.pid, exact: state.exact,
    hasXY: Boolean(finger), x: finger?.x, y: finger?.y, t: finger?.t,
    finger: finger?.finger, active: finger?.active ?? false, motion,
    trail: finger?.finger === null ? [] : finger?.trail ?? [] });
}

// Live isolation: selection keyed by (z,s), not lane index — a derived→
// genuine roster rebuild reshuffles lanes, and the pid must survive it.
function selectLive(lane, gesture = null) {
  if (!live?.disc) return;
  const meta = lane === null ? null : live.laneMeta?.[lane] ?? null;
  const finger = gesture ? gesture.finger : undefined;
  const latest = meta && gesture ? live.disc.sampleLane(lane, live.maxT, finger) : null;
  live.sel = meta ? { z: meta.zone, s: meta.seat, pid: meta.pid, finger,
    // Keep the precise clicked observation visible until a new observation
    // from that same finger arrives. Another finger must never replace it.
    previewGesture: gesture ? { ...gesture, active: false, trail: [] } : null,
    followAfter: latest ? { t: latest.t, index: latest.index } : null,
  } : null;
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
  if (live?.disc) {
    const hit = live.disc.inspectNdc(x, y);
    selectLive(hit?.lane ?? null, hit?.gesture ?? null); return;
  }
  if (!current) return;
  const hit = current.disc.inspectNdc(x, y);
  select(hit?.lane ?? null);
  current.disc.setInspection?.(hit);
  if (hit) hud.showSeat(hit);
  if (hit && current.gestureSelection) {
    current.gestureSelection.finger = hit.gesture?.finger;
    current.gestureSelection.previewTime = Number.isFinite(hit.gesture?.t) ? hit.gesture.t : null;
    current.gestureSelection.previewIndex = hit.index;
    current.gestureStamp = null;
    syncGesture();
  }
});

view.onHover((x, y) => {
  if (!live && current) current.disc.updateHoverNdc?.(x, y);
});
view.onTilt((tilt) => {
  const disc = live?.disc ?? current?.disc;
  if (disc?.uniforms.uTilt) disc.uniforms.uTilt.value = tilt;
  hud.setTilt?.(tilt);
});

window.addEventListener('keydown', (e) => {
  // Space is reserved for replay, including when Tab focuses record controls.
  if (e.key === ' ' && e.target.closest?.('#rec')) { e.preventDefault(); return; }
  if (e.target.closest?.('input, select, textarea, button, a, [contenteditable="true"]')) return;
  if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
  if (e.key === 'Escape') (live ? selectLive(null) : select(null));
  if (e.key === ' ') {
    // Space must NEVER reach a focused button — during a live take it would
    // stop the one-shot recording. It toggles the transport in pack mode only.
    e.preventDefault();
    if (current && !live) {
      transportPlayPause();
    }
  }
  if (e.key === 'f' || e.key === 'F') view.fit();
});

function clearStage() {
  if (current) { view.scene.remove(current.disc.group); current.disc.dispose(); current.replay?.clearCache(); current = null; }
}

async function switchPack(name, notice = null) {
  if (live || recPending) return; // recording owns the stage
  if (udpReplay.enabled || udpReplay.busy) { hud.setStats('Başka bir eseri açmadan önce UDP çıkışını kapatın.'); return; }
  if (!name) { hud.setStats(EMPTY_LIBRARY_MSG); return; }
  const gen = ++switchGen; // any older in-flight load is now void
  packAbort?.abort();
  packAbort = new AbortController();
  hud.setLoading(true, 'Eser yükleniyor');
  hud.setStats('yükleniyor…');
  const stale = () => gen !== switchGen || live || recPending;
  let pack;
  try {
    pack = name === DEMO_NAME ? createDemoPack() : await loadPack(name, undefined, { signal: packAbort.signal });
  } catch {
    await new Promise((r) => setTimeout(r, 600)); // dev server may be settling
    if (stale()) return;
    try { pack = name === DEMO_NAME ? createDemoPack() : await loadPack(name, undefined, { signal: packAbort.signal }); }
    catch (err) {
      if (!stale()) {
        hud.setLoading(false);
        if (current) hud.setPack(current.name);
        hud.setStats(`paket yüklenemedi: ${name} — ${err?.message ?? err}`);
      }
      return;
    }
  }
  if (stale()) return; // an overlapping switch/recording won — no GPU built yet
  let layout; let disc; let replay;
  try {
    layout = buildLayout(pack.manifest);
    replay = createGestureReplay(pack);
    disc = buildNebula(pack, layout, { replay });
  } catch (err) {
    hud.setLoading(false);
    hud.setStats(`Eser oluşturulamadı — ${err.message}`);
    return;
  }
  clearStage();
  disc.setViewMode?.(viewMode);
  if (disc.uniforms.uTilt) disc.uniforms.uTilt.value = view.tilt;
  view.setTheme(viewMode);
  hud.setViewMode(viewMode);
  const transport = createTransport(pack.manifest.durationMs);
  transport.setSpeed(playbackSpeed);
  view.scene.add(disc.group);
  current = { name, pack, layout, disc, transport, replay, gestureSelection: null, gestureStamp: null };
  orbitPhase = 0;
  rememberArtwork(name);
  lastRenderStamp = null;
  hud.setPack(name);
  hud.setDuration(pack.manifest.durationMs);
  hud.setArtwork(pack.manifest, { demo: name === DEMO_NAME });
  hud.setGestureSummary({ available: true, source: name === DEMO_NAME ? 'demo' : pack.gestures ? 'recorded' : 'legacy' });
  hud.setLoading(false);
  hud.setStats(notice ?? '');
  select(null);
}

// -------------------------------------------------------------- record mode
// Order of a fresh take: probe status → open ES → hello → arm+start
// (response-checked) → state:RECORDING → only THEN clear the stage and build
// the live disc from the fresh roster broadcast. The loaded pack is never
// disposed before the server confirms RECORDING.
async function startRecording() {
  if (live || recPending) return; // synchronous re-entry guard (double-click)
  if (udpReplay.enabled || udpReplay.busy) { hud.setStats('Canlı kayıttan önce UDP çıkışını kapatın.'); return; }
  recPending = true;
  ++switchGen; // void any in-flight pack load
  packAbort?.abort();
  hud.setLoading(false);
  hud.setRecState('● BAĞLANIYOR…', true);
  let st;
  try {
    const r = await recorderFetch(`/api/status`);
    if (!r.ok) throw new Error('status');
    st = await r.json();
  } catch {
    recPending = false;
    hud.setRecState('● KAYIT', false);
    hud.setConnection('offline');
    hud.setStats('kayıt sunucusu kapalı — önce çalıştır: npm run panel');
    return;
  }
  live = {
    es: null, disc: null, layout: null, laneOf: null, laneMeta: null, maxT: 0, queue: [],
    laneEvents: null,    // per-lane live event counts (seat panel)
    sel: null,           // isolated seat: { z, s, pid } — survives rebuilds
    selShown: null,      // last seat-panel snapshot (avoid innerHTML churn)
    durationMs: st.durationMs ?? DEFAULT_DURATION_MS, visualSeed: null,
    clockOrigin: performance.now() - (st.state === 'RECORDING' ? Math.max(0, Date.now() - st.startedAtLocalMs) : 0),
    clockAligned: false,
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
  const activeTake = live;
  es.onopen = () => { if (live === activeTake) { live.staleSince = null; } };
  es.onmessage = (m) => {
    if (live !== activeTake) return;
    live.staleSince = null;
    try {
      handleLive(JSON.parse(m.data)).catch(() => {
        if (live === activeTake) exitLive('Canlı görünüm güncellenemedi. Kayıt durumunu operatör panelinden kontrol edin.');
      });
    } catch {
      hud.setStats('Canlı görünümde geçersiz mesaj alındı; yeniden bağlantı bekleniyor.');
    }
  };
  es.onerror = () => {
    // EventSource auto-reconnects; mark stale and let the watchdog decide.
    if (live === activeTake && live.staleSince === null) live.staleSince = performance.now();
  };
  // Watchdog: a dead recorder must never brick the page mid-live.
  live.watchdog = setInterval(async () => {
    if (live !== activeTake || activeTake.probing) return;
    activeTake.probing = true;
    try {
      const r = await recorderFetch(`/api/status`);
      if (!r.ok) throw new Error('status');
      if (live === activeTake) live.failedProbes = 0;
    } catch {
      if (live !== activeTake) return;
      live.failedProbes += 1;
      if (live.failedProbes >= 2) exitLive('kayıt sunucusuna ulaşılamadı — kayıt yarıda kesildi');
    } finally { activeTake.probing = false; }
  }, 5000);
}

// Arm (if needed) and start the take, verifying each response.
async function beginTake(helloState) {
  if (!live || live.starting || live.started) return;
  live.starting = true;
  try {
    if (live.cancelling) { exitLive(null); return; }
    if (helloState !== 'ARMED') {
      const r = await recorderFetch(`/api/arm`, { method: 'POST' });
      if (!r.ok) throw new Error('arm');
      if (!live) return;
      if (live.cancelling) { await disarmQuietly(); exitLive(null); return; }
    }
    const r2 = await recorderFetch(`/api/start`, { method: 'POST' });
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
    const st = await (await recorderFetch(`/api/status`)).json();
    if (st.state === 'ARMED') await recorderFetch(`/api/arm`, { method: 'POST' });
  } catch { /* server unreachable — nothing to disarm */ }
}

async function stopRecording() {
  if (!live || live.stopping) return;
  live.stopping = true;
  hud.setRecState('■ DURDURULUYOR…', true);
  if (!live.started) live.cancelling = true; // suppress a pending arm/start
  let res = null;
  try { res = await recorderFetch(`/api/stop`, { method: 'POST' }); }
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
      const st = await (await recorderFetch(`/api/status`)).json();
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
    const st = await (await recorderFetch(`/api/status`)).json();
    if (!live) return;
    if (st.state === 'FINALIZING' || st.state === 'COMPLETE') {
      hud.setRecState('■ PAKETLENIYOR…', true);
      return; // COMPLETE broadcast will land shortly
    }
    if (st.state === 'RECORDING' || st.state === 'ARMED') {
      // server alive, stop lost in transit: retry once
      try {
        const r2 = await recorderFetch(`/api/stop`, { method: 'POST' });
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
  const spareLanes = Math.max(64, 2000 - roster.length);
  const { layout, laneOf, laneMeta, laneCount } = rosterLayout(roster, live.durationMs, buildLayout, spareLanes);
  live.layout = layout;
  live.laneOf = laneOf;
  live.laneMeta = laneMeta;
  live.laneEvents = new Uint32Array(laneCount);
  live.rosterDerived = derived;
  live.replayBuf = derived ? [] : null; // kept so a genuine roster can rebuild
  live.disc = createLiveNebula(layout, { visualSeed: live.visualSeed ?? 1 });
  live.disc.uniforms.uTilt.value = view.tilt;
  view.setTheme('nebula');
  hud.setViewMode('nebula');
  hud.setArtwork({ laneCount: roster.length, eventCount: 0, durationMs: live.durationMs, label: 'Canlı kayıt' });
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
  if (events.length && !live.clockAligned) {
    live.clockOrigin = performance.now() - Math.max(...events.map(e => Number.isFinite(e.t) ? e.t : 0));
    live.clockAligned = true;
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
      clearArtworkAddress();
      clearStage();
      ensureLiveDisc(msg.roster ?? [], { derived: !msg.roster?.length });
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
      // server confirmed the take: NOW the stage belongs to the live Nebula
      clearArtworkAddress();
      clearStage();
      if (live.pendingRoster) {
        ensureLiveDisc(live.pendingRoster);
        live.pendingRoster = null;
      } else ensureLiveDisc([], { derived: true });
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
      syncPacks(packName);
      const completedOrbit = orbitPhase;
      await switchPack(packName);
      orbitPhase = completedOrbit;
      refreshLibrary(); // a finished take is new library content
    } else if (msg.state === 'IDLE' && msg.error) {
      exitLive('kayıt hatası — sunucu loguna bak');
    }
  }
}

// The operator cancelled but the take started anyway (stop lost the race):
// stop it now that the server is provably recording.
function stopRecordingConfirmed() {
  recorderFetch(`/api/stop`, { method: 'POST' }).catch(() => {});
  hud.setRecState('■ DURDURULUYOR…', true);
}

function stopLiveUi(err) {
  if (live?.watchdog) clearInterval(live.watchdog);
  live?.es?.close();
  if (live?.disc) { view.scene.remove(live.disc.group); live.disc.dispose(); }
  if (live?.sel) hud.showSeat(null); // a live isolation panel must not linger
  live = null;
  hud.setLiveMode(false);
  view.setTheme(viewMode);
  hud.setViewMode(viewMode);
  hud.setRecState('● KAYIT', false);
  if (!current) hud.setEmpty();
  if (err) hud.setStats(err);
}

// ------------------------------------------------------------------- render
let prev = performance.now();
let lastMetrics = 0;
let lastRenderStamp = null;
function renderIfChanged(contentStamp) {
  const c = view.camera;
  const stamp = `${contentStamp}|${c.position.x}|${c.position.y}|${c.zoom}|${canvas.width}|${canvas.height}|${viewMode}|${view.revision}`;
  if (stamp === lastRenderStamp) return;
  lastRenderStamp = stamp;
  view.render();
}
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(100, now - prev);
  prev = now;
  view.tick(dt);
  (live?.disc ?? current?.disc)?.setCamera(view.camera, canvas.height);
  const px = view.pixelsPerWorldUnit();
  const devicePx = px * view.renderer.getPixelRatio();
  hud.labelLayer.hidden = true;
  if (!document.hidden && !reducedMotion.matches && !cover.visible) animationTime += dt / 1000;

  if (live?.disc) {
    const d = live.disc;
    const time = Math.min(live.durationMs, Math.max(live.maxT, now - live.clockOrigin));
    d.uniforms.uAnimation.value = animationTime;
    if (orbitMotion && !document.hidden && !cover.visible) orbitPhase = (orbitPhase + dt * 0.000024) % (Math.PI * 2);
    d.uniforms.uOrbit.value = orbitPhase;
    d.uniforms.uPointScale.value = devicePx;
    d.playheadMat.opacity = 0.55;
    d.updatePlayhead?.(time);
    hud.setTime(time, true);
    if (now - lastMetrics > 250) {
      lastMetrics = now;
      hud.setLiveMetrics?.({
        participants: live.laneMeta.filter(Boolean).length,
        events: live.laneEvents.reduce((sum, n) => sum + n, 0),
      });
    }
    if (live.sel) {
      // live-updating event count for the isolated seat, DOM-churn-free
      const lane = d.uniforms.uSelLane.value;
      const count = lane >= 0 ? live.laneEvents[lane] : 0;
      const snap = `${live.sel.pid}:${count}`;
      if (live.selShown !== snap) {
        live.selShown = snap;
        hud.showSeat({
          title: live.sel.pid,
          // z/s come straight off the SSE stream — escape before innerHTML
          meta: `zone <b>${esc(live.sel.z)}</b> · koltuk <b>${esc(live.sel.s)}</b><br>` +
            `${count.toLocaleString('tr-TR')} olay · canlı`,
        });
      }
      const latest = d.sampleLane(lane, time, live.sel.finger);
      const boundary = live.sel.followAfter;
      if (live.sel.previewGesture && live.sel.finger !== null && latest && (!boundary || latest.t > boundary.t ||
        (latest.t === boundary.t && latest.index > boundary.index))) live.sel.previewGesture = null;
      const gesture = live.sel.previewGesture ?? latest;
      hud.setGestureState({lane, pid:live.sel.pid, exact:true, hasXY:Boolean(gesture), ...gesture});
    }
    if (!live.stopping) {
      // '■ DURDURULUYOR…' / '■ PAKETLENIYOR…' own the label while stopping
      hud.setRecState(
        live.staleSince !== null
          ? '⚠ BAĞLANTI KOPTU — yeniden bağlanıyor'
          : `■ ${Math.floor(time / 60000).toString().padStart(2, '0')}:${Math.floor(time / 1000 % 60).toString().padStart(2, '0')} / 03:00` +
            (live.dropped ? ` · ⚠ ${live.dropped.toLocaleString('tr-TR')} olay şerit dışı` : ''),
        true,
      );
    }
    if (!cover.visible) renderIfChanged(`live:${d.group.uuid}:${time}:${animationTime}:${orbitPhase}:${d.grainCount()}:${d.uniforms.uSelLane.value}`);
    return;
  }

  if (!current) { renderIfChanged('ambient'); return; }
  const { disc, transport, layout } = current;
  if (!syncUdpTransport()) transport.tick(dt);
  const movedTime = transport.time !== disc.uniforms.uTime.value;
  if (transport.time < disc.uniforms.uTime.value) {
    // A previously selected late cell must not disclose future counts after
    // seeking or restarting. Includes keyboard playback from the final state.
    if (current.gestureSelection) {
      current.gestureSelection.previewTime = null;
      const p = current.pack.manifest.participants[current.gestureSelection.lane];
      hud.showSeat({ title: p.p, meta: 'Kaydedilmiş parmak hareketi · X / Y' });
      current.gestureStamp = null;
    } else select(null);
    disc.updateHover?.(null, null);
  }
  if (movedTime && current.gestureSelection) {
    if (current.gestureSelection.previewTime !== null) {
      const p = current.pack.manifest.participants[current.gestureSelection.lane];
      hud.showSeat({ title: p.p, meta: 'Kaydedilmiş parmak hareketi · X / Y' });
      current.gestureStamp = null;
    }
    current.gestureSelection.previewTime = null;
  }
  disc.uniforms.uTime.value = transport.time;
  disc.uniforms.uPointScale.value = devicePx;
  if (disc.uniforms.uOrbit) {
    if (orbitMotion && !document.hidden && !cover.visible) orbitPhase = (orbitPhase + dt * 0.000024) % (Math.PI * 2);
    disc.uniforms.uOrbit.value = orbitPhase;
  }

  disc.uniforms.uAnimation.value = animationTime;
  const replaying = transport.time < layout.durationMs;
  disc.uniforms.uReplaying.value = replaying ? 1 : 0;
  disc.playheadMat.opacity = replaying ? 0.55 : 0;
  disc.updatePlayhead?.(transport.time);

  hud.setTime(transport.time, transport.playing);
  syncGesture();
  if (!cover.visible) renderIfChanged(`${animationTime}:${disc.group.uuid}:${transport.time}:${disc.uniforms.uOrbit?.value ?? 0}:${disc.uniforms.uSelLane.value}:${disc.uniforms.uSelRow?.value}:${disc.uniforms.uSelColumn?.value}:${disc.hoverStamp ?? ''}`);
}

// Boot: if the recorder is already mid-take, auto-attach through the exact
// same path as a manual KAYIT press (startRecording probes status, opens the
// SSE tap, and the hello's state:RECORDING takes the attach branch).
async function boot() {
  requestAnimationFrame(frame); // frame() no-ops until a disc exists
  PACKS = await fetchPacks();
  syncPacks();
  if (new URLSearchParams(location.search).get('demo') === '1') { await switchPack(DEMO_NAME); return; }
  const requestedPack = new URLSearchParams(location.search).get('pack');
  if (requestedPack) { await switchPack(requestedPack); return; }
  try {
    const r = await recorderFetch(`/api/status`, { signal: AbortSignal.timeout(3000) });
    if (r.ok) {
      hud.setConnection('ready');
      if ((await r.json()).state === 'RECORDING') { startRecording(); return; }
    } else hud.setConnection('offline');
  } catch { hud.setConnection('offline'); }
  showEntrance();
  if (PACKS.length) await switchPack(PACKS[0]);
  else await switchPack(DEMO_NAME); // fresh install has a clearly labeled, local study
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
