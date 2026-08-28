// viz/src/hud.js
// Minimal operator chrome around the artwork. Show mode ('H') hides all of it.
const fmt = (ms) => `${Math.floor(ms / 1000)}.${Math.floor((ms % 1000) / 100)}s`;

export function createHud({ packs, onPack, onPlayPause, onSeek, onSpeed, onFinal, onRestart, onExport, onFit, onDeselect }) {
  const el = document.createElement('div');
  el.id = 'hud';
  el.innerHTML = `
    <div class="panel top">
      <div class="brand">2000 TRACES <span class="dim">— collective record</span></div>
      <select id="pack">${packs.map((p) => `<option value="${p}">${p}</option>`).join('')}</select>
      <div id="stats" class="dim"></div>
    </div>
    <div class="panel seat" id="seatPanel" hidden>
      <div class="pid" id="selPid"></div>
      <div id="selMeta" class="dim"></div>
      <button id="deselect">kapat (esc)</button>
    </div>
    <div class="panel transport">
      <button id="play">▶</button>
      <button id="restart" title="baştan oynat">⟲</button>
      <input id="scrub" type="range" min="0" max="90000" value="90000" step="50">
      <span id="clock" class="mono">90.0s</span>
      <select id="speed">
        <option value="0.25">0.25×</option><option value="0.5">0.5×</option>
        <option value="1" selected>1×</option><option value="2">2×</option>
        <option value="4">4×</option><option value="8">8×</option>
      </select>
      <button id="final">SON HAL</button>
      <button id="fit">SIĞDIR</button>
      <button id="export">PNG 4K</button>
    </div>
    <div class="panel help dim">kaydır: sürükle · yakınlaş: tekerlek · koltuk seç: tıkla · H: arayüzü gizle</div>
  `;
  document.body.appendChild(el);

  const $ = (id) => el.querySelector('#' + id);
  $('pack').onchange = (e) => onPack(e.target.value);
  $('play').onclick = onPlayPause;
  $('restart').onclick = onRestart;
  $('scrub').oninput = (e) => onSeek(Number(e.target.value));
  $('speed').onchange = (e) => onSpeed(Number(e.target.value));
  $('final').onclick = onFinal;
  $('fit').onclick = onFit;
  $('export').onclick = onExport;
  $('deselect').onclick = onDeselect;

  let hidden = false;
  window.addEventListener('keydown', (e) => {
    if (e.key === 'h' || e.key === 'H') { hidden = !hidden; el.classList.toggle('hidden', hidden); }
  });

  const labelLayer = document.createElement('div');
  labelLayer.id = 'zoneLabels';
  document.body.appendChild(labelLayer);

  return {
    setStats(text) { $('stats').textContent = text; },
    setDuration(ms) { $('scrub').max = String(ms); },
    setTime(ms, playing) {
      $('scrub').value = String(ms);
      $('clock').textContent = fmt(ms);
      $('play').textContent = playing ? '⏸' : '▶';
    },
    setPack(name) { $('pack').value = name; },
    showSeat(info) {
      $('seatPanel').hidden = !info;
      if (info) { $('selPid').textContent = info.title; $('selMeta').innerHTML = info.meta; }
    },
    labelLayer,
  };
}

export function updateZoneLabels(layer, layout, project, pxPerWorld) {
  if (layer.childElementCount !== layout.zoneBands.length) {
    layer.innerHTML = layout.zoneBands.map((b) => `<span class="zl">${b.zone}</span>`).join('');
  }
  layout.zoneBands.forEach((band, i) => {
    const el = layer.children[i];
    const mid = (band.r0 + band.r1) / 2;
    const p = project(0, mid); // along the 12 o'clock spoke
    const bandPx = (band.r1 - band.r0) * pxPerWorld;
    el.style.transform = `translate(${p.x}px, ${p.y}px)`;
    el.style.opacity = bandPx >= 11 && p.visible ? '0.8' : '0';
  });
}
