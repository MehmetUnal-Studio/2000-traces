"""Pure, smooth camera navigation for an interactive cinematic panel.

All distances use artwork world units. No TouchDesigner, NumPy, clock or I/O is
required. The adapter supplies pointer deltas, elapsed seconds and the current
Director pose. The target is a persistent orbit pivot; panning moves it together
with the eye. The camera always remains outside the core's 0.92 bound sphere.
"""
import math
from numbers import Real


MIN_EYE_RADIUS = 0.96
MIN_FOCUS = 0.15
MAX_FOCUS = 12.0
MAX_TARGET_RADIUS = 0.72
MAX_ELEVATION = 85.0
SMOOTHING_RATE = 10.0
ORBIT_YAW_DEGREES = 180.0
ORBIT_PITCH_DEGREES = 120.0
WHEEL_LOG_STEP = 0.12


def _number(value, name):
    if isinstance(value, bool) or not isinstance(value, Real):
        raise TypeError(name + ' must be a real number')
    value = float(value)
    if not math.isfinite(value):
        raise ValueError(name + ' must be finite')
    return value


def _vector(value, name):
    if isinstance(value, (str, bytes)):
        raise TypeError(name + ' must contain three numbers')
    try:
        result = tuple(_number(v, name) for v in value)
    except TypeError:
        raise TypeError(name + ' must contain three numbers') from None
    if len(result) != 3:
        raise ValueError(name + ' must contain three numbers')
    return result


def _clamp(value, low, high):
    return min(high, max(low, value))


def _norm(vector):
    return math.sqrt(sum(v * v for v in vector))


def _dot(first, second):
    return sum(a * b for a, b in zip(first, second))


def _cross(first, second):
    a, b, c = first
    x, y, z = second
    return (b * z - c * y, c * x - a * z, a * y - b * x)


def _direction(azimuth, elevation):
    azimuth, elevation = math.radians(azimuth), math.radians(elevation)
    horizontal = math.cos(elevation)
    return (math.sin(azimuth) * horizontal, math.sin(elevation),
            math.cos(azimuth) * horizontal)


def _bounded_target(target):
    length = _norm(target)
    if length > MAX_TARGET_RADIUS:
        return tuple(v * MAX_TARGET_RADIUS / length for v in target)
    return target


def _safe_focus(focus, target, direction):
    # target is inside the keep-out sphere. The positive ray exit is the first
    # admissible eye position, for any orbit angle and pan. This moves the eye
    # along its viewing ray instead of clipping its XYZ axes independently.
    projection = _dot(target, direction)
    exit_distance = -projection + math.sqrt(max(0.0, projection * projection
                                               + MIN_EYE_RADIUS ** 2
                                               - _dot(target, target)))
    return max(focus, exit_distance)


def _pose(state):
    log_focus, azimuth, elevation, fov, *target = state
    target = tuple(target)
    direction = _direction(azimuth, elevation)
    focus = _safe_focus(math.exp(log_focus), target, direction)
    position = tuple(aim + focus * axis for aim, axis in zip(target, direction))
    # Distance is eye-to-pivot, so a Director handoff can retain an offset look
    # target. The former origin-only camera distance is exposed as eyeRadius.
    return dict(position=position, target=target, distance=focus, focus=focus,
                eyeRadius=_norm(position), azimuth=azimuth,
                elevation=elevation, fov=fov)


def screen_basis(pose):
    """Return normalized right/up/forward vectors for a +Y-up camera pose."""
    position = _vector(pose['position'], 'position')
    target = _vector(pose['target'], 'target')
    forward = tuple(aim - eye for eye, aim in zip(position, target))
    focus = _norm(forward)
    if focus < 1e-12:
        raise ValueError('Camera eye and target must differ')
    forward = tuple(v / focus for v in forward)
    right = _cross(forward, (0.0, 1.0, 0.0))
    length = _norm(right)
    if length < 1e-12:
        raise ValueError('A vertical look direction has no stable horizontal basis')
    right = tuple(v / length for v in right)
    up = _cross(right, forward)
    return dict(right=right, up=up, forward=forward)


