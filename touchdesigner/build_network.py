"""Build native editable 2000 TRACES operators inside TouchDesigner 2023.

Execute from Textport (or the temporary local build helper). The .toe/.tox
contains all shader and runtime DAT text; only the documented data directory
is external. Existing unrelated networks are never deleted.
"""
from pathlib import Path
import json
import re

# Textport callers supply TRACES_SOURCE_DIR; Python file execution uses __file__.
ROOT = Path(TRACES_SOURCE_DIR) if 'TRACES_SOURCE_DIR' in globals() else Path(__file__).resolve().parent
ASSETS = Path(TRACES_ASSET_DIR) if 'TRACES_ASSET_DIR' in globals() else ROOT / 'assets' / 'kayit-2026-09-05T16-56-19-183Z'
layout = json.loads((ASSETS / 'layout.json').read_text())
base = op('/traces_native')
if base is None:
    base = op('/').create(baseCOMP, 'traces_native')
else:
    if not base.fetch('tracesGenerated', False) and any(not c.name.startswith('probe_') for c in base.children):
        raise RuntimeError('Existing traces_native contains unrelated work.')
    old_io = base.op('io_runtime')
    if old_io is not None:
        if old_io.module.client is not None and old_io.module.client.snapshot()['potentialOutput']:
            raise RuntimeError('Stop UDP and confirm output is off before rebuilding.')
        old_io.module.close()
    for child in list(base.children):
        if child.valid: child.destroy()
    for page in list(base.customPages):
        page.destroy()
base.store('tracesGenerated', True)
base.allowCooking = False

def parameter(page, kind, name, label, default, minimum=None, maximum=None):
    p = getattr(page, 'append' + kind)(name, label=label)[0]
    p.default = default
    p.val = default
    if minimum is not None:
        p.min = minimum; p.normMin = minimum; p.clampMin = True
    if maximum is not None:
        p.max = maximum; p.normMax = maximum; p.clampMax = True
    return p

page = base.appendCustomPage('Playback')
parameter(page, 'Toggle', 'Play', 'Play recording', False)
parameter(page, 'Float', 'Position', 'Position · seconds', layout['durationMs']/1000, 0, layout['durationMs']/1000)
parameter(page, 'Float', 'Speed', 'Playback speed', 1, 0.25, 4)
parameter(page, 'Toggle', 'Loop', 'Loop recording', True)
page.appendPulse('Restart', label='Replay from start')
parameter(page, 'Int', 'Lane', 'Isolate participant · -1 = all', -1, -1, layout['laneCount']-1)
page = base.appendCustomPage('Camera')
parameter(page, 'Float', 'Distance', 'Camera distance', 3.15, 0.78, 7)
parameter(page, 'Float', 'Azimuth', 'Camera azimuth', 0, -180, 180)
parameter(page, 'Float', 'Elevation', 'Camera elevation', 0, -85, 85)
parameter(page, 'Float', 'Fov', 'Vertical field of view', 45, 20, 80)
page.appendPulse('Approach', label='Cinematic approach · 12 seconds')
page.appendPulse('Fit', label='Reset camera')
page = base.appendCustomPage('Image')
parameter(page, 'Int', 'Width', 'Output width · current NC key', 1280, 256, 1280)
parameter(page, 'Int', 'Height', 'Output height · current NC key', 720, 256, 1280)
parameter(page, 'Float', 'Orbit', 'Artwork orbit', 0, -180, 180)
parameter(page, 'Float', 'Tilt', 'Artwork tilt', 0, -80, 80)
parameter(page, 'Toggle', 'Animate', 'Animate plasma when paused', True)
page = base.appendCustomPage('Data')
parameter(page, 'Folder', 'Assets', 'Recorded data directory', str(ASSETS))
parameter(page, 'Str', 'Session', 'Source session', layout['source']['sessionId']).readOnly=True
parameter(page, 'Int', 'Events', 'Recorded events', layout['eventCount']).readOnly=True
parameter(page, 'Int', 'Participants', 'Participants', layout['laneCount']).readOnly=True
parameter(page, 'Int', 'Eventindex', 'Inspect original event index', 0, 0, layout['eventCount']-1)

