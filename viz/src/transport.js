// viz/src/transport.js
// Replay clock: session-relative milliseconds, original relative timing at 1x.
export function createTransport(durationMs) {
  const t = { time: durationMs, playing: false, speed: 1, onEnd: null };
  return {
    get time() { return t.time; },
    get playing() { return t.playing; },
    get speed() { return t.speed; },
    setSpeed(s) { t.speed = s; },
    play() {
      if (t.time >= durationMs) t.time = 0;
      t.playing = true;
    },
    pause() { t.playing = false; },
    seek(ms) { t.time = Math.min(durationMs, Math.max(0, ms)); },
    toEnd() { t.time = durationMs; t.playing = false; },
    restart() { t.time = 0; t.playing = true; },
    tick(dtMs) {
      if (!t.playing) return;
      t.time += dtMs * t.speed;
      if (t.time >= durationMs) { t.time = durationMs; t.playing = false; t.onEnd?.(); }
    },
    set onEnd(fn) { t.onEnd = fn; },
  };
}
