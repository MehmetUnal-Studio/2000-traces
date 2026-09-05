# Bounded production-route replay acceptance

**PASS for the local OSC transport and existing bridge route — 2026-09-05, 14:39:05–14:39:08 UTC.** This was an explicit, API-triggered replay of the first two seconds of a saved take. DAW configuration and zone routing were unchanged.

- Source: `sessions/session-2026-09-05T14-01-15-589Z.jsonl`
- Saved duration: 180,000 ms; 90 participants; 123,254 stored events, zero malformed/duplicate/early/late events.
- Loaded playback index: 121,394 records; 1,860 nonmusical records skipped; zero bridge-contract exclusions.
- Destination: **127.0.0.1:6061**, speed **1×**, initial source position **0 ms**.

The recorder was confirmed COMPLETE with a finished pack before restarting only its matching `node src/server.js` process (PID 98792). The new recorder listened on 8787 as PID 6219 and was left operational. Loading the source returned READY with **zero packets sent**.

The Venue Engine initially had `paused=false`. Its existing local `/pause` control set `paused=true` and released its held notes before the monitor baseline was taken. The replay ran for **2,018.3 ms** including command overhead; source position was **2,002.69 ms** at the observation immediately before STOP. STOP and Engine-state restoration were protected by a `finally` cleanup.

## Independent sender and bridge counts

| Measure | Observed result |
| --- | --- |
| Source events emitted | 77: 11 note-ons, 59 moves, 7 note-offs |
| Distinct source voices in the window | 8; last source timestamp 1,985 ms |
| Data output | 52 datagrams / 158 OSC messages |
| STOP cleanup | 1 datagram / 4 scoped `/on 0` messages |
| Total sender output | **53 datagrams / 162 OSC messages** |
| Monitor ingress delta | **53 datagrams / 162 OSC elements** |
| Existing bridge route | Zone H → **127.0.0.1:6069** |
| Routed output delta | 48 datagrams / 128 OSC elements |
| Existing movement-governor sampling | 34 motion elements skipped |
| Send errors / invalid schema / malformed packets | 0 / 0 / 0 |
| Quarantine / dropped / dated-bundle deltas | 0 / 0 / 0 |

The source-derived OSC count is `11 × 3 + 59 × 2 + 7 + 4 = 162`, matching monitor ingress exactly. Routed elements plus the bridge's existing motion sampling also conserve the count: `128 + 34 = 162`.

STOP returned READY at source position zero with **zero replay-owned active voices**, no error, and no further datagram increase during a subsequent quiet check. The Engine's original `paused=false` state was restored. A follow-up confirmed it was **connected again**, targeting the same 6061 destination, with zero UDP errors.

## Evidence boundary

This verifies recorded-event conversion, explicit output, scoped cleanup and receipt/routing by the running bridge. A post-test socket check found **no listener on UDP 6069**; the forwarded count therefore does not establish downstream plugin receipt or sound. No DAW channel, instrument, port or installed configuration was changed to make that test pass. The 90 participants describe the whole saved take; only the eight observed source voices above participated in this bounded window. This test does not establish physical-phone multitouch or audible acceptance.

Wire encoding, original X/Y values, timestamp ordering, pause/seek/resume, speed, cancellation and error cleanup are covered separately in [the UDP tests](../test/udp-replay.test.js) and [protocol guide](UDP-REPLAY.md). Runtime counters are a dated observation; PIDs and current live/paused state can change after this report.
