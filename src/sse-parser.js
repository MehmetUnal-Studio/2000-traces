// src/sse-parser.js
// Incremental Server-Sent-Events parser: feed() raw text chunks, get each
// frame's data payload via callback. Only the `data:` field is used — the
// demo-server emits exactly one single-line data field per frame.
export function createSseParser(onData) {
  let buf = '';
  return {
    feed(chunk) {
      // Normalize on the buffer, not the chunk, so a CRLF split across two
      // feed() calls still collapses; the pending '\r' waits for its '\n'.
      buf = (buf + chunk).replace(/\r\n/g, '\n');
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of frame.split('\n')) {
          if (line.startsWith('data: ')) onData(line.slice(6));
          else if (line.startsWith('data:')) onData(line.slice(5));
        }
      }
    },
  };
}
