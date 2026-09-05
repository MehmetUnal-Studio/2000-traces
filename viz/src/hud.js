// Museum chrome around the artwork. All recording operations are delegated to
// the recorder state machine; the interface never starts or stops a take itself.
const number = (value) => Number.isFinite(Number(value)) ? Number(value).toLocaleString('tr-TR') : '—';
const clock = (ms) => {
  const seconds = Math.floor(Math.max(0, Number(ms) || 0) / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
};
const icons = {
  play: '<path d="m8 5 10 7-10 7Z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M9 5v14M15 5v14" stroke-width="3"/>',
  library: '<path d="M4 4v16M9 4v16M14 5l5-1 3 15-5 1Z"/>',
  focus: '<path d="M9 4H4v5m11-5h5v5M4 15v5h5m11-5v5h-5"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  restart: '<path d="M5 9a8 8 0 1 1-1 6M5 4v5h5"/>',
  fit: '<path d="M9 3H3v6m12-6h6v6M3 15v6h6m12-6v6h-6M9 12h6m-3-3v6"/>',
  final: '<path d="m5 6 10 6-10 6Z"/><path d="M19 5v14"/>',
  export: '<path d="M12 3v12m-4-4 4 4 4-4M5 16v5h14v-5"/>',
  arrow: '<path d="M4 12h15m-5-5 5 5-5 5"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  home: '<path d="m4 11 8-7 8 7M6 10v10h12V10M10 20v-6h4v6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.1"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name]}</svg>`;
const editableTarget = (target) => target instanceof Element && !!target.closest('input, textarea, select, [contenteditable="true"]');

// The legacy main module provides seat metadata with <b>/<br> formatting.
// Rebuild this tiny allowlist as DOM nodes; external seat data cannot create
// links, images, attributes, scripts, or other active content.
function seatContent(markup) {
  const doc = new DOMParser().parseFromString(String(markup ?? ''), 'text/html');
  const frag = document.createDocumentFragment();
  function append(source, target) {
    for (const node of source.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) target.append(document.createTextNode(node.textContent));
      else if (node.nodeType === Node.ELEMENT_NODE) {
        if (node.tagName === 'BR') target.append(document.createElement('br'));
        else if (node.tagName === 'B' || node.tagName === 'STRONG') {
          const strong = document.createElement('strong'); append(node, strong); target.append(strong);
        } else if (!['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT'].includes(node.tagName)) append(node, target);
      }
    }
  }
  append(doc.body, frag);
  return frag;
}

export function createHud({ packs = [], onPack, onPlayPause, onSeek, onSpeed, onFinal, onRestart, onExport, onFit, onDeselect, onRecord, onLibrary, onDemo, onHome, onTilt, onFocusMode, onOrbitMotion, onUdpEnable, onUdpDisable, onJourney } = {}) {
  const el = document.createElement('div');
  el.id = 'hud';
  el.dataset.view = 'nebula';
  document.body.dataset.theme = 'nebula';
  el.innerHTML = `
    <header class="panel top">
      <div class="identity" aria-label="2000 TRACES, Cosmic Symphony">
        <div class="brand"><span class="brand-number">2000</span><span class="brand-name">TRACES</span></div>
        <div class="brand-sub">COSMIC<br>SYMPHONY</div>
      </div>
      <div class="exhibition-label"><span class="exhibition-index">[ 01 — ∞ ]</span><span>KOLEKTİF SESİN TOPOGRAFYASI</span></div>
      <div class="top-actions">
        <button id="home" class="home-button" aria-label="Başlangıç ekranına dön">${icon('home')}<span>Başlangıç</span></button>
        <button id="libBtn" class="library-toggle" aria-controls="libPanel" aria-expanded="false" aria-label="Kayıt kütüphanesini aç">${icon('library')}<span class="button-label">Arşiv</span></button>
        <button id="focus" class="focus-button" aria-label="Sahne moduna geç, arayüzü gizle" title="Sahne modu · H">${icon('focus')}</button>
      </div>
    </header>
    <h1 id="artworkTitle" class="sr-only">2000 TRACES — Kolektif sesin topografyası</h1>
    <div class="edge-caption" aria-hidden="true">SES / HAREKET / ZAMAN</div>
    <div class="connection" id="connection" data-state="offline"><span class="status-dot"></span><span id="connectionLabel">ARŞİV GÖRÜNÜMÜ</span></div>
    <button id="udpOutputBadge" class="udp-output-badge" hidden>UDP çıkışını kapat</button>
    <div id="stats" role="status" aria-live="polite" aria-atomic="true"></div>
    <section class="work-note" aria-label="Görüntülenen eser">
      <div class="work-kicker" id="workKicker">Kolektif arşiv</div>
      <div class="work-name" id="workName">Henüz bir kayıt seçilmedi</div>
      <div class="work-format" id="workFormat">Ses · hareket · zaman</div>
      <div class="metrics" aria-label="Eserin verileri"><div class="metric"><span id="participants" class="metric-number">—</span><span class="metric-label">katılımcı</span></div><div class="metric"><span id="events" class="metric-number">—</span><span class="metric-label">etkileşim</span></div></div>
      <div id="gestureSummary" class="gesture-summary" hidden></div>
      <button id="demo" class="demo-action">Örnek eseri aç ${icon('arrow')}</button>
    </section>
    <div class="reading-control"><button id="readArtwork" aria-expanded="false" aria-controls="legendPanel">${icon('info')}<span>Eseri oku</span></button></div>
    <aside id="legendPanel" class="legend-panel" aria-labelledby="legendTitle" hidden>
      <div class="legend-head"><h2 id="legendTitle">Eseri okumak</h2><button id="closeLegend" aria-label="Eser açıklamasını kapat">${icon('close')}</button></div>
      <p class="legend-intro" id="legendIntro">Kayıtlı hareketlerden oluşan bir çekim alanı.</p>
      <dl id="nebulaLegend"><div><dt>X ekseni</dt><dd id="legendX">Yörüngenin açısal kıvrımı</dd></div><div><dt>Y ekseni</dt><dd id="legendY">Yörünge yarıçapı ve disk kalınlığı</dd></div><div><dt>İz bağlantısı</dt><dd>Aynı bilinen dokunuşun kayıtlı X/Y noktaları</dd></div><div><dt>Mavi / altın</dt><dd>Işık malzemesi; müzik hattı değildir</dd></div></dl>
      <div id="orbitMotionRow" class="orbit-motion-row"><span>Yörünge hareketi</span><button id="orbitMotion" type="button" role="switch" aria-checked="false" aria-label="Yörünge hareketi"><span id="orbitMotionLabel">Kapalı</span><span class="orbit-switch-dot" aria-hidden="true"></span></button><p>Kayıt değerlerini değiştirmeyen görsel hareket.</p></div>
      <div class="legend-tilt" id="legendTiltRow"><label for="tilt">Bakış / eğim</label><output id="tiltValue" for="tilt" aria-hidden="true">0°</output><input id="tilt" type="range" min="-35" max="35" step="1" value="0" aria-valuetext="0 derece"><span>Çekim alanına farklı açılardan bakın.</span></div>
      <button id="cameraJourney" class="camera-journey" aria-pressed="false">${icon('arrow')}<span id="cameraJourneyLabel">Kara deliğe yaklaş</span></button>
      <section id="udpOutput" class="udp-output" aria-labelledby="udpTitle"><h3 id="udpTitle">Ses çıkışı · UDP</h3><p class="udp-route">127.0.0.1:6061</p><p id="udpExplanation">Hazırlamak ses göndermez. Ardından Oynat ile kayıtlı nota ve hareketleri ses yönlendirmesine gönderin.</p><button id="udpEnable">UDP çıkışını hazırla</button><button id="udpDisable" hidden>Çıkışı kapat</button><p id="udpStatus" role="status" aria-live="polite"></p></section>
      <p class="legend-foot">Bir ize dokunarak katılımcıyı seçin.<br>Sürükle · yörüngede dön / tekerlek · yaklaş<br><span class="desktop-help">Shift + sürükle · kaydır / F · görünümü sıfırla</span></p>
    </aside>
    <div id="loading" class="loading-indicator" role="status" hidden><span class="spinner" aria-hidden="true"></span><span id="loadingLabel">Eser yükleniyor</span></div>
    <section class="panel library" id="libPanel" aria-labelledby="libraryTitle" hidden>
      <div class="drawer-top"><div><div class="drawer-eyebrow">KOLEKTİF ARŞİV</div><h2 class="drawer-title" id="libraryTitle">Kütüphane</h2></div><button id="closeLibrary" aria-label="Kütüphaneyi kapat">${icon('close')}</button></div>
      <label class="search-wrap">${icon('search')}<span class="sr-only">Kayıtlarda ara</span><input id="librarySearch" type="search" placeholder="Kayıt adıyla ara…" autocomplete="off"></label>
      <label class="sr-only" for="pack">Arşivden eser seç</label><select id="pack" class="sr-only" tabindex="-1" aria-hidden="true"></select>
      <div id="libBody" aria-live="polite"><div class="lib-empty">Kütüphane yükleniyor…</div></div>
      <div class="library-foot">Bir kaydı açarak bıraktığı izleri yeniden keşfedin.</div>
    </section>
    <aside class="panel seat" id="seatPanel" aria-label="Seçilen veri" hidden>
      <div class="seat-head"><div><div class="drawer-eyebrow">SEÇİLİ VERİ</div><div class="pid" id="selPid"></div></div><button id="deselect" aria-label="Veri seçimini kapat" title="Seçimi kaldır · Esc">${icon('close')}</button></div><div id="selMeta" class="seat-meta"></div>
      <div id="gestureDetail" class="gesture-detail" hidden>
        <div class="gesture-heading"><span>KAYITLI X/Y</span><span id="gestureActivity">Konum bekleniyor</span></div>
        <div class="gesture-content"><svg class="gesture-pad" viewBox="0 0 100 100" role="img" aria-label="Seçilen katılımcının kaydedilmiş X/Y hareket izi"><path class="gesture-grid" d="M10 10H90V90H10ZM10 50H90M50 10V90"/><path id="gestureTrail" class="gesture-trail" d=""/><circle id="gesturePoint" class="gesture-point" r="2.7" cx="50" cy="50" hidden/><text x="91" y="99">X</text><text x="1" y="8">Y</text></svg><dl class="gesture-values"><div><dt>X</dt><dd id="gestureX">—</dd></div><div><dt>Y</dt><dd id="gestureY">—</dd></div><div><dt>Zaman</dt><dd id="gestureTime">—</dd></div><div><dt>Parmak</dt><dd id="gestureFinger">—</dd></div></dl></div>
        <div id="gestureAccuracy" class="gesture-accuracy"></div>
      </div>
    </aside>
    <nav class="panel transport" aria-label="Eser oynatma denetimleri">
      <div class="record-control"><button id="rec" class="rec" title="Canlı akıştan 180 saniye kaydet" aria-label="Canlı kayıt başlat"><span class="record-dot" aria-hidden="true"></span><span class="rec-label" id="recLabel">Canlı kayıt</span></button></div>
      <div class="transport-center"><button id="play" class="play" aria-label="Oynat" title="Oynat / duraklat · Boşluk">${icon('play')}</button><button id="restart" class="transport-icon" aria-label="Baştan oynat" title="Baştan oynat">${icon('restart')}</button><div class="timeline"><span id="clock" class="clock" aria-hidden="true">00:00</span><label for="scrub" class="sr-only">Oynatma konumu</label><input id="scrub" type="range" min="0" max="180000" value="0" step="50" aria-valuetext="00:00"><span id="duration" class="clock duration" aria-hidden="true">03:00</span></div><label class="sr-only" for="speed">Oynatma hızı</label><select id="speed"><option value="0.25">0.25×</option><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="2">2×</option><option value="4">4×</option><option value="8">8×</option></select></div>
      <div class="transport-tools"><button id="final" class="transport-icon" aria-label="Eserin tamamını göster" title="Son hâl">${icon('final')}</button><button id="fit" class="transport-icon" aria-label="Eseri ekrana sığdır" title="Ekrana sığdır · F">${icon('fit')}</button><button id="export" class="export-button" aria-label="4K eser önizlemesini hazırla" title="4096 × 4096 PNG">${icon('export')}<span id="exportLabel">Görseli kaydet</span><span class="export-tag">4K</span></button></div>
    </nav>
    <footer class="footer"><div class="footer-help">Sürükle · yörüngede dön<span class="desktop-help"> <span aria-hidden="true">·</span> Shift · kaydır <span aria-hidden="true">·</span> Tekerlek · yaklaş <span aria-hidden="true">·</span> Sahne: H</span></div><div class="footer-right">COSMIC SYMPHONY / DATA ART</div></footer>
    <button id="focusReturn" class="focus-return" hidden>${icon('focus')}<span>Arayüzü göster</span><span class="desktop-help"> · H</span></button>
    <dialog id="exportPreview" class="export-preview" aria-labelledby="exportPreviewTitle" aria-describedby="exportPreviewMeta">
      <header class="export-preview-head"><div><div class="drawer-eyebrow">2000 TRACES / BASKI</div><h2 id="exportPreviewTitle">Eserin son hâli</h2></div><button id="closeExportPreview" aria-label="Eser önizlemesini kapat" autofocus>${icon('close')}</button></header>
      <div class="export-preview-art"><img id="exportPreviewImage" alt="4K eser önizlemesi"></div>
      <footer class="export-preview-foot"><div><p id="exportPreviewMeta"></p><p id="exportPreviewNote" class="export-preview-note">Tam kayıt · standart bakış · seçim vurgusu içermez</p></div><a id="exportDownload" class="export-download">${icon('export')}<span>PNG'yi indir</span></a></footer>
    </dialog>
    <div id="announcement" class="sr-only" role="status" aria-live="polite" aria-atomic="true"></div>
  `;
  document.body.appendChild(el);
  const $ = (id) => el.querySelector('#' + id);
  let durationMs = 180000;
  let liveMode = false;
  let hasArtwork = false;
  let loading = false;
  let focused = false;
  let exportPending = false;
  let previewUrl = null;
  let previewReturnFocus = null;
  let lastTime = null;
  let lastClock = null;
  let lastPlaying = null;
  let libraryModel = null;
  let knownPacks = [];
  let libraryHandlers = {};
  let libraryReturnFocus = null;
  let seatInfo = null;
  let gestureState = null;
  let gestureSummary = null;
  let orbitMotion = false;
  let udpEnabled = false; let udpBusy = false; let simulatedArtwork = false;
  const deleteTimers = new Set();
  const write = (id, value) => { const text = String(value ?? ''); if ($(id).textContent !== text) $(id).textContent = text; };
  const announce = (value) => write('announcement', value);
  const run = (callback, ...args) => {
    try {
      const result = callback?.(...args);
      if (result?.catch) result.catch((error) => setStats(`İşlem tamamlanamadı: ${error?.message ?? error}`));
      return result;
    } catch (error) { setStats(`İşlem tamamlanamadı: ${error?.message ?? error}`); return undefined; }
  };
  // Pointer activation drops focus to avoid a later Space reactivating Record.
  // Keyboard activation keeps its focus indicator and follows button semantics.
  const click = (id, callback) => { $(id).onclick = (event) => { if (event.detail) event.currentTarget.blur(); run(callback); }; };
  const syncDisabled = () => {
    for (const id of ['play', 'restart', 'scrub', 'speed', 'final']) $(id).disabled = liveMode || !hasArtwork || udpBusy;
    $('export').disabled = liveMode || !hasArtwork || exportPending || loading;
    $('pack').disabled = liveMode || udpEnabled || udpBusy;
    $('demo').disabled = liveMode || loading || udpEnabled || udpBusy;
    $('home').disabled = udpEnabled || udpBusy;
    $('rec').disabled = udpEnabled || udpBusy;
    $('udpEnable').disabled = liveMode || !hasArtwork || simulatedArtwork || udpBusy || loading;
    for (const option of $('speed').options) option.disabled = udpEnabled && Number(option.value) > 4;
  };
  const validAxis = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
  const syncInspection = () => {
    $('seatPanel').hidden = !seatInfo && !gestureState;
    $('gestureDetail').hidden = !gestureState;
    if (seatInfo) {
      write('selPid', seatInfo.title);
    } else if (gestureState) {
      write('selPid', gestureState.pid ?? (Number.isInteger(gestureState.lane) ? `Katılımcı ${gestureState.lane + 1}` : 'Seçilen hareket'));
      write('selMeta', 'Kayıt hareketinin yeniden oynatımı');
    }
  };
  const setGestureState = (state) => {
    gestureState = state && typeof state === 'object' ? state : null;
    if (!gestureState) {
      $('gesturePoint').setAttribute('hidden', ''); $('gestureTrail').setAttribute('d', '');
      syncInspection(); return;
    }
    const { x, y, t, active, exact, finger, hasXY, trail } = gestureState;
    const xValid = validAxis(x); const yValid = validAxis(y);
    const coordinatePair = hasXY !== false && xValid && yValid;
    write('gestureX', xValid ? x.toFixed(3) : '—');
    $('gestureX').title = xValid ? String(x) : '';
    write('gestureY', yValid ? y.toFixed(3) : '—');
    $('gestureY').title = yValid ? String(y) : '';
    write('gestureTime', typeof t === 'number' && Number.isFinite(t) ? `${(Math.max(0, t) / 1000).toFixed(2)} s` : '—');
    write('gestureFinger', Number.isInteger(finger) ? String(finger) : '—');
    write('gestureActivity', !coordinatePair ? 'X/Y mevcut değil' : active ? 'Jest sürüyor' : 'Son kayıtlı konum');
    $('gestureDetail').dataset.active = String(!!active && coordinatePair);
    $('gesturePoint').toggleAttribute('hidden', !coordinatePair);
    if (coordinatePair) {
      $('gesturePoint').setAttribute('cx', String(10 + x * 80));
      $('gesturePoint').setAttribute('cy', String(90 - y * 80));
    }
    let connected = false;
    const path = [];
    for (const point of Array.isArray(trail) ? trail.slice(-64) : []) {
      if (!validAxis(point?.x) || !validAxis(point?.y) || point.hasXY === false) { connected = false; continue; }
      path.push(`${connected ? 'L' : 'M'}${(10 + point.x * 80).toFixed(2)},${(90 - point.y * 80).toFixed(2)}`);
      connected = true;
    }
    const d = path.join(' ');
    if ($('gestureTrail').getAttribute('d') !== d) $('gestureTrail').setAttribute('d', d);
    const legacy = exact === false || gestureSummary?.source === 'legacy';
    write('gestureAccuracy', legacy ? '16-bit X/Y · eski pakette eksik eksen / dokunuş bilgisi ayırt edilemez.' : exact === true ? gestureSummary?.source === 'demo' ? 'Örnek koordinatlar · en fazla 64 iz noktası' : 'Kayıtlı koordinatlar · en fazla 64 iz noktası' : 'Koordinat kaynağı doğrulanmayı bekliyor.');
    syncInspection();
  };
  const setGestureSummary = (summary) => {
    gestureSummary = summary && typeof summary === 'object' ? summary : null;
    $('gestureSummary').hidden = !gestureSummary;
    if (!gestureSummary) return;
    const labels = { recorded: 'X/Y kayıt mevcut', legacy: 'Eski paket · 16-bit X/Y', demo: 'Örnek X/Y verisi' };
    write('gestureSummary', summary.label || (summary.available === false ? 'Bu kayıtta X/Y mevcut değil' : labels[summary.source] || 'X/Y kaynağı doğrulanıyor'));
    if (gestureState) setGestureState(gestureState);
  };
  const setOrbitMotion = (on) => {
    orbitMotion = !!on;
    $('orbitMotion').setAttribute('aria-checked', String(orbitMotion));
    write('orbitMotionLabel', orbitMotion ? 'Açık' : 'Kapalı');
  };
  const setStats = (value) => {
    const text = String(value ?? '');
    write('stats', text);
    $('stats').classList.toggle('error', /hata|başarısız|yüklenemedi|tamamlanamadı|ulaşılamadı|koptu/i.test(text));
  };
  const setConnection = (state = 'offline', label) => {
    const labels = { offline: 'ARŞİV GÖRÜNÜMÜ', ready: 'ARŞİV KAYDI', live: 'CANLI KAYIT', error: 'BAĞLANTI KESİLDİ', demo: 'ÖRNEK VERİ · SİMÜLASYON' };
    $('connection').dataset.state = state;
    write('connectionLabel', label || labels[state] || state);
  };
  const setExportState = (state, message) => {
    exportPending = state === 'pending';
    write('exportLabel', exportPending ? 'Hazırlanıyor…' : 'Görseli kaydet');
    $('export').setAttribute('aria-busy', String(exportPending));
    syncDisabled();
    if (message) setStats(message);
    else if (state === 'success') announce('4K görsel hazır. Önizlemeden PNG dosyasını indirebilirsiniz.');
    else if (state === 'error') setStats('Görsel kaydedilemedi. Lütfen yeniden deneyin.');
  };
  const closeExportPreview = (restoreFocus = true) => {
    if ($('exportPreview').open) $('exportPreview').close();
    $('exportPreviewImage').removeAttribute('src');
    $('exportDownload').removeAttribute('href');
    $('exportDownload').removeAttribute('download');
    if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
    if (restoreFocus) {
      const target = focused ? $('focusReturn') : previewReturnFocus?.isConnected ? previewReturnFocus : $('export');
      target.focus({ preventScroll: true });
    }
    previewReturnFocus = null;
  };
  const openExportPreview = async (result) => {
    if (!result || typeof result.url !== 'string' || !result.url.startsWith('blob:')) throw new Error('Önizleme dosyası oluşturulamadı.');
    closeExportPreview(false);
    previewUrl = result.url;
    previewReturnFocus = $('export');
    const expectedUrl = previewUrl;
    $('exportPreview').dataset.theme = 'nebula';
    $('exportPreviewImage').src = previewUrl;
    $('exportDownload').href = previewUrl;
    $('exportDownload').download = result.filename || '2000-traces-4096px.png';
    const megabytes = (Number(result.bytes || 0) / 1048576).toLocaleString('tr-TR', { maximumFractionDigits: 1 });
    write('exportPreviewMeta', `${result.width} × ${result.height} px · PNG · ${megabytes} MB`);
    write('exportPreviewNote', 'Tam kayıt · standart bakış · seçim vurgusu içermez');
    try {
      await $('exportPreviewImage').decode();
      if (previewUrl !== expectedUrl) return;
      $('exportPreview').showModal();
      $('closeExportPreview').focus({ preventScroll: true });
    } catch (error) { if (previewUrl === expectedUrl) closeExportPreview(false); throw error; }
  };
  $('exportPreview').addEventListener('cancel', (event) => { event.preventDefault(); closeExportPreview(); });
  window.addEventListener('pagehide', () => closeExportPreview(false));
  const setFocusMode = (on) => {
    const changed = focused !== !!on;
    if ($('exportPreview').open) closeExportPreview(false);
    focused = !!on;
    if (focused) { setLibraryOpen(false); setLegendOpen(false); }
    el.classList.toggle('focus-mode', focused);
    $('focusReturn').hidden = !focused;
    if (focused) $('focusReturn').focus({ preventScroll: true });
    else $('focus').focus({ preventScroll: true });
    if (changed) run(onFocusMode, focused);
  };
  const setLibraryOpen = (on) => {
    if (on) { libraryReturnFocus = document.activeElement; setLegendOpen(false); }
    $('libPanel').hidden = !on;
    el.classList.toggle('library-open', !!on);
    $('libBtn').setAttribute('aria-expanded', String(!!on));
    $('libBtn').setAttribute('aria-label', on ? 'Kayıt kütüphanesini kapat' : 'Kayıt kütüphanesini aç');
    if (on) $('librarySearch').focus({ preventScroll: true });
    else if ($('libPanel').contains(document.activeElement)) {
      (libraryReturnFocus instanceof HTMLElement && libraryReturnFocus !== document.body ? libraryReturnFocus : $('libBtn')).focus({ preventScroll: true });
    }
  };
  const setLegendOpen = (on) => {
    $('legendPanel').hidden = !on;
    el.classList.toggle('legend-open', !!on);
    $('readArtwork').setAttribute('aria-expanded', String(!!on));
    if (on) setLibraryOpen(false);
    else if ($('legendPanel').contains(document.activeElement)) $('readArtwork').focus({ preventScroll: true });
  };
  $('pack').onchange = (event) => { if (event.isTrusted) event.target.blur(); run(onPack, event.target.value); };
  click('play', onPlayPause); click('restart', onRestart); click('final', onFinal); click('fit', onFit);
  click('deselect', onDeselect); click('rec', onRecord); click('libBtn', onLibrary || (() => setLibraryOpen($('libPanel').hidden)));
  click('closeLibrary', () => setLibraryOpen(false));
  click('closeExportPreview', () => closeExportPreview());
  click('demo', onDemo);
  click('home', onHome);
  click('cameraJourney', onJourney);
  click('udpEnable', onUdpEnable); click('udpDisable', onUdpDisable); click('udpOutputBadge', onUdpDisable);
  click('orbitMotion', () => { setOrbitMotion(!orbitMotion); run(onOrbitMotion, orbitMotion); });
  click('readArtwork', () => setLegendOpen($('legendPanel').hidden));
  click('closeLegend', () => setLegendOpen(false));
  click('focus', () => setFocusMode(true)); click('focusReturn', () => setFocusMode(false));
  $('legendTiltRow').hidden = !onTilt;
  $('tilt').oninput = (event) => {
    const degrees = Number(event.target.value);
    write('tiltValue', `${degrees}°`);
    $('tilt').setAttribute('aria-valuetext', `${degrees} derece`);
    run(onTilt, degrees * Math.PI / 180);
  };
  $('scrub').oninput = (event) => run(onSeek, Number(event.target.value));
  $('speed').onchange = (event) => run(onSpeed, Number(event.target.value));
  click('export', async () => {
    if (exportPending || liveMode || !hasArtwork || !onExport) return;
    setExportState('pending');
    try { const result = await onExport(); await openExportPreview(result); setExportState('success'); }
    catch (error) { setExportState('error', `Görsel kaydedilemedi: ${error?.message ?? error}`); }
  });
  $('demo').hidden = !onDemo;
  $('home').hidden = !onHome;
  $('cameraJourney').hidden = !onJourney;
  $('udpOutput').hidden = !onUdpEnable;
  $('orbitMotionRow').hidden = !onOrbitMotion;

  window.addEventListener('keydown', (event) => {
    if ($('exportPreview').open) {
      if (event.key === 'Escape') { event.preventDefault(); closeExportPreview(); }
      event.stopImmediatePropagation();
      return;
    }
    if (editableTarget(event.target)) {
      if (event.key === 'Escape' && !$('libPanel').hidden) { event.preventDefault(); setLibraryOpen(false); }
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
    if (event.key.toLowerCase() === 'h') { event.preventDefault(); setFocusMode(!focused); }
    if (event.key === 'Escape') {
      if (focused) setFocusMode(false);
      if (!$('libPanel').hidden) setLibraryOpen(false);
      if (!$('legendPanel').hidden) setLegendOpen(false);
    }
  });
  const labelLayer = document.createElement('div');
  labelLayer.id = 'zoneLabels';
  labelLayer.setAttribute('aria-hidden', 'true');
  document.body.appendChild(labelLayer);

  const setPacks = (entries = [], selected) => {
    const previous = selected ?? $('pack').value;
    knownPacks = entries.map((entry) => typeof entry === 'string' ? { name: entry, label: entry } : entry);
    const options = knownPacks.map((item) => {
      const option = document.createElement('option'); option.value = item.name; option.textContent = item.label || item.name; return option;
    });
    if (!options.length) { const option = document.createElement('option'); option.value = ''; option.textContent = 'Henüz kayıt yok'; option.disabled = true; options.push(option); }
    $('pack').replaceChildren(...options);
    if (previous === '__demo__') {
      const option = document.createElement('option'); option.value = '__demo__'; option.textContent = 'Örnek eser · simülasyon'; $('pack').prepend(option);
    }
    if ([...$('pack').options].some((option) => option.value === previous)) $('pack').value = previous;
  };
  const setPack = (name) => {
    if (name === '__demo__' && ![...$('pack').options].some((option) => option.value === name)) {
      const option = document.createElement('option'); option.value = name; option.textContent = 'Örnek eser · simülasyon'; $('pack').prepend(option);
    }
    $('pack').value = name;
  };
  const clearDeleteTimers = () => { for (const timer of deleteTimers) clearTimeout(timer); deleteTimers.clear(); };
  const makeButton = (label, fn, cls = '') => {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.className = cls;
    button.onclick = (event) => { if (event.detail) event.currentTarget.blur(); run(fn); };
    return button;
  };
  const armedDelete = (button, callback, name) => {
    let timer = null;
    button.setAttribute('aria-label', `${name} kaydını sil`);
    button.onclick = (event) => {
      if (event.detail) event.currentTarget.blur();
      if (timer === null) {
        button.textContent = 'Silmek için tekrar bas'; button.classList.add('armed');
        button.setAttribute('aria-label', `${name} kaydını silmeyi onayla`);
        announce(`${name} kaydını silmek için dört saniye içinde tekrar basın.`);
        timer = setTimeout(() => {
          deleteTimers.delete(timer); timer = null; button.textContent = 'Sil'; button.classList.remove('armed'); button.setAttribute('aria-label', `${name} kaydını sil`);
        }, 4000); deleteTimers.add(timer);
      } else {
        clearTimeout(timer); deleteTimers.delete(timer); timer = null;
        button.textContent = 'Sil'; button.classList.remove('armed'); button.disabled = true;
        run(callback);
      }
    };
  };
  const drawLibrary = () => {
    clearDeleteTimers();
    const body = $('libBody'); body.replaceChildren();
    if (!libraryModel) { const p = document.createElement('p'); p.className = 'lib-empty'; p.textContent = 'Kütüphane yükleniyor…'; body.append(p); return; }
    const empty = (title, copy) => {
      const box = document.createElement('div'); box.className = 'lib-empty';
      const heading = document.createElement('strong'); heading.textContent = title;
      const description = document.createElement('span'); description.textContent = copy;
      box.append(heading, description); body.append(box);
    };
    if (libraryModel.offline) {
      empty('Kayıt paneli çevrimdışı.', knownPacks.length ? 'Arşivdeki eserleri keşfedebilirsiniz. Kayıt yönetimi için yerel paneli açın.' : 'Kayıt yönetimi için yerel paneli açın veya örnek eseri keşfedin.');
      const query = $('librarySearch').value.trim().toLocaleLowerCase('tr-TR');
      const available = knownPacks.filter((pack) => `${pack.label || ''} ${pack.name}`.toLocaleLowerCase('tr-TR').includes(query));
      for (const pack of available) {
        const row = document.createElement('article'); row.className = 'libRow';
        const title = document.createElement('div'); title.className = 'lib-title'; title.textContent = pack.label || pack.name;
        const open = makeButton('Eseri aç ↗', () => { run(onPack, pack.name); setLibraryOpen(false); }); open.disabled = liveMode || udpEnabled || udpBusy;
        open.disabled = liveMode || udpEnabled || udpBusy;
        open.setAttribute('aria-label', `${pack.label || pack.name} eserini aç`); row.append(title, open); body.append(row);
      }
      if (query && !available.length) empty('Bu aramada bir iz bulunamadı.', 'Farklı bir kayıt adıyla yeniden deneyin.');
      if (onDemo) body.append(makeButton('Örnek eseri aç', () => { setLibraryOpen(false); run(onDemo); }));
      return;
    }
    const query = $('librarySearch').value.trim().toLocaleLowerCase('tr-TR');
    const matches = (item, key) => `${item.label || ''} ${item[key] || ''}`.toLocaleLowerCase('tr-TR').includes(query);
    const packList = (libraryModel.packs || []).filter((p) => matches(p, 'name'));
    const sessionList = (libraryModel.sessions || []).filter((s) => s.packName === null && matches(s, 'file'));
    const section = (title) => { const heading = document.createElement('div'); heading.className = 'lib-section-label'; heading.textContent = title; body.append(heading); };
    const row = (title, meta, actions) => {
      const element = document.createElement('article'); element.className = 'libRow';
      const info = document.createElement('div'); info.className = 'libInfo';
      const name = document.createElement('div'); name.className = 'lib-title'; name.textContent = title;
      const detail = document.createElement('div'); detail.className = 'lib-meta'; detail.textContent = meta;
      info.append(name, detail);
      const buttons = document.createElement('div'); buttons.className = 'libActs'; buttons.append(...actions);
      element.append(info, buttons); body.append(element);
    };
    if (packList.length) section(`${packList.length} eser`);
    for (const pack of packList) {
      const title = pack.label || pack.name;
      const open = makeButton('Eseri aç ↗', () => { run(libraryHandlers.onOpen, pack.name); setLibraryOpen(false); });
      open.setAttribute('aria-label', `${title} eserini aç`); open.disabled = liveMode || udpEnabled || udpBusy;
      const remove = makeButton('Sil', null, 'danger'); armedDelete(remove, () => libraryHandlers.onDeletePack?.(pack.name), title); remove.disabled = liveMode || udpEnabled || udpBusy;
      row(title, `${number(pack.lanes)} katılımcı · ${number(pack.events ?? 0)} etkileşim`, [open, remove]);
    }
    if (sessionList.length) section('İşlenmemiş kayıtlar');
    for (const session of sessionList) {
      const title = session.label || session.file;
      const process = makeButton('Esere dönüştür', () => libraryHandlers.onPackSession?.(session.file)); process.disabled = liveMode || udpEnabled || udpBusy;
      const remove = makeButton('Sil', null, 'danger'); armedDelete(remove, () => libraryHandlers.onDeleteSession?.(session.file), title); remove.disabled = liveMode || udpEnabled || udpBusy;
      row(title, `${(Number(session.bytes || 0) / 1048576).toFixed(1)} MB · ${session.complete ? 'Kayıt tamamlandı' : 'Tamamlanmamış kayıt'}`, [process, remove]);
    }
    if (!packList.length && !sessionList.length) empty(query ? 'Bu aramada bir iz bulunamadı.' : 'İlk iz henüz bırakılmadı.', query ? 'Farklı bir kayıt adıyla yeniden deneyin.' : 'Canlı akıştan bir kayıt oluşturun veya örnek eseri keşfedin.');
  };
  $('librarySearch').oninput = drawLibrary;
  setPacks(packs);
  syncDisabled();

  return {
    setStats,
    setDuration(ms) {
      lastTime = null; lastClock = null;
      durationMs = Math.max(1, Number(ms) || 1); $('scrub').max = String(durationMs); write('duration', clock(durationMs));
    },
    setTime(ms, playing) {
      const value = Math.min(durationMs, Math.round(Math.max(0, Number(ms) || 0) / 50) * 50);
      const formatted = clock(ms);
      if (lastTime !== value) { $('scrub').value = String(value); $('scrub').style.setProperty('--progress', `${Math.min(100, value / durationMs * 100)}%`); lastTime = value; }
      if (lastClock !== formatted) { write('clock', formatted); $('scrub').setAttribute('aria-valuetext', `${formatted} / ${clock(durationMs)}`); lastClock = formatted; }
      if (lastPlaying !== !!playing) { $('play').innerHTML = icon(playing ? 'pause' : 'play'); $('play').setAttribute('aria-label', playing ? 'Duraklat' : 'Oynat'); lastPlaying = !!playing; }
    },
    setPack, setPacks,
    setArtwork(manifest, { demo = false } = {}) {
      if (!manifest) return this.setEmpty();
      hasArtwork = true;
      seatInfo = null; setGestureState(null); setGestureSummary(null);
      const selectedPack = knownPacks.find((pack) => pack.name === $('pack').value);
      if (!liveMode && !demo && selectedPack && manifest.label) selectedPack.label = manifest.label;
      const simulated = demo || manifest.simulated === true;
      simulatedArtwork = simulated;
      write('udpExplanation', simulated ? 'Örnek eserlerde UDP çıkışı kapalıdır. Ses için kaydedilmiş bir oturum açın.' : 'Hazırlamak ses göndermez. Ardından Oynat ile kayıtlı nota ve hareketleri ses yönlendirmesine gönderin.');
      write('participants', number(manifest.laneCount)); write('events', number(manifest.eventCount));
      write('workKicker', liveMode ? 'Canlı kayıt' : simulated ? 'Örnek veri · simülasyon' : 'Kolektif kayıt');
      write('workName', manifest.label || manifest.sessionId || 'İsimsiz kayıt');
      const zones = Array.isArray(manifest.zones) ? ` · ${number(manifest.zones.length)} bölge` : '';
      write('workFormat', `${clock(manifest.durationMs)} süre${zones}${simulated ? ' · canlı veri içermez' : ''}`);
      $('demo').hidden = simulated || !onDemo;
      setConnection(liveMode ? 'live' : simulated ? 'demo' : 'ready');
      setStats(''); syncDisabled();
    },
    setLiveMetrics({ participants, events } = {}) { if (participants !== undefined) write('participants', number(participants)); if (events !== undefined) write('events', number(events)); },
    setLoading(on, label) { loading = !!on; el.dataset.loading = String(loading); $('loading').hidden = !loading; write('loadingLabel', label || 'Eser yükleniyor'); syncDisabled(); },
    setConnection,
    setEmpty(message) {
      hasArtwork = false; simulatedArtwork = false; seatInfo = null; setGestureState(null); setGestureSummary(null); write('participants', '—'); write('events', '—'); write('workKicker', 'Kolektif arşiv'); write('workName', 'İlk iz için hazır'); write('workFormat', 'Ses · hareket · zaman');
      $('demo').hidden = !onDemo; setStats(message || 'Arşivden bir eser seçin veya örnek eseri keşfedin.'); setConnection('offline'); syncDisabled();
    },
    setViewMode(mode) {
      // Compatibility for callers passing a live/legacy mode: the artwork now
      // has one visual language, with the recording state owned by setLiveMode.
      el.dataset.view = 'nebula';
      document.body.dataset.theme = 'nebula';
      $('nebulaLegend').hidden = false;
      $('orbitMotionRow').hidden = !onOrbitMotion;
      $('readArtwork').hidden = false;
      write('legendIntro', mode === 'record' || mode === 'live' ? 'Katılımcıların hareketleriyle oluşan bir çekim alanı.' : 'Kayıtlı hareketlerden oluşan bir çekim alanı.');
    },
    setGestureState, setGestureSummary, setOrbitMotion,
    setUdpState({ enabled = false, busy = false, status = null, error = null, stale = false } = {}) {
      const changed = udpEnabled !== !!enabled || udpBusy !== !!busy;
      udpEnabled = !!enabled; udpBusy = !!busy;
      const labels = { READY: 'Hazır · Oynat ile başlatın', PLAYING: 'UDP gönderiliyor', PAUSED: 'UDP duraklatıldı', COMPLETE: 'UDP oynatımı tamamlandı', ERROR: 'UDP işlemi durdu' };
      write('udpStatus', error || (busy ? 'UDP işlemi sürüyor…' : enabled ? labels[status?.state] || 'UDP hazırlanıyor' : 'Kapalı · görsel oynatma sessizdir'));
      $('udpStatus').classList.toggle('error', !!error);
      $('udpEnable').hidden = enabled;
      $('udpDisable').hidden = !enabled && !busy;
      $('udpOutputBadge').hidden = !enabled && !busy;
      write('udpOutputBadge', `${stale || error ? 'UDP durumu belirsiz' : status?.state === 'PLAYING' ? 'UDP gönderiliyor' : busy ? 'UDP bekleniyor' : 'UDP hazır'} · çıkışı kapat`);
      if (enabled && status?.speed) $('speed').value = String(status.speed);
      if (changed) { syncDisabled(); if (libraryModel && !$('libPanel').hidden) drawLibrary(); }
    },
    setExportState,
    setJourneyState(active) {
      $('cameraJourney').setAttribute('aria-pressed', String(!!active));
      write('cameraJourneyLabel', active ? 'Yolculuğu durdur' : 'Kara deliğe yaklaş');
    },
    setTilt(radians) {
      const degrees = Math.max(-35, Math.min(35, Math.round((Number(radians) || 0) * 180 / Math.PI)));
      $('tilt').value = String(degrees); write('tiltValue', `${degrees}°`);
      $('tilt').setAttribute('aria-valuetext', `${degrees} derece`);
    },
    setFocusMode,
    setRecState(label, on) {
      const text = !on && /^●?\s*KAYIT$/i.test(label) ? 'Canlı kayıt' : String(label).replace(/^[●■]\s*/, '');
      write('recLabel', text); $('rec').classList.toggle('on', !!on); $('rec').title = text;
      $('rec').setAttribute('aria-label', on ? `Canlı kaydı durdur: ${text}` : 'Canlı kayıt başlat');
      $('rec').setAttribute('aria-pressed', String(!!on));
    },
    setLiveMode(on) {
      liveMode = !!on; el.dataset.live = String(liveMode);
      write('legendIntro', liveMode ? 'Katılımcıların hareketleriyle oluşan bir çekim alanı.' : 'Kayıtlı hareketlerden oluşan bir çekim alanı.');
      if (on) { seatInfo = null; setGestureState(null); setGestureSummary(null); write('workKicker', 'Canlı kayıt'); write('workName', 'Birlikte oluşan bir an'); write('workFormat', 'Katılımcılardan gelen canlı izler'); setConnection('live'); }
      else if ($('connection').dataset.state === 'live') setConnection('ready');
      syncDisabled(); if (libraryModel && !$('libPanel').hidden) drawLibrary();
    },
    isLibraryOpen: () => !$('libPanel').hidden,
    setLibraryOpen,
    renderLibrary(model, handlers = {}) { libraryModel = model; libraryHandlers = handlers; drawLibrary(); },
    showSeat(info) {
      seatInfo = info;
      if (!info) setGestureState(null);
      else { setLegendOpen(false); write('selPid', info.title); $('selMeta').replaceChildren(seatContent(info.meta)); }
      syncInspection();
    },
    labelLayer,
  };
}

export function updateZoneLabels(layer, layout, project, pxPerWorld) {
  const sig = JSON.stringify(layout.zoneBands.map((band) => [band.zone, band.laneStart]));
  if (layer.dataset.sig !== sig) {
    layer.dataset.sig = sig;
    layer.replaceChildren(...layout.zoneBands.map((band) => { const label = layer.ownerDocument.createElement('span'); label.className = 'zl'; label.textContent = String(band.zone); return label; }));
  }
  layout.zoneBands.forEach((band, i) => {
    const label = layer.children[i];
    const point = project(0, (band.r0 + band.r1) / 2);
    const bandPx = (band.r1 - band.r0) * pxPerWorld;
    label.style.transform = `translate(${point.x}px, ${point.y}px)`;
    label.style.opacity = bandPx >= 11 && point.visible ? '0.8' : '0';
  });
}
