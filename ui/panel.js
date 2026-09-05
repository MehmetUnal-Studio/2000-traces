// Local operator UI. Polling only observes; a recording requires two explicit
// button actions. Losing this page never stops or restarts a server-side take.
const $ = (id) => document.getElementById(id);
const STATES = {
  IDLE: ['BEKLEMEDE', 'Yeni bir oturum için ARM ile kayıt sistemini hazırla.'],
  ARMED: ['HAZIR', 'Kayıt henüz başlamadı. Etiketi kontrol et, ardından kaydı başlat.'],
  RECORDING: ['KAYDEDİLİYOR', 'Gelen hareketler oturuma kaydediliyor. Gerekirse erken durdurabilirsin.'],
  FINALIZING: ['PAKETLENİYOR', 'Oturum kapatılıyor ve görselleştirme paketi hazırlanıyor.'],
  COMPLETE: ['TAMAMLANDI', 'Oturum tamamlandı. Ham kayıt aşağıdaki arşivde.'],
};
const numbers = new Intl.NumberFormat('tr-TR');
const dates = new Intl.DateTimeFormat('tr-TR', { dateStyle: 'medium', timeStyle: 'short' });
const times = new Intl.DateTimeFormat('tr-TR', { timeStyle: 'medium' });
let status = null;
let connected = false;
let pending = null;
let epoch = 0;
let timer = null;
let lastLibraryRefresh = 0;
let renderedRows = '';
let lastLabelSession = null;

const count = (value) => Number.isFinite(value) ? numbers.format(value) : '—';
const clock = (ms) => {
  const seconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
};
const size = (bytes) => bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1000))} KB`;
const setText = (id, value) => { if ($(id).textContent !== value) $(id).textContent = value; };

async function request(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch(path, { cache: 'no-store', ...options, signal: controller.signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Sunucu yanıtı: HTTP ${response.status}`);
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Sunucu 4 saniye içinde yanıt vermedi.');
    if (error instanceof TypeError) throw new Error('Yerel kayıt sunucusuyla bağlantı kurulamadı.');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function renderControls() {
  const state = status?.state;
  const ready = connected && !pending;
  const replay = status?.udpReplay;
  const udpBusy = replay?.state === 'PLAYING' || replay?.busy || replay?.activeVoices > 0;
  $('arm').disabled = !ready || udpBusy || !['IDLE', 'COMPLETE', 'ARMED'].includes(state);
  $('start').disabled = !ready || udpBusy || state !== 'ARMED';
  $('stop').disabled = !ready || state !== 'RECORDING';
  $('udp-stop').disabled = !ready || !(udpBusy || ['PAUSED', 'ERROR'].includes(replay?.state));
  $('take-label').disabled = !ready || !['IDLE', 'COMPLETE', 'ARMED'].includes(state);
  document.querySelector('.controls').setAttribute('aria-busy', String(Boolean(pending)));
  setText('arm-text', pending === 'arm' ? 'Bekleniyor…' : state === 'ARMED' ? 'DISARM · İptal' : 'ARM · Hazırla');
  setText('start-text', pending === 'start' ? 'Başlatılıyor…' : 'Kaydı başlat');
  setText('stop-text', pending === 'stop' ? 'Durduruluyor…' : 'Durdur');
  setText('udp-stop', pending === 'udp-stop' ? 'Durduruluyor…' : "■ UDP'yi durdur");
}

