# Three-minute camera path

`camera.py` is a pure Python module. It reads no files, makes no network calls,
uses no TouchDesigner or NumPy API and does not change playback, events or UDP.

```python
pose = camera.sample(recorded_seconds / camera.DURATION_SECONDS)
```

`DURATION_SECONDS` is `180.0`. Use `recorded_seconds / recording_duration` instead
when the same complete journey should fit a shorter historical recording.
The caller controls playback, manual camera overrides and transitions between
manual and choreographed views. Sampling does not use the wall clock or retain
the previous phase, so backward scrubbing returns exactly the same pose.

The returned dictionary contains:

| Field | Meaning |
| --- | --- |
| `phase` | Input clamped to 0–1. Non-finite values and non-numeric inputs are rejected. |
| `distance` | Camera radius about the artwork origin, in existing artwork world units. |
| `azimuth` | Degrees: zero faces the origin from +Z; positive values move the eye toward +X. |
| `elevation` | Degrees above the world XZ plane; +Y is up. |
| `position` | Absolute `(x, y, z)` eye position matching the current native camera expressions. |
| `target` | Absolute `(x, y, z)` look-at target, providing restrained framing offsets. |
| `fov` | Vertical field of view, fixed at 45°. The approach is a physical dolly. |
| `focus` | Euclidean eye-to-target distance in world units, suitable for a focus-distance control. |

Apply `position` to the Camera COMP, `target` to its look-at Geometry COMP and
`fov` to the camera's vertical-FOV parameter. Alternatively, retain the existing
`distance`/`azimuth`/`elevation` position expressions and update their parameters.
Do not add `target` to the camera position: distance is measured about the
artwork origin. Focus is returned as data; the module enables no depth of field.

| Time | Camera beat | Origin radius |
| --- | --- | --- |
| 0 s | Full overview | 3.35 |
| 28.8 s | Inclined view reveals depth | 2.95 |
| 64.8 s | Approach with a small off-center framing | 1.80 |
| 97.2 s | Nearest view of the core | 0.96 |
| 129.6 s | Near orbit continues around the core | 1.08 |
| 158.4 s | Pullback with a gentle reversal of the orbit | 2.40 |
| 180 s | Original overview pose | 3.35 |

Shape-preserving cubic Hermite interpolation gives continuous position and
velocity without overshooting the authored control values. Distance is
interpolated logarithmically; angles remain unwrapped within −18° to 94°.
The opening and ending poses match and their velocity is zero, so looping
requires no angular wrap or hard cut. The curves are C1; acceleration need not
be identical on both sides of an interior keyframe.

The path's minimum radius is 0.96. It remains outside the cinematic core's 0.92
ray-bound sphere, 0.645 emitting-disk radius and 0.205 horizon for every disk
orientation. `MIN_CAMERA_RADIUS = 0.95` is the tested lower guard. The target
offsets affect framing without moving the eye toward the disk. The eye has at
least 0.04 units of clearance from the ray-bound sphere; the current 0.008 near
clip is smaller than this clearance. Focus is an eye-to-target measurement, so
it can be below 0.92 while the eye remains outside the sphere. It stays above
the physical disk radius throughout the path. This bound uses
the current unscaled artwork coordinates; integrations that scale or relocate
the artwork must apply the same transform to the eye/target and safety bounds.
Interpolate manual transitions in the same polar coordinates, or apply the
integrator's collision guard; a straight chord between distant safe camera
positions is not itself guaranteed to remain outside the core.

Run the standalone tests with:

```sh
python3 -m unittest discover -s test -p 'test_td_camera.py'
```
