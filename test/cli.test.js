// test/cli.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { unlink } from 'node:fs/promises';

const cliPath = new URL('../src/cli.js', import.meta.url).pathname;

test('record-live terminates with a summary when upstream cleanly closes and stays down', async () => {
  // Hub serves one event, ends the response cleanly, then dies for good.
  // Clean close reconnects by design (never lose a live take), so with no
  // events flowing stopAfterMs alone can never fire — the CLI needs the same
  // wall-clock killer the server has, or it reconnect-loops forever and the
  // operator's Ctrl-C loses the JSONL end line and the printed summary.
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' });
    res.write('data: {"type":"snapshot","zones":{}}\n\n');
    res.write('data: {"t":1,"z":0,"s":1,"ts":10}\n\n');
    res.end(); // clean close, no error
    res.once('close', () => { server.closeAllConnections?.(); server.close(); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/api/events`;

  const child = spawn(process.execPath, [cliPath, 'record-live'], {
    env: { ...process.env, CS_EVENTS_URL: url, CS_EVENTS_TOKEN: 'tok-test', DURATION_SEC: '0.3' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.on('data', (d) => { stdout += d; });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });

  // Deadline is durationMs + 5000 grace (mirrors server.js's killer): with
  // DURATION_SEC=0.3 the CLI must be done well inside 9s.
  let guard = null;
  const exit = await Promise.race([
    new Promise((r) => child.once('exit', (code) => r({ code }))),
    new Promise((r) => { guard = setTimeout(() => r({ timedOut: true }), 9000); }),
  ]);
  clearTimeout(guard);
  if (exit.timedOut) {
    child.kill('SIGKILL');
    assert.fail(`record-live still running 9s after a 0.3s take — reconnect loop never released the CLI; stderr: ${stderr}`);
  }
  assert.equal(exit.code, 0, `record-live exited ${exit.code}; stderr: ${stderr}`);

  const summary = JSON.parse(stdout);
  assert.equal(summary.stats.received >= 1, true, `expected the pre-close event in stats, got ${JSON.stringify(summary.stats)}`);
  const lines = readFileSync(summary.outPath, 'utf8').trim().split('\n');
  const last = JSON.parse(lines.at(-1));
  assert.equal(last.kind, 'end', 'JSONL must carry the end/summary line, not a Ctrl-C torn tail');
  await unlink(summary.outPath).catch(() => {});
});
