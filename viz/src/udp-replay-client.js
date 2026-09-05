// Explicit opt-in client for the recorder's authoritative UDP transport.
// Construction and archive selection do no I/O. Preparing loads JSONL without
// emitting packets; only a user play command can start the OSC destination.
export const UDP_DESTINATION = Object.freeze({ host: '127.0.0.1', port: 6061 });
const STATES = new Set(['EMPTY', 'LOADING', 'READY', 'PLAYING', 'PAUSED', 'COMPLETE', 'ERROR']);

export function replayErrorMessage(reason) {
  const text = String(reason?.message ?? reason ?? 'Bilinmeyen hata');
  if (/Engine is still sending|Engine output state could not be verified/i.test(text)) return 'Venue Engine çıkışını Hold konumuna alın; ardından UDP oynatmayı yeniden deneyin.';
  if (/outside the current A–P.*finger0/i.test(text)) return 'Bu kayıt, mevcut A–P / finger0 ses yönlendirmesiyle uyumlu değil.';
  if (/recorded session not found|ENOENT/i.test(text)) return 'Bu eserin ham JSONL kaydı bulunamadı. Görseli sessiz oynatabilirsiniz.';
  if (/no addressable/i.test(text)) return 'Bu kayıtta UDP ile oynatılabilecek adresli nota veya hareket yok.';
  if (/Stop and finalize recording|currently recording/i.test(text)) return 'UDP oynatmadan önce canlı kaydın tamamlanmasını bekleyin.';
  if (/Failed to fetch|fetch failed|NetworkError|timeout|aborted/i.test(text)) return 'Kayıt sunucusuna ulaşılamadı. UDP durumunu doğrulayın veya çıkışı kapatmayı yeniden deneyin.';
  return text;
}

