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

test('label option flows through to the session header, sanitized', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'traces-'));
  const out = join(dir, 'session.jsonl');
  await recordFromSource(fileSource(FIXTURE), {
    outPath: out, sessionId: 'rec-label', visualSeed: 1, source: 'test', label: '<script>x',
  });
  const imported = importSession(readFileSync(out, 'utf8').split('\n'));
  assert.equal(imported.meta.label, 'scriptx');
});

test('records a file source to JSONL and finalizes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'traces-'));
  const out = join(dir, 'session.jsonl');
  const summary = await recordFromSource(fileSource(FIXTURE), {
    outPath: out, sessionId: 'rec-test', visualSeed: 42, source: `file:${FIXTURE}`,
  });
  assert.equal(summary.stats.stored > 0, true);
  assert.equal(summary.stats.stored + summary.stats.malformed + summary.stats.duplicates + summary.stats.late + summary.stats.early,
    summary.stats.received);
  const imported = importSession(readFileSync(out, 'utf8').split('\n'));
  assert.equal(imported.meta.sessionId, 'rec-test');
  assert.equal(imported.meta.visualSeed, 42);
  assert.equal(imported.meta.durationMs, 180000);
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

test('three-minute wall-clock stop closes the source and writes one complete final summary', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'traces-stop-'));
  const out = join(dir, 'session.jsonl');
  let clock = 1000; let sourceClosed = false;
  async function* timedSource() {
    try {
      for (const elapsed of [0, 90001, 179999, 180000, 180001]) {
        clock = 1000 + elapsed;
        yield { raw: { t: 1, z: 0, s: 1, ts: 2000 + elapsed }, arrivalMs: clock };
      }
    } finally { sourceClosed = true; }
  }
  const summary = await recordFromSource(timedSource(), {
    outPath: out, sessionId: 'three-minute-stop', visualSeed: 1, stopAfterMs: 180000, now: () => clock,
  });
  assert.equal(sourceClosed, true);
  assert.equal(summary.durationMs, 180000);
  assert.equal(summary.session.state(), 'COMPLETE');
  assert.equal(summary.endedAtLocalMs - summary.startedAtLocalMs, 180000);
  assert.equal(summary.events, 3, 'wall-clock stop runs before accepting the next event at the deadline');
  const lines = readFileSync(out, 'utf8').trim().split('\n');
  const imported = importSession(lines);
  assert.equal(imported.complete, true);
  assert.equal(imported.meta.durationMs, 180000);
  assert.deepEqual(imported.events.map((event) => event.tMs), [0, 90001, 179999]);
  assert.equal(lines.filter((line) => JSON.parse(line).kind === 'end').length, 1);
  assert.equal(imported.end.events, summary.events);
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

test('onSession fires with the live session once recording has started', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'traces-'));
  const out = join(dir, 'session.jsonl');
  let seen = null;
  let stateAtCallback = null;
  const record = recordFromSource(fileSource(FIXTURE), {
    outPath: out, sessionId: 'hook-test', visualSeed: 3, source: 't',
    onSession: (s) => { seen = s; stateAtCallback = s.state(); },
  });
  // the callback fires synchronously, before the first await inside recordFromSource
  assert.ok(seen, 'onSession was called');
  assert.equal(stateAtCallback, 'RECORDING');
  const summary = await record;
  assert.equal(seen.state(), 'COMPLETE');
  assert.equal(seen.stats().stored, summary.stats.stored);
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
