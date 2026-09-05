# Recorded-session UDP replay

UDP replay is an explicit output mode for a saved, complete JSONL session. Opening an artwork, loading a take, or viewing the recorder panel sends no UDP. The synthetic in-memory demo has no saved session to transmit.

Enable the viewer's UDP output control, confirm the visible local destination and start playback. The server's source-time clock drives output; pause, seek, speed (0.25×–4×) and stop apply to the same global transport. The recording desk shows that transport and provides **UDP'yi durdur** even if the viewer is closed. Closing a browser tab does not stop the server transport; use Stop.

## Verified workstation route

The installed **Cosmic Venue Engine 2.5.1** sends to **127.0.0.1:6061**. The local `venue_monitor.py` listens there, and its enabled zone router maps A→6062, B→6063, … P→6077 on loopback; its quarantine destination is port 7000. Replay defaults to the existing ingress so routing and the bridge's movement governor remain in the path. The destination port is editable; the host is restricted to `127.0.0.1`.

Before playback to 6061, put the Venue Engine's output on **Hold**. Replay reads its local `/state` endpoint on port 7789 and refuses output while the Engine still sends to that same destination or its state cannot be verified. Replay never edits Engine settings, zone routes or DAW configuration. An active or pending UDP start also prevents this application's recording ARM/START; recording must finish before replay can start.

Mapping was verified from the installed application's `Contents/Resources/engine/src/index.js` (`pktToOscMessage`) and `src/osc.js`, current Engine state, `~/venue-bridge/venue_monitor.py`, `zone_routes.json` and local socket listeners. Current zone IDs are A–K and `OSC_SOURCE_BASE` uses its default 0; source seat numbers are retained.

| Recorded event | OSC messages, in order |
| --- | --- |
| Note on | `/cs/<zone>/<seat>/finger<f>/u` float32; `/v` float32; `/on` int32 1 |
| Movement | Same `/u` and `/v` float32 pair |
| Note off | Same `/on` int32 0 |
| Disconnect | `/on` int32 0 for that seat's replay-owned active fingers |
| Keepalive / progress | No output |

The current Engine does **not** emit `/line`. Every source event's messages stay together in an immediate OSC bundle; packets never exceed 8,192 bytes. The recorder retained pre-OSC SSE events, so replay converts original values into the established OSC contract; it is not a capture of the former UDP datagrams. X/Y become float32 on the wire, as in the Engine, while the source-time index retains Float64 timestamps. A fixed local scheduler emits due events without adding beat quantization.

Missing finger identity or invalid/missing coordinates are disclosed in the skipped count rather than invented. The current bridge accepts A–P, seats 0–255 and finger 0; a take containing otherwise addressable events outside that bridge contract is refused on the default route. Other local receiver ports preserve their original addressable finger IDs.

## Transport and cleanup

Files are streamed into bounded-size numeric chunks and sorted globally by timestamp, preserving file order for ties. Limits are 5,000,000 source events, a 2 GiB input file, 4,096 active replay voices and 4,096 due events per scheduler pass. No complete per-event JavaScript object history is retained.

Pause, seek, stop, completion and graceful server shutdown release only voices this replay could have started. Resume or a playing seek rebuilds held source notes with their latest recorded X/Y. An orphaned note-off never turns off another producer's voice. STOP cancels a pending start, clears scheduling and emits scoped releases; send errors stop output and attempt the same cleanup. UDP counters describe local sending, not receiver acknowledgements or audible acceptance.

## Local API

All actions are `POST` with JSON; successful responses are the transport status. `GET /api/replay/status` observes the same global transport from any local tab.

| Endpoint | Body |
| --- | --- |
| `/api/replay/load` | `{ "file": "session-….jsonl" }` — silent, same-file load is idempotent |
| `/api/replay/play` | Optional `{ "destination": { "host": "127.0.0.1", "port": 6061 }, "positionMs": 0, "speed": 1 }` |
| `/api/replay/pause` | `{}` |
| `/api/replay/seek` | `{ "positionMs": 45000 }` |
| `/api/replay/speed` | `{ "speed": 0.5 }` |
| `/api/replay/stop` | `{}` |

States: `EMPTY`, `LOADING`, `READY`, `PLAYING`, `PAUSED`, `COMPLETE`, `ERROR`. Status includes source identity, duration, source position, speed, destination, validity counts, sending counts and active replay voices. Errors return an explanatory `error` plus current `replay` status; commands from nonlocal browser origins are rejected.

## Verification

[UDP regressions](../test/udp-replay.test.js) cover independent OSC decoding, exact message order/types, group-preserving packet bounds, precision and timestamp sorting, silent loading, timing, speed, held-position reconstruction, disconnect/completion cleanup, a real ephemeral UDP receiver, capture exclusion, nonlocal-origin rejection, pending-start cancellation and send-failure cleanup. A separate read-only comparison matched 72 representative groups byte-for-byte against the installed Engine's own serializer.

The saved 2026-09-05T12-53-00-434Z synthetic take loads with 748,468 source events, 739,108 playback records, 9,360 nonmusical records skipped and zero bridge-contract exclusions. Its header duration remains 180,000 ms. A later two-second replay through the running 6061 bridge matched 53 sender/receiver datagrams and 162 OSC elements; see [production-route evidence and receiver limits](UDP-REPLAY-VALIDATION.md). Audible acceptance remains separate.
