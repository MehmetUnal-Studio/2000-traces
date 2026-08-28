// src/sources/file-source.js
import { createReadStream } from 'node:fs';
import { createSseParser } from '../sse-parser.js';

// Async generator over a raw SSE capture file (as saved by `curl -N`).
// Yields { raw, arrivalMs } as fast as the file reads; deterministic order.
// Lines that fail JSON.parse are skipped (the recorder never sees them —
// wire-level noise is not an audience event).
export async function* fileSource(path) {
  const queue = [];
  const parser = createSseParser((data) => {
    try { queue.push(JSON.parse(data)); } catch { /* skip torn frame */ }
  });
  const stream = createReadStream(path, { encoding: 'utf8' });
  for await (const chunk of stream) {
    parser.feed(chunk);
    while (queue.length) yield { raw: queue.shift(), arrivalMs: Date.now() };
  }
  parser.feed('\n\n'); // flush a trailing frame without a final blank line
  while (queue.length) yield { raw: queue.shift(), arrivalMs: Date.now() };
}