function renderStatus(next) {
  const previous = status;
  status = next;
  connected = true;
  $('connection').className = 'connection online';
  setText('connection-text', 'Sunucu bağlı');
  $('connection-error').hidden = true;
  $('state').className = `state ${next.state}`;
  setText('state', STATES[next.state][0]);
  let description = STATES[next.state][1];
  if (next.state === 'COMPLETE' && !next.participants) description = 'Oturum kapandı; katılımcı olayı alınmadığı için görsel paket oluşmadı.';
  else if (next.state === 'COMPLETE' && next.packName) description = 'Oturum ve görselleştirme paketi hazır. Ham kayıt aşağıdaki arşivde.';
  else if (next.state === 'COMPLETE' && !next.packError) description = 'Oturum kapandı. Ham kayıt arşivde; görsel paket henüz yok.';
  setText('state-description', description);
  const replay = next.udpReplay;
  const udpLabels = { EMPTY: 'ÇIKIŞ KAPALI', LOADING: 'YÜKLENİYOR', READY: 'HAZIR · ÇIKIŞ KAPALI', PLAYING: 'UDP GÖNDERİLİYOR', PAUSED: 'DURAKLATILDI', COMPLETE: 'TAMAMLANDI', ERROR: 'ÇIKIŞ HATASI' };
  setText('udp-state', udpLabels[replay?.state] ?? 'ÇIKIŞ KAPALI');
  $('udp-state').className = `state ${replay?.state === 'PLAYING' ? 'RECORDING' : ''}`;
  setText('udp-route', `${replay?.destination?.host ?? '127.0.0.1'}:${replay?.destination?.port ?? 6061}`);
  setText('udp-summary', replay?.error || (replay?.file
    ? `${replay.label || replay.file} · ${clock(replay.positionMs)} / ${clock(replay.durationMs)} · ${count(replay.datagramsSent)} UDP paketi · ${count(replay.activeVoices)} replay notası`
    : 'Kayıtlı bir eserden, görselleştiricideki UDP çıkışı kontrolüyle başlatılır.'));
  if (replay?.state === 'PLAYING' || replay?.activeVoices > 0) setText('state-description', 'UDP tekrar oynatımı sürüyor. Yeni kayıt için önce UDP çıkışını durdur.');
  const duration = Number.isFinite(next.durationMs) && next.durationMs > 0 ? next.durationMs : 180000;
  const elapsed = Number.isFinite(next.startedAtLocalMs)
    ? Math.max(0, (next.endedAtLocalMs ?? Date.now()) - next.startedAtLocalMs) : 0;
  setText('elapsed', clock(elapsed));
  setText('duration', clock(duration));
  $('progress').max = duration;
  $('progress').value = Math.min(duration, elapsed);
  const stats = next.stats;
  setText('participants', count(next.participants));
  setText('stored', count(stats?.stored ?? 0));
  setText('received', count(stats?.received ?? 0));
  setText('malformed', count(stats?.malformed ?? 0));
  setText('out-of-window', `${count(stats?.late ?? 0)} / ${count(stats?.early ?? 0)}`);
  setText('duplicates', count(stats?.duplicates ?? 0));
  setText('session-id', next.sessionId ?? 'Henüz kayıt yok');
  setText('metrics-context', next.state === 'RECORDING' ? 'AKTİF OTURUM' : next.state === 'FINALIZING' ? 'PAKETLENİYOR' : next.sessionId ? 'SON OTURUM' : 'KAYIT BEKLENİYOR');
  setText('updated-at', `Son güncelleme ${times.format(Date.now())}`);
  // On page refresh show the active take's authoritative label. Never overwrite
  // an operator's unsent draft while they are editing the next take.
  if (['RECORDING', 'FINALIZING'].includes(next.state) && lastLabelSession !== next.sessionId) {
    $('take-label').value = next.label ?? '';
    lastLabelSession = next.sessionId;
  }
  $('recording-error').hidden = !next.lastError && !next.packError;
  if (next.lastError) {
    setText('recording-error-title', 'Kayıt tamamlanamadı');
    setText('recording-error-text', next.lastError.message || 'Sunucu bir kayıt hatası bildirdi.');
  } else if (next.packError) {
    setText('recording-error-title', 'Görselleştirme paketi hazırlanamadı');
    setText('recording-error-text', `${next.packError} Ham JSONL kayıt diskte korunuyor; görselleştirici kütüphanesinden yeniden paketleyebilirsin.`);
  }
  if (previous?.state !== next.state || previous?.sessionId !== next.sessionId) lastLibraryRefresh = 0;
  renderControls();
}

