import { createSocket } from 'node:dgram';
import { loadReplayData } from './replay-data.js';
import { DEFAULT_UDP_DESTINATION, validateDestination, eventOscGroup, oscBundles, voiceKey, seatKey } from './osc-replay.js';

const MAX_HELD = 4096;
const MAX_EVENTS_PER_TICK = 4096;
const clamp = (time, duration) => Math.max(0, Math.min(duration, time));

function udpSender() {
  let socket = null;
  return {
    async send(buffers, destination) {
      if (!buffers.length) return;
      if (!socket) {
        socket = createSocket('udp4');
        socket.on('error', () => {}); // per-send callback reports errors to the transport
      }
      for (const buffer of buffers) await new Promise((resolve, reject) => socket.send(buffer, destination.port, destination.host, (error) => error ? reject(error) : resolve()));
    },
    close() { if (socket) { socket.close(); socket = null; } },
  };
}

/** Current verified ingress shares its voice identities with the Venue Engine. */
export async function ensureVenueOutputPaused(destination) {
  if (destination.port !== 6061) return;
  let state;
  try {
    const response = await fetch('http://127.0.0.1:7789/state', { signal: AbortSignal.timeout(1500) });
    if (!response.ok) throw new Error('unavailable');
    const value = await response.json();
    if (typeof value.paused !== 'boolean' || typeof value.udpHost !== 'string' || !Number.isInteger(value.udpPort)) throw new Error('invalid status');
    state = { paused: value.paused, connected: value.connected, udpHost: value.udpHost, udpPort: value.udpPort };
  } catch { throw new Error('Venue Engine output state could not be verified; use its local Hold control before replaying to 6061'); }
  if (state.paused !== true && state.udpHost === destination.host && state.udpPort === destination.port) {
    throw new Error('Venue Engine is still sending to this route; use its Hold control before UDP replay');
  }
}

