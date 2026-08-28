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
const FALLBACK_PACKS = ['live-2000', 'loadgen-384'];

async function fetchPacks() {
  return fetch('/packs/index.json')
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => (d?.packs?.length ? d.packs.map((p) => p.name) : FALLBACK_PACKS))
    .catch(() => FALLBACK_PACKS);
}

let PACKS = await fetchPacks();

const canvas = document.getElementById('c');
const view = createScene(canvas);

let current = null; // pack mode: { pack, layout, disc, transport }
let live = null;    // record mode: { es, disc, layout, laneOf, maxT, queue, durationMs }

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
    uniforms: current.disc.uniforms, sessionId: current.pack.manifest.sessionId,
  }),
  onFit: () => view.fit(),
  onDeselect: () => select(null),
  onRecord: () => (live ? stopRecording() : startRecording()),
});

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
    if (t < first) first = t;
    if (t > last) last = t;
  }
  return {
    title: `${p.p}`,
    meta: `zone <b>${p.z}</b> · koltuk <b>${p.s}</b> · lane ${p.l}<br>` +
      `${p.n} olay — ${notes} nota, ${moves} hareket<br>` +
      (p.n ? `aktif: ${(first / 1000).toFixed(1)}s → ${(last / 1000).toFixed(1)}s` : 'sessiz'),
  };
}

function select(lane) {
  if (!current) return;
  current.disc.uniforms.uSelLane.value = lane === null ? -1 : lane;
  hud.showSeat(lane === null ? null : laneInfo(lane));
}

view.onCanvasClick((x, y) => {
  if (!current) return;
  select(current.layout.pickLane(x, y));
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') select(null);
  if (e.key === ' ' && current) {
    e.preventDefault();
    current.transport.playing ? current.transport.pause() : current.transport.play();
  }
  if (e.key === 'f' || e.key === 'F') view.fit();
});

async function switchPack(name) {
  if (live) return; // recording owns the stage
  if (current) { view.scene.remove(current.disc.group); current.disc.dispose(); current = null; }
  hud.setStats('yükleniyor…');
  let pack;
  try {
    pack = await loadPack(name);
  } catch {
    await new Promise((r) => setTimeout(r, 600)); // dev server may be settling
    try { pack = await loadPack(name); }
    catch { hud.setStats(`paket yüklenemedi: ${name}`); return; }
  }
  const layout = buildLayout(pack.manifest);
  const disc = buildDisc(pack, layout);
  const transport = createTransport(pack.manifest.durationMs);
  view.scene.add(disc.group);
  current = { pack, layout, disc, transport };
  hud.setPack(name);
  hud.setDuration(pack.manifest.durationMs);
  hud.setStats(
    `${pack.manifest.laneCount} katılımcı · ${pack.manifest.eventCount.toLocaleString('tr-TR')} olay · ` +
    `${pack.manifest.strokeCount.toLocaleString('tr-TR')} vuruş · seed ${pack.manifest.visualSeed}`,
  );
  select(null);
}

// -------------------------------------------------------------- record mode
async function startRecording() {
  let st;
  try { st = await (await fetch(`${RECORDER}/api/status`)).json(); }
  catch {
    hud.setStats('kayıt sunucusu kapalı — önce çalıştır: npm run panel');
    return;
  }
  if (current) { view.scene.remove(current.disc.group); current.disc.dispose(); current = null; }
  hud.showSeat(null);
  live = { es: null, disc: null, layout: null, laneOf: null, maxT: 0, queue: [], durationMs: st.durationMs ?? 90000, visualSeed: null };
  hud.setLiveMode(true);
  hud.setRecState('● BAĞLANIYOR…', true);
  hud.setDuration(live.durationMs);
  if (st.state === 'IDLE' || st.state === 'COMPLETE') {
    await fetch(`${RECORDER}/api/arm`, { method: 'POST' }).catch(() => {});
  }
  const es = new EventSource(`${RECORDER}/api/live`);
  live.es = es;
  es.onmessage = (m) => handleLive(JSON.parse(m.data));
  es.onerror = () => { if (live && !live.disc) stopLiveUi('kayıt sunucusuna bağlanılamadı'); };
}

function stopRecording() {
  hud.setRecState('■ DURDURULUYOR…', true);
  fetch(`${RECORDER}/api/stop`, { method: 'POST' }).catch(() => {});
}

function ensureLiveDisc(roster) {
  if (live.disc) return;
  const { layout, laneOf } = rosterLayout(roster, live.durationMs, buildLayout);
  live.layout = layout;
  live.laneOf = laneOf;
  live.disc = createLiveDisc(layout, { visualSeed: live.visualSeed ?? 1 });
  view.scene.add(live.disc.group);
  if (live.queue.length) processLiveEvents(live.queue.splice(0));
}

function processLiveEvents(events) {
  for (const e of events) {
    if (e.t > live.maxT) live.maxT = e.t;
    const lane = live.laneOf(e.z, e.s);
    if (lane !== null) live.disc.append(lane, e);
  }
  live.disc.commit();
}

async function handleLive(msg) {
  if (!live) return;
  if (msg.kind === 'hello') {
    live.durationMs = msg.durationMs ?? live.durationMs;
    if (msg.visualSeed) live.visualSeed = msg.visualSeed;
    if (msg.roster?.length) ensureLiveDisc(msg.roster);
    if (msg.state === 'ARMED') await fetch(`${RECORDER}/api/start`, { method: 'POST' }).catch(() => {});
    else if (msg.state === 'RECORDING') hud.setRecState('■ KAYIT', true);
  } else if (msg.kind === 'roster') {
    ensureLiveDisc(msg.roster);
  } else if (msg.kind === 'batch') {
    if (!live.disc) {
      live.queue.push(...msg.events);
      if (live.queue.length > 12000) {
        // no snapshot arrived; derive the roster from what we heard
        const seen = new Map();
        for (const e of live.queue) seen.set(`${e.z}${e.s}`, { z: e.z, s: e.s });
        ensureLiveDisc([...seen.values()]);
      }
      return;
    }
    processLiveEvents(msg.events);
  } else if (msg.kind === 'state') {
    if (msg.state === 'RECORDING') {
      if (msg.visualSeed) live.visualSeed = msg.visualSeed;
      hud.setRecState('■ KAYIT', true);
    } else if (msg.state === 'COMPLETE') {
      const packName = msg.packName;
      stopLiveUi(null);
      if (!packName) {
        hud.setStats('kayıt boş kaldı — akışta hiç olay yoktu');
        if (PACKS.length) await switchPack(PACKS[0]);
        return;
      }
      PACKS = await fetchPacks();
      hud.setPacks(PACKS, packName);
      await switchPack(packName);
    } else if (msg.state === 'IDLE' && msg.error) {
      stopLiveUi('kayıt hatası — sunucu loguna bak');
    }
  }
}

function stopLiveUi(err) {
  live?.es?.close();
  if (live?.disc) { view.scene.remove(live.disc.group); live.disc.dispose(); }
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
    hud.setRecState(`■ ${(live.maxT / 1000).toFixed(1)}s · ${d.grainCount().toLocaleString('tr-TR')} tane`, true);
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

switchPack(PACKS[0]).then(() => requestAnimationFrame(frame));

// debug hook for driving the app programmatically
window.__traces = {
  select, view, startRecording, stopRecording,
  get current() { return current; },
  get live() { return live; },
};
