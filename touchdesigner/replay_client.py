"""Nonblocking, opt-in controller for the recorder's authoritative UDP clock.

This module uses only the Python standard library and can be embedded in a Text
DAT. It never reads TouchDesigner operators from a background thread. Creating
an instance or calling snapshot() does no network I/O. prepare() only loads the
recorded JSONL; an explicit play() is the sole path that requests OSC output.

Commands return True when queued, not when acknowledged. Read snapshot() from
the main frame callback for results. The injectable request function has the
signature request(path, method='GET', body=None, timeout=1.5) -> decoded dict.

close() requests a best-effort asynchronous stop. Quitting/killing TouchDesigner
cannot guarantee delivery: the recorder owns playback independently. Confirm
potentialOutput == False before closing, or use the recorder's Stop control.
"""
import copy
import json
import math
import queue
import threading
import time
import urllib.error
import urllib.parse
import urllib.request


UDP_DESTINATION = {'host': '127.0.0.1', 'port': 6061}
STATES = frozenset(('EMPTY', 'LOADING', 'READY', 'PLAYING', 'PAUSED', 'COMPLETE', 'ERROR'))


class ReplayRequestError(RuntimeError):
    def __init__(self, message, replay=None):
        super().__init__(message)
        self.replay = replay


def _number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _message(error):
    if isinstance(error, urllib.error.URLError) and not isinstance(error, urllib.error.HTTPError):
        return 'Kayıt sunucusuna ulaşılamadı. Sunucuyu açıp Prepare ile yeniden deneyin.'
    text = str(error)
    if 'Engine is still sending' in text or 'Engine output state could not be verified' in text:
        return 'Venue Engine çıkışını Hold konumuna alın; ardından UDP oynatmayı yeniden deneyin.'
    if 'outside the current A–P' in text and 'finger0' in text:
        return 'Bu kayıt mevcut A–P / finger0 ses yönlendirmesiyle uyumlu değil.'
    if 'Recorded session not found' in text or 'ENOENT' in text:
        return 'Eserin ham JSONL kaydı bulunamadı. Görsel sessiz oynatılabilir.'
    return text or 'UDP sunucusuna ulaşılamadı.'


