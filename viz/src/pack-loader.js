// viz/src/pack-loader.js
export const EVENT_RECORD_BYTES = 12;
export const STROKE_RECORD_BYTES = 16;
export const TYPE = { keepalive: 0, noteOn: 1, noteOff: 2, move: 3, progress: 4, disconnect: 5 };

export async function loadPack(name, onProgress) {
  const base = `/packs/${name}`;
  const manifest = await (await fetch(`${base}/manifest.json`)).json();
  onProgress?.('manifest');
  const [events, strokes] = await Promise.all([
    fetch(`${base}/events.bin`).then((r) => r.arrayBuffer()),
    fetch(`${base}/strokes.bin`).then((r) => r.arrayBuffer()),
  ]);
  onProgress?.('binary');
  return { name, manifest, events: new DataView(events), strokes: new DataView(strokes) };
}
