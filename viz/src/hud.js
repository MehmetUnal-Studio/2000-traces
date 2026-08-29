// viz/src/hud.js
// Minimal operator chrome around the artwork. Show mode ('H') hides all of it.
const fmt = (ms) => `${Math.floor(ms / 1000)}.${Math.floor((ms % 1000) / 100)}s`;

export function createHud({ packs, onPack, onPlayPause, onSeek, onSpeed, onFinal, onRestart, onExport, onFit, onDeselect, onRecord, onLibrary }) {
  const el = document.createElement('div');
  el.id = 'hud';
  el.innerHTML = `
    <div class="panel top">
      <div class="brand">2000 TRACES <span class="dim">— collective record</span></div>
      <select id="pack"></select>
      <button id="libBtn">KÜTÜPHANE</button>
      <div id="stats" class="dim"></div>
    </div>
    <div class="panel library" id="libPanel" hidden>
      <div class="libHead">KÜTÜPHANE</div>
      <div id="libBody"></div>
    </div>
    <div class="panel seat" id="seatPanel" hidden>
      <div class="pid" id="selPid"></div>
      <div id="selMeta" class="dim"></div>
      <button id="deselect">kapat (esc)</button>
    </div>
    <div class="panel transport">
      <button id="rec" class="rec" title="canlı akıştan 90 sn kaydet">● KAYIT</button>
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
  // Buttons blur on click: a focused button would otherwise be re-activated
  // by Space/Enter later — during a live take that would stop the recording.
  const click = (id, fn) => { $(id).onclick = (e) => { e.currentTarget.blur(); fn(); }; };
  $('pack').onchange = (e) => { e.target.blur(); onPack(e.target.value); };
  click('play', onPlayPause);
  click('restart', onRestart);
  $('scrub').oninput = (e) => onSeek(Number(e.target.value));
  $('speed').onchange = (e) => { e.target.blur(); onSpeed(Number(e.target.value)); };
  click('final', onFinal);
  click('fit', onFit);
  click('export', onExport);
  click('deselect', onDeselect);
  click('rec', onRecord);
  click('libBtn', onLibrary);

  // Two-step delete: first click arms the button ('EMİN MİSİN?') for 4 s,
  // the second click within that window fires. Blur-on-click like everything
  // else (keyboard safety during a live take).
  const armedDelete = (btn, fn) => {
    let timer = null;
    const original = btn.textContent;
    btn.onclick = (e) => {
      e.currentTarget.blur();
      if (timer === null) {
        btn.textContent = 'EMİN MİSİN?';
        btn.classList.add('armed');
        timer = setTimeout(() => {
          timer = null;
          btn.textContent = original;
          btn.classList.remove('armed');
        }, 4000);
      } else {
        clearTimeout(timer);
        timer = null;
        // disarm immediately: if the op stalls or fails before the panel
        // re-renders, the button must not sit live on a single click
        btn.textContent = original;
        btn.classList.remove('armed');
        btn.disabled = true; // re-render replaces the row; until then, inert
        fn();
      }
    };
  };

  const mkBtn = (label, fn, cls = '') => {
    const b = document.createElement('button');
    b.textContent = label;
    if (cls) b.className = cls;
    if (fn) b.onclick = (e) => { e.currentTarget.blur(); fn(); };
    return b;
  };

  let hidden = false;
  window.addEventListener('keydown', (e) => {
    if (e.key === 'h' || e.key === 'H') { hidden = !hidden; el.classList.toggle('hidden', hidden); }
  });

  const labelLayer = document.createElement('div');
  labelLayer.id = 'zoneLabels';
  document.body.appendChild(labelLayer);

  const setPacks = (names, selected) => {
    $('pack').innerHTML = names.length
      ? names.map((p) => `<option value="${p}">${p}</option>`).join('')
      : '<option value="" disabled selected>kayıt yok</option>';
    if (selected) $('pack').value = selected;
  };
  setPacks(packs);

  return {
    setStats(text) { $('stats').textContent = text; },
    setDuration(ms) { $('scrub').max = String(ms); },
    setTime(ms, playing) {
      $('scrub').value = String(ms);
      $('clock').textContent = fmt(ms);
      $('play').textContent = playing ? '⏸' : '▶';
    },
    setPack(name) { $('pack').value = name; },
    setPacks,
    setRecState(label, on) {
      $('rec').textContent = label;
      $('rec').classList.toggle('on', !!on);
    },
    setLiveMode(on) {
      for (const id of ['play', 'restart', 'scrub', 'speed', 'final', 'export', 'pack']) {
        $(id).disabled = on;
      }
    },
    isLibraryOpen: () => !$('libPanel').hidden,
    setLibraryOpen(on) { $('libPanel').hidden = !on; },
    // model: { offline } | { packs, sessions } (server row shapes from
    // GET /api/library) + handlers { onOpen, onDeletePack, onPackSession,
    // onDeleteSession }. Full rebuild on every call — timers live in closures.
    renderLibrary(model, handlers = {}) {
      const body = $('libBody');
      body.innerHTML = '';
      if (model.offline) {
        const d = document.createElement('div');
        d.className = 'dim';
        d.textContent = 'kayıt sunucusu kapalı (npm run panel)';
        body.appendChild(d);
        return;
      }
      const row = (title, meta, buttons) => {
        const r = document.createElement('div');
        r.className = 'libRow';
        const info = document.createElement('div');
        info.className = 'libInfo';
        const t = document.createElement('div');
        t.textContent = title;
        const m = document.createElement('div');
        m.className = 'dim';
        m.textContent = meta;
        info.append(t, m);
        const acts = document.createElement('div');
        acts.className = 'libActs';
        acts.append(...buttons);
        r.append(info, acts);
        body.appendChild(r);
      };
      for (const p of model.packs) {
        const del = mkBtn('SİL', null, 'danger');
        armedDelete(del, () => handlers.onDeletePack?.(p.name));
        row(
          p.label ?? p.name,
          `${p.lanes} şerit · ${(p.events ?? 0).toLocaleString('tr-TR')} olay`,
          [mkBtn('AÇ', () => handlers.onOpen?.(p.name)), del],
        );
      }
      const loose = model.sessions.filter((s) => s.packName === null);
      for (const s of loose) {
        const del = mkBtn('SİL', null, 'danger');
        armedDelete(del, () => handlers.onDeleteSession?.(s.file));
        row(
          s.label ?? s.file,
          `${(s.bytes / 1048576).toFixed(1)} MB${s.complete ? '' : ' · yarım'}`,
          [mkBtn('PAKETLE', () => handlers.onPackSession?.(s.file)), del],
        );
      }
      if (!model.packs.length && !loose.length) {
        const d = document.createElement('div');
        d.className = 'dim';
        d.textContent = 'kütüphane boş';
        body.appendChild(d);
      }
    },
    showSeat(info) {
      $('seatPanel').hidden = !info;
      if (info) { $('selPid').textContent = info.title; $('selMeta').innerHTML = info.meta; }
    },
    labelLayer,
  };
}

export function updateZoneLabels(layer, layout, project, pxPerWorld) {
  // rebuild keyed on the band CONTENT, not just count: equal-count layouts
  // with different zone names (pack switch, live spare band) must relabel
  const sig = layout.zoneBands.map((b) => `${b.zone} ${b.laneStart}`).join('|');
  if (layer.dataset.sig !== sig) {
    layer.dataset.sig = sig;
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
