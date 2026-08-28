// src/sources/live-source.js
import { setTimeout as sleep } from 'node:timers/promises';
import { createSseParser } from '../sse-parser.js';

// Async generator over the authenticated live SSE feed. Reconnects with
// backoff — including after a clean upstream close (proxy idle timeout,
// upstream restart): mid-take an end-of-stream is a disconnect, not the end
// of the show. Yields { raw, arrivalMs }. Snapshot frames are yielded as-is —
// the session/adapter skips them.
export async function* liveSource({ url, auth, token, maxRetries = Infinity, retryDelayMs = 500, maxRetryDelayMs = 4000, signal = null }) {
  let retries = 0;
  let delay = retryDelayMs;
  let authFailures = 0;
  const headers = { Accept: 'text/event-stream' };
  if (token && auth) {
    console.warn('live-source: both CS_EVENTS_AUTH and CS_EVENTS_TOKEN are set — CS_EVENTS_TOKEN (Bearer) wins; unset the stale one');
  }
  if (token) headers.Authorization = 'Bearer ' + token;
  else if (auth) headers.Authorization = 'Basic ' + Buffer.from(auth).toString('base64');

  while (true) {
    const queue = [];
    const parser = createSseParser((data) => {
      try { queue.push(JSON.parse(data)); } catch { /* torn frame */ }
    });
    try {
      const res = await fetch(url, { headers, signal });
      if (!res.ok) {
        // 401/403 are permanent, not transient: retry once (blip tolerance),
        // then surface the failure instead of silently retrying forever.
        if ((res.status === 401 || res.status === 403) && ++authFailures >= 2) {
          const err = new Error(`SSE auth failed (HTTP ${res.status}): check CS_EVENTS_AUTH / CS_EVENTS_TOKEN`);
          err.permanent = true;
          throw err;
        }
        throw new Error(`SSE HTTP ${res.status}`);
      }
      delay = retryDelayMs; // successful connect resets backoff
      const decoder = new TextDecoder();
      for await (const chunk of res.body) {
        retries = 0; // data is flowing — a long show earns a fresh retry budget
        parser.feed(decoder.decode(chunk, { stream: true }));
        while (queue.length) yield { raw: queue.shift(), arrivalMs: Date.now() };
      }
      // Clean end of stream: stop only when the consumer aborted or in
      // single-shot mode — otherwise it is a disconnect and we reconnect.
      // No error object exists here, so exhausted retries return quietly.
      if (signal?.aborted) return;
      if (maxRetries === 0) return; // tests use maxRetries:0 for single-shot
      if (retries >= maxRetries) return;
    } catch (err) {
      if (signal?.aborted) return;
      if (err?.permanent) throw err;
      if (retries >= maxRetries) {
        if (maxRetries === 0) return; // tests use maxRetries:0 for single-shot
        throw err;
      }
    }
    retries += 1;
    try {
      await sleep(delay, undefined, { signal: signal ?? undefined });
    } catch {
      return; // aborted mid-backoff — stop immediately, do not wait out the delay
    }
    if (signal?.aborted) return;
    delay = Math.min(delay * 2, maxRetryDelayMs);
  }
}
