// viz/src/pack-loader.js
export const EVENT_RECORD_BYTES = 12;
export const STROKE_RECORD_BYTES = 16;
export const TYPE = { keepalive: 0, noteOn: 1, noteOff: 2, move: 3, progress: 4, disconnect: 5 };

async function fetchOk(url, what, name) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`paket dosyası alınamadı (${name}/${what} — HTTP ${r.status})`);
  return r;
}

export async function loadPack(name, onProgress) {
  const base = `/packs/${name}`;
  const manifest = await (await fetchOk(`${base}/manifest.json`, 'manifest.json', name)).json();
  onProgress?.('manifest');
  const [events, strokes] = await Promise.all([
    fetchOk(`${base}/events.bin`, 'events.bin', name).then((r) => r.arrayBuffer()),
    fetchOk(`${base}/strokes.bin`, 'strokes.bin', name).then((r) => r.arrayBuffer()),
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
  return { name, manifest, events: new DataView(events), strokes: new DataView(strokes) };
}
