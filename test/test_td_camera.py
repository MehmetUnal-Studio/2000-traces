"""Pure camera-path tests; no TouchDesigner, NumPy, network or native process."""
import importlib.util
import math
import pathlib
import random
import unittest


PATH = pathlib.Path(__file__).resolve().parents[1] / 'touchdesigner' / 'cinematic' / 'camera.py'
SPEC = importlib.util.spec_from_file_location('td_cinematic_camera', PATH)
CAMERA = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CAMERA)


def norm(vector):
    return math.sqrt(sum(value * value for value in vector))


def flatten(pose):
    return (pose['distance'], pose['azimuth'], pose['elevation'], pose['fov'],
            pose['focus'], *pose['target'], *pose['position'])


class CameraPathTests(unittest.TestCase):
    def test_authored_beats_and_loop_endpoints_are_reproducible(self):
        self.assertEqual(CAMERA.DURATION_SECONDS, 180.0)
        for phase, distance, azimuth, elevation, target in CAMERA.KEYFRAMES:
            pose = CAMERA.sample(phase)
            self.assertAlmostEqual(pose['distance'], distance, places=12)
            self.assertAlmostEqual(pose['azimuth'], azimuth, places=12)
            self.assertAlmostEqual(pose['elevation'], elevation, places=12)
            for actual, expected in zip(pose['target'], target):
                self.assertAlmostEqual(actual, expected, places=12)
        self.assertEqual(flatten(CAMERA.sample(0)), flatten(CAMERA.sample(1)))
        self.assertEqual(CAMERA.sample(-10), CAMERA.sample(0))
        self.assertEqual(CAMERA.sample(10), CAMERA.sample(1))

    def test_dolly_changes_physical_distance_with_fixed_optics(self):
        overview = CAMERA.sample(0)
        near = CAMERA.sample(.54)
        self.assertGreater(overview['distance'] / near['distance'], 3)
        for i in range(1001):
            pose = CAMERA.sample(i / 1000)
            self.assertEqual(pose['fov'], 45)
            self.assertAlmostEqual(norm(pose['position']), pose['distance'], places=12)
            azimuth = math.radians(pose['azimuth'])
            elevation = math.radians(pose['elevation'])
            self.assertAlmostEqual(pose['position'][0], pose['distance'] * math.sin(azimuth) * math.cos(elevation), places=12)
            self.assertAlmostEqual(pose['position'][1], pose['distance'] * math.sin(elevation), places=12)
            self.assertAlmostEqual(pose['position'][2], pose['distance'] * math.cos(azimuth) * math.cos(elevation), places=12)
            self.assertAlmostEqual(pose['focus'], norm(tuple(a - b for a, b in zip(pose['position'], pose['target']))), places=12)
        # The opening 45-degree perspective contains a radius1.12 artwork.
        self.assertGreater(overview['distance'] * math.sin(math.radians(overview['fov'] / 2)), 1.12)

    def test_safe_continuous_path_stays_outside_core_and_disk_at_render_cadence(self):
        previous = None
        minimum_eye = math.inf
        minimum_focus = math.inf
        for frame in range(10801):
            pose = CAMERA.sample(frame / 10800)
            self.assertTrue(all(math.isfinite(value) for value in flatten(pose)))
            eye_radius = norm(pose['position'])
            minimum_eye = min(minimum_eye, eye_radius)
            minimum_focus = min(minimum_focus, pose['focus'])
            self.assertGreaterEqual(eye_radius, CAMERA.MIN_CAMERA_RADIUS)
            self.assertGreater(eye_radius - CAMERA.CORE_BOUND_RADIUS, .008, 'near plane cannot enter the ray-bound volume')
            # Focus measures the offset target, not the eye's origin radius.
            self.assertGreater(pose['focus'], CAMERA.CORE_DISK_RADIUS)
            self.assertGreater(CAMERA.MIN_CAMERA_RADIUS, CAMERA.CORE_BOUND_RADIUS)
            self.assertGreater(CAMERA.CORE_BOUND_RADIUS, CAMERA.CORE_DISK_RADIUS)
            self.assertGreater(CAMERA.CORE_DISK_RADIUS, CAMERA.CORE_HORIZON_RADIUS)
            self.assertLess(norm(pose['target']), .10)
            if previous:
                delta = tuple(b - a for a, b in zip(previous['position'], pose['position']))
                squared_length = sum(value * value for value in delta)
                projection = -sum(a * d for a, d in zip(previous['position'], delta)) / squared_length if squared_length else 0
                fraction = min(1, max(0, projection))
                nearest = tuple(a + fraction * d for a, d in zip(previous['position'], delta))
                self.assertGreaterEqual(norm(nearest), CAMERA.MIN_CAMERA_RADIUS)
                self.assertLess(abs(pose['azimuth'] - previous['azimuth']), .1, 'no angle wrap or 360-degree jump')
                self.assertLess(norm(delta) * 60, .3, 'no position cut between native60Hz frames')
            previous = pose
        self.assertAlmostEqual(minimum_eye, .96, places=12)
        self.assertGreaterEqual(minimum_eye - CAMERA.CORE_BOUND_RADIUS, .04 - 1e-12)
        self.assertGreater(minimum_focus, CAMERA.CORE_DISK_RADIUS)
        self.assertLess(minimum_focus, CAMERA.CORE_BOUND_RADIUS, 'focus inside the bound is valid with a safely external eye')

    def test_position_velocity_and_target_are_continuous_at_every_keyframe(self):
        epsilon = 1e-6
        for phase, *_ in CAMERA.KEYFRAMES[1:-1]:
            before, center, after = (flatten(CAMERA.sample(p)) for p in (phase - epsilon, phase, phase + epsilon))
            for a, b, c in zip(before, center, after):
                self.assertLess(abs(c - a), .003)
                left, right = (b - a) / epsilon, (c - b) / epsilon
                self.assertLess(abs(left - right), .03, 'velocity cannot jump at a camera beat')
        for phase, neighbor in [(0, epsilon), (1, 1 - epsilon)]:
            for a, b in zip(flatten(CAMERA.sample(phase)), flatten(CAMERA.sample(neighbor))):
                self.assertLess(abs(b - a) / epsilon, .03, 'the loop seam is stationary')

    def test_interpolation_does_not_overshoot_authored_distances_or_angles(self):
        for first, last in zip(CAMERA.KEYFRAMES, CAMERA.KEYFRAMES[1:]):
            for step in range(101):
                pose = CAMERA.sample(first[0] + (last[0] - first[0]) * step / 100)
                for key, column in [('distance', 1), ('azimuth', 2), ('elevation', 3)]:
                    self.assertGreaterEqual(pose[key] + 1e-12, min(first[column], last[column]))
                    self.assertLessEqual(pose[key] - 1e-12, max(first[column], last[column]))
                for axis in range(3):
                    self.assertGreaterEqual(pose['target'][axis] + 1e-12, min(first[4][axis], last[4][axis]))
                    self.assertLessEqual(pose['target'][axis] - 1e-12, max(first[4][axis], last[4][axis]))

    def test_forward_backward_random_scrubbing_has_no_history_or_shared_output(self):
        phases = [i / 600 for i in range(601)]
        baseline = {phase: CAMERA.sample(phase) for phase in phases}
        for phase in reversed(phases):
            self.assertEqual(CAMERA.sample(phase), baseline[phase])
        random.Random(2026).shuffle(phases)
        for phase in phases:
            self.assertEqual(CAMERA.sample(phase), baseline[phase])
        changed = CAMERA.sample(.54)
        changed['target'] = (99, 99, 99)
        changed['distance'] = -1
        self.assertNotEqual(CAMERA.sample(.54), changed)

    def test_invalid_phases_are_rejected_before_native_controls_receive_them(self):
        for value in [math.nan, math.inf, -math.inf]:
            with self.assertRaises(ValueError):
                CAMERA.sample(value)
        for value in [None, True, False, '0.5', [], {}]:
            with self.assertRaises(TypeError):
                CAMERA.sample(value)


if __name__ == '__main__':
    unittest.main()