class NavigationState:
    """Orbit/pan/dolly goals with elapsed-time exponential smoothing.

    ``adopt(pose)`` is immediate and changes both current and goal states. Call
    it on the last rendered Director pose before disabling the Director. Mouse
    actions change only the goal; ``step(dt)`` produces the next rendered pose.
    Positive wheel steps approach the target; FOV does not change on dolly.
    """
    def __init__(self, pose=None):
        self._current = [math.log(3.35), -18.0, 12.0, 45.0, 0.0, 0.0, 0.0]
        self._goal = self._current[:]
        if pose is not None:
            self.adopt(pose)

    def adopt(self, pose):
        """Seed from an absolute eye/target pose without an orientation cut.

        Invalid or unsupported poses are rejected rather than silently moved.
        The authored Director path satisfies these bounds, including its 0.96
        eye radius and eye-to-target distances smaller than 0.96.
        """
        position = _vector(pose['position'], 'position')
        target = _vector(pose['target'], 'target')
        fov = _number(pose['fov'], 'fov')
        delta = tuple(eye - aim for eye, aim in zip(position, target))
        focus = _norm(delta)
        if not MIN_FOCUS <= focus <= MAX_FOCUS:
            raise ValueError('Camera focus is outside navigation bounds')
        if _norm(position) < MIN_EYE_RADIUS - 1e-10:
            raise ValueError('Camera eye is inside the core keep-out sphere')
        if _norm(target) > MAX_TARGET_RADIUS + 1e-10:
            raise ValueError('Camera target is outside the pan bounds')
        if not 20 <= fov <= 80:
            raise ValueError('Camera vertical FOV is outside 20 to 80 degrees')
        azimuth = math.degrees(math.atan2(delta[0], delta[2]))
        elevation = math.degrees(math.asin(_clamp(delta[1] / focus, -1.0, 1.0)))
        if abs(elevation) > MAX_ELEVATION + 1e-10:
            raise ValueError('Camera elevation is outside navigation bounds')
        self._current = [math.log(focus), azimuth, elevation, fov, *target]
        self._goal = self._current[:]
        return self.pose()

    def pose(self):
        """Current rendered pose as a fresh dictionary."""
        return _pose(self._current)

    def controls(self):
        """Goal pose for synchronizing custom camera parameters, not rendering."""
        return _pose(self._goal)

    def set_controls(self, distance=None, azimuth=None, elevation=None,
                     fov=None, target=None):
        """Update selected goals; external azimuth edits use the shortest turn.

        ``distance`` is the pivot-to-eye focus, not distance from world origin.
        Angles are degrees. Unspecified values are retained, including pan.
        Validation happens before mutation; camera controls may clamp at bounds.
        """
        goal = self._goal[:]
        if distance is not None:
            goal[0] = math.log(_clamp(_number(distance, 'distance'), MIN_FOCUS, MAX_FOCUS))
        if azimuth is not None:
            angle = _number(azimuth, 'azimuth')
            goal[1] += (angle - goal[1] + 180.0) % 360.0 - 180.0
        if elevation is not None:
            goal[2] = _clamp(_number(elevation, 'elevation'), -MAX_ELEVATION, MAX_ELEVATION)
        if fov is not None:
            goal[3] = _clamp(_number(fov, 'fov'), 20.0, 80.0)
        if target is not None:
            goal[4:] = _bounded_target(_vector(target, 'target'))
        goal[0] = math.log(_safe_focus(math.exp(goal[0]), tuple(goal[4:]),
                                       _direction(goal[1], goal[2])))
        self._goal = goal
        return self.controls()

    def orbit(self, delta_u, delta_v):
        """Drag deltas in panel UV; yaw is unlimited, pitch stops before poles."""
        du = _number(delta_u, 'delta_u')
        dv = _number(delta_v, 'delta_v')
        # Pointer drags retain their winding. Shortest-path wrapping is only
        # appropriate to absolute external controls, not relative gestures.
        self._goal[1] -= du * ORBIT_YAW_DEGREES
        self._goal[2] = _clamp(self._goal[2] - dv * ORBIT_PITCH_DEGREES,
                               -MAX_ELEVATION, MAX_ELEVATION)
        return self.set_controls()

    def pan(self, delta_u, delta_v, aspect=16.0 / 9.0):
        """Shift eye and pivot in the visible camera plane; scene follows drag.

        UV deltas are converted to world distance at the current focus plane,
        using vertical FOV and viewport aspect. Pan is bounded to a 0.72 world
        radius so the pivot remains within the keep-out sphere and Reset can
        always recover a nearby composition without crossing the core.
        """
        du = _number(delta_u, 'delta_u')
        dv = _number(delta_v, 'delta_v')
        aspect = _number(aspect, 'aspect')
        if aspect <= 0:
            raise ValueError('Viewport aspect must be positive')
        pose = self.pose()
        basis = screen_basis(pose)
        height = 2.0 * pose['focus'] * math.tan(math.radians(pose['fov']) / 2.0)
        movement = tuple(-height * (du * aspect * right + dv * up)
                         for right, up in zip(basis['right'], basis['up']))
        target = tuple(v + shift for v, shift in zip(self._goal[4:], movement))
        return self.set_controls(target=target)

    def dolly(self, wheel_steps):
        """Physical approach/pullback. Consume each nonzero wheel pulse once."""
        amount = _number(wheel_steps, 'wheel_steps')
        # Clamp the logarithm before exp, including extremely large trackpad
        # events. Starting from the collision-corrected goal avoids windup.
        focus = self.controls()['focus']
        wanted = _clamp(math.log(focus) - amount * WHEEL_LOG_STEP,
                          math.log(MIN_FOCUS), math.log(MAX_FOCUS))
        return self.set_controls(distance=math.exp(wanted))

    def reset(self):
        """Smoothly reframe the complete artwork and clear the pan target."""
        return self.set_controls(distance=3.35, azimuth=-18.0, elevation=12.0,
                                 fov=45.0, target=(0.0, 0.0, 0.0))

    def step(self, elapsed_seconds):
        """Advance the current pose by elapsed wall seconds, independent of FPS.

        No elapsed-time cap: an idle pause does not produce slow catch-up. With
        a fixed goal, dividing a time interval into different frame cadences
        yields the same state (up to float roundoff). Angles, log focus, pivot
        and FOV all use the same smoothing factor.
        """
        dt = _number(elapsed_seconds, 'elapsed_seconds')
        if dt < 0:
            raise ValueError('Elapsed seconds cannot be negative')
        blend = -math.expm1(-SMOOTHING_RATE * dt)
        self._current = [value + (goal - value) * blend
                         for value, goal in zip(self._current, self._goal)]
        return self.pose()
