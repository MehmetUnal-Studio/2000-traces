// test/viz-pack.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, appendFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { recordFromSource } from '../src/recorder.js';
import { fileSource } from '../src/sources/file-source.js';
import { packSession, EVENT_RECORD_BYTES, STROKE_RECORD_BYTES, GESTURE_RECORD_BYTES, TYPE_CODES } from '../src/viz-pack.js';

const FIXTURE = new URL('../captures/fixture-small.sse.txt', import.meta.url).pathname;

async function makeSession(dir, opts = {}) {
  const out = join(dir, 'session.jsonl');
  const summary = await recordFromSource(fileSource(FIXTURE), {
    outPath: out, sessionId: 'pack-test', visualSeed: 7, source: 'fixture', ...opts,
  });
  return { out, summary };
}

test('label rides from session header into manifest and the packs index entry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'traces-pack-'));
  const { out } = await makeSession(dir, { sessionId: 'pack-label', label: 'prova 1' });
  const packDir = join(dir, 'pack');
  const manifest = await packSession(out, packDir);
  assert.equal(manifest.label, 'prova 1');

  const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'));
  const entry = index.packs.find((p) => p.sessionId === 'pack-label');
  assert.equal(entry.label, 'prova 1');
});

test('phone XY and finger survive capture and precise sidecar without changing the legacy event layout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'traces-gesture-pack-'));
  const raw = [
    { t: 1, z: 0, s: 1, f: 7, l: 3, uu: .12345678901234568, vv: .9876543210987654, ts: 1000.125 },
    { t: 3, z: 0, s: 1, f: 7, uu: .1111111111111111, vv: .2222222222222222, ts: 1001.75 },
    { t: 2, z: 0, s: 1, f: 7, l: 3, ts: 1003.5 },
    { t: 1, z: 0, s: 1, f: 1, l: 4, uu: 0, vv: 0, ts: 1004.125 },
    { t: -1, z: 0, s: 1, ts: 1005.125 },
  ];
  async function* source() { for (const event of raw) yield { raw: event, arrivalMs: event.ts }; }
  const out = join(dir, 'session.jsonl');
  await recordFromSource(source(), { outPath: out, sessionId: 'exact-phone', visualSeed: 7, source: 'fixture' });
  const records = readFileSync(out, 'utf8').split('\n').filter(Boolean).map(JSON.parse).filter((r) => r.kind === 'event');
  for (let i = 0; i < raw.length; i++) {
    assert.deepEqual(records[i].raw, raw[i]);
    assert.equal(records[i].u, raw[i].uu);
    assert.equal(records[i].v, raw[i].vv);
    assert.equal(records[i].finger, raw[i].f);
  }
  const outDir = join(dir, 'pack');
  const manifest = await packSession(out, outDir);
  assert.deepEqual(manifest.gestures, { formatVersion: 1, file: 'gestures.bin', recordBytes: 32, count: raw.length });
  const legacy = readFileSync(join(outDir, 'events.bin'));
  const gestures = readFileSync(join(outDir, 'gestures.bin'));
  assert.equal(legacy.length, raw.length * EVENT_RECORD_BYTES);
  assert.equal(gestures.length, raw.length * GESTURE_RECORD_BYTES);
  for (let i = 0; i < raw.length; i++) {
    const base = i * GESTURE_RECORD_BYTES;
    assert.equal(gestures.readDoubleLE(base), raw[i].ts - raw[0].ts);
    for (const [field, offset] of [['uu', 8], ['vv', 16], ['f', 24]]) {
      const value = gestures.readDoubleLE(base + offset);
      if (raw[i][field] === undefined) assert.equal(Number.isNaN(value), true);
      else assert.equal(value, raw[i][field]);
    }
  }
  assert.equal(gestures.readDoubleLE(GESTURE_RECORD_BYTES), 1.625, 'fractional source-relative time remains exact');
  assert.equal(legacy.readUInt32LE(EVENT_RECORD_BYTES + 6), 2, 'legacy uint32 compatibility is retained');
  const second = join(dir, 'pack-again');
  await packSession(out, second);
  assert.deepEqual(readFileSync(join(second, 'gestures.bin')), gestures, 'sidecar bytes are deterministic');
});

test('packs a session into manifest + events.bin + strokes.bin', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'traces-pack-'));
  const { out, summary } = await makeSession(dir);
  const packDir = join(dir, 'pack');
  const manifest = await packSession(out, packDir);

  assert.equal(manifest.formatVersion, 1);
  assert.equal(manifest.sessionId, 'pack-test');
  assert.equal(manifest.visualSeed, 7);
  assert.equal(manifest.durationMs, 90000);
  assert.equal(manifest.laneCount, summary.participants);
  assert.equal(manifest.eventCount, summary.stats.stored);
  assert.equal(statSync(join(packDir, 'events.bin')).size, manifest.eventCount * EVENT_RECORD_BYTES);
  assert.equal(statSync(join(packDir, 'strokes.bin')).size, manifest.strokeCount * STROKE_RECORD_BYTES);
  const onDisk = JSON.parse(readFileSync(join(packDir, 'manifest.json'), 'utf8'));
  assert.deepEqual(onDisk, JSON.parse(JSON.stringify(manifest)));
});

