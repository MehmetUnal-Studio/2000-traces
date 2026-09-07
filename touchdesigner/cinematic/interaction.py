"""Native viewport controls. UI changes never initiate UDP output."""
import math

navigation=None
replay=None
replay_folder=None
finger='auto'
selection=None
last_selection_key=None
last_selection_at=-1
pointer=None
approach=None

def _runtime(): return op('runtime').module

def _navigation():
    global navigation
    if navigation is None:
        c=parent()
        navigation=op('navigation_model').module.NavigationState()
        navigation.set_controls(distance=c.par.Distance.eval(),azimuth=c.par.Azimuth.eval(),
            elevation=c.par.Elevation.eval(),fov=c.par.Fov.eval(),
            target=tuple(getattr(c.par,'Pivot'+a).eval() for a in 'xyz'))
        navigation.adopt(navigation.controls())
    return navigation

def _sync():
    c=parent(); goal=_navigation().controls()
    for name,key in [('Distance','distance'),('Azimuth','azimuth'),('Elevation','elevation'),('Fov','fov')]:
        getattr(c.par,name).val=goal[key]
    for axis,value in zip('xyz',goal['target']): getattr(c.par,'Pivot'+axis).val=value

def _manual():
    global approach
    c=parent(); runtime=_runtime(); nav=_navigation()
    if c.par.Director and runtime.last_director_pose is not None:
        nav.adopt(runtime.last_director_pose)
        runtime.last_director_pose=None
        _sync()
    c.par.Director=False
    approach=None
    return nav

def manual_pose(dt,director_pose=None):
    global approach
    c=parent(); nav=_navigation()
    if director_pose is not None:
        approach=None
        nav.adopt(director_pose); _sync()
    if approach:
        t=min(1,max(0,(absTime.seconds-approach[0])/16))
        ease=t*t*t*(t*(t*6-15)+10)
        start=approach[1]
        nav.set_controls(distance=math.exp(math.log(start['distance'])*(1-ease)+math.log(.98)*ease),
            azimuth=start['azimuth']+18*ease,elevation=start['elevation']+8*ease)
        _sync()
        if t>=1: approach=None
    nav.set_controls(distance=c.par.Distance.eval(),azimuth=c.par.Azimuth.eval(),
        elevation=c.par.Elevation.eval(),fov=c.par.Fov.eval(),
        target=tuple(getattr(c.par,'Pivot'+a).eval() for a in 'xyz'))
    return nav.step(dt)

def _replay():
    global replay,replay_folder
    folder=_runtime().data()['folder']
    if replay is None or folder!=replay_folder:
        if replay is not None: replay.close()
        replay=op('seat_replay').module.SelectionReplay(folder)
        replay_folder=folder
        table=op('SEATS'); table.clear(); table.appendRow(['label','lane'])
        table.appendRow(['Tüm koltuklar',-1])
        for seat in replay.seats(): table.appendRow([seat['label'],seat['lane']])
    return replay

def select_lane(lane,selected_finger='auto'):
    global finger,last_selection_key
    c=parent(); lane=int(lane)
    if lane < -1 or lane >= _replay().lane_count: return
    c.par.Lane=lane; finger=selected_finger; last_selection_key=None
    popup=op('VIEWPORT/seats')
    if popup is not None: popup.par.display=False
    update_selection(c.par.Position.eval()*1000,True)

def update_selection(ms,force=False):
    global selection,last_selection_key,last_selection_at,finger
    c=parent(); recording=_replay(); lane=c.par.Lane.eval()
    if lane>=recording.lane_count: c.par.Lane=-1; lane=-1
    changed=last_selection_key is not None and (lane!=last_selection_key[0] or replay_folder!=last_selection_key[3])
    if changed: finger='auto'
    key=(lane,ms,finger,replay_folder)
    backwards=last_selection_key is not None and ms<last_selection_key[1]
    if not force and not changed and not backwards and (key==last_selection_key or absTime.seconds-last_selection_at<.08): return
    last_selection_key=key; last_selection_at=absTime.seconds
    selection=recording.sample_lane(lane,ms,finger=finger) if lane>=0 else None
    graph=op('xy_graph')
    if graph is not None: graph.cook(force=True)

def _pick(u,v):
    c=parent(); values=_runtime().values
    if not values: return
    hit=_replay().pick_ndc(u*2-1,v*2-1,c.par.Position.eval()*1000,
        values['uCameraPos'],values['uCameraRight'],values['uCameraUp'],values['uCameraForward'],
        values['uCameraInfo'][0],values['uCameraInfo'][1],c.par.Height.eval(),
        orbit=values['uOrbit'],tilt=values['uTilt'],radius_px=14,
        lane=int(c.par.Lane.eval()) if c.par.Isolate and c.par.Lane.eval()>=0 else None,
        near=values['uCameraInfo'][2],far=values['uCameraInfo'][3])
    if hit is not None: select_lane(hit['lane'],hit['finger'])

def _value(panel,name,default=0):
    try: return getattr(panel,name).val
    except AttributeError: return default

