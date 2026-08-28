// test/server.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createControlServer } from '../src/server.js';
import { fileSource } from '../src/sources/file-source.js';

const FIXTURE = new URL('../captures/fixture-small.sse.txt', import.meta.url).pathname;

test('arm/start/stop lifecycle over HTTP', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'traces-'));
  const srv = createControlServer({ sessionsDir: dir, sourceFactory: () => fileSource(FIXTURE) });
  await srv.listen(0);
  const base = `http://127.0.0.1:${srv.port()}`;

  let st = await (await fetch(`${base}/api/status`)).json();
  assert.equal(st.state, 'IDLE');

  await fetch(`${base}/api/arm`, { method: 'POST' });
  st = await (await fetch(`${base}/api/status`)).json();
  assert.equal(st.state, 'ARMED');

  await fetch(`${base}/api/start`, { method: 'POST' });
  // file source drains fast; wait for completion
  for (let i = 0; i < 100 && st.state !== 'COMPLETE'; i++) {
    await new Promise((r) => setTimeout(r, 50));
    st = await (await fetch(`${base}/api/status`)).json();
  }
  assert.equal(st.state, 'COMPLETE');
  assert.equal(st.stats.stored > 0, true);

  const sessions = await (await fetch(`${base}/api/sessions`)).json();
  assert.equal(sessions.length, 1);
  await srv.close();
});
