// src/sources/live-source.js
import { createSseParser } from '../sse-parser.js';

// Async generator over the authenticated live SSE feed. Reconnects with
// backoff; yields { raw, arrivalMs }. Snapshot frames are yielded as-is —
// the session/adapter skips them.
export async function* liveSource({ url, auth, token, maxRetries = Infinity, retryDelayMs = 500, maxRetryDelayMs = 4000, signal = null }) {
  let retries = 0;
  let delay = retryDelayMs;
  const headers = { Accept: 'text/event-stream' };
  if (token) headers.Authorization = 'Bearer ' + token;
  else if (auth) headers.Authorization = 'Basic ' + Buffer.from(auth).toString('base64');

  while (true) {
    const queue = [];
    const parser = createSseParser((data) => {
      try { queue.push(JSON.parse(data)); } catch { /* torn frame */ }
    });
    try {
      const res = await fetch(url, { headers, signal });
      if (!res.ok) throw new Error(`SSE HTTP ${res.status}`);
      delay = retryDelayMs; // successful connect resets backoff
      const decoder = new TextDecoder();
      for await (const chunk of res.body) {
        parser.feed(decoder.decode(chunk, { stream: true }));
        while (queue.length) yield { raw: queue.shift(), arrivalMs: Date.now() };
      }
      return; // clean end of stream
    } catch (err) {
      if (signal?.aborted) return;
      if (retries >= maxRetries) {
        if (maxRetries === 0) return; // tests use maxRetries:0 for single-shot
        throw err;
      }
      retries += 1;
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, maxRetryDelayMs);
    }
  }
}
