import test from 'node:test';
import assert from 'node:assert/strict';
import { formatGestureMotion } from '../viz/src/hud.js';
import { createLiveMotionSignals } from '../viz/src/motion-signals.js';
import { TYPE } from '../viz/src/gesture-replay.js';

test('selected motion uses normalized XY units and converts measured radians per second to degrees', () => {
  const motion = createLiveMotionSignals();
  const ingest = (t, x, y, kind = TYPE.move) => motion.ingest({ lane: 0, finger: 3, t, x, y, kind });
  ingest(0, .1, .1, TYPE.noteOn);
  ingest(500, .6, .1);
  const measured = ingest(1000, .6, .6);
  const formatted = formatGestureMotion({ motion: measured, exact: true, finger: 3, hasXY: true });
  assert.equal(formatted.available, true);
  assert.equal(formatted.speed, '1,000 birim/s');
  assert.equal(formatted.turn, '180,0 °/s');
  const stopped = formatGestureMotion({ motion: ingest(1500, .6, .6), exact: true, finger: 3, hasXY: true });
  assert.equal(stopped.available, true, 'observed stillness is a valid measurement');
  assert.equal(stopped.speed, '0,000 birim/s');
  assert.equal(stopped.turn, '0,0 °/s');
});

test('legacy identity, missing derivatives and malformed values remain unavailable rather than inferred zero', () => {
  const valid = { valid: true, speed: 0, turn: 0 };
  for (const state of [
    { exact: false, finger: null, motion: valid },
    { exact: true, source: 'legacy', finger: 0, motion: valid },
    { exact: true, finger: null, motion: valid },
    { exact: true, finger: 0, hasXY: false, motion: valid },
    { exact: true, finger: 0, motion: { ...valid, valid: false } },
    { exact: true, finger: 0, motion: { ...valid, speed: NaN } },
    { exact: true, finger: 0, motion: { ...valid, turn: Infinity } },
  ]) {
    const formatted = formatGestureMotion(state);
    assert.equal(formatted.available, false);
    assert.equal(formatted.speed, 'Mevcut değil');
    assert.equal(formatted.turn, 'Mevcut değil');
  }
});