test('lanes are ordered by zone then seat, with contiguous event ranges', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'traces-pack-'));
  const { out } = await makeSession(dir);
  const packDir = join(dir, 'pack');
  const manifest = await packSession(out, packDir);

  const ps = manifest.participants;
  for (let i = 1; i < ps.length; i++) {
    assert.equal(ps[i].l, i, 'laneIndex is dense');
    const a = ps[i - 1]; const b = ps[i];
    assert.equal(a.z < b.z || (a.z === b.z && a.s < b.s), true, 'zone,seat order');
    assert.equal(b.o, a.o + a.n, 'event ranges contiguous');
  }
  assert.equal(ps[0].o, 0);
  const last = ps[ps.length - 1];
  assert.equal(last.o + last.n, manifest.eventCount);
});

test('binary events are per-lane time-ordered and round-trip u/v within quantization', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'traces-pack-'));
  const { out } = await makeSession(dir);
  const packDir = join(dir, 'pack');
  const manifest = await packSession(out, packDir);

  const buf = readFileSync(join(packDir, 'events.bin'));
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const readEvent = (i) => ({
    lane: dv.getUint16(i * EVENT_RECORD_BYTES + 0, true),
    uq: dv.getUint16(i * EVENT_RECORD_BYTES + 2, true),
    vq: dv.getUint16(i * EVENT_RECORD_BYTES + 4, true),
    tMs: dv.getUint32(i * EVENT_RECORD_BYTES + 6, true),
    type: dv.getUint8(i * EVENT_RECORD_BYTES + 10),
    line: dv.getUint8(i * EVENT_RECORD_BYTES + 11),
  });

  for (const p of manifest.participants) {
    let prev = -1;
    for (let i = p.o; i < p.o + p.n; i++) {
      const e = readEvent(i);
      assert.equal(e.lane, p.l, 'event belongs to its lane range');
      assert.equal(e.tMs >= prev, true, 'per-lane time order');
      prev = e.tMs;
    }
  }

  // find the first stored noteOn in the JSONL and its binary twin
  const lines = readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const firstOn = lines.find((l) => l.kind === 'event' && l.eventType === 'noteOn');
  const p = manifest.participants.find((q) => q.p === firstOn.participantId);
  let found = null;
  for (let i = p.o; i < p.o + p.n; i++) {
    const e = readEvent(i);
    if (e.type === TYPE_CODES.noteOn && e.tMs === firstOn.tMs) { found = e; break; }
  }
  assert.notEqual(found, null);
  assert.equal(Math.abs(found.uq / 65535 - firstOn.u) < 1e-4, true);
  assert.equal(Math.abs(found.vq / 65535 - firstOn.v) < 1e-4, true);
});

test('strokes pair noteOn with noteOff on the same lane+finger', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'traces-pack-'));
  const { out } = await makeSession(dir);
  const packDir = join(dir, 'pack');
  const manifest = await packSession(out, packDir);

  const lines = readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const noteOns = lines.filter((l) => l.kind === 'event' && l.eventType === 'noteOn').length;
  assert.equal(manifest.strokeCount > 0, true);
  assert.equal(manifest.strokeCount <= noteOns, true);

  const buf = readFileSync(join(packDir, 'strokes.bin'));
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let i = 0; i < manifest.strokeCount; i++) {
    const lane = dv.getUint16(i * STROKE_RECORD_BYTES + 0, true);
    const t0 = dv.getUint32(i * STROKE_RECORD_BYTES + 4, true);
    const t1 = dv.getUint32(i * STROKE_RECORD_BYTES + 8, true);
    assert.equal(lane < manifest.laneCount, true);
    assert.equal(t1 >= t0, true, 'stroke ends at or after it starts');
    assert.equal(t1 <= manifest.durationMs, true);
  }
});

const HEADER = JSON.stringify({ kind: 'session', schemaVersion: 1, sessionId: 'hand', durationMs: 90000, visualSeed: 1 });
const ev = (o) => JSON.stringify({ kind: 'event', participantId: 'A1', zone: 'A', seatNumber: 1, u: 0.5, v: 0.5, ...o });

test('packSession tolerates a torn final line (crash-truncated take)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'traces-pack-'));
  const { out, summary } = await makeSession(dir);
  appendFileSync(out, '{"kind":"event","tru'); // power-cut mid-flush: half a line at EOF
  const manifest = await packSession(out, join(dir, 'pack'));
  assert.equal(manifest.truncatedTail, true, 'truncation is reported in the manifest');
  assert.equal(manifest.eventCount, summary.stats.stored, 'all intact events survive');
});

test('packSession of a clean file reports no truncated tail', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'traces-pack-'));
  const { out } = await makeSession(dir);
  const manifest = await packSession(out, join(dir, 'pack'));
  assert.equal(manifest.truncatedTail, false);
});

