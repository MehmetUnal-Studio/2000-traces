"""Embedded runtime DAT: causal recorded transport and shared native camera."""
from pathlib import Path
import math
import json
import struct
from numbers import Integral
import numpy as np

previous=None
values={}
cache={}
journey=None
camera_state=None
last_director_pose=None
manual_target=(0.0,0.0,0.0)

def interaction():
    # Old .tox files and data-only test hosts do not have the optional viewer.
    try: node=op('interaction')
    except KeyError: return None
    return node.module if node is not None else None

def data():
    folder=Path(parent().par.Assets.eval()).expanduser()
    if not folder.is_absolute(): folder=Path(project.folder)/folder
    folder=folder.resolve()
    if cache.get('folder') != folder:
        layout=json.loads((folder/'layout.json').read_text())
        timeline=layout['groups']['timeline']
        loaded=dict(folder=folder,layout=layout)
        for name,spec in timeline['attributes'].items():
            array=np.fromfile(folder/spec['file'],dtype='<f4')
            if array.size != timeline['width']*timeline['height']*4:
                raise ValueError('Truncated timeline texture: '+spec['file'])
            loaded[name]=array.reshape((-1,4))[:timeline['count']]
        # Promoting a Float32 texture timestamp to Float64 cannot recover its
        # original time. A rounded-down boundary would reveal a future sample.
        # This sidecar contains the exporter's exact 60 Hz sample timestamps.
        spec=layout['timeline']['exactTimes']
        filename=spec['file'] if isinstance(spec,dict) else spec
        times=np.fromfile(folder/filename,dtype='<f8')
        if (times.size != timeline['count'] or times.size == 0
                or not np.all(np.isfinite(times)) or times[0] != 0
                or times[-1] != layout['durationMs'] or np.any(np.diff(times)<=0)):
            raise ValueError('Invalid exact timeline timestamps')
        loaded['times']=times
        cache.clear(); cache.update(loaded)
    return cache

def envelope(time_ms):
    """Hold the latest causal source envelope, including exact frame edges."""
    if not math.isfinite(time_ms): raise ValueError('Invalid playback time')
    source=data()
    ms=max(0,min(source['layout']['durationMs'],time_ms))
    index=max(0,min(len(source['times'])-1,int(np.searchsorted(source['times'],ms,side='right')-1)))
    return dict(index=index,timeMs=float(source['times'][index]),
                activity=float(source['flow'][index,1]),motion=source['motion'][index])

def inspect(index):
    """Read one ORIGINAL source event, retaining exact recorded X/Y and finger.

    This is a data-only query. It does not change the playhead, selection or UDP
    output. A native rendered instance maps here through its source-indices or
    source-pairs uint32 sidecar; its instance id is not an original event index.
    """
    source=data(); layout=source['layout']
    if isinstance(index,bool) or not isinstance(index,Integral):
        raise TypeError('Source event index must be an integer')
    index=int(index)
    if index<0 or index>=layout['eventCount']:
        raise IndexError('Source event index out of range')
    def raw_path(name):
        return source['folder']/layout['source']['files'][name]['file']
    def record(name,bytes_per_record):
        with raw_path(name).open('rb') as stream:
            stream.seek(index*bytes_per_record)
            value=stream.read(bytes_per_record)
        if len(value)!=bytes_per_record: raise ValueError('Truncated source '+name)
        return value
    manifest=source.get('rawManifest')
    if manifest is None:
        manifest=json.loads(raw_path('manifest.json').read_text())
        if manifest['eventCount']!=layout['eventCount']:
            raise ValueError('Source event count differs from exported artwork')
        source['rawManifest']=manifest
    lane,uq,vq,compat_time,kind,line=struct.unpack('<HHHIBB',record('events.bin',12))
    if lane>=len(manifest['participants']): raise ValueError('Source participant lane is invalid')
    participant=manifest['participants'][lane]
    if participant['l']!=lane or not participant['o']<=index<participant['o']+participant['n']:
        raise ValueError('Source event is outside its participant range')
    exact=bool(manifest.get('gestures'))
    finger=None
    if exact:
        time,x,y,recorded_finger=struct.unpack('<dddd',record('gestures.bin',32))
        if math.isfinite(recorded_finger) and recorded_finger.is_integer(): finger=int(recorded_finger)
    else:
        time=float(compat_time)
        x,y=(uq/65535,vq/65535) if kind in (1,3) else (math.nan,math.nan)
    has_time=math.isfinite(time)
    has_xy=has_time and math.isfinite(x) and math.isfinite(y) and 0<=x<=1 and 0<=y<=1
    names={0:'keepalive',1:'noteOn',2:'noteOff',3:'fingerMove',4:'loadProgress',5:'disconnect'}
    return dict(index=index,sessionId=manifest['sessionId'],lane=lane,
                participantId=participant['p'],zone=participant['z'],seatNumber=participant['s'],
                tMs=time if has_time else None,x=x if math.isfinite(x) else None,
                y=y if math.isfinite(y) else None,finger=finger,fingerKnown=finger is not None,
                eventType=names.get(kind,'unknown'),typeCode=kind,line=line,
                hasXY=has_xy,hasTime=has_time,exact=exact,coordinatePresenceKnown=exact)

