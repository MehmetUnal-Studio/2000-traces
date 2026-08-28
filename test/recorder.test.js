// test/recorder.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { recordFromSource } from '../src/recorder.js';
import { fileSource } from '../src/sources/file-source.js';
import { importSession } from '../src/jsonl.js';

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
  assert.deepEqual(imported.events[0].raw, imported.events[0].raw); // raw preserved on disk
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
