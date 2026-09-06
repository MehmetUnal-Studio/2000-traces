"""Deterministic, data-independent camera choreography in artwork world units.

No TouchDesigner operators, clocks, I/O or NumPy are used. Call sample(seconds /
DURATION_SECONDS), then apply position, target and fov to the native camera.
Distance is measured from the artwork origin; focus is measured to the target.
"""
import bisect
import math
from numbers import Real


DURATION_SECONDS = 180.0
VERTICAL_FOV_DEGREES = 45.0
CORE_HORIZON_RADIUS = 0.205
CORE_DISK_RADIUS = 0.645
CORE_BOUND_RADIUS = 0.92
MIN_CAMERA_RADIUS = 0.95

# phase, origin distance, azimuth degrees, elevation degrees, target XYZ.
# The final pose matches the initial pose; no modulo-angle wrap or cut is
# needed when a three-minute journey loops. Pullback gently reverses the orbit.
KEYFRAMES = (
    (0.00, 3.35, -18.0, 6.0, (0.000, 0.000, 0.000)),
    (0.16, 2.95, -2.0, 24.0, (0.025, -0.010, 0.000)),
    (0.36, 1.80, 22.0, 30.0, (-0.045, 0.025, 0.015)),
    (0.54, 0.96, 56.0, 16.0, (0.065, 0.005, 0.020)),
    (0.72, 1.08, 94.0, 8.0, (0.045, -0.015, 0.005)),
    (0.88, 2.40, 30.0, 18.0, (0.010, 0.015, 0.000)),
    (1.00, 3.35, -18.0, 6.0, (0.000, 0.000, 0.000)),
)
_PHASES = tuple(row[0] for row in KEYFRAMES)


def _curve(values):
    """Shape-preserving cubic Hermite slopes with a stationary loop seam."""
    values = tuple(values)
    widths = tuple(b - a for a, b in zip(_PHASES, _PHASES[1:]))
    secants = tuple((b - a) / h for a, b, h in zip(values, values[1:], widths))
    slopes = [0.0] * len(values)
    for index in range(1, len(values) - 1):
        before, after = secants[index - 1], secants[index]
        if before * after <= 0.0:
            continue
        previous_width, next_width = widths[index - 1], widths[index]
        first = 2.0 * next_width + previous_width
        second = next_width + 2.0 * previous_width
        slopes[index] = (first + second) / (first / before + second / after)
    return values, tuple(slopes)


_DISTANCE = _curve(math.log(row[1]) for row in KEYFRAMES)
_AZIMUTH = _curve(row[2] for row in KEYFRAMES)
_ELEVATION = _curve(row[3] for row in KEYFRAMES)
_TARGET = tuple(_curve(row[4][axis] for row in KEYFRAMES) for axis in range(3))


def _evaluate(curve, phase, index):
    values, slopes = curve
    if phase <= 0.0:
        return values[0]
    if phase >= 1.0:
        return values[-1]
    width = _PHASES[index + 1] - _PHASES[index]
    t = (phase - _PHASES[index]) / width
    t2, t3 = t * t, t * t * t
    return ((2.0 * t3 - 3.0 * t2 + 1.0) * values[index]
            + (t3 - 2.0 * t2 + t) * width * slopes[index]
            + (-2.0 * t3 + 3.0 * t2) * values[index + 1]
            + (t3 - t2) * width * slopes[index + 1])


def sample(phase):
    """Return the reproducible camera pose at a normalized journey phase.

    Finite real values are clamped to [0, 1]; bool, strings, NaN and infinity
    are rejected. Returned dictionaries are fresh and have no shared state.

    position uses the existing Camera COMP convention: +Y up, azimuth zero
    along +Z, positive azimuth toward +X. target is an absolute world-space
    look-at position, not an offset added to the camera origin. Angles and the
    fixed vertical fov are degrees. focus is the true eye-to-target distance.
    """
    if isinstance(phase, bool) or not isinstance(phase, Real):
        raise TypeError('Camera phase must be a real number')
    phase = float(phase)
    if not math.isfinite(phase):
        raise ValueError('Camera phase must be finite')
    phase = min(1.0, max(0.0, phase))
    index = min(len(_PHASES) - 2, max(0, bisect.bisect_right(_PHASES, phase) - 1))
    distance = math.exp(_evaluate(_DISTANCE, phase, index))
    azimuth = _evaluate(_AZIMUTH, phase, index)
    elevation = _evaluate(_ELEVATION, phase, index)
    target = tuple(_evaluate(curve, phase, index) for curve in _TARGET)
    azimuth_rad, elevation_rad = math.radians(azimuth), math.radians(elevation)
    horizontal = distance * math.cos(elevation_rad)
    position = (horizontal * math.sin(azimuth_rad),
                distance * math.sin(elevation_rad),
                horizontal * math.cos(azimuth_rad))
    focus = math.sqrt(sum((eye - aim) ** 2 for eye, aim in zip(position, target)))
    return dict(phase=phase, distance=distance, azimuth=azimuth,
                elevation=elevation, fov=VERTICAL_FOV_DEGREES,
                focus=focus, target=target, position=position)