def adopt_director():
    """Continuous handoff from authored eye/target to manual polar controls."""
    global last_director_pose,camera_state,manual_target
    if last_director_pose is None: return
    pose=last_director_pose; c=parent()
    for name,key in [('Distance','distance'),('Azimuth','azimuth'),('Elevation','elevation'),('Fov','fov')]:
        getattr(c.par,name).val=pose[key]
    camera_state=[math.log(pose['distance']),pose['azimuth'],pose['elevation'],pose['fov']]
    manual_target=tuple(pose['target'])
    last_director_pose=None

def pulse(name):
    global journey, camera_state
    c=parent()
    controls=interaction()
    if controls is not None and name in ('Fit','Approach','Openviewer'):
        controls.action(name)
        return
    if name in ('Restart','Startshow'):
        if op('io_runtime').module.poll()['locked']: return
        c.par.Position=0; c.par.Play=True
        if name=='Startshow': c.par.Director=True
    elif name=='Fit':
        adopt_director()
        c.par.Director=False; journey=None
        c.par.Distance=3.35; c.par.Azimuth=-18; c.par.Elevation=12
    elif name=='Approach':
        adopt_director()
        c.par.Director=False
        journey=(absTime.seconds,c.par.Distance.eval(),c.par.Azimuth.eval(),c.par.Elevation.eval())