page = base.appendCustomPage('UDP')
parameter(page, 'Str', 'Udpstatus', 'Replay status', 'OFF · UDP çıkışı kapalı').readOnly=True
page.appendPulse('Prepareudp', label='Prepare · load silently')
page.appendPulse('Playudp', label='Play · send UDP')
page.appendPulse('Pauseudp', label='Pause UDP')
page.appendPulse('Stopudp', label='Stop UDP / confirm off')

def text_dat(name, text, x, y):
    node=base.create(textDAT,name); node.text=text; node.nodeX=x; node.nodeY=y
    return node

runtime=text_dat('runtime', (ROOT/'runtime.py').read_text(), -800, 300)
text_dat('replay_client', (ROOT/'replay_client.py').read_text(), -1020, 180)
text_dat('io_runtime', (ROOT/'io_runtime.py').read_text(), -1020, 300)
texture_callbacks=text_dat('texture_loader', '''import numpy as np
from pathlib import Path
cache = {}
def onCook(scriptOp):
    spec = scriptOp.fetch('spec')
    folder = Path(parent().par.Assets.eval()).expanduser()
    if not folder.is_absolute(): folder = Path(project.folder) / folder
    filename = str(folder / spec['file'])
    shape = (spec['height'], spec['width'], 4)
    key = (filename, shape)
    if key not in cache:
        data = np.fromfile(filename, dtype='<f4')
        if data.size != shape[0]*shape[1]*4:
            raise ValueError('Truncated data texture: '+filename)
        cache[key] = np.ascontiguousarray(data.reshape(shape))
    scriptOp.copyNumpyArray(cache[key])
''', -800, 120)
clock=base.create(executeDAT,'clock'); clock.text='def onFrameStart(frame):\n    op("runtime").module.update()\n    return\n'; clock.par.framestart=True
clock.text+='\ndef onExit():\n    op("io_runtime").module.close()\n'
clock.par.exit=True
clock.nodeX=-800; clock.nodeY=440
callbacks=base.create(parameterexecuteDAT,'controls_callbacks')
callbacks.par.op='..'; callbacks.par.pars='Restart Fit Approach Eventindex Prepareudp Playudp Pauseudp Stopudp'; callbacks.par.onpulse=True
callbacks.text='def onPulse(par):\n    op("io_runtime" if par.name.endswith("udp") else "runtime").module.pulse(par.name)\n    return\ndef onValueChange(par, prev):\n    if par.name == "Eventindex":\n        rows = op("runtime").module.inspect(int(par.eval()))\n        table = op("SOURCE_EVENT")\n        table.clear(); table.appendRow(["field", "recorded value"])\n        for key, value in rows.items(): table.appendRow([key, value])\n    return\n'
callbacks.nodeX=-800; callbacks.nodeY=580

camera=base.create(cameraCOMP,'camera'); camera.nodeX=-420; camera.nodeY=600
camera.par.viewanglemethod='vertfov'; camera.par.fov.expr='parent().par.Fov'; camera.par.near=.008; camera.par.far=80
camera.par.tx.expr='parent().par.Distance * math.sin(math.radians(parent().par.Azimuth)) * math.cos(math.radians(parent().par.Elevation))'
camera.par.ty.expr='parent().par.Distance * math.sin(math.radians(parent().par.Elevation))'
camera.par.tz.expr='parent().par.Distance * math.cos(math.radians(parent().par.Azimuth)) * math.cos(math.radians(parent().par.Elevation))'
focus=base.create(geometryCOMP,'camera_target'); focus.par.render=False; focus.nodeX=-600; focus.nodeY=600
camera.par.lookat=focus
depth_camera=base.copy(camera,name='depth_camera'); depth_camera.nodeY=740
for c in 'rgba': getattr(depth_camera.par,'bgcolor'+c).val=1

