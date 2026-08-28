// viz/src/main.js
import { loadPack, EVENT_RECORD_BYTES, TYPE } from './pack-loader.js';
import { buildLayout } from './layout.js';
import { buildDisc } from './disc.js';
import { createScene } from './scene.js';
import { createTransport } from './transport.js';
import { createHud, updateZoneLabels } from './hud.js';
import { exportStill } from './export-still.js';

const FALLBACK_PACKS = ['live-2000', 'loadgen-384'];
const PACKS = await fetch('/packs/index.json')
  .then((r) => (r.ok ? r.json() : null))
  .then((d) => (d?.packs?.length ? d.packs.map((p) => p.name) : FALLBACK_PACKS))
  .catch(() => FALLBACK_PACKS);

const canvas = document.getElementById('c');
const view = createScene(canvas);

let current = null; // { pack, layout, disc, transport }

const hud = createHud({
  packs: PACKS,
  onPack: (name) => switchPack(name),
  onPlayPause: () => {
    const t = current.transport;
    t.playing ? t.pause() : t.play();
  },
  onSeek: (ms) => { current.transport.pause(); current.transport.seek(ms); },
  onSpeed: (s) => current.transport.setSpeed(s),
  onFinal: () => current.transport.toEnd(),
  onRestart: () => current.transport.restart(),
  onExport: () => exportStill({
    renderer: view.renderer, scene: view.scene,
    uniforms: current.disc.uniforms, sessionId: current.pack.manifest.sessionId,
  }),
  onFit: () => view.fit(),
  onDeselect: () => select(null),
});

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
  current.disc.uniforms.uSelLane.value = lane === null ? -1 : lane;
  hud.showSeat(lane === null ? null : laneInfo(lane));
}

view.onCanvasClick((x, y) => {
  const lane = current.layout.pickLane(x, y);
  select(lane);
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') select(null);
  if (e.key === ' ') { e.preventDefault(); current.transport.playing ? current.transport.pause() : current.transport.play(); }
  if (e.key === 'f' || e.key === 'F') view.fit();
});

async function switchPack(name) {
  if (current) { view.scene.remove(current.disc.group); current.disc.dispose(); current = null; }
  hud.setStats('yükleniyor…');
  const pack = await loadPack(name);
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

const projectToScreen = (x, y) => {
  const v = { x, y };
  const cam = view.camera;
  const w = canvas.clientWidth || window.innerWidth;
  const h = canvas.clientHeight || window.innerHeight;
  const ndcX = ((v.x - cam.position.x) * cam.zoom) / (cam.right - cam.left) * 2;
  const ndcY = ((v.y - cam.position.y) * cam.zoom) / (cam.top - cam.bottom) * 2;
  return { x: (ndcX * 0.5 + 0.5) * w, y: (1 - (ndcY * 0.5 + 0.5)) * h, visible: Math.abs(ndcX) < 1.05 && Math.abs(ndcY) < 1.05 };
};

let prev = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(100, now - prev);
  prev = now;
  if (!current) return;
  const { disc, transport, layout } = current;
  transport.tick(dt);
  disc.uniforms.uTime.value = transport.time;
  disc.uniforms.uPointScale.value = view.pixelsPerWorldUnit() * view.renderer.getPixelRatio();

  const replaying = transport.time < layout.durationMs;
  disc.uniforms.uReplaying.value = replaying ? 1 : 0;
  disc.playheadMat.opacity = replaying ? 0.55 : 0;
  disc.playhead.rotation.z = -(2 * Math.PI * transport.time) / layout.durationMs;

  hud.setTime(transport.time, transport.playing);
  updateZoneLabels(hud.labelLayer, layout, projectToScreen, view.pixelsPerWorldUnit());
  view.renderer.render(view.scene, view.camera);
}

switchPack(PACKS[0]).then(() => requestAnimationFrame(frame));

// debug hook for driving the app programmatically
window.__traces = { select, view, get current() { return current; } };
