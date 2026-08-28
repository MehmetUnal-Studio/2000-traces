// test/viz-pack.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { recordFromSource } from '../src/recorder.js';
import { fileSource } from '../src/sources/file-source.js';
import { packSession, EVENT_RECORD_BYTES, STROKE_RECORD_BYTES, TYPE_CODES } from '../src/viz-pack.js';

const FIXTURE = new URL('../captures/fixture-small.sse.txt', import.meta.url).pathname;

async function makeSession(dir) {
  const out = join(dir, 'session.jsonl');
  const summary = await recordFromSource(fileSource(FIXTURE), {
    outPath: out, sessionId: 'pack-test', visualSeed: 7, source: 'fixture',
  });
  return { out, summary };
}

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