textures={}
for group_index,(group_name,group) in enumerate(layout['groups'].items()):
    if group_name=='timeline': continue
    for attr_index,(attr,spec) in enumerate(group['attributes'].items()):
        node=base.create(scriptTOP,group_name+'_'+attr)
        node.par.callbacks=texture_callbacks
        node.par.format='rgba32float'; node.par.resolutionw=group['width']; node.par.resolutionh=group['height']
        node.par.filtertype='nearest'; node.par.inputfiltertype='nearest'
        node.store('spec',dict(file=spec['file'],width=group['width'],height=group['height']))
        node.nodeX=-550+attr_index*160; node.nodeY=-group_index*230
        textures[(group_name,attr)]=node

def uniforms(node, source, extras=None):
    names=[]
    for match in re.finditer(r'uniform\s+(?:float|vec[234])\s+([^;]+);',source):
        names.extend(n.strip() for n in match.group(1).split(','))
    names=list(dict.fromkeys(names))
    node.seq.vec.numBlocks=max(1,len(names))
    for i,name in enumerate(names):
        getattr(node.par,f'vec{i}name').val=name
        value=(extras or {}).get(name)
        for k,c in enumerate('xyzw'):
            p=getattr(node.par,f'vec{i}value{c}')
            if value is not None:
                p.val=(value[k] if isinstance(value,(tuple,list)) else value if k==0 else 0)
            else:
                p.expr=f'op("runtime").module.uniform("{name}", {k}, absTime.frame)'

draws=[]; depths=[]
contract=json.loads((ROOT/'shaders/contract.json').read_text())
attr_names={'sPositions':'position','sData':'data','sSizes':'size','sMotion':'motion','sStarts':'start','sEnds':'end','sColors':'color'}
for index,(kind,group_name) in enumerate([('atmosphere','halos'),('filament','filaments'),('dust','dust'),('stars','stars'),('clouds','clouds')]):
    group=layout['groups'][group_name]
    vertex=(ROOT/'shaders'/f'{kind}.vert').read_text(); fragment=(ROOT/'shaders'/f'{kind}.frag').read_text()
    vd=text_dat(kind+'_vertex',vertex,550,-index*250+55)
    pd=text_dat(kind+'_fragment',fragment,730,-index*250+55)
    for depth in [False,True] if kind in ['filament','dust','stars'] else [False]:
        suffix='_depth' if depth else ''
        mat=base.create(glslMAT,kind+'_material'+suffix)
        mat.par.vdat=vd; mat.par.pdat=pd; mat.par.glslversion='glsl430'
        mat.par.blending=not depth; mat.par.srcblend='sa'; mat.par.destblend='one'; mat.par.postmultalpha=False
        mat.par.depthwriting=depth; mat.par.depthtest=True; mat.par.cullface='neither'
        bindings=contract['mats'][kind]['samplers']; mat.seq.sampler.numBlocks=len(bindings)
        for s,name in enumerate(bindings):
            getattr(mat.par,f'sampler{s}name').val=name
            getattr(mat.par,f'sampler{s}top').val=textures[(group_name,attr_names[name])]
            getattr(mat.par,f'sampler{s}filter').val='nearest'
        uniforms(mat,vertex+'\n'+fragment,{'uCount':group['count'],'uDepthPass':1 if depth else 0})
        geo=base.create(geometryCOMP,kind+suffix)
        for child in list(geo.children):child.destroy()
        quad=geo.create(rectangleSOP,'sprite'); quad.par.sizex=1; quad.par.sizey=1; quad.render=True; quad.display=True
        geo.par.instancing=True; geo.par.instancecountmode='manual'; geo.par.numinstances=group['count']; geo.par.material=mat
        geo.nodeX=1150+(210 if depth else 0); geo.nodeY=-index*250
        mat.nodeX=930+(210 if depth else 0); mat.nodeY=-index*250+90
        (depths if depth else draws).append(geo)

def resolution(node, half=False):
    node.par.outputresolution='custom'
    divisor=2 if half else 1
    node.par.resolutionw.expr=f'max(1, int(parent().par.Width / {divisor}))'
    node.par.resolutionh.expr=f'max(1, int(parent().par.Height / {divisor}))'

for name,geos,cam in [('field',draws,camera),('field_depth',depths,depth_camera)]:
    node=base.create(renderTOP,name); node.par.camera=cam
    node.par.geometry=' '.join(g.name for g in geos); node.par.antialias='aa1'; node.par.format='rgba32float'
    node.par.dither=False; resolution(node); node.nodeX=1610; node.nodeY=0 if name=='field' else -200

