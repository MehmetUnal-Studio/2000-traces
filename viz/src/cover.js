// An original procedural event cover. Its stars and planetary light are an
// atmospheric illustration, independent of the participant recording.
const arrow = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h15m-5-5 5 5-5 5"/></svg>';
const star = '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="m16 1 3.6 10.8L31 16l-11.4 4.2L16 31l-3.6-10.8L1 16l11.4-4.2Z"/></svg>';

function noise(x, y) {
  const ix = Math.floor(x); const iy = Math.floor(y);
  const fx = x - ix; const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx); const sy = fy * fy * (3 - 2 * fy);
  const hash = (a, b) => {
    let n = Math.imul(a, 374761393) + Math.imul(b, 668265263);
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
  };
  const a = hash(ix, iy); const b = hash(ix + 1, iy);
  const c = hash(ix, iy + 1); const d = hash(ix + 1, iy + 1);
  return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
}

function mist(x, y) {
  return noise(x, y) * .54 + noise(x * 2.13 + 17, y * 2.13) * .27 + noise(x * 4.31, y * 4.31 + 11) * .13 + noise(x * 9.3, y * 9.3) * .06;
}

function makeSky(canvas) {
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) return { show() {}, hide() {}, dispose() {} };
  const plate = document.createElement('canvas');
  const plateCtx = plate.getContext('2d', { alpha: false });
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let width = 1; let height = 1; let horizon = 1; let radius = 1;
  let stars = []; let frame = 0; let visible = false; let previous = 0;
  let seed = 54781;
  const random = () => { seed = Math.imul(seed, 1664525) + 1013904223; return (seed >>> 0) / 4294967296; };

  function rebuild() {
    width = Math.max(1, window.innerWidth); height = Math.max(1, window.innerHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    horizon = height * (width < 600 ? .76 : .78);
    radius = Math.max(width * .86, height * .68);
    const scale = Math.min(1, 760 / width, 620 / height);
    plate.width = Math.ceil(width * scale); plate.height = Math.ceil(height * scale);
    const pixels = plateCtx.createImageData(plate.width, plate.height);
    for (let py = 0; py < plate.height; py++) {
      for (let px = 0; px < plate.width; px++) {
        const x = px / scale; const y = py / scale;
        const dx = x - width * .5; const dy = y - horizon - radius;
        const distance = Math.hypot(dx, dy) - radius;
        const n = mist(x / 125 + 30, y / 95 + 17);
        const fine = noise(x / 4.5, y / 1.6);
        const hot = .42 + .58 * Math.exp(-Math.pow(dx / (width * .39), 2));
        let r; let g; let b;
        if (distance >= 0) {
          const smoke = Math.pow(n, 2.5) * Math.exp(-distance / (32 + height * .035));
          const corona = Math.exp(-distance / (4 + height * .012)) * (.4 + n * .9);
          const broad = Math.exp(-distance / (height * .19)) * Math.pow(n, 2.5);
          const sky = mist(x / 310 - 19, y / 270) * .8;
          r = 3 + sky * 4 + hot * (smoke * 118 + corona * 143 + broad * 18);
          g = 6 + sky * 5 + hot * (smoke * 71 + corona * 107 + broad * 8);
          b = 10 + sky * 8 + hot * (smoke * 28 + corona * 50 + broad * 3);
        } else {
          const depth = -distance;
          const edge = Math.exp(-depth / (height * .055)) * hot;
          const texture = (.3 + n * .65 + fine * .18) * edge;
          r = 2 + texture * 22;
          g = 5 + texture * 33;
          b = 9 + texture * 37;
          const gold = Math.exp(-depth / 2.2) * hot;
          r += gold * 113; g += gold * 75; b += gold * 29;
        }
        const vignette = Math.min(1, .32 + 1.1 * (1 - Math.pow(Math.abs(dx) / width, .9)));
        const i = (py * plate.width + px) * 4;
        pixels.data[i] = Math.min(255, r * vignette);
        pixels.data[i + 1] = Math.min(255, g * vignette);
        pixels.data[i + 2] = Math.min(255, b * vignette);
        pixels.data[i + 3] = 255;
      }
    }
    plateCtx.putImageData(pixels, 0, 0);
    seed = 54781;
    stars = Array.from({ length: Math.min(1200, Math.round(width * height / 1400)) }, () => ({
      x: random() * width, y: random() * height, size: .22 + Math.pow(random(), 5) * 1.35,
      brightness: .2 + Math.pow(random(), 2) * .72, phase: random() * Math.PI * 2,
      warm: random() > .84,
    })).filter((point) => Math.hypot(point.x - width * .5, point.y - horizon - radius) > radius + 4);
    draw(0);
  }

  function draw(time) {
    ctx.drawImage(plate, 0, 0, width, height);
    for (const point of stars) {
      const alpha = point.brightness * (reducedMotion.matches ? 1 : .84 + .16 * Math.sin(time * .00035 + point.phase));
      ctx.fillStyle = point.warm ? `rgba(238,199,150,${alpha})` : `rgba(207,226,242,${alpha})`;
      ctx.beginPath(); ctx.arc(point.x, point.y, point.size, 0, Math.PI * 2); ctx.fill();
      if (point.size > 1.2) {
        const glow = ctx.createRadialGradient(point.x, point.y, 0, point.x, point.y, 11);
        glow.addColorStop(0, `rgba(191,215,237,${alpha * .15})`); glow.addColorStop(1, 'rgba(191,215,237,0)');
        ctx.fillStyle = glow; ctx.fillRect(point.x - 11, point.y - 11, 22, 22);
      }
    }
    // A fine, uneven illuminated limb sits within the mist; the surface below
    // it is shaded and textured, so the horizon is never a flat SVG ellipse.
    const rim = ctx.createLinearGradient(0, 0, width, 0);
    rim.addColorStop(0, 'rgba(177,104,44,.15)'); rim.addColorStop(.28, 'rgba(228,164,78,.58)');
    rim.addColorStop(.5, 'rgba(255,227,165,.88)'); rim.addColorStop(.72, 'rgba(228,164,78,.58)'); rim.addColorStop(1, 'rgba(177,104,44,.15)');
    ctx.strokeStyle = rim; ctx.lineWidth = .9; ctx.beginPath();
    for (let x = 0; x <= width; x += 2) {
      const dx = x - width * .5;
      const y = horizon + radius - Math.sqrt(radius * radius - dx * dx) + (noise(x * .06, 4) - .5) * .7;
      x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  function animate(time) {
    frame = 0;
    if (!visible || document.hidden || reducedMotion.matches) return;
    if (time - previous >= 80) { draw(time); previous = time; }
    frame = requestAnimationFrame(animate);
  }
  function stop() { if (frame) cancelAnimationFrame(frame); frame = 0; }
  function resume() { stop(); if (visible) { draw(performance.now()); if (!document.hidden && !reducedMotion.matches) frame = requestAnimationFrame(animate); } }
  const resize = () => { if (visible) rebuild(); };
  window.addEventListener('resize', resize);
  document.addEventListener('visibilitychange', resume);
  reducedMotion.addEventListener('change', resume);
  return {
    show() { visible = true; rebuild(); resume(); },
    hide() { visible = false; stop(); },
    dispose() { stop(); window.removeEventListener('resize', resize); document.removeEventListener('visibilitychange', resume); reducedMotion.removeEventListener('change', resume); },
  };
}

export function createCover({ onEnter, onRecord, onArchive } = {}) {
  const el = document.createElement('section');
  el.id = 'eventCover'; el.className = 'event-cover'; el.hidden = true;
  el.setAttribute('aria-labelledby', 'coverTitle');
  el.innerHTML = `
    <canvas class="cover-sky" aria-hidden="true"></canvas>
    <div class="cover-vignette" aria-hidden="true"></div>
    <header class="cover-header"><div class="cover-company">${star}<span>YILDIZ<span class="cover-holding">HOLDING</span></span></div><div class="cover-event">SENENİN<br>YILDIZLARI</div></header>
    <div class="cover-editorial"><p class="cover-eyebrow">BİRLİKTE PARLAYAN YILDIZLARA</p><h1 id="coverTitle"><span class="cover-title-stars">Stars</span><span class="cover-title-year"><i>of</i> The Year</span></h1><p class="cover-copy">Her birimiz bir yıldız.<br>Birlikte, aynı gökyüzünde iz bırakıyoruz.</p><button id="coverEnter" class="cover-enter">Deneyime gir ${arrow}</button><p id="coverStatus" class="cover-status" role="status" aria-live="polite"></p></div>
    <div class="cover-horizon-label" aria-hidden="true"><span></span>ORTAK BİR GÖKYÜZÜ<span></span></div>
    <footer class="cover-footer"><div class="cover-signature"><span>2000 TRACES</span><span>BY COSMIC SYMPHONY</span></div><div class="cover-actions"><button id="coverRecord"><span class="cover-record-dot" aria-hidden="true"></span>Canlı kayıt başlat</button><button id="coverArchive">Kayıtları keşfet ${arrow}</button></div></footer>
  `;
  document.body.append(el);
  const $ = (id) => el.querySelector('#' + id);
  const sky = makeSky(el.querySelector('canvas'));
  let busy = false; let returnFocus = null; let background = [];
  const setBusy = (on, message = '') => {
    busy = !!on; el.setAttribute('aria-busy', String(busy));
    for (const button of el.querySelectorAll('button')) button.disabled = busy;
    $('coverStatus').textContent = message;
  };
  const invoke = async (callback) => {
    if (busy || !callback) return;
    setBusy(true, 'Hazırlanıyor…');
    try { await callback(); setBusy(false); }
    catch (error) { setBusy(false, `Açılamadı: ${error?.message || 'Lütfen yeniden deneyin.'}`); }
  };
  $('coverEnter').onclick = () => invoke(onEnter);
  $('coverRecord').onclick = () => invoke(onRecord);
  $('coverArchive').onclick = () => invoke(onArchive);
  $('coverRecord').hidden = !onRecord; $('coverArchive').hidden = !onArchive;
  el.addEventListener('keydown', (event) => {
    event.stopPropagation(); // H, F and Space must not operate the artwork behind the cover.
    if (event.key !== 'Tab') return;
    const buttons = [...el.querySelectorAll('button')].filter((button) => !button.hidden && !button.disabled);
    if (!buttons.length) { event.preventDefault(); return; }
    if (event.shiftKey && document.activeElement === buttons[0]) { event.preventDefault(); buttons.at(-1).focus(); }
    else if (!event.shiftKey && document.activeElement === buttons.at(-1)) { event.preventDefault(); buttons[0].focus(); }
  });
  // Disabling a pending action can move focus to body in some browsers.
  // Cover keyboard isolation must survive that transient focus change too.
  const guardBackgroundKey = (event) => {
    if (el.hidden || el.contains(event.target)) return;
    event.stopImmediatePropagation();
    if (event.key === 'Tab') {
      event.preventDefault();
      if (!busy) $('coverEnter').focus({ preventScroll: true });
    }
  };
  window.addEventListener('keydown', guardBackgroundKey, true);
  const hide = () => {
    if (el.hidden) return;
    el.hidden = true; sky.hide();
    for (const [node, inert] of background) node.inert = inert;
    background = []; document.body.classList.remove('cover-visible');
    if (returnFocus?.isConnected && !returnFocus.closest('[hidden]')) returnFocus.focus({ preventScroll: true });
  };
  return {
    element: el,
    get visible() { return !el.hidden; },
    show() {
      if (!el.hidden) return;
      returnFocus = document.activeElement;
      background = ['hud', 'c'].map((id) => document.getElementById(id)).filter(Boolean).map((node) => [node, node.inert]);
      for (const [node] of background) node.inert = true;
      el.hidden = false; document.body.classList.add('cover-visible'); setBusy(false); sky.show();
      $('coverEnter').focus({ preventScroll: true });
    },
    hide, setBusy,
    dispose() { hide(); sky.dispose(); window.removeEventListener('keydown', guardBackgroundKey, true); el.remove(); },
  };
}