test('packSession still throws on a corrupt mid-file line', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'traces-pack-'));
  const out = join(dir, 's.jsonl');
  writeFileSync(out, [
    HEADER,
    '{"kind":"event","tru', // corrupt line FOLLOWED by more data = real corruption
    ev({ eventType: 'noteOn', finger: 0, line: 1, tMs: 100 }),
  ].join('\n') + '\n');
  await assert.rejects(() => packSession(out, join(dir, 'pack')), SyntaxError);
});

test('disconnect closes open strokes on every finger, not just finger 0', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'traces-pack-'));
  const out = join(dir, 's.jsonl');
  writeFileSync(out, [
    HEADER,
    ev({ eventType: 'noteOn', finger: 1, line: 2, tMs: 10000 }),
    ev({ eventType: 'noteOn', finger: 0, line: 1, tMs: 10500 }),
    ev({ eventType: 'disconnect', tMs: 12000 }), // adapter emits no finger field on t:-1
  ].join('\n') + '\n');
  const manifest = await packSession(out, join(dir, 'pack'));
  assert.equal(manifest.strokeCount, 2);
  const buf = readFileSync(join(dir, 'pack', 'strokes.bin'));
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let i = 0; i < manifest.strokeCount; i++) {
    const t1 = dv.getUint32(i * STROKE_RECORD_BYTES + 8, true);
    assert.equal(t1, 12000, 'every open stroke ends at the disconnect, not durationMs');
  }
});

test('already-recorded negative or fractional tMs still packs (clamped, not thrown)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'traces-pack-'));
  const out = join(dir, 's.jsonl');
  writeFileSync(out, [
    HEADER,
    ev({ eventType: 'noteOn', finger: 0, line: 1, tMs: -1 }),      // pre-guard recording
    ev({ eventType: 'fingerMove', finger: 0, line: 1, tMs: 500.5 }), // float server ts
    ev({ eventType: 'noteOff', finger: 0, line: 1, tMs: 1000 }),
  ].join('\n') + '\n');
  const manifest = await packSession(out, join(dir, 'pack')); // must not throw RangeError
  assert.equal(manifest.eventCount, 3);
  const buf = readFileSync(join(dir, 'pack', 'events.bin'));
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  assert.equal(dv.getUint32(0 * EVENT_RECORD_BYTES + 6, true), 0, 'negative tMs clamps to 0');
  assert.equal(dv.getUint32(1 * EVENT_RECORD_BYTES + 6, true), 501, 'fractional tMs rounds');
  const sb = readFileSync(join(dir, 'pack', 'strokes.bin'));
  const sdv = new DataView(sb.buffer, sb.byteOffset, sb.byteLength);
  assert.equal(sdv.getUint32(0 * STROKE_RECORD_BYTES + 4, true), 0, 'stroke t0 clamps too');
});

test('packing updates the directory-level index.json', async () => {
  const { mkdtempSync: mkd, readFileSync: rf } = await import('node:fs');
  const { join: j } = await import('node:path');
  const { tmpdir: td } = await import('node:os');
  const dir = mkd(j(td(), 'traces-pack-'));
  const { out } = await makeSession(dir);
  await packSession(out, j(dir, 'packs', 'a'));
  await packSession(out, j(dir, 'packs', 'b'));
  const idx = JSON.parse(rf(j(dir, 'packs', 'index.json'), 'utf8'));
  assert.deepEqual(idx.packs.map((p) => p.name), ['b', 'a']);
  assert.equal(idx.packs[0].sessionId, 'pack-test');
});

test('index.json is written atomically and self-heals from the pack directories', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'traces-pack-'));
  const { out } = await makeSession(dir);
  const packsDir = join(dir, 'packs');
  await packSession(out, join(packsDir, 'a'));
  await packSession(out, join(packsDir, 'b'));
  // temp-file + rename: no *.tmp residue after sequential packs, content correct
  assert.deepEqual(readdirSync(packsDir).filter((n) => n.endsWith('.tmp')), []);
  let idx = JSON.parse(readFileSync(join(packsDir, 'index.json'), 'utf8'));
  assert.deepEqual([...idx.packs.map((p) => p.name)].sort(), ['a', 'b']);
  // a torn/garbage index (crashed concurrent writer) must not wipe history:
  // the next pack rebuilds the index from the pack directories on disk
  writeFileSync(join(packsDir, 'index.json'), '{"packs":[{"na'); // torn mid-write
  await packSession(out, join(packsDir, 'c'));
  idx = JSON.parse(readFileSync(join(packsDir, 'index.json'), 'utf8'));
  assert.deepEqual([...idx.packs.map((p) => p.name)].sort(), ['a', 'b', 'c'],
    'previously packed sessions survive a torn index');
  assert.equal(idx.packs[0].name, 'c', 'freshest pack listed first');
  for (const p of idx.packs) {
    assert.equal(p.sessionId, 'pack-test');
    assert.equal(typeof p.lanes, 'number');
    assert.equal(typeof p.events, 'number');
    assert.equal(typeof p.strokes, 'number');
  }
});
