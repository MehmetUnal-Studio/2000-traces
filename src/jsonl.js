// Session file lines. Raw payload rides on each event line so the on-disk file
// preserves the original message even though the in-memory store does not.
export function headerLine(meta, source) {
  return JSON.stringify({ kind: 'session', ...meta, source });
}

export function eventLine(rec, raw) {
  return JSON.stringify({ kind: 'event', ...rec, raw });
}

export function endLine(summary) {
  return JSON.stringify({ kind: 'end', ...summary });
}

export function importSession(lines) {
  let meta = null; let end = null; const events = [];
  // A crash/power-cut mid-flush can leave half a JSON line at EOF. Tolerate a
  // parse failure only on the FINAL non-empty line (hold it pending; rethrow if
  // more data follows) so a truncated take stays importable while a corrupt
  // mid-file line still throws.
  let pendingParseError = null;
  for (const line of lines) {
    if (!line || !line.trim()) continue;
    if (pendingParseError) throw pendingParseError;
    let obj;
    try { obj = JSON.parse(line); } catch (err) { pendingParseError = err; continue; }
    if (obj.kind === 'session') { meta = obj; continue; }
    if (!meta) throw new Error('file does not start with a session header');
    if (obj.kind === 'event') events.push(obj);
    else if (obj.kind === 'end') end = obj;
  }
  if (!meta) throw new Error('file does not start with a session header');
  return { meta, events, end, complete: end !== null, truncatedTail: pendingParseError !== null };
}
