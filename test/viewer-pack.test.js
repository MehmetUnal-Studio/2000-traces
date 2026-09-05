import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDemoPack } from '../viz/src/demo-pack.js';
import { loadPack, validateManifest, EVENT_RECORD_BYTES, GESTURE_RECORD_BYTES, TYPE } from '../viz/src/pack-loader.js';

test('exhibition demo is deterministic and has a truthful, self-contained lane table', () => {
  const a = createDemoPack();
  const b = createDemoPack();
  assert.deepEqual(a.manifest, b.manifest);
  assert.deepEqual(a.events, b.events);
  assert.deepEqual(a.strokes, b.strokes);
  assert.equal(a.manifest.simulated, true);
  assert.equal(a.manifest.laneCount, 2000);
  assert.ok(a.manifest.eventCount >= 150000 && a.manifest.eventCount <= 250000, 'rich ensemble study stays within its bounded demo budget');
  validateManifest(a.manifest);
  for (const p of a.manifest.participants) {
    let previous = -1;
    for (let i = p.o; i < p.o + p.n; i++) {
      const base = i * EVENT_RECORD_BYTES;
      assert.equal(a.events.getUint16(base, true), p.l);
      const time = a.events.getUint32(base + 6, true);
      assert.ok(time >= previous && time <= a.manifest.durationMs);
      assert.ok(Object.values(TYPE).includes(a.events.getUint8(base + 10)));
      previous = time;
    }
  }
});

test('manifest validation rejects malformed layout and event ranges before GPU allocation', () => {
  const { manifest } = createDemoPack({ laneCount: 2 });
  const mutate = (fn) => { const m = structuredClone(manifest); fn(m); return m; };
  for (const m of [
    null, {}, { ...manifest, formatVersion: 99 }, { ...manifest, durationMs: 0 },
    { ...manifest, laneCount: 0 }, { ...manifest, eventCount: -1 },
    mutate((m) => m.participants[1].o++), mutate((m) => m.participants[0].n = -1),
    mutate((m) => m.zones[0].laneStart++), mutate((m) => m.zones[0].laneCount++),
  ]) assert.throws(() => validateManifest(m), /manifesti bozuk/);
});

test('pack loading rejects traversal before performing a request', async () => {
  for (const name of ['../private', 'a/b', 'a\\b', '', 'a\x00b']) {
    await assert.rejects(loadPack(name), /geçersiz paket adı/);
  }
});

test('pack loading checks binary length and propagates cancellation to every fetch', async (t) => {
  const pack = createDemoPack({ laneCount: 2 });
  const controller = new AbortController();
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, signal: options.signal });
    if (url.endsWith('manifest.json')) return new Response(JSON.stringify(pack.manifest));
    if (url.endsWith('events.bin')) return new Response(pack.events.buffer);
    return new Response(new ArrayBuffer(0));
  });
  await assert.rejects(loadPack('take 1', null, { signal: controller.signal }), /strokes.bin/);
  assert.equal(requests.length, 3);
  assert.ok(requests.every((r) => r.signal === controller.signal && r.url.startsWith('/packs/take%201/')));
});

test('optional precise sidecar is validated, fetched with cancellation, and never silently downgraded', async (t) => {
  const pack = createDemoPack({ laneCount: 2 });
  pack.manifest.gestures = { formatVersion: 1, file: 'gestures.bin', recordBytes: GESTURE_RECORD_BYTES, count: pack.manifest.eventCount };
  for (const gestures of [
    { ...pack.manifest.gestures, file: '../private.bin' },
    { ...pack.manifest.gestures, formatVersion: 2 },
    { ...pack.manifest.gestures, recordBytes: 24 },
    { ...pack.manifest.gestures, count: 0 },
  ]) assert.throws(() => validateManifest({ ...pack.manifest, gestures }), /hareket verisi/);
  const controller = new AbortController();
  const requests = [];
  let broken = false;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, signal: options.signal });
    if (url.endsWith('manifest.json')) return new Response(JSON.stringify(pack.manifest));
    if (url.endsWith('events.bin')) return new Response(pack.events.buffer);
    if (url.endsWith('strokes.bin')) return new Response(pack.strokes.buffer);
    return new Response(new ArrayBuffer(broken ? 0 : pack.manifest.eventCount * GESTURE_RECORD_BYTES));
  });
  const loaded = await loadPack('precise-take', null, { signal: controller.signal });
  assert.ok(loaded.gestures instanceof DataView);
  assert.equal(requests.length, 4);
  assert.ok(requests.every((request) => request.signal === controller.signal));
  broken = true;
  await assert.rejects(loadPack('precise-take'), /gestures.bin/);
});