function renderOffline(error) {
  connected = false;
  $('connection').className = 'connection offline';
  setText('connection-text', 'Bağlantı yok');
  $('connection-error').hidden = false;
  setText('connection-detail', error.message);
  $('state').className = 'state';
  setText('state', 'DURUM BİLİNMİYOR');
  setText('state-description', 'Sunucudan güncel durum alınamıyor. Görünen sayılar son başarılı güncellemeye ait.');
  setText('metrics-context', status ? 'SON BİLİNEN VERİ' : 'VERİ YOK');
  renderControls();
}

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function renderLibrary(sessions) {
  setText('session-count', count(sessions.length));
  const signature = JSON.stringify([sessions, status?.state, status?.sessionId]);
  $('library-message').hidden = sessions.length > 0;
  setText('library-message', 'Henüz oturum yok. İlk kayıt tamamlandığında burada görünecek.');
  $('sessions-table-wrap').hidden = sessions.length === 0;
  if (signature === renderedRows) return;
  renderedRows = signature;
  const fragment = document.createDocumentFragment();
  for (const session of sessions) {
    if (typeof session.file !== 'string') continue;
    const busy = ['RECORDING', 'FINALIZING'].includes(status?.state) && session.sessionId === status?.sessionId;
    const row = node('tr');
    const name = node('td');
    name.append(node('strong', session.label || 'İsimsiz oturum'));
    const date = Number.isFinite(session.mtimeMs) ? dates.format(session.mtimeMs) : 'Tarih bilinmiyor';
    name.append(node('small', date), node('small', session.file, 'file-id'));
    row.append(name, node('td', count(session.participants)), node('td', count(session.events)));
    const stateCell = node('td');
    const label = busy ? (status.state === 'FINALIZING' ? 'Paketleniyor' : 'Kaydediliyor')
      : !session.complete ? 'Eksik oturum' : session.packName ? 'Paket hazır' : 'Ham kayıt hazır';
    stateCell.append(node('span', label, `status-note ${!busy && session.complete ? 'complete' : 'incomplete'}`));
    const file = node('td');
    if (!busy) {
      const link = node('a', 'JSONL indir ↗', 'download');
      link.href = `/sessions/${encodeURIComponent(session.file)}`;
      link.download = session.file;
      link.setAttribute('aria-label', `${session.label || session.file} — JSONL indir`);
      file.append(link);
    } else file.append(node('span', 'Kayıt sürüyor', 'status-note'));
    file.append(node('small', size(session.bytes ?? 0)));
    row.append(stateCell, file);
    fragment.append(row);
  }
  $('sessions').replaceChildren(fragment);
}

async function refreshStatus(requestEpoch) {
  try {
    const next = await request('/api/status');
    if (!next || !Object.hasOwn(STATES, next.state)) throw new Error('Sunucudan geçerli kayıt durumu alınamadı.');
    if (requestEpoch === epoch) renderStatus(next);
  } catch (error) {
    if (requestEpoch === epoch) renderOffline(error);
  }
}

async function refreshLibrary(requestEpoch) {
  try {
    const library = await request('/api/library');
    if (!Array.isArray(library?.sessions)) throw new Error('Oturum listesi geçerli değil.');
    if (requestEpoch !== epoch) return;
    renderLibrary(library.sessions);
    lastLibraryRefresh = Date.now();
  } catch (error) {
    if (requestEpoch !== epoch) return;
    $('library-message').hidden = false;
    setText('library-message', `Oturum arşivi güncellenemedi. ${error.message}`);
    // Keep prior rows visible, accompanied by an explicit stale-data message.
  }
}

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(poll, 1000);
}

async function poll() {
  if (pending) return schedule();
  const requestEpoch = epoch;
  await refreshStatus(requestEpoch);
  if (requestEpoch === epoch && connected && Date.now() - lastLibraryRefresh >= 5000) await refreshLibrary(requestEpoch);
  schedule();
}

async function command(action) {
  if (pending || !connected || $(action).disabled) return;
  if (action === 'start' && !$('take-label').reportValidity()) return;
  clearTimeout(timer);
  ++epoch; // Ignore every response started before this operator action.
  pending = action;
  $(action).blur();
  renderControls();
  $('action-error').hidden = true;
  try {
    await request(action === 'udp-stop' ? '/api/replay/stop' : `/api/${action}`, {
      method: 'POST',
      ...(action === 'start' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: $('take-label').value.trim() }) } : {}),
    });
  } catch (error) {
    setText('action-error-text', `${error.message} Güncel sunucu durumu yeniden sorgulandı; bir işlemi tekrar denemeden önce aşağıdaki durumu kontrol et.`);
    $('action-error').hidden = false;
  } finally {
    await refreshStatus(epoch);
    pending = null;
    renderControls();
    await refreshLibrary(epoch);
    schedule();
  }
}

$('take-label').addEventListener('input', () => {
  $('take-label').setCustomValidity(/[^\p{L}\p{N} _-]/u.test($('take-label').value)
    ? 'Harf, rakam, boşluk, _ veya - kullanın.' : '');
});
for (const action of ['arm', 'start', 'stop', 'udp-stop']) $(action).addEventListener('click', () => command(action));
$('dismiss-error').addEventListener('click', () => { $('action-error').hidden = true; });
$('retry').addEventListener('click', async () => {
  if (pending) return;
  clearTimeout(timer);
  ++epoch;
  $('retry').disabled = true;
  await poll();
  $('retry').disabled = false;
});
window.addEventListener('pageshow', (event) => { if (event.persisted) { clearTimeout(timer); ++epoch; poll(); } });
poll();