/** Serialized transport: one monotonic clock, one scheduler, only replay-owned voices. */
export function createUdpReplay({ now = () => performance.now(), schedule = setTimeout, unschedule = clearTimeout,
  sender = udpSender(), canPlay = () => true, guardDestination = ensureVenueOutputPaused } = {}) {
  let data = null; let file = null; let state = 'EMPTY'; let position = 0; let speed = 1;
  let destination = { ...DEFAULT_UDP_DESTINATION }; let anchor = 0; let cursor = 0; let timer = null;
  let error = null; let serial = Promise.resolve(); let disposed = false; let starting = false; let cancelEpoch = 0;
  let eventsSent = 0; let datagramsSent = 0; let messagesSent = 0; let cleanupMessages = 0;
  const held = new Map();
  const clock = () => data ? state === 'PLAYING' ? clamp(position + (now() - anchor) * speed, data.durationMs) : position : 0;
  const enqueue = (action) => { const next = serial.then(action); serial = next.catch(() => {}); return next; };
  const clearTimer = () => { if (timer !== null) unschedule(timer); timer = null; };
  const status = () => ({ state, file, sessionId: data?.sessionId ?? null, label: data?.label ?? '', durationMs: data?.durationMs ?? 0,
    positionMs: clock(), speed, destination: { ...destination }, sourceEvents: data?.sourceEvents ?? 0,
    playableEvents: data?.eventCount ?? 0, skippedEvents: data?.skipped ?? 0, bridgeUnsupported: data?.bridgeUnsupported ?? 0,
    eventsSent, datagramsSent, messagesSent, cleanupMessages, activeVoices: held.size, busy: starting || state === 'LOADING', error });

  async function emit(groups, cleanup = false) {
    if (!groups.length) return;
    const packets = oscBundles(groups);
    await sender.send(packets, destination);
    datagramsSent += packets.length;
    const messages = groups.reduce((sum, group) => sum + group.length, 0);
    messagesSent += messages; if (cleanup) cleanupMessages += messages;
  }
  async function releaseHeld() {
    const groups = [...held.values()].map((event) => eventOscGroup({ ...event, k: 2 }));
    await emit(groups, true); held.clear();
  }
  function track(event, voices) {
    const key = voiceKey(event);
    if (event.k === 5) {
      const prefix = seatKey(event);
      for (const id of voices.keys()) if (id.startsWith(prefix)) voices.delete(id);
    } else if (event.k === 1) {
      if (!voices.has(key) && voices.size >= MAX_HELD) throw new Error('Replay exceeds the 4096 active-voice limit');
      voices.set(key, event);
    } else if (event.k === 2) voices.delete(key);
    else if (event.k === 3 && voices.has(key)) voices.set(key, { ...voices.get(key), x: event.x, y: event.y });
  }
  async function restore() {
    const voices = new Map();
    for (let i = 0; i < cursor; i++) track(data.at(i), voices);
    const groups = [...voices.values()].map((event) => eventOscGroup({ ...event, k: 1 }));
    for (const [key, event] of voices) held.set(key, event);
    await emit(groups);
  }
  async function failure(reason) {
    clearTimer(); position = clock(); state = 'ERROR'; error = reason?.message ?? String(reason);
    try { await releaseHeld(); } catch (cleanupError) { error += `; voice cleanup failed: ${cleanupError.message}`; }
  }
  function armTimer(delay = 10) {
    clearTimer();
    timer = schedule(() => { timer = null; enqueue(tick).catch((reason) => enqueue(() => failure(reason))); }, delay);
  }
  async function tick() {
    if (state !== 'PLAYING' || disposed) return;
    const due = clock(); const groups = []; const cleanupCandidates = new Map(held);
    let emittedEvents = 0;
    let drained = 0;
    while (cursor < data.eventCount && data.at(cursor).t <= due && drained < MAX_EVENTS_PER_TICK) {
      const event = data.at(cursor++); drained++;
      if (event.k === 5) {
        const prefix = seatKey(event); let emitted = false;
        for (const [key, active] of held) if (key.startsWith(prefix)) { groups.push(eventOscGroup({ ...active, k: 2 })); held.delete(key); emitted = true; }
        if (emitted) emittedEvents++;
      } else {
        // An orphaned recorded release never turns off another producer's note.
        if (event.k === 2 && !held.has(voiceKey(event))) continue;
        track(event, held);
        if (event.k === 1) cleanupCandidates.set(voiceKey(event), event);
        const group = eventOscGroup(event);
        if (group) { groups.push(group); emittedEvents++; }
      }
    }
    try { await emit(groups); }
    catch (reason) {
      // UDP send failure may occur after only some bundles reached the kernel.
      // Release the union of every voice we could have started, including a
      // voice whose release was in an unsuccessfully sent bundle.
      for (const [key, event] of cleanupCandidates) held.set(key, event);
      throw reason;
    }
    eventsSent += emittedEvents;
    if (cursor === data.eventCount && due >= data.durationMs) {
      position = data.durationMs; state = 'COMPLETE'; await releaseHeld(); return;
    }
    armTimer(drained === MAX_EVENTS_PER_TICK ? 0 : 10);
  }
  function requireData() { if (!data) throw new Error('Load a recorded session before UDP playback'); }
  function requireIdleCapture() { if (!canPlay()) throw new Error('Stop and finalize recording before UDP replay'); }
  function checkedPosition(value) { if (!Number.isFinite(value)) throw new Error('Invalid replay position'); return clamp(value, data.durationMs); }
  function checkedSpeed(value) { if (!Number.isFinite(value) || value < .25 || value > 4) throw new Error('Replay speed must be between 0.25 and 4'); return value; }

  return {
    status,
    isPlaying: () => state === 'PLAYING',
    blocksRecording: () => starting || state === 'PLAYING' || held.size > 0,
    load(path, name) {
      return enqueue(async () => {
        if (data && file === name) return status();
        requireIdleCapture();
        if (state === 'PLAYING' || held.size) throw new Error('Stop UDP replay before loading another recording');
        clearTimer(); state = 'LOADING'; error = null;
        try {
          const loaded = await loadReplayData(path);
          data = loaded; file = name; position = 0; cursor = 0; speed = 1;
          eventsSent = 0; datagramsSent = 0; messagesSent = 0; cleanupMessages = 0; state = 'READY';
          return status();
        } catch (reason) { data = null; file = null; state = 'ERROR'; error = reason.message; throw reason; }
      });
    },
    play(options = {}) {
      const requestEpoch = cancelEpoch;
      return enqueue(async () => {
        if (requestEpoch !== cancelEpoch || disposed) throw new Error('Replay start was canceled');
        requireData(); requireIdleCapture();
        const target = validateDestination(options.destination ?? destination);
        const nextSpeed = options.speed === undefined ? speed : checkedSpeed(options.speed);
        const nextPosition = options.positionMs === undefined ? clock() : checkedPosition(options.positionMs);
        if (state === 'PLAYING' && options.positionMs === undefined && nextSpeed === speed && target.host === destination.host && target.port === destination.port) return status();
        starting = true;
        try {
          await guardDestination(target); requireIdleCapture();
          if (requestEpoch !== cancelEpoch || disposed) throw new Error('Replay start was canceled');
          if (target.port === 6061 && data.bridgeUnsupported) throw new Error(`This take has ${data.bridgeUnsupported} events outside the current A–P / finger0 bridge contract`);
          clearTimer(); await releaseHeld(); destination = target; position = nextPosition; speed = nextSpeed;
          if (position >= data.durationMs) position = 0;
          cursor = data.lowerBound(position); error = null;
          await restore(); state = 'PLAYING'; anchor = now(); armTimer(0); starting = false; return status();
        } catch (reason) { await failure(reason); throw reason; }
        finally { starting = false; }
      });
    },
    pause() {
      cancelEpoch++; clearTimer();
      return enqueue(async () => {
        requireData(); clearTimer(); position = clock(); state = 'PAUSED';
        try { await releaseHeld(); return status(); } catch (reason) { await failure(reason); throw reason; }
      });
    },
    seek(positionMs) {
      const requestEpoch = cancelEpoch;
      return enqueue(async () => {
        requireData(); const next = checkedPosition(positionMs); const playing = state === 'PLAYING';
        clearTimer(); position = clock(); state = 'PAUSED'; starting = playing;
        try {
          await releaseHeld(); position = next; cursor = data.lowerBound(position);
          if (playing) {
            requireIdleCapture(); await guardDestination(destination);
            if (requestEpoch !== cancelEpoch || disposed) throw new Error('Replay seek was canceled');
            await restore(); state = 'PLAYING'; anchor = now(); armTimer(0);
          }
          starting = false; return status();
        } catch (reason) { await failure(reason); throw reason; }
        finally { starting = false; }
      });
    },
    setSpeed(value) {
      return enqueue(async () => {
        const next = checkedSpeed(value); position = clock(); speed = next; anchor = now(); return status();
      });
    },
    stop() {
      cancelEpoch++; clearTimer();
      return enqueue(async () => {
        clearTimer(); position = 0; cursor = 0; state = data ? 'READY' : 'EMPTY';
        try { await releaseHeld(); error = null; return status(); } catch (reason) { await failure(reason); throw reason; }
      });
    },
    async close() {
      disposed = true; cancelEpoch++; clearTimer();
      await enqueue(async () => { clearTimer(); try { await releaseHeld(); } finally { sender.close?.(); state = 'EMPTY'; data = null; } });
    },
  };
}