def poll_pointer():
    global pointer
    scene=op('VIEWPORT/scene')
    if scene is None: return
    p=scene.panel
    buttons=(bool(_value(p,'lselect')),bool(_value(p,'mselect')),bool(_value(p,'rselect')))
    u,v=float(_value(p,'u')),float(_value(p,'v'))
    if any(buttons):
        if pointer is None:
            pointer=dict(u=u,v=v,start=(u,v),buttons=buttons,moved=False)
            return
        du,dv=u-pointer['u'],v-pointer['v']
        displacement=math.hypot((u-pointer['start'][0])*parent().par.Width.eval(),
                                (v-pointer['start'][1])*parent().par.Height.eval())
        if displacement>4: pointer['moved']=True
        if pointer['moved'] and (du or dv):
            nav=_manual()
            if _value(p,'shift') or buttons[1]: nav.pan(du,dv,parent().par.Width.eval()/parent().par.Height.eval())
            elif buttons[2]: nav.dolly(dv*12)
            else: nav.orbit(du,dv)
            _sync()
        pointer['u']=u; pointer['v']=v
    elif pointer is not None:
        if not pointer['moved'] and pointer['buttons'][0]: _pick(*pointer['start'])
        pointer=None

def panel_event(panelValue):
    if panelValue.name in ('u','v','lselect','mselect','rselect'):
        poll_pointer()
    elif panelValue.name=='wheel' and float(panelValue.val)!=0:
        nav=_manual(); nav.dolly(float(panelValue.val)); _sync()
    elif panelValue.name=='key' and int(panelValue.val)!=0:
        key=int(panelValue.val)
        if key==32: action('Play')
        elif key in (102,70): action('Fit')
        elif key==27: action('Clearselection')

def seek(fraction):
    if op('io_runtime').module.poll()['locked']: return
    c=parent(); c.par.Position=max(0,min(1,float(fraction)))*_runtime().data()['layout']['durationMs']/1000
    update_selection(c.par.Position.eval()*1000,True)

def action(name):
    global approach
    c=parent()
    if name=='Play':
        if op('io_runtime').module.poll()['locked']: return
        if not c.par.Play and c.par.Position.eval()>=_runtime().data()['layout']['durationMs']/1000: c.par.Position=0
        c.par.Play=not c.par.Play.eval()
    elif name=='Restart': _runtime().pulse('Restart')
    elif name=='Director':
        if c.par.Director: _manual()
        else: c.par.Director=True
    elif name=='Fit':
        nav=_manual(); nav.reset(); _sync()
    elif name=='Approach':
        nav=_manual(); approach=(absTime.seconds,nav.controls())
    elif name=='Clearselection': select_lane(-1)
    elif name=='Soloselection': c.par.Isolate=not c.par.Isolate.eval()
    elif name=='Openviewer': op('WINDOW_CINEMATIC').par.winopen.pulse()

def ui(field,frame=None):
    c=parent(); selected=selection.get('selected') if selection else None
    if field=='playLabel': return 'DURAKLAT' if c.par.Play else 'OYNAT'
    if field=='directorLabel': return 'KAMERA: SİNEMA' if c.par.Director else 'KAMERA: SERBEST'
    if field=='soloLabel': return 'SOLO: AÇIK' if c.par.Isolate else 'SOLO: KAPALI'
    if field=='selectionLabel': return selection['participantId'] if selection else 'KOLTUK SEÇ'
    if field=='inspectorVisible': return c.par.Lane.eval()>=0
    if field=='helpLabel': return 'Sürükle: dön · Shift: kaydır · Tekerlek: yaklaş'
    if field=='progress': return c.par.Position.eval()/max(1,_runtime().data()['layout']['durationMs']/1000)
    if field=='timeLabel':
        seconds=int(c.par.Position.eval()); total=int(_runtime().data()['layout']['durationMs']/1000)
        return f'{seconds//60:02}:{seconds%60:02} / {total//60:02}:{total%60:02}'
    if field=='inspectorTitle': return 'SEÇİLİ KOLTUK\n'+(selection['participantId'] if selection else '—')
    if field=='inspectorText':
        if selected is None: return 'Bu anda kayıtlı X/Y yok.\n\nZaman çizgisinde ilerleyin.'
        point=selected
        motion=point['motion']
        status='Jest sürüyor' if point['active'] else 'Son kayıtlı konum'
        def fmt(v,d=3): return '—' if v is None else f'{v:.{d}f}'
        speed=fmt(motion.get('speed')) if motion.get('valid') else '—'
        turn=fmt(motion.get('turnDegrees'),1) if motion.get('valid') else '—'
        return (f'{status}\n\nX              {fmt(point["x"])}\nY              {fmt(point["y"])}\n'
            f'Zaman       {point["t"]/1000:.2f} s\nParmak      {point["finger"] if point["finger"] is not None else "—"}\n\n'
            f'Hız                 {speed} birim/s\nYön değişimi    {turn} °/s\n\nKayıtlı X/Y · en fazla 64 iz noktası')
    return ''

def close():
    global replay
    if replay is not None: replay.close(); replay=None