class NativeReplayClient:
    """Daemon HTTP workers; no OSC encoding and no independent output clock."""

    def __init__(self, base_url='http://127.0.0.1:8787', request=None,
                 now_ms=None, poll_ms=200, stale_ms=900, timeout=1.5):
        parsed = urllib.parse.urlsplit(base_url)
        if (parsed.scheme != 'http' or parsed.hostname not in ('127.0.0.1', 'localhost', '::1')
                or parsed.username or parsed.password or parsed.query or parsed.fragment
                or parsed.path not in ('', '/')):
            raise ValueError('Replay server must be a local HTTP origin')
        if not _number(poll_ms) or poll_ms <= 0 or not _number(stale_ms) or stale_ms <= 0:
            raise ValueError('Replay polling and stale intervals must be positive')
        if not _number(timeout) or timeout <= 0:
            raise ValueError('Replay timeout must be positive')
        self._base_url = base_url.rstrip('/')
        self._request = request or self._http_request
        self._now = now_ms or (lambda: time.monotonic() * 1000.0)
        self._poll_seconds = poll_ms / 1000.0
        self._stale_ms = stale_ms
        self._timeout = timeout
        self._lock = threading.RLock()
        self._commands = queue.Queue()
        self._urgent = queue.Queue()
        self._epoch = 0
        self._enabled = False
        self._busy = False
        self._closed = False
        self._expected_session = None
        self._expected_duration = None
        self._status = None
        self._received_at = 0.0
        self._frozen_position = None
        self._error = None
        self._output_requested = False
        self._requires_stop = False
        self._inflight_plays = set()
        self._next_poll = math.inf
        # Emergency Stop has its own worker so a slow play/guard HTTP request
        # cannot prevent the backend's cancellation epoch from being advanced.
        self._worker = threading.Thread(target=self._run, name='TracesReplayHTTP', daemon=True)
        self._stop_worker = threading.Thread(target=self._run_stops, name='TracesReplayStop', daemon=True)
        self._worker.start()
        self._stop_worker.start()

    def _http_request(self, path, method='GET', body=None, timeout=1.5):
        encoded = None if body is None else json.dumps(body, allow_nan=False).encode('utf-8')
        request = urllib.request.Request(self._base_url + path, data=encoded, method=method,
                                         headers={'Content-Type': 'application/json'})
        # A redirect must not move replay commands to another server.
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, req, fp, code, msg, headers, newurl):
                return None
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        try:
            with opener.open(request, timeout=timeout) as response:
                value = json.loads(response.read(1024 * 1024 + 1))
        except urllib.error.HTTPError as error:
            try:
                value = json.loads(error.read(1024 * 1024 + 1))
            except (ValueError, UnicodeDecodeError):
                value = {}
            raise ReplayRequestError(value.get('error', 'Replay HTTP %s' % error.code),
                                     value.get('replay')) from error
        except (ValueError, UnicodeDecodeError) as error:
            raise ReplayRequestError('UDP sunucusundan okunabilir bir yanıt alınamadı.') from error
        return value

    def _read(self, action='status', body=None):
        return self._request('/api/replay/' + action,
                             method='GET' if action == 'status' else 'POST',
                             body=body, timeout=self._timeout)

    @staticmethod
    def _validate(value):
        if (not isinstance(value, dict) or value.get('state') not in STATES
                or not _number(value.get('positionMs')) or not _number(value.get('durationMs'))
                or value['durationMs'] < 0 or value['positionMs'] < 0
                or value['positionMs'] > value['durationMs'] + 1
                or not _number(value.get('speed')) or not .25 <= value['speed'] <= 4
                or not isinstance(value.get('busy'), bool)
                or not isinstance(value.get('activeVoices'), int)
                or isinstance(value.get('activeVoices'), bool) or value['activeVoices'] < 0):
            raise ReplayRequestError('UDP sunucusu geçerli bir oynatma saati döndürmedi.')
        return value

    def _accept(self, value, identity=True):
        self._validate(value)
        if identity and self._expected_session is not None:
            if value.get('sessionId') != self._expected_session:
                raise ReplayRequestError('UDP sunucusunda farklı bir kayıt açık; çıkışı kapatıp yeniden hazırlayın.')
            if abs(value['durationMs'] - self._expected_duration) > 1:
                raise ReplayRequestError('Ham kayıt süresi ile görselin süresi eşleşmiyor.')
        self._status = copy.deepcopy(value)
        self._received_at = self._now()
        self._frozen_position = None
        self._error = _message(value['error']) if value.get('error') else None

    def _snapshot(self):
        status = self._status or {}
        age = max(0.0, self._now() - self._received_at)
        stale = self._enabled and status.get('state') == 'PLAYING' and age > self._stale_ms
        elapsed = min(age, self._stale_ms) * status.get('speed', 1) if status.get('state') == 'PLAYING' else 0
        position = self._frozen_position
        if position is None:
            position = status.get('positionMs', 0) + elapsed
        return dict(enabled=self._enabled, prepared=self._enabled, busy=self._busy,
                    state=status.get('state', 'EMPTY'), status=copy.deepcopy(self._status),
                    error=self._error or ('UDP saat bilgisi gecikti; çıkışı doğrulayın.' if stale else None),
                    stale=stale, positionMs=max(0, min(status.get('durationMs', 0), position)),
                    playing=self._enabled and status.get('state') == 'PLAYING'
                    and not self._error and not stale and not self._requires_stop and not self._closed,
                    potentialOutput=self._output_requested or bool(self._inflight_plays),
                    closed=self._closed)

    def snapshot(self):
        """Copy cached state only: safe to call once per TouchDesigner frame."""
        with self._lock:
            return self._snapshot()

    def _freeze(self):
        self._frozen_position = self._snapshot()['positionMs']

    def _queue(self, action, body):
        with self._lock:
            if self._closed:
                raise RuntimeError('UDP denetimi kapandı.')
            if self._busy:
                raise RuntimeError('Önceki UDP işleminin tamamlanmasını bekleyin.')
            if self._requires_stop:
                raise RuntimeError('UDP çıkışı doğrulanmadı; önce yeniden Stop kullanın.')
            self._epoch += 1
            self._busy = True
            self._error = None
            self._commands.put((self._epoch, action, body))
        return True

    def prepare(self, sessionId, durationMs, simulated=False):
        if simulated:
            raise ValueError('Örnek eser UDP çıkışına gönderilemez.')
        if (not isinstance(sessionId, str) or not sessionId
                or any(c in sessionId for c in '/\\\0') or any(ord(c) < 32 for c in sessionId)):
            raise ValueError('Geçerli bir kayıt seçin.')
        if not _number(durationMs) or durationMs <= 0:
            raise ValueError('Kayıt süresi geçerli olmalıdır.')
        with self._lock:
            if self._enabled:
                raise RuntimeError('Yeni kayıt hazırlamadan önce UDP çıkışını kapatın.')
        return self._queue('prepare', dict(sessionId=sessionId, durationMs=durationMs))

    def play(self, positionMs=None, speed=1):
        if not _number(speed) or not .25 <= speed <= 4:
            raise ValueError('Replay speed must be between 0.25 and 4')
        with self._lock:
            if not self._enabled:
                raise RuntimeError('Önce UDP çıkışını hazırlayın.')
            if self._snapshot()['error']:
                raise RuntimeError('UDP saati doğrulanmadı; çıkışı kapatıp yeniden hazırlayın.')
            if positionMs is not None and (not _number(positionMs) or not 0 <= positionMs <= self._expected_duration):
                raise ValueError('Invalid replay position')
        body = dict(destination=dict(UDP_DESTINATION), speed=speed)
        if positionMs is not None:
            body['positionMs'] = positionMs
        return self._queue('play', body)

    def pause(self):
        with self._lock:
            if not self._enabled:
                raise RuntimeError('Önce UDP çıkışını hazırlayın.')
        return self._queue('pause', {})

    def _disable(self):
        self._enabled = False
        self._busy = False
        self._expected_session = None
        self._expected_duration = None
        self._output_requested = False
        self._requires_stop = False
        self._error = None
        self._next_poll = math.inf

    def stop(self):
        """Cancel queued play immediately; send priority Stop if output is possible.

        A silent preparation never stops somebody else's transport. Repeating
        Stop is permitted after a timeout, including while another Stop waits.
        """
        with self._lock:
            if self._closed:
                raise RuntimeError('UDP denetimi kapandı.')
            self._epoch += 1
            self._freeze()
            self._busy = True
            self._next_poll = math.inf
            if self._output_requested or self._inflight_plays:
                self._requires_stop = True
                self._urgent.put(self._epoch)
            else:
                self._disable()
        return True

    def close(self, stop_output=True):
        """Best-effort shutdown, never a guarantee that the remote server stopped."""
        with self._lock:
            if self._closed:
                return
            if stop_output:
                self.stop()
            else:
                self._epoch += 1
                self._freeze()
                self._busy = False
            self._closed = True
            self._next_poll = math.inf
            self._commands.put(None)

    def _run(self):
        while True:
            with self._lock:
                delay = min(.2, max(0.0, self._next_poll - time.monotonic()))
            try:
                job = self._commands.get(timeout=delay)
            except queue.Empty:
                with self._lock:
                    if self._closed:
                        return
                    if not self._enabled or self._busy or self._requires_stop or self._next_poll > time.monotonic():
                        continue
                    job = (self._epoch, 'status', None)
            if job is None:
                return
            token, action, body = job
            with self._lock:
                if token != self._epoch or self._closed:
                    continue
                if action == 'play':
                    self._output_requested = True
                    self._inflight_plays.add(token)
            try:
                if action == 'prepare':
                    existing = self._validate(self._read())
                    if existing['state'] in ('PLAYING', 'LOADING') or existing['busy'] or existing['activeVoices']:
                        raise ReplayRequestError('Sunucuda başka bir UDP oynatımı var. Önce onu durdurun.')
                    with self._lock:
                        if token != self._epoch or self._closed:
                            continue
                        self._expected_session = body['sessionId']
                        self._expected_duration = body['durationMs']
                    value = self._read('load', {'file': body['sessionId'] + '.jsonl'})
                    self._validate(value)
                    if value['state'] not in ('READY', 'PAUSED', 'COMPLETE') or value['busy'] or value['activeVoices'] or value.get('error'):
                        raise ReplayRequestError('Ham kayıt sessiz oynatmaya hazır değil.')
                else:
                    value = self._read(action, body)
                with self._lock:
                    if token == self._epoch:
                        self._accept(value)
                        if action == 'prepare':
                            self._enabled = True
                        if action == 'play':
                            if (value['state'] != 'PLAYING' or value.get('error')
                                    or value.get('destination') != UDP_DESTINATION):
                                raise ReplayRequestError('UDP oynatımı ve hedefi doğrulanamadı; Stop kullanın.')
                        if action == 'pause':
                            if value['state'] != 'PAUSED' or value['activeVoices'] or value['busy'] or value.get('error'):
                                raise ReplayRequestError('UDP çıkışının durakladığı doğrulanamadı.')
                            self._output_requested = False
                        if action == 'status' and value['state'] in ('READY', 'PAUSED', 'COMPLETE', 'EMPTY') and not value['activeVoices'] and not value['busy']:
                            self._output_requested = False
            except Exception as error:
                with self._lock:
                    if token == self._epoch:
                        self._freeze()
                        self._error = _message(error)
                        if action in ('play', 'pause'):
                            # A timeout is not evidence that output never
                            # started. Require an explicit confirmed Stop.
                            self._requires_stop = True
            finally:
                with self._lock:
                    self._inflight_plays.discard(token)
                    if action == 'play' and token != self._epoch and self._requires_stop:
                        # Stop may have reached the backend before the older
                        # play request was dispatched. Confirm again after that
                        # request settles; never accept its late PLAYING clock.
                        self._urgent.put(self._epoch)
                    if token == self._epoch:
                        if action != 'status':
                            self._busy = False
                        self._next_poll = time.monotonic() + self._poll_seconds if self._enabled and not self._closed and not self._requires_stop else math.inf

    def _run_stops(self):
        while True:
            try:
                token = self._urgent.get(timeout=.2)
            except queue.Empty:
                with self._lock:
                    if self._closed and not self._inflight_plays:
                        return
                continue
            with self._lock:
                if token != self._epoch or not self._requires_stop:
                    continue
                play_pending_at_dispatch = bool(self._inflight_plays)
            try:
                value = self._read('stop', {})
                self._validate(value)
                if value['state'] not in ('READY', 'EMPTY', 'PAUSED', 'COMPLETE') or value['activeVoices'] or value['busy'] or value.get('error'):
                    raise ReplayRequestError('UDP çıkışının durduğu doğrulanamadı. Yeniden Stop kullanın.')
                with self._lock:
                    if token != self._epoch:
                        continue
                    # A restarted server may be EMPTY with no session id. A
                    # confirmed global Stop is still valid; only playback
                    # clocks must match the selected recording's identity.
                    self._accept(value, identity=False)
                    if play_pending_at_dispatch or self._inflight_plays:
                        # A second confirmation is queued by the normal worker.
                        # The old Play can settle before this Stop response
                        # arrives, even if Stop reached the server first. Its
                        # absence at response time alone proves nothing.
                        self._busy = True
                    else:
                        self._disable()
            except Exception as error:
                with self._lock:
                    if token == self._epoch:
                        self._freeze()
                        self._enabled = True
                        self._busy = False
                        self._error = _message(error)
                        self._next_poll = math.inf
