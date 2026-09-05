// test/cli.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { unlink } from 'node:fs/promises';

const cliPath = new URL('../src/cli.js', import.meta.url).pathname;

test('record-live terminates with a summary when upstream cleanly closes and stays down', { timeout: 15000 }, async (t) => {
  // Give cold fetch/child startup headroom on a busy CI runner. A 300 ms take
  // could expire before the first response arrived, never exercising a clean
  // close after ingestion. Persisting the event is the shutdown handshake.
  const durationMs = 2000;
  const raw = { t: 1, z: 0, s: 1, ts: 10 };
  let upstream = null;
  // Hub serves one event, waits for its disk acknowledgment, then closes.
  // Clean close reconnects by design (never lose a live take), so with no
  // events flowing stopAfterMs alone can never fire — the CLI needs the same
  // wall-clock killer the server has, or it reconnect-loops forever and the
  // operator's Ctrl-C loses the JSONL end line and the printed summary.
  const server = createServer((req, res) => {
    upstream = res;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' });
    res.write('data: {"type":"snapshot","zones":{}}\n\n');
    res.write(`data: ${JSON.stringify(raw)}\n\n`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/api/events`;

  const child = spawn(process.execPath, [cliPath, 'record-live'], {
    env: { ...process.env, CS_EVENTS_URL: url, CS_EVENTS_TOKEN: 'tok-test', DURATION_SEC: String(durationMs / 1000) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.on('data', (d) => { stdout += d; });
  let stderr = '';
  let outPath = null;
  child.stderr.on('data', (d) => {
    stderr += d;
    outPath ??= stderr.match(/ -> ([^\n]+)\n/)?.[1] ?? null;
  });
  let closed = false;
  let spawnError = null;
  child.once('error', (error) => { spawnError = error; });
  // 'close' also waits for stdout/stderr to drain, unlike 'exit'.
  const exitPromise = new Promise((resolve) => child.once('close', (code) => { closed = true; resolve({ code }); }));
  let timedOut = false;
  const guard = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 12000);
  t.after(async () => {
    clearTimeout(guard);
    if (!closed) { child.kill('SIGKILL'); await exitPromise; }
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    if (outPath) await unlink(outPath).catch(() => {});
  });

  let persisted = null;
  while (!persisted && !closed) {
    if (outPath) {
      try {
        // Ignore an incomplete final line while the writer is still active.
        const lines = readFileSync(outPath, 'utf8').split('\n').slice(0, -1).filter(Boolean).map(JSON.parse);
        persisted = lines.find((line) => line.kind === 'event');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (!persisted) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(persisted, `fixture never observed its event before CLI exit; stdout: ${stdout}; stderr: ${stderr}`);
  assert.deepEqual(persisted.raw, raw);
  assert.ok(upstream);
  // Stop accepting reconnects but let this response finish normally. Forced
  // socket destruction is reserved for teardown, not the clean-close fixture.
  const upstreamClosed = new Promise((resolve) => server.close(resolve));
  upstream.end();
  await upstreamClosed;

  // Deadline is durationMs + 5000 grace (mirrors server.js's killer): with
  // a 2s take the CLI must finish inside the independent 12s test guard.
  const exit = await exitPromise;
  clearTimeout(guard);
  assert.equal(timedOut, false, `record-live still running 12s after a 2s take — reconnect loop never released the CLI; stderr: ${stderr}`);
  assert.equal(spawnError, null);
  assert.equal(exit.code, 0, `record-live exited ${exit.code}; stderr: ${stderr}`);

  const summary = JSON.parse(stdout);
  assert.equal(summary.outPath, outPath);
  assert.equal(summary.stats.received, 1);
  assert.equal(summary.stats.stored, 1);
  const lines = readFileSync(summary.outPath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(lines[0].durationMs, durationMs);
  assert.deepEqual(lines.filter((line) => line.kind === 'event').map((line) => line.raw), [raw]);
  const last = lines.at(-1);
  assert.equal(last.kind, 'end', 'JSONL must carry the end/summary line, not a Ctrl-C torn tail');
  assert.equal(last.events, 1);
  assert.ok(last.endedAtLocalMs - lines[0].startedAtLocalMs >= durationMs, 'upstream close must not prematurely finish the take');
});