def glsl_top(name, filename, inputs=(), half=False, extra=None):
    source=(ROOT/'shaders'/filename).read_text()
    dat=text_dat(name+'_shader',source,1810,-len(base.children)*12)
    node=base.create(glslTOP,name); node.par.pixeldat=dat; node.par.glslversion='glsl430'; node.par.format='rgba32float'
    for i,item in enumerate(inputs[:3]):node.inputConnectors[i].connect(item)
    if len(inputs)>3: node.par.tops=' '.join(item.name for item in inputs[3:])
    resolution(node,half); uniforms(node,source,extra)
    return node

core=glsl_top('black_hole','core.frag'); core.par.numcolorbufs=2; core.nodeX=1620; core.nodeY=-500
core_depth=base.create(renderselectTOP,'black_hole_depth'); core_depth.par.top=core; core_depth.par.index=1; core_depth.par.format='rgba32float'
core_depth.nodeX=1840; core_depth.nodeY=-500
composite=glsl_top('gravitational_lens','composite.frag',[base.op('field'),base.op('field_depth'),core,core_depth]); composite.nodeX=2070; composite.nodeY=0
glow=glsl_top('glow_extract','bloom-extract.frag',[composite],True); glow.nodeX=2270; glow.nodeY=-180
for i,spread in enumerate([1.,2.4]):
    for axis in ['x','y']:
        name=f'glow_{i}_{axis}'
        node=glsl_top(name,'bloom-blur.frag',[glow],True,{'uBlurStep':(0,0,0,0)})
        p=node.par.vec0valuex if axis=='x' else node.par.vec0valuey
        p.expr=f'{spread} / max(1, parent().par.{"Width" if axis=="x" else "Height"} / 2)'
        node.nodeX=2470+(i*2+(axis=='y'))*185; node.nodeY=-180
        glow=node
finish=glsl_top('display_transform','finish.frag',[composite,glow]); finish.nodeX=3310; finish.nodeY=0
out=base.create(nullTOP,'OUT_NEBULA'); out.inputConnectors[0].connect(finish); out.nodeX=3530; out.nodeY=0
out.viewer=True; base.par.opviewer=out; base.viewer=True
inspector=base.create(tableDAT,'SOURCE_EVENT'); inspector.nodeX=-600; inspector.nodeY=850
inspector.appendRow(['field','recorded value'])
for key,value in runtime.module.inspect(0).items():inspector.appendRow([key,value])

# Remove unused editor templates generated by MAT/TOP constructors, retaining
# the real shader DATs and compile reports. This leaves a readable native graph.
used_dats={runtime.path,texture_callbacks.path,clock.path,callbacks.path}
for node in base.children:
    for name in ['vdat','pdat','pixeldat','vertexdat','callbacks']:
        p=getattr(node.par,name,None)
        if p is not None and p.eval() is not None: used_dats.add(p.eval().path)
for node in list(base.children):
    if node.valid and node.isDAT and node.path not in used_dats and node.name.endswith(('_pixel','_compute','_callbacks','_vertex')):
        node.destroy()
for node in base.children:
    if node.isTOP: node.color=(0.16,0.28,0.42)
    if node.isMAT: node.color=(0.34,0.19,0.12)
    if node.isDAT: node.color=(0.22,0.24,0.28)
core.color=(0.60,0.30,0.08);out.color=(0.12,0.46,0.35)

text_dat('README', '2000 TRACES / NATIVE TOUCHDESIGNER\n\nPlayback and camera: select this COMP and open Custom Parameters.\nOUT_NEBULA is the final linear-render / display-encoded output.\nEditable stages: data textures → instanced geometry → field/depth → curved core → lens → bloom → display.\nAll event coordinates and original indices are preserved in the data directory.\nNo browser, screenshot or video input.\nUDP page: Prepare loads silently; Play sends through the existing recorder. Stop and confirm OFF before closing.\n',-820,800)
base.allowCooking=True
runtime.module.update()
out.cook(force=True)
result={'path':base.path,'nodes':len(base.children),'errors':base.errors(recurse=True)}
