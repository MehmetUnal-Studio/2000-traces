// src/cli.js
import { fileSource } from './sources/file-source.js';
import { liveSource } from './sources/live-source.js';
import { recordFromSource } from './recorder.js';
import { loadEnv } from './env.js';

const [, , cmd, arg] = process.argv;
const durationSec = Number(process.env.DURATION_SEC ?? 90);
const sessionId = `session-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const outPath = new URL(`../sessions/${sessionId}.jsonl`, import.meta.url).pathname;

const opts = {
  outPath, sessionId,
  visualSeed: Number(process.env.VISUAL_SEED ?? Math.floor(Math.random() * 2 ** 31)),
  durationMs: durationSec * 1000,
};

if (cmd === 'record-file') {
  if (!arg) { console.error('usage: node src/cli.js record-file <capture.raw>'); process.exit(1); }
  const summary = await recordFromSource(fileSource(arg), { ...opts, source: `file:${arg}` });
  console.log(JSON.stringify({ outPath: summary.outPath, participants: summary.participants, events: summary.events, stats: summary.stats }, null, 2));
} else if (cmd === 'record-live') {
  const env = loadEnv();
  const src = liveSource({ url: env.CS_EVENTS_URL, auth: env.CS_EVENTS_AUTH });
  console.error(`recording ${durationSec}s from ${env.CS_EVENTS_URL} -> ${outPath}`);
  const summary = await recordFromSource(src, { ...opts, source: env.CS_EVENTS_URL, stopAfterMs: durationSec * 1000 });
  console.log(JSON.stringify({ outPath: summary.outPath, participants: summary.participants, events: summary.events, stats: summary.stats }, null, 2));
} else {
  console.error('usage: node src/cli.js record-file <capture.raw> | record-live');
  process.exit(1);
}