export function createUdpReplayClient({ request, now = () => performance.now(), schedule = setTimeout, unschedule = clearTimeout, onState = () => {}, pollMs = 200, staleMs = 900 } = {}) {
  if (typeof request !== 'function') throw new TypeError('A replay request function is required');
  let enabled = false; let busy = false; let status = null; let error = null;
  let receivedAt = 0; let timer = null; let epoch = 0; let pollPending = false; let frozenPosition = null;
  let expectedSession = null; let expectedDuration = null; let outputRequested = false; let disposed = false;
  const snapshot = () => {
    const age = Math.max(0, now() - receivedAt);
    const stale = enabled && status?.state === 'PLAYING' && age > staleMs;
    const playing = enabled && status?.state === 'PLAYING' && !error && !stale;
    // A short bounded interpolation follows the last server clock sample.
    // On connection loss the visual freezes; it never becomes a second clock.
    const elapsed = status?.state === 'PLAYING' ? Math.min(age, staleMs) * status.speed : 0;
    return { enabled, busy, status, error: error || (stale ? 'UDP saat bilgisi gecikti; oynatma durumu doğrulanıyor.' : null), stale,
      positionMs: Math.max(0, Math.min(status?.durationMs || 0, frozenPosition ?? ((status?.positionMs || 0) + elapsed))), playing };
  };
  const emit = () => onState(snapshot());
  const stopPoll = () => { if (timer !== null) unschedule(timer); timer = null; };
  const accept = (value) => {
    if (!value || !STATES.has(value.state) || !Number.isFinite(value.positionMs) || !Number.isFinite(value.durationMs)
      || !Number.isFinite(value.speed) || value.speed < .25 || value.speed > 4) throw new Error('UDP sunucusu geçerli bir oynatma saati döndürmedi.');
    if (expectedSession && value.sessionId !== expectedSession) throw new Error('UDP sunucusunda farklı bir kayıt açık; çıkışı kapatıp yeniden hazırlayın.');
    if (expectedDuration !== null && Math.abs(value.durationMs - expectedDuration) > 1) throw new Error('Ham kayıt süresi ile görselin süresi eşleşmiyor.');
    status = value; receivedAt = now(); frozenPosition = null; error = value.error ? replayErrorMessage(value.error) : null;
  };
  const readResponse = async (path, options = {}) => {
    const response = await request(path, options);
    let value;
    try { value = await response.json(); } catch { throw new Error('UDP sunucusundan okunabilir bir yanıt alınamadı.'); }
    if (!response.ok) {
      const failure = new Error(value?.error || `UDP işlemi başarısız (${response.status})`);
      failure.replay = value?.replay; throw failure;
    }
    return value;
  };
  const post = (action, body = {}) => readResponse(`/api/replay/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  function armPoll() {
    stopPoll();
    if (enabled && !disposed) timer = schedule(() => { timer = null; poll(); }, pollMs);
  }
  async function poll() {
    if (!enabled || disposed || pollPending) return;
    if (busy) { armPoll(); return; }
    const token = epoch; pollPending = true;
    try {
      const value = await readResponse('/api/replay/status', { signal: AbortSignal.timeout(1500) });
      if (token === epoch && enabled) { accept(value); emit(); }
    } catch (reason) {
      if (token === epoch && enabled) { frozenPosition = snapshot().positionMs; error = replayErrorMessage(reason); emit(); }
    } finally { pollPending = false; armPoll(); }
  }
  const operation = async (action) => {
    if (disposed) throw new Error('UDP denetimi kapandı.');
    if (busy) throw new Error('Önceki UDP işleminin tamamlanmasını bekleyin.');
    const token = ++epoch; busy = true; error = null; emit();
    try {
      const result = await action();
      if (token === epoch) { accept(result); return result; }
      return null;
    } catch (reason) {
      if (token === epoch) {
        if (reason.replay && (!expectedSession || reason.replay.sessionId === expectedSession)) { try { accept(reason.replay); } catch {} }
        error = replayErrorMessage(reason);
      }
      throw reason;
    } finally { if (token === epoch) { busy = false; emit(); armPoll(); } }
  };
  return {
    snapshot,
    get enabled() { return enabled; }, get busy() { return busy; },
    async enable({ sessionId, durationMs, simulated = false } = {}) {
      if (simulated) throw new Error('Örnek eser UDP çıkışına gönderilemez.');
      if (typeof sessionId !== 'string' || !sessionId || /[/\\\0]/.test(sessionId)) throw new Error('Geçerli bir kayıt seçin.');
      if (enabled) return snapshot();
      const loaded = await operation(async () => {
        const existing = await readResponse('/api/replay/status');
        if (existing.state === 'PLAYING' || existing.busy || existing.activeVoices > 0) throw new Error('Sunucuda başka bir UDP oynatımı var. Önce onu durdurun.');
        expectedSession = sessionId;
        expectedDuration = Number.isFinite(durationMs) ? durationMs : null;
        const loaded = await post('load', { file: `${sessionId}.jsonl` });
        if (loaded.sessionId !== sessionId) throw new Error('Ham kayıt ile görselin oturum kimliği eşleşmiyor.');
        return loaded;
      });
      if (loaded) { enabled = true; emit(); armPoll(); }
      return snapshot();
    },
    async play({ positionMs, speed } = {}) {
      if (!enabled) throw new Error('Önce UDP çıkışını hazırlayın.');
      return operation(() => { outputRequested = true; return post('play', { destination: UDP_DESTINATION, ...(positionMs === undefined ? {} : { positionMs }), ...(speed === undefined ? {} : { speed }) }); });
    },
    pause() { if (!enabled) return Promise.resolve(null); return operation(() => post('pause')); },
    seek(positionMs) {
      if (!enabled) return Promise.resolve(null);
      return operation(async () => { if (status?.state === 'PLAYING') await post('pause'); return post('seek', { positionMs }); });
    },
    setSpeed(speed) { if (!enabled) return Promise.resolve(null); return operation(() => post('speed', { speed })); },
    async disable() {
      // Stop bypasses the ordinary busy gate so it can cancel a pending play.
      ++epoch; busy = true; stopPoll(); emit();
      try {
        if (outputRequested) {
          const stopped = await post('stop');
          if (stopped.activeVoices > 0 || stopped.state === 'PLAYING') throw new Error('UDP çıkışının durduğu doğrulanamadı. Yeniden kapatmayı deneyin.');
          status = stopped; receivedAt = now();
        }
        enabled = false; expectedSession = null; expectedDuration = null; outputRequested = false; error = null;
      } catch (reason) { enabled = true; error = replayErrorMessage(reason); throw reason; }
      finally { busy = false; emit(); armPoll(); }
    },
    dispose() { disposed = true; stopPoll(); ++epoch; },
  };
}
