// viz/src/pack-loader.js
export const EVENT_RECORD_BYTES = 12;
export const STROKE_RECORD_BYTES = 16;
export const GESTURE_RECORD_BYTES = 32;
export const TYPE = { keepalive: 0, noteOn: 1, noteOff: 2, move: 3, progress: 4, disconnect: 5 };

async function fetchOk(url, what, name, signal) {
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(`paket dosyası alınamadı (${name}/${what} — HTTP ${r.status})`);
  return r;
}

export function validateManifest(m) {
  const invalid = (detail) => { throw new Error(`paket manifesti bozuk: ${detail}`); };
  if (!m || m.formatVersion !== 1) invalid('desteklenmeyen sürüm');
  if (!Number.isInteger(m.durationMs) || m.durationMs < 1 || m.durationMs > 0xffffffff) invalid('süre');
  if (!Number.isInteger(m.laneCount) || m.laneCount < 1 || m.laneCount > 65536) invalid('katılımcı sayısı');
  for (const key of ['eventCount', 'strokeCount']) {
    if (!Number.isSafeInteger(m[key]) || m[key] < 0) invalid(key);
  }
  if (!Array.isArray(m.participants) || m.participants.length !== m.laneCount || !Array.isArray(m.zones) || !m.zones.length) invalid('katılımcı tablosu');
  let offset = 0;
  for (let lane = 0; lane < m.laneCount; lane++) {
    const p = m.participants[lane];
    if (!p || p.l !== lane || p.o !== offset || !Number.isSafeInteger(p.n) || p.n < 0) invalid('olay aralıkları');
    offset += p.n;
  }
  if (offset !== m.eventCount) invalid('olay sayısı uyuşmuyor');
  let lanes = 0;
  for (const z of m.zones) {
    if (!z || typeof z.zone !== 'string' || z.laneStart !== lanes || !Number.isInteger(z.laneCount) || z.laneCount < 1) invalid('bölgeler');
    lanes += z.laneCount;
  }
  if (lanes !== m.laneCount) invalid('bölge sayısı uyuşmuyor');
  if (m.gestures !== undefined) {
    const g = m.gestures;
    if (!g || g.formatVersion !== 1 || g.file !== 'gestures.bin' || g.recordBytes !== GESTURE_RECORD_BYTES || g.count !== m.eventCount) invalid('hareket verisi');
  }
  return m;
}

export async function loadPack(name, onProgress, { signal } = {}) {
  if (typeof name !== 'string' || !name || /[/\\\x00]/.test(name) || name.includes('..')) throw new Error('geçersiz paket adı');
  const base = `/packs/${encodeURIComponent(name)}`;
  const manifest = validateManifest(await (await fetchOk(`${base}/manifest.json`, 'manifest.json', name, signal)).json());
  onProgress?.('manifest');
  const [events, strokes, gestures] = await Promise.all([
    fetchOk(`${base}/events.bin`, 'events.bin', name, signal).then((r) => r.arrayBuffer()),
    fetchOk(`${base}/strokes.bin`, 'strokes.bin', name, signal).then((r) => r.arrayBuffer()),
    manifest.gestures ? fetchOk(`${base}/gestures.bin`, 'gestures.bin', name, signal).then((r) => r.arrayBuffer()) : null,
  ]);
  onProgress?.('binary');
  // A truncated .bin would otherwise throw a RangeError deep inside buildDisc;
  // validate here so switchPack can show a readable notice instead.
  const wantE = manifest.eventCount * EVENT_RECORD_BYTES;
  if (events.byteLength !== wantE) {
    throw new Error(`paket bozuk (${name}/events.bin: ${events.byteLength} bayt, beklenen ${wantE})`);
  }
  const wantS = manifest.strokeCount * STROKE_RECORD_BYTES;
  if (strokes.byteLength !== wantS) {
    throw new Error(`paket bozuk (${name}/strokes.bin: ${strokes.byteLength} bayt, beklenen ${wantS})`);
  }
  if (gestures && gestures.byteLength !== manifest.eventCount * GESTURE_RECORD_BYTES) {
    throw new Error(`paket bozuk (${name}/gestures.bin: ${gestures.byteLength} bayt, beklenen ${manifest.eventCount * GESTURE_RECORD_BYTES})`);
  }
  return { name, manifest, events: new DataView(events), strokes: new DataView(strokes), gestures: gestures ? new DataView(gestures) : null };
}
