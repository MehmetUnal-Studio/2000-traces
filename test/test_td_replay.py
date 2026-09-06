"""Native controller tests: all HTTP is injected; no recorder or UDP is used."""
import copy
import importlib.util
import pathlib
import threading
import time
import unittest
from unittest import mock


PATH = pathlib.Path(__file__).resolve().parents[1] / 'touchdesigner' / 'replay_client.py'
SPEC = importlib.util.spec_from_file_location('td_replay_client', PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
NativeReplayClient = MODULE.NativeReplayClient
READY = dict(state='READY', sessionId='take-1', durationMs=5000, positionMs=0,
             speed=1, activeVoices=0, busy=False, error=None,
             destination={'host': '127.0.0.1', 'port': 6061})
EMPTY = dict(READY, state='EMPTY', sessionId=None, durationMs=0)


class FakeRequest:
    def __init__(self, handler=None):
        self.calls = []
        self.state = copy.deepcopy(EMPTY)
        self.handler = handler
        self.lock = threading.Lock()

    def __call__(self, path, method='GET', body=None, timeout=1.5):
        with self.lock:
            self.calls.append(dict(path=path, method=method, body=copy.deepcopy(body),
                                   thread=threading.get_ident()))
        if self.handler:
            result = self.handler(path, body)
            if result is not None:
                return result
        with self.lock:
            if path.endswith('/load'):
                self.state = copy.deepcopy(READY)
            elif path.endswith('/play'):
                self.state.update(state='PLAYING', positionMs=body.get('positionMs', self.state['positionMs']),
                                  speed=body.get('speed', 1), activeVoices=1)
            elif path.endswith('/pause'):
                self.state.update(state='PAUSED', activeVoices=0)
            elif path.endswith('/stop'):
                self.state.update(state='READY', positionMs=0, activeVoices=0, busy=False, error=None)
            return copy.deepcopy(self.state)

    def paths(self):
        with self.lock:
            return [call['path'] for call in self.calls]


class NativeReplayTests(unittest.TestCase):
    def setUp(self):
        self.clients = []
        self.gates = []
        self.clock = 0.0
        # Accidental use of a real HTTP client is a test failure.
        self.no_network = mock.patch('urllib.request.OpenerDirector.open',
                                     side_effect=AssertionError('Real network forbidden in native replay tests'))
        self.no_network.start()

    def tearDown(self):
        for gate in self.gates:
            gate.set()
        for client in self.clients:
            client.close(stop_output=False)
        for client in self.clients:
            client._worker.join(1)
            client._stop_worker.join(1)
        self.no_network.stop()

    def gate(self):
        gate = threading.Event()
        self.gates.append(gate)
        return gate

    def client(self, request=None, **kwargs):
        client = NativeReplayClient(request=request, now_ms=lambda: self.clock,
                                    poll_ms=kwargs.pop('poll_ms', 60000), **kwargs)
        self.clients.append(client)
        return client

    def wait(self, predicate, message='Native replay operation did not settle'):
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            if predicate():
                return
            time.sleep(.002)
        self.fail(message)

    def prepared(self, request=None, **kwargs):
        request = request or FakeRequest()
        client = self.client(request, **kwargs)
        client.prepare('take-1', 5000)
        self.wait(lambda: not client.snapshot()['busy'])
        self.assertTrue(client.snapshot()['enabled'], client.snapshot())
        return client, request

    def playing(self, request=None, **kwargs):
        client, request = self.prepared(request, **kwargs)
        client.play(100, 2)
        self.wait(lambda: not client.snapshot()['busy'])
        self.assertTrue(client.snapshot()['playing'], client.snapshot())
        return client, request

    def test_default_construction_snapshot_and_close_make_no_http_requests(self):
        client = self.client()
        self.assertFalse(client.snapshot()['enabled'])
        self.assertFalse(client.snapshot()['potentialOutput'])
        self.assertTrue(client._worker.daemon)
        self.assertTrue(client._stop_worker.daemon)
        client.close()
        time.sleep(.02)
        self.assertIsNone(client.snapshot()['error'])

    def test_prepare_is_silent_and_commands_run_off_the_main_thread(self):
        client, request = self.prepared()
        self.assertEqual(request.paths(), ['/api/replay/status', '/api/replay/load'])
        self.assertEqual(request.calls[1]['body'], {'file': 'take-1.jsonl'})
        self.assertTrue(all(c['thread'] != threading.get_ident() for c in request.calls))
        self.assertFalse(client.snapshot()['playing'])
        client.stop()
        self.assertFalse(client.snapshot()['enabled'])
        self.assertEqual(len(request.calls), 2)

    def test_invalid_source_and_simulation_never_make_io(self):
        request = FakeRequest()
        client = self.client(request)
        for session, duration in [('', 5000), ('../take', 5000), ('a\\b', 5000),
                                  ('take\n', 5000), ('take', 0), ('take', float('nan')),
                                  ('take', True)]:
            with self.subTest(session=session, duration=duration):
                with self.assertRaises(ValueError):
                    client.prepare(session, duration)
        with self.assertRaises(ValueError):
            client.prepare('take-1', 5000, simulated=True)
        with self.assertRaises(RuntimeError):
            client.play()
        self.assertEqual(request.calls, [])

    def test_server_origin_must_be_local_and_has_no_credentials(self):
        for origin in ['https://example.org', 'http://example.org', 'http://user@localhost:8787',
                       'http://127.0.0.1:8787/api', 'http://127.0.0.1:8787/?x=1']:
            with self.assertRaises(ValueError):
                NativeReplayClient(base_url=origin)

    def test_explicit_play_uses_fixed_destination_and_bounded_server_interpolation(self):
        client, request = self.playing()
        self.assertEqual(request.calls[-1]['body'],
                         {'destination': {'host': '127.0.0.1', 'port': 6061}, 'positionMs': 100, 'speed': 2})
        self.clock = 100
        self.assertEqual(client.snapshot()['positionMs'], 300)
        self.clock = 1000
        self.assertEqual(client.snapshot()['positionMs'], 1900)
        self.assertFalse(client.snapshot()['playing'])
        self.assertTrue(client.snapshot()['stale'])
        self.clock = 9000
        self.assertEqual(client.snapshot()['positionMs'], 1900)
        with self.assertRaises(RuntimeError):
            client.play()

    def test_play_arguments_cannot_send_nonfinite_out_of_range_values(self):
        client, request = self.prepared()
        for position, speed in [(float('nan'), 1), (-1, 1), (6000, 1), (True, 1),
                                (0, .1), (0, 8), (0, float('inf')), (0, True)]:
            with self.assertRaises(ValueError):
                client.play(position, speed)
        self.assertNotIn('/api/replay/play', request.paths())

    def test_prepare_refuses_existing_output_or_busy_transport(self):
        for change in [dict(state='PLAYING'), dict(activeVoices=1), dict(busy=True), dict(state='LOADING')]:
            with self.subTest(change=change):
                request = FakeRequest(lambda path, body: dict(READY, **change))
                client = self.client(request)
                client.prepare('take-1', 5000)
                self.wait(lambda: not client.snapshot()['busy'])
                self.assertFalse(client.snapshot()['enabled'])
                self.assertIsNotNone(client.snapshot()['error'])
                self.assertEqual(request.paths(), ['/api/replay/status'])

    def test_prepare_fails_closed_on_identity_duration_and_invalid_clock(self):
        for change in [dict(sessionId='other'), dict(durationMs=6000), dict(positionMs=float('nan')),
                       dict(positionMs=-1), dict(speed=True), dict(activeVoices=-1), dict(busy=None),
                       dict(state='ERROR', error='bad'), dict(state='PLAYING')]:
            with self.subTest(change=change):
                request = FakeRequest(lambda path, body: dict(READY, **change) if path.endswith('/load') else EMPTY)
                client = self.client(request)
                client.prepare('take-1', 5000)
                self.wait(lambda: not client.snapshot()['busy'])
                self.assertFalse(client.snapshot()['enabled'])
                self.assertIsNotNone(client.snapshot()['error'])
                self.assertNotIn('/api/replay/play', request.paths())

    def test_pause_releases_clock_without_implicit_resume(self):
        client, request = self.playing()
        client.pause()
        self.wait(lambda: not client.snapshot()['busy'])
        self.assertEqual(client.snapshot()['state'], 'PAUSED')
        self.assertEqual(client.snapshot()['positionMs'], 100)
        self.assertFalse(client.snapshot()['playing'])
        self.assertFalse(client.snapshot()['potentialOutput'])
        self.assertEqual(request.paths()[-1], '/api/replay/pause')

    def test_pending_play_is_canceled_with_priority_stop_then_late_reply_confirmation(self):
        entered, release, first_stop = self.gate(), self.gate(), self.gate()
        def handler(path, body):
            if path.endswith('/play'):
                entered.set()
                release.wait(2)
                return dict(READY, state='PLAYING', activeVoices=1)
            if path.endswith('/stop'):
                first_stop.set()
                return READY
        client, request = self.prepared(FakeRequest(handler))
        client.play()
        self.assertTrue(entered.wait(1))
        started = time.monotonic()
        client.stop()
        self.assertLess(time.monotonic() - started, .05)
        self.assertTrue(first_stop.wait(1), 'Stop waited behind slow Play HTTP')
        self.assertTrue(client.snapshot()['potentialOutput'])
        self.assertFalse(client.snapshot()['playing'])
        release.set()
        self.wait(lambda: not client.snapshot()['enabled'] and not client.snapshot()['busy'])
        self.assertEqual(request.paths().count('/api/replay/stop'), 2)
        self.assertFalse(client.snapshot()['potentialOutput'])
        self.assertNotEqual(client.snapshot()['state'], 'PLAYING')

    def test_canceling_pending_silent_load_never_stops_foreign_output(self):
        entered, release = self.gate(), self.gate()
        def handler(path, body):
            if path.endswith('/load'):
                entered.set()
                release.wait(2)
                return READY
        request = FakeRequest(handler)
        client = self.client(request)
        client.prepare('take-1', 5000)
        self.assertTrue(entered.wait(1))
        client.stop()
        release.set()
        time.sleep(.03)
        self.assertFalse(client.snapshot()['enabled'])
        self.assertNotIn('/api/replay/stop', request.paths())
        self.assertNotIn('/api/replay/play', request.paths())

    def test_delayed_stop_reply_cannot_suppress_confirmation_after_later_play(self):
        for closing in (False, True):
            with self.subTest(closing=closing):
                entered_play, release_play = self.gate(), self.gate()
                entered_stop, release_stop = self.gate(), self.gate()
                stop_count = [0]
                def handler(path, body):
                    if path.endswith('/play'):
                        entered_play.set()
                        release_play.wait(2)
                        return dict(READY, state='PLAYING', activeVoices=1)
                    if path.endswith('/stop'):
                        stop_count[0] += 1
                        if stop_count[0] == 1:
                            # Server stopped before Play, but its HTTP reply is
                            # held until that stale Play has already settled.
                            entered_stop.set()
                            release_stop.wait(2)
                        return READY
                client, request = self.prepared(FakeRequest(handler))
                client.play()
                self.assertTrue(entered_play.wait(1))
                client.close() if closing else client.stop()
                self.assertTrue(entered_stop.wait(1))
                release_play.set()
                self.wait(lambda: not client._inflight_plays)
                release_stop.set()
                self.wait(lambda: not client.snapshot()['enabled'] and not client.snapshot()['busy'])
                self.assertEqual(stop_count[0], 2)
                self.assertFalse(client.snapshot()['potentialOutput'])
                if closing:
                    self.wait(lambda: not client._worker.is_alive() and not client._stop_worker.is_alive())

    def test_close_after_foreign_prepare_rejection_or_pending_load_is_silent(self):
        request = FakeRequest(lambda path, body: dict(READY, state='PLAYING', activeVoices=3))
        client = self.client(request)
        client.prepare('take-1', 5000)
        self.wait(lambda: not client.snapshot()['busy'])
        client.close()
        self.wait(lambda: not client._worker.is_alive() and not client._stop_worker.is_alive())
        self.assertEqual(request.paths(), ['/api/replay/status'])
        self.assertFalse(client.snapshot()['potentialOutput'])

        entered, release = self.gate(), self.gate()
        def handler(path, body):
            if path.endswith('/load'):
                entered.set()
                release.wait(2)
                return READY
        request = FakeRequest(handler)
        client = self.client(request)
        client.prepare('take-1', 5000)
        self.assertTrue(entered.wait(1))
        client.close()
        release.set()
        self.wait(lambda: not client._worker.is_alive() and not client._stop_worker.is_alive())
        self.assertEqual(request.paths(), ['/api/replay/status', '/api/replay/load'])
        self.assertFalse(client.snapshot()['enabled'])
        self.assertFalse(client.snapshot()['potentialOutput'])

    def test_stop_cancels_play_queued_behind_status_before_dispatch(self):
        entered, release = self.gate(), self.gate()
        status_count = [0]
        def handler(path, body):
            if path.endswith('/status'):
                status_count[0] += 1
                if status_count[0] > 1:
                    entered.set()
                    release.wait(2)
        client, request = self.prepared(FakeRequest(handler), poll_ms=10)
        self.assertTrue(entered.wait(1))
        client.play()
        client.stop()
        release.set()
        time.sleep(.03)
        self.assertFalse(client.snapshot()['enabled'])
        self.assertNotIn('/api/replay/play', request.paths())
        self.assertNotIn('/api/replay/stop', request.paths())

    def test_uncertain_stop_retains_potential_output_and_repeated_stop_recovers(self):
        stop_count = [0]
        def handler(path, body):
            if path.endswith('/stop'):
                stop_count[0] += 1
                if stop_count[0] == 1:
                    raise TimeoutError('stop timeout')
        client, request = self.playing(FakeRequest(handler))
        client.stop()
        self.wait(lambda: not client.snapshot()['busy'])
        self.assertTrue(client.snapshot()['enabled'])
        self.assertTrue(client.snapshot()['potentialOutput'])
        self.assertIn('timeout', client.snapshot()['error'])
        frozen = client.snapshot()['positionMs']
        self.clock = 2000
        self.assertEqual(client.snapshot()['positionMs'], frozen)
        with self.assertRaises(RuntimeError):
            client.play()
        client.stop()
        self.wait(lambda: not client.snapshot()['busy'])
        self.assertFalse(client.snapshot()['potentialOutput'])
        self.assertFalse(client.snapshot()['enabled'])
        self.assertEqual(stop_count[0], 2)

    def test_play_timeout_is_not_mistaken_for_silent_ready_status(self):
        def handler(path, body):
            if path.endswith('/play'):
                raise TimeoutError('play timeout')
        client, request = self.prepared(FakeRequest(handler), poll_ms=10)
        client.play()
        self.wait(lambda: not client.snapshot()['busy'])
        self.assertTrue(client.snapshot()['potentialOutput'])
        self.assertFalse(client.snapshot()['playing'])
        count = len(request.calls)
        time.sleep(.05)
        self.assertEqual(len(request.calls), count, 'An idle poll cannot clear uncertain output')
        client.stop()
        self.wait(lambda: not client.snapshot()['busy'])
        self.assertFalse(client.snapshot()['potentialOutput'])

    def test_invalid_stop_response_cannot_claim_output_is_off(self):
        request = FakeRequest(lambda path, body: dict(READY, state='PLAYING', activeVoices=1)
                              if path.endswith('/stop') else None)
        client, request = self.playing(request)
        client.stop()
        self.wait(lambda: not client.snapshot()['busy'])
        self.assertTrue(client.snapshot()['potentialOutput'])
        self.assertIsNotNone(client.snapshot()['error'])
        self.assertFalse(client.snapshot()['playing'])

    def test_restart_empty_stop_can_confirm_output_is_off_without_session_identity(self):
        request = FakeRequest(lambda path, body: EMPTY if path.endswith('/stop') else None)
        client, request = self.playing(request)
        client.stop()
        self.wait(lambda: not client.snapshot()['busy'])
        self.assertFalse(client.snapshot()['potentialOutput'])
        self.assertFalse(client.snapshot()['enabled'])
        self.assertIsNone(client.snapshot()['error'])

    def test_play_and_pause_require_the_expected_transport_state(self):
        for action, response in [('play', dict(READY, state='PLAYING', destination={'host': '127.0.0.1', 'port': 9999})),
                                 ('play', READY), ('pause', dict(READY, state='ERROR', error='cleanup failed'))]:
            with self.subTest(action=action, response=response):
                request = FakeRequest(lambda path, body: response if path.endswith('/' + action) else None)
                client, request = self.prepared(request) if action == 'play' else self.playing(request)
                getattr(client, action)()
                self.wait(lambda: not client.snapshot()['busy'])
                self.assertTrue(client.snapshot()['potentialOutput'])
                self.assertIsNotNone(client.snapshot()['error'])
                self.assertFalse(client.snapshot()['playing'])

    def test_polling_only_starts_after_prepare_and_stops_after_disable(self):
        request = FakeRequest()
        client = self.client(request, poll_ms=20)
        time.sleep(.04)
        self.assertEqual(request.paths(), [])
        client.prepare('take-1', 5000)
        self.wait(lambda: request.paths().count('/api/replay/status') >= 3)
        client.stop()
        time.sleep(.03)
        count = len(request.calls)
        time.sleep(.05)
        self.assertEqual(len(request.calls), count)

    def test_wrong_poll_identity_freezes_visual_clock_and_blocks_play(self):
        mismatch = threading.Event()
        def handler(path, body):
            if path.endswith('/status') and mismatch.is_set():
                return dict(READY, sessionId='somebody-else', state='PLAYING')
        client, request = self.playing(FakeRequest(handler), poll_ms=20)
        self.clock = 100
        mismatch.set()
        self.wait(lambda: client.snapshot()['error'] is not None)
        position = client.snapshot()['positionMs']
        self.clock = 400
        self.assertEqual(client.snapshot()['positionMs'], position)
        self.assertFalse(client.snapshot()['playing'])
        self.assertTrue(client.snapshot()['potentialOutput'])
        with self.assertRaises(RuntimeError):
            client.play()

    def test_snapshot_is_detached_and_close_only_requests_best_effort_stop(self):
        stopped = self.gate()
        def handler(path, body):
            if path.endswith('/stop'):
                stopped.set()
        client, request = self.playing(FakeRequest(handler))
        snap = client.snapshot()
        snap['status']['destination']['port'] = 9999
        self.assertEqual(client.snapshot()['status']['destination']['port'], 6061)
        client.close()
        self.assertTrue(stopped.wait(1))
        self.wait(lambda: not client.snapshot()['potentialOutput'])
        self.assertTrue(client.snapshot()['closed'])
        self.assertFalse(client.snapshot()['playing'])


if __name__ == '__main__':
    unittest.main()
