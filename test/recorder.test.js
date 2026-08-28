// test/recorder.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { recordFromSource } from '../src/recorder.js';
import { fileSource } from '../src/sources/file-source.js';
import { importSession } from '../src/jsonl.js';
import { normalizeEvent } from '../src/adapter.js';

const FIXTURE = new URL('../captures/fixture-small.sse.txt', import.meta.url).pathname;

test('records a file source to JSONL and finalizes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'traces-'));
  const out = join(dir, 'session.jsonl');
  const summary = await recordFromSource(fileSource(FIXTURE), {
    outPath: out, sessionId: 'rec-test', visualSeed: 42, source: `file:${FIXTURE}`,
  });
  assert.equal(summary.stats.stored > 0, true);
  assert.equal(summary.stats.stored + summary.stats.malformed + summary.stats.duplicates + summary.stats.late,
    summary.stats.received);
  const imported = importSession(readFileSync(out, 'utf8').split('\n'));
  assert.equal(imported.meta.sessionId, 'rec-test');
  assert.equal(imported.meta.visualSeed, 42);
  assert.equal(imported.complete, true);
  assert.equal(imported.events.length, summary.stats.stored);
  // raw preserved on disk: the first stored event carries the first accepted
  // fixture payload verbatim (fixture is one `data: ` line per frame, in order)
  const firstAcceptedRaw = readFileSync(FIXTURE, 'utf8').split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => { try { return JSON.parse(l.slice('data: '.length)); } catch { return null; } })
    .find((o) => o !== null && normalizeEvent(o).ok);
  assert.ok(firstAcceptedRaw); // fixture sanity: it contains an acceptable event
  assert.deepEqual(imported.events[0].raw, firstAcceptedRaw);
  assert.equal(imported.end.stats.stored, summary.stats.stored);
});

test('same file + same seed produce identical event lines (determinism)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'traces-'));
  const a = join(dir, 'a.jsonl'); const b = join(dir, 'b.jsonl');
  await recordFromSource(fileSource(FIXTURE), { outPath: a, sessionId: 'x', visualSeed: 1, source: 't' });
  await recordFromSource(fileSource(FIXTURE), { outPath: b, sessionId: 'x', visualSeed: 1, source: 't' });
  const strip = (p) => importSession(readFileSync(p, 'utf8').split('\n')).events
    .map(({ arrivalMs, ...rest }) => rest); // arrivalMs is wall-clock, excluded
  assert.deepEqual(strip(a), strip(b));
});

test('a throwing source rejects but still flushes and closes the partial file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'traces-'));
  const out = join(dir, 'partial.jsonl');
  const boom = new Error('live source died');
  async function* dyingSource() {
    yield { raw: { t: 1, z: 0, s: 1, ts: 1000 }, arrivalMs: 1 };
    yield { raw: { t: 1, z: 0, s: 2, ts: 1001 }, arrivalMs: 2 };
    throw boom;
  }
  await assert.rejects(
    () => recordFromSource(dyingSource(), { outPath: out, sessionId: 'crash-test', visualSeed: 7, source: 't' }),
    (err) => err === boom, // the source error itself propagates
  );
  // stream was ended, not leaked: header + both events reached disk as a
  // valid partial session (no end line)
  const imported = importSession(readFileSync(out, 'utf8').split('\n'));
  assert.equal(imported.meta.sessionId, 'crash-test');
  assert.equal(imported.complete, false);
  assert.equal(imported.events.length, 2);
  assert.deepEqual(imported.events[1].raw, { t: 1, z: 0, s: 2, ts: 1001 });
});
