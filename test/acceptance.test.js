// test/acceptance.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { recordFromSource } from '../src/recorder.js';
import { fileSource } from '../src/sources/file-source.js';
import { importSession } from '../src/jsonl.js';

const CAPTURE = new URL('../captures/2026-08-28-loadgen384-45s.sse.raw', import.meta.url).pathname;

test('full 384-participant capture: counts, identity, monotonicity, round-trip', { skip: !existsSync(CAPTURE) }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'traces-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = join(dir, 'full.jsonl');
  const summary = await recordFromSource(fileSource(CAPTURE), {
    outPath: out, sessionId: 'acceptance', visualSeed: 1, source: 'file:capture',
  });

  // MVP criterion 3+4: stable identities, every participant owns a trace
  assert.equal(summary.participants, 384);
  // Every event accounted for: stored + rejected == received (criterion 11 bookkeeping)
  const st = summary.stats;
  assert.equal(st.received, 263986);
  assert.equal(st.stored + st.malformed + st.duplicates + st.late + st.early, st.received);
  assert.equal(st.malformed, 0);

  // Criterion 5: a seat's complete trace is isolable and internally ordered
  const store = summary.session.store;
  for (const pid of store.participants().keys()) {
    const evs = store.eventsOf(pid);
    assert.equal(evs.length > 0, true, `${pid} has a trace`);
    for (let i = 1; i < evs.length; i++) {
      assert.equal(evs[i].serverTimestampMs >= evs[i - 1].serverTimestampMs, true,
        `${pid} trace is time-ordered`);
    }
  }

  // Criterion 7/9: export → import round-trip preserves everything stored
  const imported = importSession(readFileSync(out, 'utf8').split('\n'));
  assert.equal(imported.complete, true);
  assert.equal(imported.events.length, st.stored);
  assert.equal(imported.meta.visualSeed, 1);
  // raw preserved on disk for every event
  assert.equal(imported.events.every((e) => e.raw && typeof e.raw.t === 'number'), true);
});
