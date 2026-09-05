# Three-minute Nebula live acceptance

**PASS — 2026-09-05.** This take used the synthetic load generator: **260 generated participants**, not physical phone hardware or real-human touch input.

- Source: `sessions/session-2026-09-05T12-53-00-434Z.jsonl`
- Automatically saved pack: `viz/public/packs/kayit-2026-09-05T12-53-00-434Z/`
- Browser QA, reported separately by the coordinating agent: Nebula was visible during live recording at **01:43** and the saved Nebula opened at **03:00**. Server state was **COMPLETE**.

## Capture and preservation

A read-only streaming audit matched every JSONL event to its manifest lane and original per-lane index. All **2,993,872 timestamp/X/Y/finger scalar comparisons** matched the Float64 sidecar exactly, including absent values. Raw `uu/vv/f/ts` also matched their normalized fields and the anchored relative clock; every mismatch counter was zero.

| Check | Result |
| --- | --- |
| Stored / received events | 748,468 / 748,468 |
| Participants / packed strokes | 260 / 15,430 |
| Configured window, header and manifest | 180,000 ms |
| Measured local start-to-end interval | 180,011 ms |
| Source-relative event time range | 0–179,904 ms |
| Malformed / duplicate / early / late / ignored | 0 / 0 / 0 / 0 / 0 |
| Moves retaining both axes | 708,245 / 708,245 |
| All events retaining both axes | 723,675 |
| X and Y diversity | 1,001 distinct values each; both range 0–1 |
| Missing X / Y / finger | 24,793 / 24,793 / 9,360, preserved as absent |
| Real zero X / Y | 17,968 / 16,660, preserved as zero |
| Finger identities / fractional timestamps | Finger 0 only / none in this take |
| `gestures.bin` | 23,950,976 bytes; 32 bytes per event |

The final source event precedes the window boundary by 96 ms; this take therefore does not itself exercise an event exactly at 180,000 ms. [Session](../test/session.test.js) and [recorder](../test/recorder.test.js) regressions separately verify the inclusive event-time boundary, rejection beyond it, wall-clock stop, source closure and one complete end record. Higher-precision coordinates, fractional timestamps and multiple fingers are covered by [packing](../test/viz-pack.test.js) and [replay](../test/gesture-replay.test.js) fixtures.

## Replay and activity

Lane **120** (3,276 source events) was checked at **0, 89,355, 143,266, 35,961 and 180,000 ms**. Independent source references matched all **4 populated finger snapshots**, their active/inactive state and **144 trail points**. Trails contain original coordinates in chronological order, with no future points or bridges across release/disconnect/missing-data/gap boundaries. A loop at 180,000 + 89,355 ms reproduced the 89,355 ms state; backward seeks were deterministic.

The source contained 10,794 global timestamp reversals across participants and **zero per-participant reversals**. Live-input and saved-pack flow envelopes were compared at 0, 1,000, 45,000, 90,000, 103,000, 135,000, 180,000 and 185,000 ms, using all qualifying source events. Counts matched exactly; maximum numerical differences were **2.60 × 10⁻¹¹ events/s** for rate and **6.67 × 10⁻¹⁶** for activity. An independent exponential sum agreed within **6.69 × 10⁻¹¹ events/s**. The post-take sample uses no new input: rate fell from 3,763.39 events/s at 180 s to 25.36 events/s at 185 s. Backward sampling reproduced the same envelope.

These checks establish this saved take's data preservation and deterministic visual replay. Browser observations establish visible live-to-saved Nebula continuity, not a measured GPU frame rate. Physical-phone multitouch, receiver-side musical acceptance and replay-to-UDP/OSC output were not tested. The audit changed no running process, source configuration or network route.

SHA-256:

- JSONL: `7be5f84a2884047e17045fec8c174e281d41c207faed4d27935b07bec4e40a8b`
- `gestures.bin`: `a021142272c5e0dcad91a4387324fcef38ebee8726ac2a5ed929b52e7ec515d9`

## Final viewer checks

- The new pack opens as Nebula at **03:00**, with 260 participants and 748,468 events.
- Browser selection A6 exposed original X 0.443 / Y 0.434 at 139.892 s; restarting updated the same participant to X 0.520 / Y 0.839 at 0.20 s.
- The PNG preview decoded at **4096 × 4096** (26.5 MB); export restored the interactive view.
- Stars of The Year cover and artwork were visually inspected at 390 × 844 and the normal desktop viewport. Refreshing the cover preserved the entrance URL and view.
- No shader or browser runtime warnings/errors were observed during these checks.