def update():
    global previous,values,journey,camera_state,last_director_pose,manual_target
    c=parent(); now=absTime.seconds
    dt=0 if previous is None else max(0,now-previous)
    previous=now; source=data(); duration=source['layout']['durationMs']/1000
    controls=interaction()
    if controls is not None: controls.poll_pointer()
    transport=op('io_runtime').module.poll()
    if transport['locked']: c.par.Play=False
    if transport['positionMs'] is not None: c.par.Position=transport['positionMs']/1000
    if c.par.Play:
        position=c.par.Position.eval()+dt*c.par.Speed.eval()
        if position>=duration:
            if c.par.Loop: position%=duration
            else: position=duration; c.par.Play=False
        c.par.Position=position
    ms=c.par.Position.eval()*1000
    if c.par.Director:
        pose=op('director_path').module.sample(ms/(duration*1000))
        last_director_pose=pose
        camera_state=None
        position=pose['position']; target=pose['target']; fov=pose['fov']; focus=pose['focus']
    elif controls is not None:
        pose=controls.manual_pose(dt,last_director_pose)
        last_director_pose=None
        position=pose['position']; target=pose['target']; fov=pose['fov']; focus=pose['focus']
    else:
        adopt_director()
        if journey:
            t=min(1,max(0,(now-journey[0])/16)); ease=t*t*t*(t*(t*6-15)+10)
            c.par.Distance=math.exp(math.log(journey[1])*(1-ease)+math.log(.98)*ease)
            c.par.Azimuth=journey[2]+18*ease
            c.par.Elevation=journey[3]+8*ease
            if t>=1: journey=None
        wanted=[math.log(c.par.Distance.eval()),c.par.Azimuth.eval(),c.par.Elevation.eval(),c.par.Fov.eval()]
        if camera_state is None: camera_state=wanted[:]
        blend=1-math.exp(-min(dt,.25)*6.0)
        camera_state=[v+(goal-v)*blend for v,goal in zip(camera_state,wanted)]
        distance=math.exp(camera_state[0]); az=math.radians(camera_state[1]); el=math.radians(camera_state[2])
        position=(distance*math.sin(az)*math.cos(el),distance*math.sin(el),distance*math.cos(az)*math.cos(el))
        manual_target=tuple(v*(1-blend) for v in manual_target)
        target=manual_target; fov=camera_state[3]
        focus=math.sqrt(sum((eye-aim)**2 for eye,aim in zip(position,target)))
    camera=op('camera'); look=op('camera_target')
    for axis,value in zip('xyz',position): getattr(camera.par,'t'+axis).val=value
    for axis,value in zip('xyz',target): getattr(look.par,'t'+axis).val=value
    camera.par.fov=fov
    matrix=camera.worldTransform
    pos=[matrix[r,3] for r in range(3)]; right=[matrix[r,0] for r in range(3)]
    up=[matrix[r,1] for r in range(3)]; forward=[-matrix[r,2] for r in range(3)]
    sample=envelope(ms); motion=sample['motion']
    width=c.par.Width.eval(); height=c.par.Height.eval()
    values=dict(uCameraPos=pos,uCameraRight=right,uCameraUp=up,uCameraForward=forward,
        uCameraInfo=[math.tan(math.radians(fov)/2),width/height,camera.par.near.eval(),camera.par.far.eval()],
        uViewport=[width,height,1/width,1/height],uTime=ms,uDuration=duration*1000,
        uOrbit=math.radians(c.par.Orbit.eval()),uTilt=math.radians(c.par.Tilt.eval()),
        uAnimation=now if c.par.Animate else ms/1000,uActivity=sample['activity'],
        uMotionSpeed=float(motion[0]),uMotionTurn=float(motion[1]),uMotionCoherence=float(motion[2]),uMotionEnergy=float(motion[3]),
        uSelLane=c.par.Lane.eval(),uHoverLane=-1,uReplaying=1 if c.par.Play or transport['playing'] else 0,
        uSolo=float(c.par.Isolate.eval()) if controls is not None else 0,
        uPointMax=128,uPointScale=500,uAtmosphere=0,uDepthPass=0,uActive=1,
        uAccretion=[c.par.Plasma.eval(),c.par.Density.eval(),c.par.Detail.eval(),c.par.Thickness.eval()],
        uRelativity=[c.par.Lensing.eval(),c.par.Beaming.eval(),c.par.Temperature.eval(),c.par.Corona.eval()],
        uFieldLook=[c.par.Dust.eval(),c.par.Gas.eval(),c.par.Traces.eval(),c.par.Stars.eval()],
        uLensOptics=[focus,c.par.Aperture.eval(),c.par.Lensing.eval(),0],
        uGrade=[c.par.Exposure.eval(),c.par.Saturation.eval(),c.par.Bloom.eval(),c.par.Glare.eval()],
        uEnvironment=[c.par.Skygas.eval(),c.par.Skystars.eval(),0,0],
        uFilm=[c.par.Grain.eval(),c.par.Vignette.eval(),now if c.par.Animate else ms/1000,0])
    if controls is not None: controls.update_selection(ms)

def uniform(name,component,frame):
    if not values: update()
    value=values.get(name,0)
    if isinstance(value,(tuple,list)): return value[component] if component<len(value) else 0
    return value if component==0 else 0
