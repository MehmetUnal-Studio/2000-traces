// test/file-source.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileSource } from '../src/sources/file-source.js';

const FIXTURE = new URL('../captures/fixture-small.sse.txt', import.meta.url).pathname;

test('yields parsed raw objects from a capture file', async () => {
  // The capture (like the real cs:events stream) opens with a `type:"snapshot"`
  // frame before any per-event lines; fileSource yields it unfiltered (shape
  // filtering is the adapter's job — see adapter.js), so we assert the shape
  // on the first *event-shaped* raw object rather than index 0.
  let n = 0; let firstEvent = null;
  for await (const { raw } of fileSource(FIXTURE)) {
    if (firstEvent === null && typeof raw.t === 'number') firstEvent = raw;
    n += 1;
  }
  assert.equal(n, 3000);
  assert.equal(typeof firstEvent.t, 'number');
  assert.equal(typeof firstEvent.z, 'number');
  assert.equal(typeof firstEvent.ts, 'number');
});

test('skips unparseable lines without throwing', async () => {
  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'traces-'));
  const p = join(dir, 'bad.txt');
  writeFileSync(p, 'data: {"t":1,"z":0,"s":0,"ts":1}\n\ndata: {broken\n\ndata: {"t":0,"z":0,"s":0,"ts":2}\n\n');
  const got = [];
  for await (const { raw } of fileSource(p)) got.push(raw.t);
  assert.deepEqual(got, [1, 0]);
});
