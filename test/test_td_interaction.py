"""Native viewport/runtime integration with recorded binaries and a tiny host.

The host replaces TouchDesigner parameters and operators only. Tests execute
real interaction, camera navigation, runtime transport and selection modules.
No sockets, UI, UDP output or clock sleeps are used.
"""
import importlib.util
import json
import math
from pathlib import Path
import struct
import tempfile
from types import SimpleNamespace
import unittest

from test_td_runtime import Host as RuntimeHost, Parameter, Parameters, load_module


ROOT = Path(__file__).resolve().parents[1] / 'touchdesigner/cinematic'


def load(name):
    spec = importlib.util.spec_from_file_location('test_interaction_' + name, ROOT / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Table:
    def __init__(self):
        self.rows = []

    def clear(self):
        self.rows.clear()

    def appendRow(self, row):
        self.rows.append(list(row))


class Graph:
    def __init__(self):
        self.cooks = 0

    def cook(self, force=False):
        self.cooks += 1


def fixture(folder, offset=0.0, lanes=2):
    raw = folder / 'raw'
    raw.mkdir(parents=True)
    # Distinct finger identities make accidental cross-seat finger reuse clear.
    rows = [[(100.125, .2 + offset, .3, 2, 1), (200.5, .4 + offset, .3, 2, 3),
             (220, math.nan, math.nan, 2, 2), (300.25, .5 + offset, .4, 2, 1)],
            [(50, .1 + offset, .2, 5, 1), (150, .2 + offset, .4, 5, 3)]]
    events, gestures, participants = bytearray(), bytearray(), []
    count = 0
    for lane, records in enumerate(rows[:lanes]):
        participants.append(dict(l=lane, p='A' + str(lane + 1), z='A', s=lane + 1, o=count, n=len(records)))
        for t, x, y, finger, kind in records:
            events.extend(struct.pack('<HHHIBB', lane, 0, 0, int(t), kind, 0))
            gestures.extend(struct.pack('<dddd', t, x, y, finger))
            count += 1
    manifest = dict(formatVersion=1, sessionId='fixture-' + str(offset), durationMs=10000,
        laneCount=lanes, eventCount=count, participants=participants,
        gestures=dict(formatVersion=1, recordBytes=32, count=count, file='gestures.bin'))
    (raw / 'manifest.json').write_text(json.dumps(manifest))
    (raw / 'events.bin').write_bytes(events)
    (raw / 'gestures.bin').write_bytes(gestures)
    (folder / 'layout.json').write_text(json.dumps(dict(durationMs=10000, laneCount=lanes, eventCount=count,
        source=dict(files={name:dict(file='raw/' + name) for name in ('manifest.json', 'events.bin', 'gestures.bin')}))))


class InteractionHost:
    def __init__(self, folder):
        self.runtime = load_module('cinematic/runtime.py')
        self.host = RuntimeHost(self.runtime, duration=10000)
        self.par = self.host.par
        for name, value in dict(Pivotx=0.0, Pivoty=0.0, Pivotz=0.0, Isolate=True).items():
            object.__setattr__(self.par, name, Parameter(value))
        self.host.clock.seconds = 1.0
        self.source = self.runtime.data()
        self.source['folder'] = folder
        self.interaction = load('interaction')
        self.navigation = load('navigation')
        self.selection = load('selection')
        self.graph = Graph()
        self.table = Table()
        self.panel = SimpleNamespace(**{k:Parameter(v) for k,v in dict(u=.5,v=.5,lselect=0,mselect=0,rselect=0,shift=0).items()})
        self.operators = self.host.operators
        self.operators.update({
            'runtime': SimpleNamespace(module=self.runtime),
            'interaction': SimpleNamespace(module=self.interaction),
            'navigation_model': SimpleNamespace(module=self.navigation),
            'seat_replay': SimpleNamespace(module=self.selection),
            'SEATS':self.table, 'xy_graph':self.graph,
            'VIEWPORT/scene':SimpleNamespace(panel=self.panel),
            'VIEWPORT/seats':SimpleNamespace(par=Parameters(display=True)),
        })
        self.interaction.parent = lambda: self.host
        self.interaction.op = self.operators.get
        self.interaction.absTime = self.host.clock
        self.runtime.op = self.operators.get

    def advance(self, dt=1/30):
        self.host.clock.seconds += dt
        self.runtime.update()

    def point(self):
        return self.interaction.selection['selected']


class InteractionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.folder = Path(self.temporary.name) / 'first'
        fixture(self.folder)
        self.h = InteractionHost(self.folder)
        self.i = self.h.interaction
        self.addCleanup(self.i.close)

    def assertVectorClose(self, a, b, places=10):
        for first, second in zip(a,b):
            self.assertAlmostEqual(first, second, places=places)

    def test_play_seek_and_restart_are_local_and_locked_transport_is_untouched(self):
        # io_runtime only provides poll(); any attempted output action fails.
        self.i.action('Play')
        self.assertTrue(self.h.par.Play.eval())
        self.i.seek(.5)
        self.assertEqual(self.h.par.Position.eval(), 5.0)
        self.i.action('Play')
        self.assertFalse(self.h.par.Play.eval())
        self.h.par.Position = 10
        self.i.action('Play')
        self.assertEqual(self.h.par.Position.eval(), 0)
        self.assertTrue(self.h.par.Play.eval())
        self.i.seek(4)
        self.assertEqual(self.h.par.Position.eval(), 10)
        self.i.seek(-4)
        self.assertEqual(self.h.par.Position.eval(), 0)
        self.h.par.Position = 5
        self.h.par.Play = False
        self.h.host.transport['locked'] = True
        for action in ('Play','Restart'):
            self.i.action(action)
            self.assertEqual(self.h.par.Position.eval(), 5)
            self.assertFalse(self.h.par.Play.eval())
        self.i.seek(.8)
        self.assertEqual(self.h.par.Position.eval(), 5)

    def test_ui_seek_forces_exact_causal_selection_even_within_throttle(self):
        self.h.par.Position = .301
        self.i.select_lane(0, 2)
        self.assertEqual(self.h.point()['t'], 300.25)
        self.i.seek(100.1249 / 10000)
        self.assertIsNone(self.h.point())
        self.i.seek(100.125 / 10000)
        self.assertEqual(self.h.point()['t'], 100.125)
        self.assertEqual(self.h.point()['x'], .2)

    def test_runtime_backward_parameter_seek_never_keeps_future_coordinates(self):
        self.h.par.Position = .301
        self.i.select_lane(0, 2)
        self.assertEqual(self.h.point()['t'], 300.25)
        self.h.par.Position = .1
        self.h.advance(.001)
        self.assertIsNone(self.h.point(), 'A backward seek must bypass refresh throttling')

    def test_external_lane_change_resets_clicked_finger_immediately(self):
        self.h.par.Position = .201
        self.i.select_lane(0, 2)
        self.assertEqual(self.h.point()['finger'], 2)
        self.h.par.Lane = 1
        self.h.advance(.001)
        self.assertEqual(self.i.selection['participantId'], 'A2')
        self.assertEqual(self.h.point()['finger'], 5)
        self.assertEqual(self.h.point()['t'], 150)

    def test_explicit_click_finger_selection_is_retained_within_same_lane(self):
        self.h.par.Position = .201
        self.i.select_lane(0, 2)
        self.assertFalse(self.h.operators['VIEWPORT/seats'].par.display.eval())
        self.h.advance(.2)
        self.assertEqual(self.i.finger, 2)
        self.assertEqual(self.h.point()['finger'], 2)
        self.i.select_lane(1)
        self.assertEqual(self.h.point()['finger'], 5)
        self.assertEqual(self.i.finger, 'auto')

    def test_paused_assets_switch_reloads_metadata_and_releases_old_mmaps(self):
        self.h.par.Position = .201
        self.i.select_lane(0, 2)
        old = self.i.replay
        self.assertEqual(self.h.point()['x'], .4)
        folder = Path(self.temporary.name) / 'second'
        fixture(folder, offset=.1)
        self.h.source['folder'] = folder
        self.h.advance(.001)
        self.assertIsNot(self.i.replay, old)
        self.assertTrue(old._closed)
        self.assertAlmostEqual(self.h.point()['x'], .5)
        self.assertEqual(self.i.selection['sessionId'], 'fixture-0.1')

    def test_new_smaller_pack_does_not_reuse_out_of_range_lane(self):
        self.h.par.Position = .201
        self.i.select_lane(1, 5)
        folder = Path(self.temporary.name) / 'second'
        fixture(folder, lanes=1)
        self.h.source['folder'] = folder
        self.h.advance(.001)
        self.assertLess(self.h.par.Lane.eval(), 1)
        if self.i.selection is not None:
            self.assertEqual(self.i.selection['participantId'], 'A1')

    def test_clear_selection_updates_panel_immediately(self):
        self.h.par.Position = .201
        self.i.select_lane(0)
        self.i.action('Clearselection')
        self.assertEqual(self.h.par.Lane.eval(), -1)
        self.assertIsNone(self.i.selection)
        self.assertFalse(self.i.ui('inspectorVisible'))
        self.assertEqual(self.i.ui('selectionLabel'), 'KOLTUK SEÇ')

    def test_director_handoff_preserves_eye_target_fov_and_pan_stays_persistent(self):
        self.h.par.Position = 3.6
        self.h.advance()
        original = self.h.runtime.last_director_pose
        self.i.action('Director')
        self.assertFalse(self.h.par.Director.eval())
        pose = self.i.manual_pose(0)
        self.assertVectorClose(pose['position'], original['position'])
        self.assertVectorClose(pose['target'], original['target'])
        self.assertEqual(pose['fov'], original['fov'])
        self.assertVectorClose(self.i.manual_pose(30)['target'], original['target'])

    def test_direct_parameter_director_disable_hands_off_through_runtime(self):
        self.h.par.Position = 5.4
        self.h.advance()
        original = self.h.runtime.last_director_pose
        self.h.par.Director = False
        self.h.advance(.01)
        self.assertVectorClose(self.h.runtime.values['uCameraPos'], original['position'])
        self.assertVectorClose([getattr(self.h.host.target.par,'t'+axis).eval() for axis in 'xyz'], original['target'])
        self.assertIsNone(self.h.runtime.last_director_pose)

    def test_wheel_switches_director_without_changing_fov_or_playhead(self):
        self.h.par.Position = 3.6
        self.h.advance()
        original = self.h.runtime.last_director_pose
        self.i.panel_event(SimpleNamespace(name='wheel',val=2))
        self.assertFalse(self.h.par.Director.eval())
        self.assertEqual(self.h.par.Position.eval(), 3.6)
        self.assertEqual(self.h.par.Fov.eval(), original['fov'])
        start = self.i.manual_pose(0)
        self.assertVectorClose(start['position'], original['position'])
        self.assertLess(self.i.manual_pose(1)['focus'], original['focus'])

    def test_director_handoff_does_not_resume_an_obsolete_approach(self):
        self.h.par.Director=False
        self.i.action('Approach')
        self.h.runtime.pulse('Startshow')
        self.h.advance(.5)
        original=self.h.runtime.last_director_pose
        self.h.par.Director=False
        self.h.advance(.01)
        self.assertVectorClose(self.h.runtime.values['uCameraPos'],original['position'])
        self.assertIsNone(self.i.approach)

    def test_shift_and_middle_pan_move_identical_persistent_pivots(self):
        def drag(middle):
            h = InteractionHost(self.folder)
            self.addCleanup(h.interaction.close)
            h.par.Director = False
            h.par.Position = .2
            h.interaction.manual_pose(0)
            original = h.interaction.navigation.pose()
            h.panel.lselect.val = not middle
            h.panel.mselect.val = middle
            h.panel.shift.val = not middle
            h.interaction.poll_pointer()
            h.panel.u.val += .02
            h.panel.v.val -= .01
            h.interaction.poll_pointer()
            h.panel.lselect.val = h.panel.mselect.val = 0
            h.interaction.poll_pointer()
            pose = h.interaction.manual_pose(1)
            moved_eye = tuple(a-b for a,b in zip(pose['position'],original['position']))
            moved_pivot = tuple(a-b for a,b in zip(pose['target'],original['target']))
            self.assertVectorClose(moved_eye,moved_pivot)
            self.assertNotEqual(pose['target'],original['target'])
            self.assertEqual(h.par.Position.eval(),.2)
            return pose
        shift,middle = drag(False),drag(True)
        self.assertVectorClose(shift['position'],middle['position'])
        self.assertVectorClose(shift['target'],middle['target'])

    def test_drag_does_not_pick_and_click_only_picks_once_on_release(self):
        calls=[]
        self.i._pick=lambda u,v:calls.append((u,v))
        self.h.panel.lselect.val=1
        self.i.poll_pointer()
        self.h.panel.u.val += .02
        self.i.poll_pointer()
        self.h.panel.lselect.val=0
        self.i.poll_pointer()
        self.assertEqual(calls,[])
        self.h.panel.lselect.val=1
        self.i.poll_pointer()
        self.h.panel.lselect.val=0
        self.i.poll_pointer()
        self.i.poll_pointer()
        self.assertEqual(calls,[(.52,.5)])

    def test_picker_filters_hidden_lanes_in_solo_mode(self):
        self.h.par.Position = .201
        self.i.select_lane(0)
        self.h.advance(.1)
        calls=[]
        self.i.replay.pick_ndc=lambda *a,**kw: calls.append((a,kw))
        self.i._pick(.5,.6)
        self.assertEqual(calls[-1][1].get('lane'),0)
        self.h.par.Isolate=False
        self.i._pick(.5,.6)
        self.assertIsNone(calls[-1][1].get('lane'))
        self.assertEqual(calls[-1][0][:3],(0,.19999999999999996,201.0))


if __name__=='__main__':
    unittest.main()
