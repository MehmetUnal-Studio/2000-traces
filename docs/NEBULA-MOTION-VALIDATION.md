# Nebula: curved core light, cloud structure and recorded motion

Validated locally on 2026-09-06 (Europe/Istanbul). This supersedes the core
geometry description in the earlier spatial validation report.

## What changed

- The accretion disk is sampled along bounded curved world rays. A 128-step
  integration accumulates emission through a finite disk slab before capture
  at the radius-0.205 horizon. Rear-disk light appears above/below the shadow
  as the camera approaches the disk plane. Camera projection, orbit, tilt and
  render-target resolution are shared with the actual view. The near-side
  depth used by selection includes slab emission, even at exactly edge-on views.
- A continuous local-space field shades the recorded event footprints into
  uneven cloud knots and dark dust channels. Three depth samples soften the
  gas; finer structure appears during approach. Event centers, source indices,
  participant counts and recorded coordinates are unchanged. The automatic
  approach now ends at distance 0.95 to frame the enlarged lensed shadow.
- Motion is measured per known participant/finger from exact X/Y and time.
  Speed controls luminous strength, footprint direction and trace width;
  direction-change rate increases fine cloud variation. Equally time-weighted
  directional coherence influences gas and core flow. The inspector reports
  the selected source event's speed in normalized-screen units/second and
  unsigned direction change in degrees/second.

## Data behavior

New note onsets, releases, disconnects, missing coordinates, equal/backward
timestamps and gaps over 1200 ms reset derivative continuity. Unknown fingers
never create inferred motion. Legacy records display “Mevcut değil”; measured
stillness remains a valid zero. No raw captures or UDP messages are modified.

Archive attributes retain original source indices, including events omitted
from the GPU sample. A sorted exact-time prefix supports causal random seeking
and loops. Feeding the same chronological sequence to the live engine gives the
same motion values. A late event for a finger in a live stream cannot revise a
velocity already emitted; an archive can sort that event chronologically.

## Evidence

- `npm run check`: **179 tests passed**, production build passed. The existing
  Vite large-chunk warning remains. Tests include 30/60 Hz resampling, opposed
  and aligned directions, tied timestamps, source-index alignment, live/archive
  equivalence, exact-finger selection, legacy handling and export restoration.
- Curved-ray tests prove rear-disk intersections that a straight ray misses,
  horizon capture, foreground emission, camera/viewport changes, and finite-slab
  selection at 720 px and 4096 px.
- Chrome rendered the saved 578-participant / **1,073,700-event** three-minute
  pack `kayit-2026-09-05T16-56-19-183Z` at fitted, oblique and near views. Rear
  arcs and foreground light were visually inspected. Zero-direction shader
  artifacts found during QA were fixed by guarding `atan(0,0)`.
- The same pack exported a **4096 × 4096 PNG, 27,543,119 bytes**. The preview was
  visually inspected and the downloaded PNG header checked. The viewport
  recovered after export and continued navigating normally.
- Small saved pack `kayit-2026-09-05T17-19-06-903Z`: playback, pause, selection,
  backward seek to zero and forward seek to 36 s were observed. At the selected
  C9/finger-0 source sample at 52.276 s, the HUD showed X=0.854, Y=0.422,
  speed=0.162 units/s and turn=762.8 degrees/s. Seeking to zero removed the
  future coordinate and motion readout.
- Legacy pack `kayit-2026-08-31T11-55-30-564Z` (**2,037,830 events**) rendered
  and selected correctly, with both motion measurements unavailable and the
  original 16-bit coordinate label preserved.
- No shader compilation or WebGL errors were observed in the inspected logs.
  Chrome extension messaging warnings and one asynchronous message-channel
  error were present; these are not evidence of a clean whole-browser console.
- Initial CI exposed a pre-existing 300 ms CLI test window that could expire
  during cold connection startup. The clean-close fixture now waits for its
  actual JSONL event before ending the response, allows 2 seconds for the take,
  and checks one stored event plus the final summary. Production capture timing
  is unchanged.

## Limits

This is a finite artistic ray-curvature model, not a general-relativistic
geodesic solver. The surrounding field still uses the existing thin-lens
postprocess with sparse nearest-bright-source depth. Translucent overlaps are
approximate. Cloud shading is procedural visual interpretation, not measured
gas or an added audience data source.

Per-event motion and its time prefixes are deterministic. Decorative animation
may continue while transport is paused, so wall-clock screenshots need not be
identical. Still export fixes decorative time and uses final-record motion,
then restores all interactive uniforms even on failure.

CPU construction observed for the 1,073,700-event pack was about 490 ms with
90 MiB of retained motion arrays; this is not a GPU frame-rate benchmark. Close
views and 4K gas shading have substantial fill cost. Sustained venue FPS and
fresh live capture remain separate on-site acceptance checks. No production
UDP output or downstream audio was exercised for this visual package.
