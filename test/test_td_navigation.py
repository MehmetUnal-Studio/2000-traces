"""Interactive camera geometry and gesture tests, without TouchDesigner."""
import importlib.util
import math
import pathlib
import random
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1] / 'touchdesigner' / 'cinematic'


def load(name):
    spec = importlib.util.spec_from_file_location('td_' + name, ROOT / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


NAV = load('navigation')
CAMERA = load('camera')


def norm(vector):
    return math.sqrt(sum(v * v for v in vector))


def delta(first, second):
    return tuple(a - b for a, b in zip(first, second))


class NavigationTests(unittest.TestCase):
    def assertVectorClose(self, first, second, places=11):
        for a, b in zip(first, second):
            self.assertAlmostEqual(a, b, places=places)

    def test_every_director_pose_hands_off_without_position_target_or_fov_cut(self):
        for index in range(1081):
            original = CAMERA.sample(index / 1080)
            state = NAV.NavigationState(original)
            for pose in [state.pose(), state.step(0), state.step(1 / 30), state.controls()]:
                self.assertVectorClose(pose['position'], original['position'])
                self.assertVectorClose(pose['target'], original['target'])
                self.assertEqual(pose['fov'], original['fov'])
                self.assertAlmostEqual(pose['focus'], original['focus'], places=11)
            # No director target decay on manual handoff or paused playback.
            self.assertVectorClose(state.step(120)['target'], original['target'])
        near = NAV.NavigationState(CAMERA.sample(.54)).controls()
        self.assertLess(near['distance'], .96)
        self.assertAlmostEqual(near['eyeRadius'], .96)

    def test_orbit_rotates_about_panned_target_with_fixed_focus(self):
        state = NAV.NavigationState()
        state.pan(.05, -.02)
        before = state.step(10)
        state.orbit(.2, -.1)
        self.assertVectorClose(state.pose()['position'], before['position'])
        after = state.step(10)
        self.assertVectorClose(after['target'], before['target'])
        self.assertAlmostEqual(after['focus'], before['focus'])
        self.assertGreater(norm(delta(after['position'], before['position'])), 1)
        self.assertEqual(after['fov'], before['fov'])

    def test_pan_translates_eye_and_target_in_visible_screen_plane(self):
        state = NAV.NavigationState(CAMERA.sample(.36))
        before = state.pose()
        basis = NAV.screen_basis(before)
        du, dv, aspect = .015, -.008, 1.5
        height = 2 * before['focus'] * math.tan(math.radians(before['fov']) / 2)
        expected = tuple(-height * (du * aspect * right + dv * up)
                         for right, up in zip(basis['right'], basis['up']))
        state.pan(du, dv, aspect)
        after = state.step(10)
        self.assertVectorClose(delta(after['position'], before['position']), expected)
        self.assertVectorClose(delta(after['target'], before['target']), expected)
        self.assertAlmostEqual(sum(a * b for a, b in zip(expected, basis['forward'])), 0)
        self.assertAlmostEqual(after['focus'], before['focus'])

    def test_wheel_dolly_changes_perspective_position_with_fixed_fov(self):
        state = NAV.NavigationState()
        before = state.pose()
        state.dolly(2)
        after = state.step(10)
        self.assertEqual(after['fov'], before['fov'])
        self.assertVectorClose(after['target'], before['target'])
        self.assertAlmostEqual(after['focus'], before['focus'] * math.exp(-.24))
        self.assertGreater(norm(delta(after['position'], before['position'])), .6)
        state.dolly(-2)
        self.assertVectorClose(state.step(10)['position'], before['position'])

    def test_same_goal_converges_identically_at_different_frame_cadences(self):
        results = []
        for fps in (15, 24, 30, 60, 144):
            state = NAV.NavigationState(CAMERA.sample(.36))
            state.pan(.025, .01)
            state.orbit(.1, -.05)
            state.dolly(.3)
            state.set_controls(fov=52)
            for _ in range(fps):
                state.step(1 / fps)
            results.append(state.pose())
        for pose in results[1:]:
            self.assertVectorClose(pose['position'], results[0]['position'])
            self.assertVectorClose(pose['target'], results[0]['target'])
            self.assertAlmostEqual(pose['fov'], results[0]['fov'], places=11)
        # A single long frame reaches the same time, without the old dt=.25 cap.
        once = NAV.NavigationState(CAMERA.sample(.36))
        once.pan(.025, .01); once.orbit(.1, -.05); once.dolly(.3); once.set_controls(fov=52)
        self.assertVectorClose(once.step(1)['position'], results[0]['position'])

    def test_safety_radius_holds_during_pan_near_core_and_full_orbits(self):
        randomizer = random.Random(1715)
        state = NAV.NavigationState(CAMERA.sample(.54))
        for index in range(3000):
            if index % 3 == 0:
                state.pan(randomizer.uniform(-.3, .3), randomizer.uniform(-.3, .3))
            if index % 5 == 0:
                state.dolly(randomizer.uniform(-3, 5))
            state.orbit(randomizer.uniform(-.3, .3), randomizer.uniform(-.1, .1))
            pose = state.step(1 / 60)
            self.assertGreaterEqual(norm(pose['position']), NAV.MIN_EYE_RADIUS - 1e-12)
            self.assertLessEqual(norm(pose['target']), NAV.MAX_TARGET_RADIUS + 1e-12)
            self.assertLessEqual(abs(pose['elevation']), NAV.MAX_ELEVATION)
            self.assertGreater(pose['focus'], .15)
            self.assertTrue(all(math.isfinite(v) for v in (*pose['position'], *pose['target'])))
            basis = NAV.screen_basis(pose)
            self.assertAlmostEqual(norm(basis['right']), 1)
            self.assertAlmostEqual(norm(basis['up']), 1)
            self.assertAlmostEqual(norm(basis['forward']), 1)

    def test_clamped_wheel_can_immediately_reverse_without_windup(self):
        state = NAV.NavigationState()
        for _ in range(100):
            state.dolly(100000)
        closest = state.step(10)
        self.assertAlmostEqual(closest['eyeRadius'], .96)
        state.dolly(-1)
        self.assertGreater(state.step(.1)['eyeRadius'], closest['eyeRadius'])
        state.dolly(-100000)
        self.assertAlmostEqual(state.step(10)['focus'], NAV.MAX_FOCUS)
        state.dolly(1)
        self.assertLess(state.step(.1)['focus'], NAV.MAX_FOCUS)

    def test_external_angle_edits_take_short_path_across_seam(self):
        state = NAV.NavigationState()
        state.set_controls(azimuth=179)
        state.step(10)
        before = state.controls()['azimuth']
        state.set_controls(azimuth=-179)
        self.assertAlmostEqual(state.controls()['azimuth'] - before, 2)
        before = state.controls()['azimuth']
        state.orbit(2.1, 0)
        self.assertAlmostEqual(state.controls()['azimuth'] - before, -378)

    def test_reset_is_smooth_clears_pan_and_recovers_full_composition(self):
        state = NAV.NavigationState(CAMERA.sample(.54))
        state.pan(.1, .1)
        state.step(10)
        before = state.pose()
        state.reset()
        self.assertVectorClose(state.step(0)['position'], before['position'])
        after = state.step(10)
        self.assertVectorClose(after['target'], (0, 0, 0))
        self.assertAlmostEqual(after['distance'], 3.35)
        self.assertAlmostEqual(after['azimuth'], -18)
        self.assertAlmostEqual(after['elevation'], 12)
        self.assertAlmostEqual(after['fov'], 45)

    def test_bad_inputs_are_rejected_without_poisoning_camera_state(self):
        state = NAV.NavigationState()
        before = state.controls()
        for bad in [math.nan, math.inf, -math.inf, '1', None, True]:
            for operation in [lambda: state.orbit(0, bad),
                              lambda: state.pan(0, 0, bad),
                              lambda: state.dolly(bad), lambda: state.step(bad)]:
                with self.assertRaises((ValueError, TypeError)):
                    operation()
                self.assertEqual(state.controls(), before)
        with self.assertRaises(ValueError):
            state.step(-1)
        with self.assertRaises(ValueError):
            state.pan(0, 0, 0)
        with self.assertRaises(ValueError):
            state.adopt(dict(position=(0, 0, .5), target=(0, 0, 0), fov=45))
        with self.assertRaises(ValueError):
            state.set_controls(distance=3, target=(0, 0, math.inf))
        self.assertEqual(state.controls(), before)


if __name__ == '__main__':
    unittest.main()
