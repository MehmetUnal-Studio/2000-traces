# Native TouchDesigner data validation

Date: 2026-09-06. Source pack: `kayit-2026-09-05T16-56-19-183Z`.

## Recorded source and geometry

The native exporter calls the existing `buildNebula()` and `createNebulaSpace()` functions. It writes their GPU attributes directly; it does not regenerate an approximate galaxy from event counts.

| Source or draw | Verified count | Data texture |
| --- | ---: | --- |
| Original events | 1,073,700 | Unmodified source pack |
| Participants | 578 | Original participant/lane table |
| Recorded dust | 230,000 | 512 × 450 |
| Recorded atmosphere | 6,970 | 512 × 14 |
| Recorded finger segments | 100,000 | 512 × 196 |
| Decorative stars | 2,400 | 512 × 5 |
| Decorative distant clouds | 18 | 512 × 1 |
| Control envelope samples | 10,801 | 512 × 22 |

The duration remains exactly 180,000 ms. Each attribute is row-major RGBA Float32 little-endian with zero padding and explicit count/dimensions. Source links use separate little-endian Uint32 arrays: one original event index per dust/atmosphere instance and two original event indices per filament. Decorative groups are explicitly marked `recordedData: false`.

All generated texture sizes and index sizes were checked. All four copied source files (`manifest.json`, `events.bin`, `strokes.bin`, `gestures.bin`) passed the exported SHA256 checks. Their total plus checked texture bytes is 69,773,236 bytes, excluding source-index arrays and exact timeline timestamps.

## Automated export checks

`node --test test/td-export.test.js`: **5 tests passed**.

Full project check at this integration point: `npm run check` passed **189 JavaScript tests** and the Vite production build. `npm run test:td` passed the five export tests, **22 injected-HTTP Python replay-client tests**, and verification of all **16 generated native shader/contract files** with no differences. Python client tests forbid real network access; these results do not assert production UDP delivery or audible output.

- Raw X/Y/finger/time bytes remain identical to the source pack. Native point coordinates and metadata match the canonical mapping at their original event indices.
- Filament pairs retain proven same-participant, same-finger links, including reordered arrival timestamps. Missing coordinates and contact boundaries are respected.
- Every exported motion/activity envelope equals the canonical causal sampler at its sample time. A non-frame-aligned duration is preserved exactly.
- Legacy packs do not acquire invented finger identities, connecting paths, or inferred motion.
- Truncated source files and attempts to export over/inside the original source pack are rejected.

## Native runtime precision and inspection

`runtime.data()` loads sample times from the Float64 `timeline/times.f64.bin` sidecar. It does not reconstruct time from the Float32 GPU texture. This distinction prevents a rounded-down frame boundary from selecting a future envelope. `envelope(time_ms)` selects the latest sample at or before the requested time, with a maximum envelope lag below one 60 Hz interval. It remains a sampled control envelope; the complete original gestures remain available separately.

`runtime.inspect(source_index)` reads the original 12-byte event and, when present, the 32-byte Float64 gesture record. It returns exact coordinates, recorded time, finger identity, participant/zone/seat, event type, and presence flags. The method has no playhead, selection, or UDP side effects. Its index is an **original event index**, not a rendered instance number.

The Python inspector was compared field-for-field against JavaScript `readGesture()` for 85 original events spanning the full dense recording. All compared fields matched; four invalid-index cases were rejected. This check used standard-library Python binary reads with the source descriptor supplied directly. It does not stand in for TouchDesigner's NumPy/runtime execution.

The exact causal-edge check **passed inside TouchDesigner** at timeline indices 1, 5401, and 10800. `envelope(nextafter(edge, -inf))` selected `k-1`; `envelope(edge)` selected `k`. This exercised the embedded runtime with TouchDesigner's actual NumPy execution, including the final 180,000 ms boundary.

## Camera and output acceptance boundary

The native shaders receive the exported local positions and retain the source Nebula orbit/inclination/roll transform. Their core and field share one camera position/basis/FOV/viewport contract. The exporter tests prove source-coordinate parity; they do not prove TouchDesigner's camera matrix conventions, rendering depth, or shader rasterization by themselves.

All native GLSL MAT/TOP operators compiled, with zero recursive operator errors. The fitted view and an oblique view at 35 degrees azimuth / 30 degrees elevation were visually inspected inside TouchDesigner. Native close-up at distance 1.15 / azimuth22 / elevation18 was inspected. The 12-second approach reached distance 0.95 / azimuth 12 / elevation 8. At 2× speed, 43.4 seconds of the native clock advanced the recording from 36 to 122.8 seconds exactly. Across separate native frames, seek 0/36/180 seconds produced field RGB means 0.000088988 / 0.00122849 / 0.02841739.

A nested `.tox` import under `/traces_portability_test/traces_native` resolved the relative recording directory, had no errors or warnings, and matched the source 1280×720 frozen output with maximum absolute channel difference 0. UDP remained uninstantiated/off on import. Native I/O controls were exercised with injected HTTP replies: Prepare ready, Play shader time 30000 ms, Pause replaying 0, seek/play 45000 ms, Stop confirmed off. No real production OSC was emitted. An unavailable local server also produced a clear failure without stopping the visual renderer.

Further native visual acceptance should include an edge-on view and production receiver verification. Recorded points must remain at the same world-space positions while the camera moves; the core, depth composite and lens must respond consistently.

The copied `raw/` directory is the visualization pack, not the original capture JSONL. UDP reconstruction remains owned by the existing recorder and its saved JSONL. This native data export does not transmit packets or alter any existing UDP route.

The port now samples both sparse depth textures with nearest/clamp texel reads, matching the browser depth-filter contract while retaining linear color sampling. All field/core/composite values were finite. Extreme close-up speckling remains from the canonical compositor’s binary warped/direct UV and foreground/core classification; this is an inherited approximation, not a verified physical lens simulation. Same-camera browser/native image parity has not been claimed.

## Delivered project reopen

The saved Desktop `2000 Traces Native.toe` was reloaded through TouchDesigner. The reloaded project contains 91 native operators with zero recursive errors and warnings; output is 1280×720. `Assets=recording` resolves inside the delivered folder. The temporary build helper is absent and UDP client is uninstantiated/off. Event 1073690 still reads I64, finger 0, X 0.478 / Y 0.652 at 176051 ms. The actual native output was inspected after reload. Machine-readable evidence is `Verification.json` in the delivery folder.
