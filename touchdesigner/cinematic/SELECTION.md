# Recorded seat inspection

`selection.py` reads the **original** `raw/events.bin` and optional Float64
`raw/gestures.bin` of an exported recording folder. It never changes transport,
source geometry, X/Y, camera parameters or UDP. Embed it as a Text DAT such as
`seat_replay`; create one object for each active assets folder:

```python
inspector = op('seat_replay').module.SelectionReplay(assets_folder)
choices = inspector.seats()
state = inspector.sample_lane(lane, playback_seconds * 1000)
point = state['selected']
```

Close the previous inspector before replacing it when the assets folder changes.
Retain it between frames: raw binaries are read-only memory maps; a bounded LRU
holds at most eight participant indices. Building an index sorts that seat's
events by exact recorded time, then original event index for ties. Subsequent
queries binary-search each recorded finger. Backward seeks and loops return the
same data without sequential simulation or interpolation.

| Value | Use |
| --- | --- |
| `seats()` | Menu dictionaries with real `lane`, recorded `label`, `zone`, `seatNumber`, `participantId`, count and source offset. Do not treat the displayed ordinal as the source lane. |
| `state['selected']` | Selected finger observation, or `None` before any valid X/Y for that finger. |
| `state['fingers']` | All observed finger states for the selected seat; each has its own independent trail and active flag. |
| `state['observedEventCount']` | Count of valid-time events from this seat at or before the playhead, including releases/control events. |
| `point['x'], ['y'], ['t']` | Recorded normalized axes and original milliseconds, preserving Float64. |
| `point['index']` | Original source event index, never an instance index. |
| `point['active'], ['stale']` | Contact status and gap status. Coordinates can be held while inactive; the panel should label that state. |
| `point['trail']` | At most 64 recorded points during the latest segment in the past 2.5 seconds. No estimated points or interpolation. |
| `point['motion']` | `valid`, normalized-screen units/second `speed`, radians/second `turn`, `turnDegrees`, measured direction. These are the selected observation's measurements, not current fabricated movement. |

The default `finger='auto'` follows the web inspector: first active finger in
recorded identity order, else last observed finger. Pass `finger=hit['finger']`
after click-picking to keep following that exact finger even while other fingers
move. Explicit `finger=None` refers to unknown historical identity. Unknown
identity has no trail or inferred motion; legacy uint16 axes remain labeled
`source='legacy'` and `coordinatePresenceKnown=False`.

A `noteOn`, `noteOff`, disconnect, invalid/missing coordinate, or gap longer than
1200 ms breaks a path. Release and disconnect take effect at their exact source
time. Equal timestamps preserve binary ordering but cannot imply velocity.
Future events, non-finite times and events outside the session are excluded.
Set `loop=True` only when a transport explicitly wants wraparound; normal output
clamps to the recording endpoints.

## Picking

`pick_ndc()` lazily loads the exported **dust** source positions and its uint32
source-index sidecar using NumPy, which is included with TouchDesigner. It uses
the same orbit/tilt/roll and camera basis as the native shaders. Example after
receiving a panel click `(u,v)` in 0–1 with Y up:

```python
hit = inspector.pick_ndc(
    u * 2 - 1, v * 2 - 1, playback_ms,
    camera_position=values['uCameraPos'],
    camera_right=values['uCameraRight'], camera_up=values['uCameraUp'],
    camera_forward=values['uCameraForward'],
    tan_half_fov=values['uCameraInfo'][0], aspect=values['uCameraInfo'][1],
    viewport_height=values['uViewport'][1],
    orbit=values['uOrbit'], tilt=values['uTilt'],
)
```

Picking projects **source geometry before the lens pass**. It excludes events
after the exact playhead, points outside the frame/clips, and background points
hidden by the spherical horizon. Projection differs from the warped background
near the lens rim; the menu remains a precise alternative for selecting a seat.
No hit should select or seek a future event. Supply `lane=selected_lane` only
when strict solo rendering hides other seats. A hit includes all recorded event
fields, `worldPosition`, and distance in output pixels. Test clicking on pointer
release after distinguishing click from orbit/pan; do not perform a 230k-point
pick every frame or during a drag.

Solo rendering belongs to shader visibility. Feed the selected source lane to
that control; keep the backdrop, stars and core independent. Showing this
inspector alone does not hide any geometry.

Run data tests with `python3 -m unittest discover -s test -p test_td_selection.py`.
Picker checks additionally require NumPy; use TouchDesigner's Python or the
bundled workspace Python to run all tests.
