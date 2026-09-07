"""Original-binary causal seat replay without TD, network or NumPy."""
import importlib.util
import json
import math
from pathlib import Path
import struct
import tempfile
import unittest

try:
    import numpy
except ImportError:
    numpy = None


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('td_selection', ROOT / 'touchdesigner/cinematic/selection.py')
selection = importlib.util.module_from_spec(spec)
spec.loader.exec_module(selection)


def event(t, x=None, y=None, finger=0, kind=3):
    return dict(t=t, x=x, y=y, finger=finger, kind=kind)


class SelectionTest(unittest.TestCase):
    def recording(self, lanes, exact=True, duration=10000, cache_lanes=8):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        folder = Path(temporary.name)
        raw = folder / 'raw'
        raw.mkdir()
        participants = []
        events = bytearray()
        gestures = bytearray()
        offset = 0
        for lane, records in enumerate(lanes):
            participants.append(dict(p='A' + str(lane + 1), z='A', s=lane + 1, l=lane, o=offset, n=len(records)))
            for e in records:
                uq, vq = [int(round((e[key] or 0) * 65535)) if e[key] is None or math.isfinite(e[key]) and 0 <= e[key] <= 1 else 0 for key in ('x', 'y')]
                compat_t = max(0, round(e['t'])) if math.isfinite(e['t']) else 0
                events.extend(struct.pack('<HHHIBB', lane, uq, vq, compat_t, e['kind'], 0))
                gestures.extend(struct.pack('<dddd', *[math.nan if e[k] is None else e[k] for k in ('t', 'x', 'y', 'finger')]))
                offset += 1
        manifest = dict(formatVersion=1, sessionId='recording-test', participants=participants,
                        eventCount=offset, laneCount=len(lanes), durationMs=duration)
        files = {name: dict(file='raw/' + name) for name in ('manifest.json', 'events.bin', 'gestures.bin')}
        if exact:
            manifest['gestures'] = dict(formatVersion=1, recordBytes=32, count=offset, file='gestures.bin')
            (raw / 'gestures.bin').write_bytes(gestures)
        (raw / 'manifest.json').write_text(json.dumps(manifest))
        (raw / 'events.bin').write_bytes(events)
        (folder / 'layout.json').write_text(json.dumps(dict(source=dict(files=files), eventCount=offset,
                                    laneCount=len(lanes), durationMs=duration)))
        result = selection.SelectionReplay(folder, cache_lanes=cache_lanes)
        self.addCleanup(result.close)
        return result

    def test_fractional_time_and_coordinate_presence_are_exact(self):
        x, y, t = .12345678901234568, .9876543210987654, 100.125
        replay = self.recording([[event(t, x, y, 7), event(200, 0, 0, None), event(300, .6, None, 7)]])
        self.assertIsNone(replay.sample_lane(0, t - 1e-9)['selected'])
        point = replay.sample_lane(0, t)['selected']
        self.assertEqual((point['x'], point['y'], point['t'], point['finger']), (x, y, t, 7))
        missing = replay.read_event(2)
        self.assertEqual(missing['x'], .6)
        self.assertIsNone(missing['y'])
        self.assertFalse(missing['hasXY'])
        unknown = replay.sample_lane(0, 200, finger=None)['selected']
        self.assertEqual((unknown['x'], unknown['y']), (0, 0))
        self.assertIsNone(unknown['finger'])
        self.assertEqual(unknown['trail'], [])
        self.assertFalse(unknown['motion']['valid'])

    def test_multifinger_sort_seek_and_no_future_points(self):
        replay = self.recording([[
            event(250.5, .9, .2, 3), event(100, .1, .9, 0, 1),
            event(150.25, .3, .7, 3, 1), event(200, .2, .8, 0)]])
        first = replay.sample_lane(0, 225)
        self.assertEqual([(p['finger'], p['t']) for p in first['fingers']], [(0, 200), (3, 150.25)])
        self.assertEqual([p['t'] for p in first['selected']['trail']], [100, 200])
        self.assertEqual(replay.sample_lane(0, 300, finger=3)['selected']['t'], 250.5)
        self.assertEqual(replay.sample_lane(0, 225), first)
        self.assertEqual(replay.sample_lane(0, 50)['fingers'], [])
        self.assertEqual(first['observedEventCount'], 3)

    def test_release_disconnect_missing_axes_and_gaps_close_tracks(self):
        replay = self.recording([[event(100, .1, .2, 1, 1), event(200, .2, .3, 1),
            event(250, finger=1, kind=2), event(300, .3, .4, 1, 1),
            event(350, finger=None, kind=5), event(400, .4, .5, 1),
            event(450, .8, None, 1), event(500, .5, .6, 1), event(3000, .6, .7, 1)]])
        for boundary in (250, 350, 450):
            self.assertTrue(replay.sample_lane(0, boundary - .001)['selected']['active'])
            self.assertFalse(replay.sample_lane(0, boundary)['selected']['active'])
        self.assertEqual([p['t'] for p in replay.sample_lane(0, 320)['selected']['trail']], [300])
        self.assertFalse(replay.sample_lane(0, 2000)['selected']['active'])
        self.assertTrue(replay.sample_lane(0, 2000)['selected']['stale'])
        self.assertEqual([p['t'] for p in replay.sample_lane(0, 3100)['selected']['trail']], [3000])
        self.assertFalse(replay.sample_lane(0, 3100)['selected']['motion']['valid'])

    def test_noteon_and_equal_timestamp_preserve_order(self):
        replay = self.recording([[event(100, .1, .2, 2, 1), event(200, .2, .3, 2),
                                 event(200, .7, .8, 2, 1), event(300, .8, .9, 2)]])
        point = replay.sample_lane(0, 200)['selected']
        self.assertEqual(point['index'], 2)
        self.assertEqual([p['index'] for p in point['trail']], [2])
        self.assertFalse(point['motion']['valid'])
        self.assertFalse(replay.sample_lane(0, 300)['selected']['motion']['valid'])
        self.assertEqual(replay.sample_lane(0, 199)['selected']['index'], 0)

    def test_motion_uses_only_same_finger_segment_geometry(self):
        replay = self.recording([[event(0, 0, 0, 0, 1), event(50, .9, .9, 1, 1),
            event(100, .1, 0, 0), event(200, .1, .1, 0), event(300, .1, .1, 0),
            event(350, finger=0, kind=2), event(400, .4, .4, 0), event(500, .5, .4, 0)]])
        straight = replay.sample_lane(0, 100, finger=0)['selected']['motion']
        turn = replay.sample_lane(0, 200, finger=0)['selected']['motion']
        self.assertTrue(straight['valid'])
        self.assertAlmostEqual(straight['speed'], 1)
        self.assertEqual(straight['turn'], 0)
        self.assertAlmostEqual(turn['speed'], 1)
        self.assertAlmostEqual(turn['turnDegrees'], 900)
        self.assertEqual(replay.sample_lane(0, 300, finger=0)['selected']['motion']['speed'], 0)
        self.assertFalse(replay.sample_lane(0, 400, finger=0)['selected']['motion']['valid'])
        self.assertAlmostEqual(replay.sample_lane(0, 500, finger=0)['selected']['motion']['speed'], 1)

    def test_equal_time_motion_does_not_guess_velocity(self):
        replay = self.recording([[event(0, 0, 0), event(0, .1, .1), event(100, .2, .2), event(200, .3, .2)]])
        self.assertFalse(replay.sample_lane(0, 0)['selected']['motion']['valid'])
        self.assertFalse(replay.sample_lane(0, 100)['selected']['motion']['valid'])
        self.assertTrue(replay.sample_lane(0, 200)['selected']['motion']['valid'])

    def test_trail_is_bounded_and_loop_restarts_source(self):
        replay = self.recording([[event(i * 10, i / 500, .2, 4) for i in range(500)]], duration=5000)
        end = replay.sample_lane(0, 4990, trail_ms=5000)
        self.assertEqual(len(end['selected']['trail']), 64)
        self.assertEqual([end['selected']['trail'][i]['t'] for i in (0, -1)], [0, 4990])
        loop = replay.sample_lane(0, 5100, loop=True)
        self.assertEqual(loop['timeMs'], 100)
        self.assertTrue(loop['looped'])
        self.assertEqual(loop['fingers'], replay.sample_lane(0, 100)['fingers'])
        self.assertEqual(replay.sample_lane(0, -10, loop=True)['timeMs'], 4990)
        self.assertEqual(replay.sample_lane(0, 5000, loop=True)['selected']['t'], 0)

    def test_legacy_does_not_fabricate_finger_or_motion(self):
        replay = self.recording([[event(100, .2, .3), event(200, .4, .5)]], exact=False)
        result = replay.sample_lane(0, 200)
        self.assertEqual(result['source'], 'legacy')
        self.assertFalse(result['coordinatePresenceKnown'])
        self.assertIsNone(result['selected']['finger'])
        self.assertEqual(result['selected']['trail'], [])
        self.assertFalse(result['selected']['motion']['valid'])

    def test_invalid_times_are_not_positions_and_bounds_are_closed(self):
        replay = self.recording([[event(-1, .1, .2), event(math.nan, .1, .2),
            event(100, .3, .4), event(10000, .6, .7), event(10001, .8, .9)]])
        self.assertIsNone(replay.sample_lane(0, -100)['selected'])
        self.assertEqual(replay.sample_lane(0, 1e7)['selected']['t'], 10000)
        self.assertEqual(replay.sample_lane(0, 1e7)['observedEventCount'], 2)
        for value in (math.nan, math.inf, True, '100'):
            with self.assertRaises((TypeError, ValueError)):
                replay.sample_lane(0, value)
        with self.assertRaises(ValueError):
            replay.sample_lane(0, 100, max_trail_points=65)

    def test_seat_metadata_empty_lane_and_lru(self):
        replay = self.recording([[event(0, .2, .3)], [], [event(0, .4, .5)]], cache_lanes=1)
        self.assertEqual(replay.seats()[2], dict(lane=2, label='A3', participantId='A3', zone='A', seatNumber=3, eventCount=1, firstEventIndex=1))
        self.assertIsNone(replay.sample_lane(1, 100)['selected'])
        first = replay.sample_lane(0, 100)
        replay.sample_lane(2, 100)
        self.assertEqual(list(replay._cache), [2])
        self.assertEqual(replay.sample_lane(0, 100), first)
        with self.assertRaises(ValueError):
            replay.sample_lane(-1, 100)
        with self.assertRaises(TypeError):
            replay.sample_lane(True, 100)

    def test_truncated_exact_source_fails(self):
        replay = self.recording([[event(100, .2, .3)]])
        folder = replay.folder
        replay.close()
        (folder / 'raw/gestures.bin').write_bytes(b'bad')
        with self.assertRaisesRegex(ValueError, 'source size'):
            selection.SelectionReplay(folder)

    def test_participant_range_mismatch_fails_on_indexing(self):
        replay = self.recording([[event(100, .2, .3)], [event(100, .4, .5)]])
        folder = replay.folder
        replay.close()
        path = folder / 'raw/events.bin'
        contents = bytearray(path.read_bytes())
        struct.pack_into('<H', contents, 0, 1)
        path.write_bytes(contents)
        corrupt = selection.SelectionReplay(folder)
        self.addCleanup(corrupt.close)
        with self.assertRaisesRegex(ValueError, 'participant range'):
            corrupt.sample_lane(0, 100)

    def pick_geometry(self, replay, points, indices=None):
        indices = list(range(len(points))) if indices is None else indices
        (replay.folder / 'dust').mkdir()
        (replay.folder / 'dust/position.bin').write_bytes(b''.join(struct.pack('<ffff', *p, 0) for p in points))
        (replay.folder / 'dust/source-indices.u32.bin').write_bytes(struct.pack('<' + 'I' * len(indices), *indices))
        replay.layout['groups'] = dict(dust=dict(count=len(points), width=len(points), height=1,
            attributes=dict(position=dict(file='dust/position.bin')),
            sourceIndices=dict(file='dust/source-indices.u32.bin')))
        return dict(camera_position=(0, 0, 3), camera_right=(1, 0, 0), camera_up=(0, 1, 0),
                    camera_forward=(0, 0, -1), tan_half_fov=.4, aspect=16/9, viewport_height=720,
                    tilt=-0.6981317008)

    @unittest.skipUnless(numpy is not None, 'NumPy is included in TouchDesigner; run native picker checks there or with the bundled Python')
    def test_pick_uses_exact_time_and_returns_original_index(self):
        replay = self.recording([[event(100.125, .2, .3), event(0, .4, .5)]])
        camera = self.pick_geometry(replay, [(.5, 0, 0), (-.5, 0, 0)])
        time = 100.12499
        angle = 3.45575191895 * time / replay.duration_ms - .25
        x, y = .5 * math.cos(angle), .5 * math.sin(angle)
        hit = replay.pick_ndc(x / (3 * .4 * 16/9), y / (3 * .4), time, **camera)
        self.assertIsNone(hit, 'A nearby future event is never selectable')
        # Native macOS/TD must also work with strict floating-point reporting.
        with numpy.errstate(all='raise'):
            hit = replay.pick_ndc(x / (3 * .4 * 16/9), y / (3 * .4), 100.125, **camera)
        self.assertEqual((hit['index'], hit['t'], hit['x'], hit['y']), (0, 100.125, .2, .3))
        self.assertLess(hit['pixelDistance'], .001)

    @unittest.skipUnless(numpy is not None, 'NumPy picker check')
    def test_pick_parallax_tracks_camera_and_rejects_old_screen_point(self):
        replay = self.recording([[event(0, .2, .3)]])
        camera = self.pick_geometry(replay, [(.5, 0, 0)])
        x, y = .5 * math.cos(-.25), .5 * math.sin(-.25)
        ndc = (x / (3 * .4 * 16/9), y / (3 * .4))
        self.assertIsNotNone(replay.pick_ndc(*ndc, 0, **camera))
        camera['camera_position'] = (.4, 0, 3)
        self.assertIsNone(replay.pick_ndc(*ndc, 0, **camera))
        shifted = ((x - .4) / (3 * .4 * 16/9), y / (3 * .4))
        self.assertIsNotNone(replay.pick_ndc(*shifted, 0, **camera))

    @unittest.skipUnless(numpy is not None, 'NumPy picker check')
    def test_pick_horizon_occludes_background_but_not_foreground(self):
        replay = self.recording([[event(0, .2, .3), event(100, .4, .5)]])
        camera = self.pick_geometry(replay, [(0, 0, -.5), (0, 0, 2.8)])
        self.assertIsNone(replay.pick_ndc(0, 0, 0, **camera))
        self.assertEqual(replay.pick_ndc(0, 0, 100, **camera)['index'], 1)
        replay.close()  # No lingering ndarray views may prevent source mmap close.

    @unittest.skipUnless(numpy is not None, 'NumPy picker check')
    def test_pick_honors_solo_lane_and_camera_validation(self):
        replay = self.recording([[event(0, .2, .3)], [event(0, .4, .5)]])
        camera = self.pick_geometry(replay, [(.5, 0, 0), (-.5, 0, 0)])
        x, y = .5 * math.cos(-.25), .5 * math.sin(-.25)
        ndc = (x / (3 * .4 * 16/9), y / (3 * .4))
        self.assertIsNone(replay.pick_ndc(*ndc, 0, lane=1, **camera))
        self.assertEqual(replay.pick_ndc(*ndc, 0, lane=0, **camera)['lane'], 0)
        self.assertIsNone(replay.pick_ndc(3, 0, 0, **camera))
        camera['camera_forward'] = (0, 0, -2)
        with self.assertRaisesRegex(ValueError, 'orthonormal'):
            replay.pick_ndc(*ndc, 0, **camera)


if __name__ == '__main__':
    unittest.main()
