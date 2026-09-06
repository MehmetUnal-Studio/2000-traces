"""Exercise embedded runtime behavior without TouchDesigner or a live transport.

The tiny array/search and parameter doubles replace host facilities only. Tests
execute the real runtime functions, with original binary source fixtures. Asset
texture construction is covered separately by td-export.test.js.
"""
import bisect
import importlib.util
import json
import math
from pathlib import Path
import struct
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[1] / 'touchdesigner'
RUNTIMES = ('runtime.py', 'cinematic/runtime.py')


def load_module(relative):
    spec = importlib.util.spec_from_file_location('td_test_' + relative.replace('/', '_'), ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    # NumPy is part of TD; CI does not require it. Only the real runtime's
    # envelope search is exercised here; no replacement asset loader is used.
    search = lambda values, value, side: (bisect.bisect_right if side == 'right' else bisect.bisect_left)(values, value)
    with mock.patch.dict(sys.modules, {'numpy': SimpleNamespace(searchsorted=search)}):
        spec.loader.exec_module(module)
    return module


class Rows(list):
    def __getitem__(self, key):
        if isinstance(key, tuple):
            return super().__getitem__(key[0])[key[1]]
        return super().__getitem__(key)


def timeline(duration=1001):
    times = [0.0, 1000 / 60, 1000 / 30, duration]
    # Preserve the same exact Float64 representation as the exported sidecar.
    times = struct.unpack('<4d', struct.pack('<4d', *times))
    return dict(layout={'durationMs': duration}, times=times,
                flow=Rows([[struct.unpack('<f', struct.pack('<f', t))[0], index / 4, 0, 0]
                           for index, t in enumerate(times)]),
                motion=Rows([[index / 4, index / 8, index / 16, index / 32] for index in range(4)]))


class Parameter:
    def __init__(self, value):
        self.val = value

    def eval(self):
        return self.val

    def __bool__(self):
        return bool(self.val)


class Parameters:
    def __init__(self, **values):
        for name, value in values.items():
            object.__setattr__(self, name, Parameter(value))

    def __setattr__(self, name, value):
        if name not in self.__dict__:
            raise AssertionError('Unexpected native parameter: ' + name)
        self.__dict__[name].val = value


class Matrix:
    def __init__(self, position):
        self.position = position

    def __getitem__(self, key):
        row, column = key
        return self.position[row] if column == 3 else float(row == column)


class Camera:
    def __init__(self, target):
        self.par = Parameters(tx=0, ty=0, tz=3.35, fov=45, near=.008, far=80)
        self.target = target
        self.matrix_reads = []

    @property
    def worldTransform(self):
        position = tuple(getattr(self.par, 't' + axis).eval() for axis in 'xyz')
        target = tuple(getattr(self.target.par, 't' + axis).eval() for axis in 'xyz')
        self.matrix_reads.append((position, target))
        return Matrix(position)


class Host:
    def __init__(self, module, duration=180000):
        self.module = module
        self.par = Parameters(Position=0, Play=False, Speed=1, Loop=False,
                              Director=True, Distance=3.35, Azimuth=-18, Elevation=6, Fov=45,
                              Width=1920, Height=1080, Orbit=0, Tilt=0, Animate=False, Lane=-1,
                              Plasma=1, Density=1, Detail=1, Thickness=1, Lensing=1, Beaming=1,
                              Temperature=1, Corona=1, Dust=1, Gas=1, Traces=1, Stars=1,
                              Aperture=.01, Exposure=1, Saturation=1, Bloom=1, Glare=1,
                              Skygas=1, Skystars=1, Grain=0, Vignette=0, Udpstatus='')
        self.clock = SimpleNamespace(seconds=0.0)
        self.transport = dict(locked=False, playing=False, positionMs=None)
        self.target = SimpleNamespace(par=Parameters(tx=0, ty=0, tz=0))
        self.camera = Camera(self.target)
        self.director = load_module('cinematic/camera.py')
        self.director_phases = []
        self.operators = dict(camera=self.camera, camera_target=self.target,
                              director_path=SimpleNamespace(module=SimpleNamespace(sample=self.sample)),
                              io_runtime=SimpleNamespace(module=SimpleNamespace(poll=lambda: dict(self.transport))))
        module.parent = lambda: self
        module.op = lambda name: self.operators[name]
        module.absTime = self.clock
        source = timeline(duration)
        module.data = lambda: source

    def sample(self, phase):
        self.director_phases.append(phase)
        return self.director.sample(phase)

    def update(self, now):
        self.clock.seconds = now
        self.module.update()
        return self.module.values


class NativeRuntimeDataTests(unittest.TestCase):
    def test_exact_boundary_does_not_round_a_future_envelope_into_the_present(self):
        for filename in RUNTIMES:
            with self.subTest(runtime=filename):
                module = load_module(filename)
                source = timeline()
                module.data = lambda: source
                exact = source['times'][1]
                rounded = source['flow'][1, 0]
                self.assertLess(rounded, exact, 'fixture must expose Float32 rounding down')
                for time_ms, index in ((-1, 0), (0, 0), (rounded, 0),
                                       ((rounded + exact) / 2, 0), (exact, 1),
                                       (source['times'][2], 2), (1001, 3), (9000, 3),
                                       (rounded, 0), (exact, 1)):
                    result = module.envelope(time_ms)
                    self.assertEqual(result['index'], index)
                    self.assertEqual(result['activity'], index / 4)
                    self.assertEqual(result['motion'], source['motion'][index])
                    self.assertLessEqual(result['timeMs'], max(0, time_ms))
                for invalid in (math.nan, math.inf, -math.inf):
                    with self.assertRaises(ValueError):
                        module.envelope(invalid)

    def fixture(self, folder, exact=True):
        manifest = dict(sessionId='synthetic-runtime-fixture', eventCount=4,
                        participants=[dict(l=0, p='A:1', z='A', s=1, o=0, n=3),
                                      dict(l=1, p='B:2', z='B', s=2, o=3, n=1)])
        if exact:
            manifest['gestures'] = {'file': 'gestures.bin', 'bytesPerRecord': 32}
        (folder / 'manifest.json').write_text(json.dumps(manifest))
        records = [(0, 123, 456, 100, 1, 9), (0, 60000, 40000, 16, 3, 7),
                   (0, 0, 0, 210, 2, 7), (1, 0, 65535, 1000, 3, 2)]
        gestures = [(100.1253, .123456789012345, .987654321098765, 7.0),
                    (1000 / 60, .6, .4, 7.0),
                    (210.25, math.nan, math.nan, 7.0), (1000.125, 0, 1, math.nan)]
        (folder / 'events.bin').write_bytes(b''.join(struct.pack('<HHHIBB', *row) for row in records))
        (folder / 'gestures.bin').write_bytes(b''.join(struct.pack('<dddd', *row) for row in gestures))
        source = timeline()
        source.update(folder=folder)
        source['layout'].update(eventCount=4, source={'files': {
            name: {'file': name} for name in ('manifest.json', 'events.bin', 'gestures.bin')}})
        return source, gestures

    def test_inspect_retains_original_source_order_fractional_time_axes_and_unknowns(self):
        for filename in RUNTIMES:
            with self.subTest(runtime=filename), tempfile.TemporaryDirectory() as temporary:
                module = load_module(filename)
                source, gestures = self.fixture(Path(temporary))
                module.data = lambda: source
                module.parent = mock.Mock(side_effect=AssertionError('Inspection must not alter the playhead'))
                module.op = mock.Mock(side_effect=AssertionError('Inspection must not access transport'))
                for index in (3, 0, 2, 1, 0):
                    result = module.inspect(index)
                    t, x, y, finger = gestures[index]
                    self.assertEqual(result['index'], index)
                    self.assertEqual(result['tMs'], t)
                    self.assertEqual(result['x'], x if math.isfinite(x) else None)
                    self.assertEqual(result['y'], y if math.isfinite(y) else None)
                    self.assertEqual(result['finger'], int(finger) if math.isfinite(finger) else None)
                    self.assertEqual(result['fingerKnown'], math.isfinite(finger))
                    self.assertEqual(result['hasXY'], index != 2)
                    self.assertTrue(result['exact'])
                self.assertEqual(module.inspect(3)['participantId'], 'B:2')
                for invalid in (True, 1.5, '1'):
                    with self.assertRaises(TypeError): module.inspect(invalid)
                for invalid in (-1, 4):
                    with self.assertRaises(IndexError): module.inspect(invalid)
                (Path(temporary) / 'gestures.bin').write_bytes(b'')
                with self.assertRaisesRegex(ValueError, 'Truncated source'):
                    module.inspect(0)

    def test_legacy_inspection_never_invents_finger_or_lifecycle_coordinates(self):
        for filename in RUNTIMES:
            with self.subTest(runtime=filename), tempfile.TemporaryDirectory() as temporary:
                module = load_module(filename)
                source, _ = self.fixture(Path(temporary), exact=False)
                module.data = lambda: source
                for index in range(4):
                    result = module.inspect(index)
                    self.assertFalse(result['exact'])
                    self.assertFalse(result['coordinatePresenceKnown'])
                    self.assertFalse(result['fingerKnown'])
                    self.assertIsNone(result['finger'])
                self.assertEqual(module.inspect(3)['x'], 0)
                self.assertEqual(module.inspect(3)['y'], 1)
                self.assertEqual(module.inspect(3)['tMs'], 1000)
                self.assertIsNone(module.inspect(2)['x'])
                self.assertIsNone(module.inspect(2)['y'])
                self.assertFalse(module.inspect(2)['hasXY'])


class NativeRuntimeTransportTests(unittest.TestCase):
    def test_native_io_adapter_holds_uncertain_output_and_confirmed_stop_does_not_resume_locally(self):
        host = Host(load_module('cinematic/runtime.py'))
        adapter = load_module('io_runtime.py')
        adapter.parent = lambda: host
        snapshot = dict(enabled=True, busy=False, potentialOutput=True, state='PLAYING',
                        playing=True, positionMs=375.125, error=None)
        adapter.client = SimpleNamespace(snapshot=lambda: dict(snapshot))
        host.operators['io_runtime'].module = adapter
        host.par.Play = True
        host.update(0)
        self.assertEqual(host.module.values['uTime'], 375.125)
        self.assertFalse(host.par.Play)
        # Loss of confirmation cannot release the local clock while the server
        # may still own notes. The previously confirmed source time stays put.
        snapshot.update(playing=False, error='synthetic lost confirmation')
        host.par.Play = True
        host.update(100)
        self.assertTrue(adapter.poll()['locked'])
        self.assertEqual(host.module.values['uTime'], 375.125)
        self.assertFalse(host.par.Play)
        # STOP is an explicit confirmed response, not an automatic local Play.
        snapshot.update(enabled=False, potentialOutput=False, state='READY', positionMs=0, error=None)
        host.update(200)
        self.assertEqual(host.module.values['uTime'], 0)
        self.assertFalse(host.par.Play)
        self.assertFalse(adapter.poll()['locked'])
        host.update(500)
        self.assertEqual(host.module.values['uTime'], 0)
        self.assertFalse(host.par.Play)

    def test_udp_clock_overrides_local_speed_loop_and_stays_frozen_when_stale(self):
        for filename in RUNTIMES:
            with self.subTest(runtime=filename):
                host = Host(load_module(filename))
                host.update(0)
                host.par.Play = True
                host.par.Speed = 4
                host.par.Loop = True
                host.transport.update(locked=True, playing=True, positionMs=97325.125)
                values = host.update(500)
                self.assertFalse(host.par.Play)
                self.assertEqual(values['uTime'], 97325.125)
                self.assertEqual(values['uReplaying'], 1)
                # A paused/stale authoritative transport holds its last exact
                # position even across a large wall-clock jump or local Play.
                host.transport['playing'] = False
                host.par.Play = True
                values = host.update(900)
                self.assertFalse(host.par.Play)
                self.assertEqual(values['uTime'], 97325.125)
                self.assertEqual(values['uReplaying'], 0)
                if filename.startswith('cinematic/'):
                    self.assertEqual(host.director_phases[-1], 97325.125 / 180000)
                    self.assertEqual(host.director_phases[-2:], [97325.125 / 180000] * 2)

    def test_cinematic_restart_cannot_override_locked_udp_and_seek_has_no_camera_history(self):
        host = Host(load_module('cinematic/runtime.py'))
        host.transport.update(locked=True, playing=False, positionMs=97325.125)
        host.par.Director = False
        host.update(0)
        for pulse in ('Restart', 'Startshow'):
            host.module.pulse(pulse)
            self.assertEqual(host.par.Position.eval(), 97.325125)
            self.assertFalse(host.par.Play)
            self.assertFalse(host.par.Director)
        host.par.Director = True
        original = None
        for frame, time_ms in enumerate((97325.125, 180000, 0, 40000.125, 97325.125)):
            host.transport['positionMs'] = time_ms
            values = host.update(frame + 1)
            pose = host.director.sample(time_ms / 180000)
            self.assertEqual(tuple(values['uCameraPos']), pose['position'])
            self.assertEqual(host.camera.matrix_reads[-1], (pose['position'], pose['target']))
            self.assertEqual(values['uLensOptics'][0], pose['focus'])
            if original is None: original = tuple(values['uCameraPos'])
        self.assertEqual(tuple(values['uCameraPos']), original)

    def test_manual_easing_is_frame_rate_independent_and_never_cuts_through_core(self):
        final = []
        for fps in (30, 60):
            host = Host(load_module('cinematic/runtime.py'))
            host.par.Director = False
            host.update(0)
            host.par.Distance = .95
            host.par.Azimuth = 160
            host.par.Elevation = 25
            for frame in range(1, fps + 1):
                values = host.update(frame / fps)
                radius = math.sqrt(sum(value * value for value in values['uCameraPos']))
                self.assertGreaterEqual(radius, .95)
                self.assertLessEqual(radius, 3.35)
                self.assertGreater(radius - host.director.CORE_BOUND_RADIUS, .008)
                self.assertTrue(all(math.isfinite(value) for value in values['uCameraPos']))
                self.assertEqual(values['uTime'], 0, 'manual camera movement must not advance source playback')
            final.append(values['uCameraPos'])
        for first, second in zip(*final):
            self.assertAlmostEqual(first, second, places=12)

    def test_director_to_manual_preserves_pose_then_eases_offset_target_without_advancing_time(self):
        endings = []
        for fps in (30, 60):
            host = Host(load_module('cinematic/runtime.py'))
            host.par.Position = 180 * .54
            before = dict(host.update(10))
            initial_target = host.camera.matrix_reads[-1][1]
            self.assertGreater(math.sqrt(sum(value * value for value in initial_target)), .05)
            host.par.Director = False
            after = host.update(10)
            for actual, expected in zip(after['uCameraPos'], before['uCameraPos']):
                self.assertAlmostEqual(actual, expected, places=12)
            self.assertEqual(host.camera.matrix_reads[-1][1], initial_target)
            self.assertEqual(after['uCameraInfo'][0], before['uCameraInfo'][0])
            self.assertAlmostEqual(after['uLensOptics'][0], before['uLensOptics'][0], places=12)
            previous_target_radius = math.sqrt(sum(value * value for value in initial_target))
            for frame in range(1, fps + 1):
                values = host.update(10 + frame / fps)
                eye, target = host.camera.matrix_reads[-1]
                target_radius = math.sqrt(sum(value * value for value in target))
                self.assertLessEqual(target_radius, previous_target_radius)
                previous_target_radius = target_radius
                self.assertGreaterEqual(math.sqrt(sum(value * value for value in eye)), .95)
                self.assertAlmostEqual(values['uLensOptics'][0], math.dist(eye, target), places=12)
                self.assertEqual(values['uTime'], before['uTime'])
            self.assertLess(previous_target_radius, .01, 'manual aim should settle toward the origin')
            endings.append((*eye, *target, values['uLensOptics'][0]))
        for first, second in zip(*endings):
            self.assertAlmostEqual(first, second, places=12)

    def test_fit_and_approach_keep_their_manual_goal_after_director_handoff(self):
        for pulse, phase, seconds, expected_distance in (('Fit', .54, 1, 3.35),
                                                         ('Approach', .36, 16, .98)):
            with self.subTest(pulse=pulse):
                host = Host(load_module('cinematic/runtime.py'))
                host.par.Position = 180 * phase
                before = dict(host.update(10))
                initial_target = host.camera.matrix_reads[-1][1]
                host.module.pulse(pulse)
                self.assertFalse(host.par.Director)
                after = host.update(10)
                for actual, expected in zip(after['uCameraPos'], before['uCameraPos']):
                    self.assertAlmostEqual(actual, expected, places=12)
                self.assertEqual(host.camera.matrix_reads[-1][1], initial_target)
                for frame in range(1, seconds * 30 + 1):
                    values = host.update(10 + frame / 30)
                    radius = math.sqrt(sum(value * value for value in values['uCameraPos']))
                    self.assertGreaterEqual(radius, .95)
                    self.assertEqual(values['uTime'], before['uTime'])
                self.assertAlmostEqual(host.par.Distance.eval(), expected_distance, places=12)
                self.assertLess(abs(radius - expected_distance), .02)


if __name__ == '__main__':
    unittest.main()
