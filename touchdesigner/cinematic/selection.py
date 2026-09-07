"""Exact, causal seat inspector; independent of TouchDesigner and UDP.

Embed as a Text DAT and retain one ``SelectionReplay(assets_folder)`` per pack.
Source files are read-only memory maps. Only the last eight inspected seats are
indexed, and a frame query does binary searches and emits at most 64 trail points
per finger. Geometry instance ids are deliberately never treated as event ids.
"""
from bisect import bisect_left, bisect_right
from collections import OrderedDict
import json
import math
import mmap
from numbers import Integral
from pathlib import Path
import struct


AUTO_FINGER = 'auto'
TYPE_NAMES = {0: 'keepalive', 1: 'noteOn', 2: 'noteOff', 3: 'fingerMove',
              4: 'loadProgress', 5: 'disconnect'}


def _integer(value, name, minimum=0, maximum=None):
    if isinstance(value, bool) or not isinstance(value, Integral):
        raise TypeError(name + ' must be an integer')
    value = int(value)
    if value < minimum or (maximum is not None and value > maximum):
        raise ValueError(name + ' out of range')
    return value


def _finite(value, name):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError('Invalid ' + name)
    return float(value)


class SelectionReplay:
    def __init__(self, folder, gap_ms=1200, cache_lanes=8):
        self.folder = Path(folder).expanduser().resolve()
        self.gap_ms = _finite(gap_ms, 'replay gap')
        if self.gap_ms <= 0:
            raise ValueError('Invalid replay gap')
        self.cache_lanes = _integer(cache_lanes, 'cache size', 1, 64)
        self._maps = []
        self._cache = OrderedDict()
        self._closed = False
        self._pick_cache = None
        try:
            self.layout = json.loads((self.folder / 'layout.json').read_text())
            self.manifest = json.loads(self._source_path('manifest.json').read_text())
            self.duration_ms = _finite(self.manifest['durationMs'], 'recording duration')
            if self.duration_ms <= 0 or self.duration_ms != self.layout['durationMs']:
                raise ValueError('Invalid recording duration')
            self.event_count = _integer(self.manifest['eventCount'], 'event count')
            self.lane_count = _integer(self.manifest['laneCount'], 'lane count', 1, 65536)
            if self.event_count != self.layout['eventCount'] or self.lane_count != self.layout['laneCount']:
                raise ValueError('Source counts differ from artwork')
            self.participants = self.manifest['participants']
            if len(self.participants) != self.lane_count:
                raise ValueError('Invalid participant table')
            offset = 0
            for lane, participant in enumerate(self.participants):
                if participant['l'] != lane or participant['o'] != offset:
                    raise ValueError('Invalid participant event range')
                offset += _integer(participant['n'], 'participant event count')
            if offset != self.event_count:
                raise ValueError('Participant ranges differ from event count')
            self.exact = bool(self.manifest.get('gestures'))
            if self.exact:
                spec = self.manifest['gestures']
                if spec.get('count') != self.event_count or spec.get('recordBytes') != 32 or spec.get('formatVersion') != 1:
                    raise ValueError('Invalid exact gesture format')
            self._events = self._map(self._source_path('events.bin'), 12 * self.event_count)
            self._gestures = self._map(self._source_path('gestures.bin'), 32 * self.event_count) if self.exact else None
        except Exception:
            self.close()
            raise

    def _source_path(self, name):
        return self.folder / self.layout['source']['files'][name]['file']

    def _map(self, path, size):
        if path.stat().st_size != size:
            raise ValueError('Invalid source size: ' + str(path))
        if size == 0:
            return b''
        with path.open('rb') as stream:
            result = mmap.mmap(stream.fileno(), 0, access=mmap.ACCESS_READ)
        self._maps.append(result)
        return result

    def close(self):
        self._cache.clear()
        self._pick_cache = None
        for value in self._maps:
            value.close()
        self._maps.clear()
        self._closed = True

    def clear_cache(self):
        self._cache.clear()

    def _lane(self, lane):
        if self._closed:
            raise ValueError('Selection recording is closed')
        return _integer(lane, 'participant lane', 0, self.lane_count - 1)

    def seats(self):
        """Dropdown entries; value is the real lane, label is the recorded seat."""
        return [dict(lane=p['l'], label=str(p['p']), participantId=p['p'],
                     zone=p['z'], seatNumber=p['s'], eventCount=p['n'],
                     firstEventIndex=p['o']) for p in self.participants]

    def read_event(self, index):
        if self._closed:
            raise ValueError('Selection recording is closed')
        index = _integer(index, 'source event index', 0, self.event_count - 1)
        lane, uq, vq, compat_time, kind, line = struct.unpack_from('<HHHIBB', self._events, index * 12)
        if lane >= self.lane_count:
            raise ValueError('Source participant lane is invalid')
        participant = self.participants[lane]
        if not participant['o'] <= index < participant['o'] + participant['n']:
            raise ValueError('Source event is outside its participant range')
        finger = None
        if self.exact:
            time, x, y, recorded_finger = struct.unpack_from('<dddd', self._gestures, index * 32)
            if math.isfinite(recorded_finger) and recorded_finger.is_integer():
                finger = int(recorded_finger)
        else:
            time = float(compat_time)
            x, y = (uq / 65535, vq / 65535) if kind in (1, 3) else (math.nan, math.nan)
        has_time = math.isfinite(time)
        has_xy = has_time and math.isfinite(x) and math.isfinite(y) and 0 <= x <= 1 and 0 <= y <= 1
        return dict(index=index, lane=lane, participantId=participant['p'],
                    zone=participant['z'], seatNumber=participant['s'],
                    t=time if has_time else None, tMs=time if has_time else None,
                    x=x if math.isfinite(x) else None, y=y if math.isfinite(y) else None,
                    finger=finger, kind=kind, eventType=TYPE_NAMES.get(kind, 'unknown'), line=line,
                    hasTime=has_time, hasXY=has_xy, exact=self.exact,
                    fingerKnown=finger is not None, coordinatePresenceKnown=self.exact)

    def _index_lane(self, lane):
        lane = self._lane(lane)
        if lane in self._cache:
            self._cache.move_to_end(lane)
            return self._cache[lane]
        p = self.participants[lane]
        records = [self.read_event(index) for index in range(p['o'], p['o'] + p['n'])]
        records = sorted((e for e in records if e['hasTime'] and 0 <= e['t'] <= self.duration_ms),
                         key=lambda e: (e['t'], e['index']))
        tracks = {}

        def close(track, time):
            if track and track['current'] is not None:
                track['current']['endedAt'] = time
                track['current'] = None
            if track:
                track['anchor'] = None
                track['direction'] = None

        for event in records:
            t, kind, finger = event['t'], event['kind'], event['finger']
            if kind == 5:
                for track in tracks.values():
                    close(track, t)
                continue
            if kind == 2:
                close(tracks.get(finger), t)
                continue
            if kind not in (1, 3):
                continue
            track = tracks.setdefault(finger, dict(finger=finger, events=[], times=[],
                segments=[], segmentIds=[], current=None, anchor=None, direction=None))
            equal_motion_time = track['anchor'] is not None and t == track['anchor']['t']
            if not event['hasXY']:
                close(track, t)
                continue
            if kind == 1:
                close(track, t)
            if track['current'] is not None and t - track['times'][-1] > self.gap_ms:
                close(track, track['times'][-1] + self.gap_ms)
            if track['current'] is None:
                segment = dict(start=len(track['events']), endedAt=None)
                track['current'] = segment
                track['segments'].append(segment)
            motion = dict(valid=False, speed=0.0, turn=0.0, turnDegrees=0.0,
                          directionX=0.0, directionY=0.0)
            anchor = track['anchor']
            known = finger is not None and 0 <= finger <= 65535
            if equal_motion_time:
                # A tied noteOn still opens a new visible trail, but follows
                # the web motion analyzer's no-velocity/no-anchor rule.
                track['anchor'] = None
                track['direction'] = None
            elif known and anchor is not None and t > anchor['t']:
                dt = (t - anchor['t']) / 1000
                dx, dy = event['x'] - anchor['x'], event['y'] - anchor['y']
                length = math.hypot(dx, dy)
                ux, uy = (dx / length, dy / length) if length else (0.0, 0.0)
                prior = track['direction']
                angle = math.atan2(abs(prior[0] * uy - prior[1] * ux), prior[0] * ux + prior[1] * uy) if prior and length else 0.0
                turn = angle / ((dt + prior[2]) / 2) if prior else 0.0
                speed = length / dt
                if math.isfinite(speed) and math.isfinite(turn) and max(speed, turn) <= 3.4028234663852886e38:
                    motion.update(valid=True, speed=speed, turn=turn, turnDegrees=math.degrees(turn), directionX=ux, directionY=uy)
                    track['direction'] = (ux, uy, dt) if length else None
                    track['anchor'] = event
                else:
                    track['anchor'] = None
                    track['direction'] = None
            elif anchor is not None and t <= anchor['t']:
                # Equal-time updates cannot establish velocity or a new anchor.
                track['anchor'] = None
                track['direction'] = None
            else:
                track['anchor'] = event if known else None
                track['direction'] = None
            event['motion'] = motion
            track['events'].append(event)
            track['times'].append(t)
            track['segmentIds'].append(len(track['segments']) - 1)
        indexed = dict(tracks=sorted((track for track in tracks.values() if track['events']),
                       key=lambda track: (track['finger'] is None, track['finger'] or 0)),
                       eventTimes=[event['t'] for event in records])
        self._cache[lane] = indexed
        while len(self._cache) > self.cache_lanes:
            self._cache.popitem(last=False)
        return indexed

    def sample_lane(self, lane, time_ms, finger=AUTO_FINGER, loop=False,
                    trail_ms=2500, max_trail_points=64):
        """No interpolation. ``finger='auto'`` follows the web inspector policy.

        Auto chooses the first active recorded finger, else the last observed
        finger. Pass an integer to keep following a clicked finger; ``None``
        explicitly chooses unknown identity. ``selected=None`` means no causal
        position exists. Coordinates never originate from the playhead.
        """
        lane = self._lane(lane)
        time_ms = _finite(time_ms, 'replay time')
        trail_ms = _finite(trail_ms, 'trail duration')
        if trail_ms < 0:
            raise ValueError('Invalid trail duration')
        max_trail_points = _integer(max_trail_points, 'trail point limit', 1, 64)
        if finger != AUTO_FINGER and finger is not None:
            _integer(finger, 'finger identity', -65535, 65535)
        time = time_ms % self.duration_ms if loop else min(self.duration_ms, max(0.0, time_ms))
        indexed = self._index_lane(lane)
        fingers = []
        for track in indexed['tracks']:
            position = bisect_right(track['times'], time) - 1
            if position < 0:
                continue
            event = track['events'][position]
            segment = track['segments'][track['segmentIds'][position]]
            stale = time - event['t'] > self.gap_ms
            active = not stale and (segment['endedAt'] is None or time < segment['endedAt'])
            start = max(segment['start'], bisect_left(track['times'], time - trail_ms))
            available = max(0, position - start + 1)
            wanted = min(max_trail_points, available) if track['finger'] is not None else 0
            trail = []
            for i in range(wanted):
                offset = position if wanted == 1 else start + i * (available - 1) // (wanted - 1)
                point = track['events'][offset]
                trail.append({key: point[key] for key in ('x', 'y', 't', 'index')})
            current = dict(event, active=active, stale=stale, ageMs=max(0.0, time - event['t']), trail=trail)
            current['motion'] = dict(event['motion'])
            fingers.append(current)
        if finger == AUTO_FINGER:
            selected = next((current for current in fingers if current['active']), fingers[-1] if fingers else None)
        else:
            selected = next((current for current in fingers if current['finger'] == finger), None)
        p = self.participants[lane]
        return dict(time=time, timeMs=time, lane=lane, pid=p['p'], label=str(p['p']),
                    participantId=p['p'], zone=p['z'], seatNumber=p['s'],
                    participant=dict(p), eventCount=p['n'],
                    observedEventCount=bisect_right(indexed['eventTimes'], time),
                    sessionId=self.manifest.get('sessionId'), durationMs=self.duration_ms,
                    exact=self.exact, coordinatePresenceKnown=self.exact,
                    source='demo' if self.manifest.get('simulated') else 'recorded' if self.exact else 'legacy',
                    looped=bool(loop and (time_ms < 0 or time_ms >= self.duration_ms)),
                    hasXY=selected is not None, selected=selected, fingers=fingers)

    def _pick_points(self):
        """Load sampled source geometry once, only if pointer picking is used."""
        if self._closed:
            raise ValueError('Selection recording is closed')
        if self._pick_cache is not None:
            return self._pick_cache
        import numpy as np  # Included with TouchDesigner; inspector needs no NumPy.
        group = self.layout['groups']['dust']
        count = _integer(group['count'], 'dust point count')
        storage_count = _integer(group['width'], 'dust texture width', 1) * _integer(group['height'], 'dust texture height', 1)
        if count > storage_count:
            raise ValueError('Dust count exceeds texture')
        positions = np.fromfile(self.folder / group['attributes']['position']['file'], dtype='<f4')
        if positions.size != storage_count * 4:
            raise ValueError('Invalid dust position texture size')
        indices = np.fromfile(self.folder / group['sourceIndices']['file'], dtype='<u4')
        if indices.size != count or np.any(indices >= self.event_count):
            raise ValueError('Invalid dust source indices')
        # Copy derived arrays: no NumPy view survives on the source mmap, so
        # close() remains safe when switching a recording or reloading a DAT.
        dtype = np.dtype([('lane', '<u2'), ('x', '<u2'), ('y', '<u2'),
                          ('time', '<u4'), ('kind', 'u1'), ('line', 'u1')])
        records = np.frombuffer(self._events, dtype=dtype)[indices]
        lanes = records['lane'].copy()
        if np.any(lanes >= self.lane_count):
            raise ValueError('Invalid dust participant lane')
        starts = np.array([p['o'] for p in self.participants], dtype=np.uint64)
        ends = np.array([p['o'] + p['n'] for p in self.participants], dtype=np.uint64)
        if np.any(indices < starts[lanes]) or np.any(indices >= ends[lanes]):
            raise ValueError('Dust event is outside participant range')
        if self.exact:
            gestures = np.frombuffer(self._gestures, dtype='<f8').reshape((-1, 4))[indices]
            times = gestures[:, 0].copy()
            coordinates = gestures[:, 1:3]
            valid = np.all(np.isfinite(coordinates) & (coordinates >= 0) & (coordinates <= 1), axis=1)
        else:
            times = records['time'].astype(np.float64)
            valid = np.ones(count, dtype=bool)
        positions = positions.reshape((-1, 4))[:count, :3].astype(np.float64)
        valid &= np.isin(records['kind'], [1, 3]) & np.isfinite(times) & (times >= 0) & (times <= self.duration_ms)
        valid &= np.all(np.isfinite(positions), axis=1)
        self._pick_cache = dict(positions=positions, indices=indices.copy(), times=times,
                               lanes=lanes, valid=valid)
        return self._pick_cache

    def pick_ndc(self, x, y, time_ms, camera_position, camera_right, camera_up,
                 camera_forward, tan_half_fov, aspect, viewport_height,
                 orbit=0.0, tilt=0.0, radius_px=10.0, near=0.008, far=80.0,
                 lane=None, horizon_radius=0.205):
        """Pick a causal recorded dust instance with the shared native camera.

        NDC is [-1,+1], Y up. Orbit/tilt are radians, matching runtime uniforms.
        Pass ``lane`` only for strict solo rendering. The circular hit footprint
        is measured in output pixels. A hit returns exact original event data,
        plus worldPosition/pixelDistance. Core-occluded points are excluded.

        This projects source geometry before the background-lensing pass: near
        the bent rim, a warped pixel can differ from its source hit location.
        The native seat menu remains an exact, projection-independent selector.
        """
        import numpy as np
        x, y = _finite(x, 'pointer X'), _finite(y, 'pointer Y')
        time = min(self.duration_ms, max(0.0, _finite(time_ms, 'pick time')))
        fov = _finite(tan_half_fov, 'camera FOV')
        aspect = _finite(aspect, 'camera aspect')
        height = _finite(viewport_height, 'viewport height')
        radius = _finite(radius_px, 'pick radius')
        near, far = _finite(near, 'near clip'), _finite(far, 'far clip')
        horizon = _finite(horizon_radius, 'horizon radius')
        orbit, tilt = _finite(orbit, 'orbit'), _finite(tilt, 'tilt')
        if min(fov, aspect, height, radius, near) <= 0 or far <= near or horizon < 0:
            raise ValueError('Invalid pick camera dimensions')
        if lane is not None:
            lane = self._lane(lane)
        def vector(value):
            result = np.asarray(value, dtype=float)
            if result.shape != (3,) or not np.all(np.isfinite(result)):
                raise ValueError('Invalid camera vector')
            return result
        eye, right, up, forward = map(vector, (camera_position, camera_right, camera_up, camera_forward))
        basis = np.array([right, up, forward])
        if not np.allclose(np.einsum('ik,jk->ij', basis, basis), np.eye(3), atol=1e-4):
            raise ValueError('Camera basis must be orthonormal')
        if abs(x) > 1 or abs(y) > 1:
            return None
        source = self._pick_points()
        valid = source['valid'] & (source['times'] <= time)
        if lane is not None:
            valid &= source['lanes'] == lane
        slots = np.flatnonzero(valid)
        if not len(slots):
            return None
        points = source['positions'][slots].copy()
        angle = orbit + 3.45575191895 * time / max(self.duration_ms, 1.0)
        c, s = math.cos(angle), math.sin(angle)
        points[:, 0], points[:, 1] = (points[:, 0] * c - points[:, 1] * s,
                                     points[:, 0] * s + points[:, 1] * c)
        c, s = math.cos(0.6981317008 + tilt), math.sin(0.6981317008 + tilt)
        points[:, 1], points[:, 2] = (points[:, 1] * c - points[:, 2] * s,
                                     points[:, 1] * s + points[:, 2] * c)
        c, s = 0.9689124217, -0.2474039593
        points[:, 0], points[:, 1] = (points[:, 0] * c - points[:, 1] * s,
                                     points[:, 0] * s + points[:, 1] * c)
        relative = points - eye
        # Three-component contractions need no BLAS dispatch. The Accelerate
        # matmul path bundled with TD 2025 on macOS can report floating-point
        # status warnings even for these finite, bounded scene coordinates.
        depth = np.einsum('ij,j->i', relative, forward)
        valid = (depth > near) & (depth < far)
        safe_depth = np.maximum(depth, near)
        screen_x = np.einsum('ij,j->i', relative, right) / (safe_depth * fov * aspect)
        screen_y = np.einsum('ij,j->i', relative, up) / (safe_depth * fov)
        valid &= (np.abs(screen_x) <= 1) & (np.abs(screen_y) <= 1)
        distance2 = ((screen_x - x) * height * aspect / 2) ** 2 + ((screen_y - y) * height / 2) ** 2
        valid &= distance2 <= radius * radius
        if horizon > 0:
            # Segment-to-origin distance: foreground points remain pickable;
            # points behind the spherical black horizon cannot be selected.
            denominator = np.einsum('ij,ij->i', relative, relative)
            along = -np.einsum('ij,j->i', relative, eye) / np.maximum(denominator, 1e-20)
            closest = eye + relative * np.clip(along, 0, 1)[:, None]
            occluded = (along > 0) & (along < 1) & (np.einsum('ij,ij->i', closest, closest) < horizon * horizon)
            valid &= ~occluded
        candidates = np.flatnonzero(valid)
        if not len(candidates):
            return None
        nearest = candidates[np.lexsort((depth[candidates], distance2[candidates]))[0]]
        result = self.read_event(int(source['indices'][slots[nearest]]))
        result.update(worldPosition=tuple(float(v) for v in points[nearest]),
                      pixelDistance=float(math.sqrt(distance2[nearest])))
        return result
