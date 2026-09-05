import test from 'node:test';
import assert from 'node:assert/strict';
import { createUdpReplayClient, UDP_DESTINATION, replayErrorMessage } from '../viz/src/udp-replay-client.js';

const source = { sessionId: 'take-1', durationMs: 5000 };
const ready = { state: 'READY', file: 'take-1.jsonl', ...source, positionMs: 0, speed: 1, activeVoices: 0, busy: false, destination: UDP_DESTINATION };
const response = (value, ok = true) => ({ ok, status: ok ? 200 : 409, json: async () => value });
function fixture(handler) {
  let time = 0; const calls = []; const timers = new Map(); let id = 0;
  let state = { ...ready, state: 'EMPTY', sessionId: null, durationMs: 0 };
  const request = async (path, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : {};
    calls.push({ path, method: options.method || 'GET', body });
    if (handler) return handler(path, body, state);
    if (path.endsWith('/load')) state = { ...ready };
    if (path.endsWith('/play')) state = { ...state, state: 'PLAYING', positionMs: body.positionMs ?? state.positionMs, speed: body.speed ?? state.speed };
    if (path.endsWith('/pause')) state = { ...state, state: 'PAUSED' };
    if (path.endsWith('/seek')) state = { ...state, positionMs: body.positionMs };
    if (path.endsWith('/stop')) state = { ...state, state: 'READY', positionMs: 0, activeVoices: 0 };
    return response(state);
  };
  const client = createUdpReplayClient({ request, now: () => time, schedule: (fn) => { timers.set(++id, fn); return id; }, unschedule: (key) => timers.delete(key) });
  return { client, calls, timers, time: (value) => { time = value; } };
}

test('archive construction is silent; demo opt-in performs no request; preparation never plays', async () => {
  const { client, calls } = fixture();
  assert.equal(client.enabled, false); assert.equal(calls.length, 0);
  await assert.rejects(client.enable({ ...source, simulated: true }), /Örnek/);
  assert.equal(calls.length, 0);
  await client.enable(source);
  assert.deepEqual(calls.map((c) => c.path), ['/api/replay/status', '/api/replay/load']);
  assert.deepEqual(calls[1].body, { file: 'take-1.jsonl' });
  assert.equal(client.snapshot().playing, false);
  await client.disable(); // a merely prepared client has no voices to release.
  assert.equal(calls.length, 2); client.dispose();
});

test('explicit play selects only the fixed destination and source clock freezes when stale', async () => {
  const { client, calls, time } = fixture();
  await client.enable(source); await client.play({ positionMs: 100, speed: 2 });
  assert.deepEqual(calls.at(-1).body, { destination: UDP_DESTINATION, positionMs: 100, speed: 2 });
  time(100); assert.equal(client.snapshot().positionMs, 300); assert.equal(client.snapshot().playing, true);
  time(1000); assert.equal(client.snapshot().positionMs, 1900); assert.equal(client.snapshot().playing, false);
  time(3000); assert.equal(client.snapshot().positionMs, 1900);
  await client.disable(); assert.equal(calls.at(-1).path, '/api/replay/stop'); assert.equal(client.enabled, false); client.dispose();
});

test('scrub pauses the UDP source before seeking and never implicitly resumes output', async () => {
  const { client, calls } = fixture();
  await client.enable(source); await client.play(); await client.seek(1234.5);
  assert.deepEqual(calls.slice(-2).map((c) => c.path), ['/api/replay/pause', '/api/replay/seek']);
  assert.equal(client.snapshot().positionMs, 1234.5); assert.equal(client.snapshot().playing, false);
  await client.disable(); client.dispose();
});

test('opt-in refuses an existing producer and mismatched recording duration', async () => {
  const playing = fixture(() => response({ ...ready, state: 'PLAYING', activeVoices: 1 }));
  await assert.rejects(playing.client.enable(source), /başka bir UDP/); assert.equal(playing.calls.length, 1);
  const mismatch = fixture((path) => response(path.endsWith('/load') ? { ...ready, durationMs: 6000 } : { ...ready, state: 'EMPTY' }));
  await assert.rejects(mismatch.client.enable(source), /süresi/); assert.equal(mismatch.client.enabled, false);
  playing.client.dispose(); mismatch.client.dispose();
});

test('stop cancels a pending play and late responses cannot re-enable output', async () => {
  let resolvePlay;
  const { client, calls } = fixture((path) => {
    if (path.endsWith('/play')) return new Promise((resolve) => { resolvePlay = resolve; });
    return response(path.endsWith('/status') ? { ...ready, state: 'EMPTY' } : ready);
  });
  await client.enable(source);
  const pending = client.play();
  await client.disable();
  assert.equal(calls.at(-1).path, '/api/replay/stop');
  resolvePlay(response({ ...ready, state: 'PLAYING' })); await pending;
  assert.equal(client.enabled, false); assert.equal(client.snapshot().playing, false); client.dispose();
});

test('canceling a pending silent load does not stop another transport or enable late', async () => {
  let resolveLoad;
  const { client, calls } = fixture((path) => path.endsWith('/load') ? new Promise((resolve) => { resolveLoad = resolve; }) : response({ ...ready, state: 'EMPTY' }));
  const loading = client.enable(source);
  while (!resolveLoad) await Promise.resolve();
  await client.disable();
  resolveLoad(response(ready)); await loading;
  assert.equal(calls.some((c) => c.path.endsWith('/stop')), false);
  assert.equal(client.enabled, false); client.dispose();
});

test('Engine Hold rejection is readable and retains explicit stop access', async () => {
  const { client } = fixture((path) => path.endsWith('/play')
    ? response({ error: 'Venue Engine is still sending to this route; use its Hold control before UDP replay', replay: { ...ready, state: 'ERROR' } }, false)
    : response(path.endsWith('/status') ? { ...ready, state: 'EMPTY' } : ready));
  await client.enable(source); await assert.rejects(client.play());
  assert.match(client.snapshot().error, /Hold/); assert.equal(client.enabled, true);
  assert.match(replayErrorMessage(new Error('Failed to fetch')), /ulaşılamadı/);
  await client.disable(); client.dispose();
});
