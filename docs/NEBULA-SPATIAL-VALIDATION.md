# Spatial Nebula and camera validation

Historical baseline. The current curved-ray core, motion-driven clouds and
updated camera endpoint are documented in
[Nebula motion validation](NEBULA-MOTION-VALIDATION.md).

Validated locally on 2026-09-05 against the saved three-minute pack
`kayit-2026-09-05T14-01-15-589Z` (90 participants / 123,254 events).

## Camera and artwork

The viewer uses a fixed-45-degree perspective camera. Wheel and pinch move the
camera in world space; normal drag orbits and Shift-drag pans. Four deterministic
decorative star strata provide spatial context independently of recorded events.
They are explicitly marked as decorative and never enter counts or selection.

The central occluder is an actual radius-0.205 sphere. Thin emitting torus
surfaces and the photon shell use the same world transform as the recorded data.
Both live capture and archive playback use the same camera and core geometry.
The Eseri oku panel offers an interruptible 12-second camera approach to distance
0.65. User navigation immediately cancels it; F restores the fitted view.

The lens pass samples actual rendered galaxy and star light. Its center and
angular extent derive from the current camera, and sparse source depth protects
foreground stars from background deflection. Picking uses the same inverse lens
mapping and preserves the original participant/event/X/Y identity. The core is
composited with its own geometry depth before bloom and display conversion.

This is an artistic finite thin-lens approximation, not relativistic geodesic
integration. It uses a circular angular lens off axis and nearest bright-source
depth for translucent data. The physical accretion geometry retains its direct
projection; the surrounding galaxy and background stars receive the lens warp.

## Observed checks

- Browser: fitted, oblique and close approaches rendered; the near disk crosses
  the sphere coherently and source structures move through the foreground.
- Explicit journey, fit, archive final-state and ordinary playback controls work.
- No application/GPU errors were reported in the inspected Chrome console.
- 4K export completed: **4096 × 4096 PNG, 25.4 MB**, visually inspected in the
  export preview. Interactive GPU state is restored after offscreen rendering.
- UDP prepare displayed READY without emitting. Play while the existing Engine
  was running was refused with the readable Hold instruction. Output was then
  explicitly closed and the viewer returned to silent playback.
- Camera tests cover parallax, fixed FOV, framing, time-independent damping,
  core clearance, screen-plane pan, journey cancellation and reduced motion.
- Lens/picker tests cover aspect ratios, panned cameras, foreground exclusion,
  finite coordinates and source identity on a bent background arc.
- Pipeline tests inject failures into every render phase and verify restoration
  of shared uniforms, material flags, camera layers and render targets, including
  export-to-viewport resizing.

Actual UDP receipt and routing are documented separately in
[UDP-REPLAY-VALIDATION.md](UDP-REPLAY-VALIDATION.md). These checks do not establish
downstream audible playback.
