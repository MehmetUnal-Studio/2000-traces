# Interactive cinematic navigation

`navigation.py` supplies an operator-independent camera state. Embed the source
as a Text DAT and construct `NavigationState()` from its module. It reads no
recording and changes neither playback nor UDP output. The runtime adapter owns
the native camera, input events and Director enable state.

| Method | Adapter use |
| --- | --- |
| `adopt(pose)` | Seed both current and desired eye, look target and optics from the **last rendered** Director pose. Disable Director only after this succeeds. |
| `orbit(du, dv)` | Normalized UV drag difference from a left-button drag. |
| `pan(du, dv, aspect)` | Shift-drag or middle-button drag; aspect is the visible image width/height. |
| `dolly(steps)` | Signed mouse wheel pulse, consumed once, or vertical right-button drag. Positive means toward the pivot. |
| `step(dt)` | Elapsed wall seconds; call once per render update, including while recording playback is paused. |
| `pose()` | Current rendered state. |
| `controls()` | Desired state for custom-parameter synchronization. |
| `set_controls(...)` | Update selected goals from manual parameters. Accepts `distance`, `azimuth`, `elevation`, `fov`, `target`. |
| `reset()` | Smooth full-artwork view and clear panning. |

The returned fields are `position`, `target`, `fov`, `azimuth`, `elevation`,
`distance`, `focus`, `eyeRadius`. `distance` and `focus` both measure eye-to-pivot
distance, which differs from the authored path's origin-distance field. Use the
absolute eye and target returned here for Camera COMP transforms. Keep the UI
Distance parameter range at 0.15–12 so adopting an offset Director pose does not
clamp it or change composition. The exact same eye has `eyeRadius >= 0.96` even
when its focus is below 0.96. Angles are unwrapped internally; normalize only
when displaying them in a limited-range parameter.

```python
# Initialization from manual parameter values at an origin target:
navigation = op('navigation_model').module.NavigationState()
navigation.set_controls(distance=c.par.Distance.eval(),
                        azimuth=c.par.Azimuth.eval(),
                        elevation=c.par.Elevation.eval(), fov=c.par.Fov.eval())
navigation.adopt(navigation.controls())

# First manual input after a Director frame:
navigation.adopt(last_director_pose)
c.par.Director = False
navigation.orbit(delta_u, delta_v)

# Once per runtime frame:
pose = navigation.step(elapsed_seconds)
```

The state smooths log focus, both orbit angles, the pan pivot and FOV with one
exponential elapsed-time factor. With a fixed goal, 15 Hz, 30 Hz, 60 Hz and
144 Hz converge to the same pose after the same wall time. It does not cap
elapsed time or alter FOV when approaching. Panning retains the look direction
and moves eye and target together in the current screen plane. Its distance
conversion accounts for vertical FOV, focus distance and aspect ratio.

The pivot is constrained to a 0.72 world-unit sphere about the artwork so the
camera can orbit the panned composition without losing the subject. For every
rendered state, a ray/sphere exit calculation keeps the eye at least 0.96 units
from the origin. That leaves 0.04 clearance outside the cinematic core's 0.92
bound. Close-range collision correction moves the eye along its viewing ray;
it cannot shift individual XYZ axes or distort the look direction. Elevation
stops at ±85 degrees to preserve a stable +Y-up screen basis. A blocked wheel
movement does not accumulate, so reversing the wheel immediately pulls away.

## TouchDesigner panel adapter

A raw TOP viewer is a texture viewer and does not expose Panel Values. Put
`OUT_CINEMATIC` in a Container COMP's background and open that Container in a
floating Window COMP for image navigation. Set `mousewheel=True` and enable
`uvbuttonsleft`, `uvbuttonsmiddle`, `uvbuttonsright`; keep panel dragging and
resizing disabled. [Container COMP](https://derivative.ca/UserGuide/Container_COMP)

Read `u`, `v` and button states `lselect`, `mselect`, `rselect`. Save initial UV on
button-down, calculate drag deltas while held, and clear drag state on release
or window close; do not apply an initial delta from a previous click. `shift`
reflects the modifier when the panel was clicked. `wheel` is a signed instant
pulse followed by zero, so polling once per frame can miss it. Use a Panel
Execute value-change callback and consume only its nonzero value, rather than
subtracting it from a previous wheel value. [Panel Value](https://derivative.ca/UserGuide/Panel_Value)

Configure the Panel Execute DAT's `panels` to the viewer Container, `panelvalue`
to the required input values, and `valuechange=True`. A callback receives
`panelValue`; its `name`, `val` and `owner` identify the changed panel input.
The implemented adapter samples both coordinates and button states together on
`u`, `v`, `lselect`, `mselect` and `rselect` changes, and also in the runtime frame
update. It stores the consumed UV position, so a second callback with the same
coordinates does not apply the movement again. Event sampling retains quick
drags between frames; frame sampling supports continued interaction while
replay is paused. Wheel pulses are consumed only by their value-change event.
Do not use `offtoon` to catch negative wheel values.
[Panel Execute DAT](https://docs.derivative.ca/Panel_Execute_DAT),
[PanelValue Class](https://docs.derivative.ca/PanelValue_Class)

The adapter should leave single clicks available for participant picking:
only classify an input as a drag once it exceeds a small pixel-distance
threshold. On reset, clear the pending gesture before calling `reset()`.
Changing navigation must not invoke playback restart or enable UDP.

The saved project opens the interactive `VIEWPORT` through `WINDOW_CINEMATIC`
when **Playback → Open cinema when project loads** is enabled. The
**Open interactive cinema** pulse reopens it. Its bar provides playback, camera,
seat-selection and solo controls. The raw `OUT_CINEMATIC` TOP remains a clean
image output without those controls. With the interactive scene focused,
**Space** toggles playback, **F** resets the framing, and **Esc** clears the
selection (the floating window may also close with Escape).

Run the geometry tests with:

```sh
python3 -m unittest discover -s test -p 'test_td_navigation.py'
```
