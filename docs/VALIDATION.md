# Data artwork validation

Local acceptance on 2026-09-05, Node 22.14.0 / macOS.

## Automated checks

`npm run check` passed all 108 local tests and the Vite production build. CI runs
this command on Node 22 and 24; the private local capture acceptance fixture is
skipped when absent in CI.

New atlas coverage checks exact event/note/movement conservation, note-only color
dominance, deterministic ties, bounded aggregation of two million unsorted onsets,
true same-participant transition endpoints, flat and tilted data inspection,
future-data exclusion, stable ink geometry, GPU disposal, and restoration of
interactive state when print readback fails. Triangle ribbons preserve filament
and engraving width across screen and print resolutions. Existing recorder, pack loading,
transport and operator regressions remain in the suite.

Read-only aggregation of existing local packs:

| Source | Cells | Sampled / actual note transitions | Aggregation wall time |
| --- | ---: | ---: | ---: |
| 1,300 participants / 2,037,830 events / 38,306 strokes | 34,560 | 5,000 / 37,130 | about 38–46 ms |
| 2,600 participants / 919,980 events / 23,411 strokes | 10,225 | 5,000 / 21,057 | about 34 ms |

Cell and participant totals independently matched source counts. These timings
measure CPU summary construction on this machine, not GPU frame rate or a venue
performance guarantee.

## Browser checks

The Codex in-app browser was used for:

- Explicit simulation labeling: 2,000 participants, 220,533 events, 22,056 held notes.
- Desktop 1440 × 900 and mobile 390 × 844 layouts, Atlas and Mürekkep.
- Zooming into the real 2,037,830-event pack and selecting a time cell: C204–C216,
  10.50–10.75 seconds, 60 movement events and no note onsets.
- Demo cell inspection: E181–E200, 0.25–0.50 seconds, 31 events, 20 note onsets.
- Tilt slider, fit/reset, scene mode and return, library search, pack loading,
  and preservation of the selected pack/style after reload.
- Playback at 8×, pause near 44 seconds, completed state, and clearing an inspected
  future cell when seeking backward.
- Real 4096 × 4096 PNG encoding and display for both Atlas and Mürekkep through
  the print preview dialog, also checked at 390 × 844.
  The preview exposes an explicit download link; a filesystem download location
  is controlled by the browser and is not assumed by this verification.
- Browser console checked for shader/WebGL errors; none observed in these checks.

No new live recording was started for this art revision. Raw sessions, local
packs, recorder state and musical routing were not modified. Live event delivery
and audible performance acceptance are separate from these viewer checks.

Production output excludes private local packs. Vite reports an approximately
800 kB uncompressed main chunk (about 213 kB gzip), largely including Three.js.

## Repeat

Run `npm run panel` and `npm run viz` in separate terminals, then open
`http://127.0.0.1:5174/?demo=1`. Open an existing pack for dense-data testing.
For print validation, inspect the generated preview before downloading.
Only test recording with the intended source or an isolated fixture.
