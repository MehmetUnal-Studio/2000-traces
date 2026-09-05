# X/Y capture and visual replay acceptance

**PASS — 2026-09-05.** Source: **synthetic load test**, labelled **Nebula XY - load test**. These 260 generated participants are not evidence of 260 real humans or physical phone touches.

Artifacts audited read-only:

- Raw session: `sessions/session-2026-09-05T09-30-48-981Z.jsonl`
- Repacked artwork: `viz/public/packs/kayit-2026-09-05T09-30-48-981Z/`
- Sidecar: `gestures.bin`, format 1, 32 bytes per event; 12,003,584 bytes.

## Exact data acceptance

A streaming audit mapped every source event to its manifest participant range and original per-lane arrival index. All **1,500,448 timestamp/X/Y/finger scalar comparisons** matched exactly, including NaN for absent values. Raw `uu/vv/f/ts` were independently checked against normalized `u/v/finger/tMs`; mismatch count was **0**. No values were reconstructed from artwork coordinates.

| Check | Observed result |
| --- | --- |
| Events / participants | 375,112 / 260 |
| Movement events containing both axes | 355,155 / 355,155 |
| All events containing both axes | 362,793 |
| X values | 1,001 distinct; range 0–1 |
| Y values | 1,001 distinct; range 0–1 |
| Missing X / Y | 12,319 / 12,319, retained as absent |
| Real zero X / Y | 9,127 / 8,372, retained as zero |
| Finger values / missing finger | Only finger 0; 4,680 absent |
| Source-relative time range | 0–89,921 ms in a 90,000 ms session |
| Fractional source-relative timestamps in this take | 0 |
| Session footer malformed / duplicate / early / late | 0 / 0 / 0 / 0 |
| Sidecar, normalized/raw coordinate, finger, time mismatches | 0 for each category |

The sidecar retains Float64 values. This take only contains integer timestamps and 1,001 distinct values on each axis; it cannot establish live sub-millisecond or finer-coordinate coverage. The separate regression in [test/viz-pack.test.js](../test/viz-pack.test.js) verifies capture → JSONL → sidecar using an exact **1.625 ms** relative timestamp, higher-precision X/Y values, multiple finger identities, and missing-coordinate versus true-zero values. The compatibility `events.bin` remains 12 bytes per event and quantized; the sidecar supplies the original precision.

## Source-based replay acceptance

Selected lane **254**, with **1,648 source events**, was checked at 0, 44,271, 71,759, 17,151, 90,000 ms, including forward and backward seeks. Independently sorted raw-source references matched all 4 populated finger-position snapshots and 139 retained trail points. Trail checks verified original coordinates, identity, ordering, absence of future points, and breaks at recorded release/disconnect/missing-coordinate boundaries and gaps. Looping at 90,000 + 44,271 ms reproduced the original 44,271 ms state. No interpolation was used.

Synthetic regression coverage in [test/gesture-replay.test.js](../test/gesture-replay.test.js) additionally exercises unsorted timestamps, separate fingers, releases, disconnects, missing coordinates, long gaps, bounded segments, backwards seeks and loops. Legacy packs disclose quantized X/Y and unknown finger identity; they do not fabricate connecting finger trails.

## Timeout and retry review

This part is a read-only source/test review, not a new upstream outage test.

| Behavior | Existing coverage |
| --- | --- |
| Reconnect after a dropped connection or a clean stream close | Both directly tested in [test/live-source.test.js](../test/live-source.test.js) |
| Abort while waiting in retry backoff | Directly tested; expected completion within 200 ms after abort |
| Persistent authentication rejection | HTTP 401 tested with exactly two requests; HTTP 403 uses the same source branch but has no dedicated test |
| Upstream closes and remains unavailable | [test/cli.test.js](../test/cli.test.js) verifies the 0.3-second take exits within its 5-second grace plus test allowance and writes a complete JSONL end record |
| Source throws during recording | [test/recorder.test.js](../test/recorder.test.js) checks the partial file is flushed and closed |

The recorder server and CLI have an outer `durationMs + 5000` abort deadline. The live source has no separate inactivity/read timeout: a connected but silent stream waits for that outer abort. A dedicated server test for an indefinitely open silent stream, exact exponential-backoff timings, and retry-counter reset after new data is not present. These gaps were documented without changing capture behavior.

## Evidence limits

This validates preservation and visual replay of the accepted synthetic session. It does not prove real-human multitouch, lossless delivery of every upstream packet, receiver-side musical acceptance, GPU frame rate, or replay-to-UDP/OSC output. **UDP output from replay is not implemented or validated here.** No browser, running process, source configuration, or network route was changed by this audit.

SHA-256 fingerprints:

`session.jsonl: 39910221601ab7c84ce066969186d4dffde07079b8357ce4a52a55ff3faee947`

`gestures.bin: d58345c6ed67b75264995d19acfc0b732059b45b53f00558dd81e583de046b2a`
