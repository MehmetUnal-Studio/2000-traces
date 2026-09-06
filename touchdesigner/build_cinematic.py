"""Build native cinematic 2000 TRACES operators inside TouchDesigner 2023.

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
base = op('/traces_cinematic')
if base is None:
    base = op('/').create(baseCOMP, 'traces_cinematic')
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
parameter(page, 'Float', 'Distance', 'Camera distance', 2.45, 0.96, 7)
parameter(page, 'Float', 'Azimuth', 'Camera azimuth', 32, -180, 180)
parameter(page, 'Float', 'Elevation', 'Camera elevation', 18, -85, 85)
parameter(page, 'Float', 'Fov', 'Vertical field of view', 45, 20, 80)
parameter(page, 'Toggle', 'Director', 'Follow recorded 3 minute camera path', False)
page.appendPulse('Startshow', label='Start cinematic recording playback')
page.appendPulse('Approach', label='Approach the horizon · 16 seconds')
page.appendPulse('Fit', label='Reset camera')
page = base.appendCustomPage('Image')
parameter(page, 'Int', 'Width', 'Output width · current NC key', 1280, 256, 1280)
parameter(page, 'Int', 'Height', 'Output height · current NC key', 720, 256, 1280)
parameter(page, 'Float', 'Orbit', 'Artwork orbit', 0, -180, 180)
parameter(page, 'Float', 'Tilt', 'Artwork tilt', 0, -80, 80)
parameter(page, 'Toggle', 'Animate', 'Animate plasma when paused', True)
page = base.appendCustomPage('Plasma')
for name,label,value,lo,hi in [
 ('Plasma','Plasma radiance',1.45,0,3),('Density','Optical density',1,0,2),('Detail','Turbulent detail',1,0,1.5),
 ('Thickness','Disk thickness',1,0.5,1.8),('Lensing','Gravitational curvature',1,0,1.2),
 ('Beaming','Doppler asymmetry',.8,0,1.2),('Temperature','Gas temperature',1,0.7,1.2),('Corona','Diffuse corona',.5,0,1.2)]:
    parameter(page,'Float',name,label,value,lo,hi)
page = base.appendCustomPage('Starlight')
for name,label,value,lo,hi in [('Dust','Recorded point light',.7,0,2),('Gas','Recorded gas light',.55,0,2),('Traces','Recorded filaments',.18,0,1),('Stars','Distant stars',1.1,0,3),('Aperture','Foreground defocus',.08,0,1)]:
    parameter(page,'Float',name,label,value,lo,hi)
parameter(page,'Float','Skygas','Distant galactic dust',.10,0,1)
parameter(page,'Float','Skystars','Distant starfield',.6,0,2)
page = base.appendCustomPage('Optics')
for name,label,value,lo,hi in [('Exposure','Exposure · stops',0,-3,3),('Saturation','Color saturation',.9,0,1.5),('Bloom','Optical bloom',.24,0,1),('Glare','Anamorphic scattering',.06,0,.5),('Grain','Film grain',.12,0,1),('Vignette','Lens falloff',.15,0,1),('Corescale','Plasma render scale',.625,.5,1)]:
    parameter(page,'Float',name,label,value,lo,hi)
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

runtime=text_dat('runtime', (ROOT/'cinematic/runtime.py').read_text(), -800, 300)
text_dat('director_path', (ROOT/'cinematic/camera.py').read_text(), -1020, 460)
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
callbacks=base.create(parameterexecuteDAT,'controls_callbacks')
callbacks.par.op='..'; callbacks.par.pars='Restart Startshow Fit Approach Eventindex Prepareudp Playudp Pauseudp Stopudp'; callbacks.par.onpulse=True
callbacks.text='def onPulse(par):\n    op("io_runtime" if par.name.endswith("udp") else "runtime").module.pulse(par.name)\n    return\ndef onValueChange(par, prev):\n    if par.name == "Eventindex":\n        rows = op("runtime").module.inspect(int(par.eval()))\n        table = op("SOURCE_EVENT")\n        table.clear(); table.appendRow(["field", "recorded value"])\n        for key, value in rows.items(): table.appendRow([key, value])\n    return\n'
callbacks.nodeX=-800; callbacks.nodeY=580

camera=base.create(cameraCOMP,'camera'); camera.nodeX=-420; camera.nodeY=600
camera.par.viewanglemethod='vertfov'; camera.par.fov.expr='parent().par.Fov'; camera.par.near=.008; camera.par.far=80
camera.par.tz=2.7
for channel in 'rgba': getattr(camera.par,'bgcolor'+channel).val=0
focus=base.create(geometryCOMP,'camera_target'); focus.par.render=False; focus.nodeX=-600; focus.nodeY=600
camera.par.lookat=focus

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

def resolution(node, scale=1):
    node.par.outputresolution='custom'
    factor='parent().par.Corescale' if scale=='core' else str(scale)
    node.par.resolutionw.expr=f'max(1, int(parent().par.Width * {factor}))'
    node.par.resolutionh.expr=f'max(1, int(parent().par.Height * {factor}))'

def glsl_top(name, filename, inputs=(), scale=1):
    source=(ROOT/'cinematic'/filename).read_text()
    dat=text_dat(name+'_shader',source,1760,-len(base.children)*12)
    node=base.create(glslTOP,name); node.par.pixeldat=dat; node.par.glslversion='glsl430'; node.par.format='rgba16float'
    for i,item in enumerate(inputs[:3]): node.inputConnectors[i].connect(item)
    if len(inputs)>3: node.par.tops=' '.join(item.name for item in inputs[3:])
    resolution(node,scale); uniforms(node,source)
    return node

core=glsl_top('plasma_volume','core.frag',scale='core'); core.par.numcolorbufs=2; core.par.format='rgba32float'; core.nodeX=1420; core.nodeY=440
for i in range(core.seq.vec.numBlocks):
    if getattr(core.par,f'vec{i}name').eval()=='uViewport':
        for k,axis in enumerate(['Width','Height']):
            getattr(core.par,f'vec{i}value'+ 'xy'[k]).expr=f'max(1,int(parent().par.{axis}*parent().par.Corescale))'
            getattr(core.par,f'vec{i}value'+ 'zw'[k]).expr=f'1/max(1,int(parent().par.{axis}*parent().par.Corescale))'
core_depth=base.create(renderselectTOP,'plasma_depth'); core_depth.par.top=core; core_depth.par.index=1; core_depth.par.format='rgba32float'
core_depth.nodeX=1620; core_depth.nodeY=440
# Depth is sampled in normalized UV; its camera matches the full-resolution field.
draws=[]
contract=json.loads((ROOT/'shaders/contract.json').read_text())
attr_names={'sPositions':'position','sData':'data','sSizes':'size','sMotion':'motion','sStarts':'start','sEnds':'end','sColors':'color'}
for index,(kind,group_name) in enumerate([('atmosphere','halos'),('filament','filaments'),('dust','dust'),('stars','stars'),('clouds','clouds')]):
    group=layout['groups'][group_name]
    vertex=(ROOT/'cinematic/field'/f'{kind}.vert').read_text(); fragment=(ROOT/'cinematic/field'/f'{kind}.frag').read_text()
    vd=text_dat(kind+'_vertex',vertex,550,-index*250+55); pd=text_dat(kind+'_fragment',fragment,730,-index*250+55)
    mat=base.create(glslMAT,kind+'_material')
    mat.par.vdat=vd; mat.par.pdat=pd; mat.par.glslversion='glsl430'
    mat.par.blending=True; mat.par.srcblend='sa'; mat.par.destblend='one'; mat.par.postmultalpha=False
    mat.par.depthwriting=False; mat.par.depthtest=False; mat.par.cullface='neither'
    bindings=list(contract['mats'][kind]['samplers'])+['sCoreDepth']; mat.seq.sampler.numBlocks=len(bindings)
    for s,name in enumerate(bindings):
        getattr(mat.par,f'sampler{s}name').val=name
        getattr(mat.par,f'sampler{s}top').val=core_depth if name=='sCoreDepth' else textures[(group_name,attr_names[name])]
        getattr(mat.par,f'sampler{s}filter').val='nearest'
    uniforms(mat,vertex+'\n'+fragment,{'uCount':group['count'],'uDepthPass':0})
    geo=base.create(geometryCOMP,kind)
    for child in list(geo.children): child.destroy()
    quad=geo.create(rectangleSOP,'sprite'); quad.par.sizex=1; quad.par.sizey=1; quad.render=True; quad.display=True
    geo.par.drawpriority=index  # Stable additive accumulation across .tox relocation.
    geo.par.instancing=True; geo.par.instancecountmode='manual'; geo.par.numinstances=group['count']; geo.par.material=mat
    geo.nodeX=1150; geo.nodeY=-index*250; mat.nodeX=930; mat.nodeY=-index*250+90
    draws.append(geo)
field=base.create(renderTOP,'starlight_layers'); field.par.camera=camera; field.par.geometry=' '.join(g.name for g in draws)
field.par.antialias='aa1'; field.par.format='rgba16float'; field.par.numcolorbufs=2; field.par.allowbufblending=True
field.par.dither=False; resolution(field); field.nodeX=1620; field.nodeY=0
foreground=base.create(renderselectTOP,'foreground'); foreground.par.top=field; foreground.par.index=1
foreground.nodeX=1830; foreground.nodeY=-180
environment=glsl_top('galactic_environment','environment.frag'); environment.nodeX=1830; environment.nodeY=640
composite=glsl_top('gravitational_lens','composite.frag',[field,foreground,core,environment]); composite.nodeX=2070; composite.nodeY=0
bloom=base.create(bloomTOP,'optical_bloom'); bloom.inputConnectors[0].connect(composite)
bloom.par.format='rgba16float'; bloom.par.output='bloom'; bloom.par.preblacklevel=.75; bloom.par.bloomthreshold=.12
bloom.par.minbloomradius=.08; bloom.par.maxbloomradius=.55; bloom.par.bloomintensity=.8
bloom.nodeX=2300; bloom.nodeY=-170
scattering=base.create(blurTOP,'anamorphic_scattering'); scattering.inputConnectors[0].connect(bloom)
scattering.par.method='horz'; scattering.par.type='gaussian'; scattering.par.size=65; scattering.par.preshrink=2
scattering.par.format='rgba16float'; scattering.nodeX=2520; scattering.nodeY=-340
finish=glsl_top('film_grade','finish.frag',[composite,bloom,scattering]); finish.nodeX=2780; finish.nodeY=0
antialias=base.create(antialiasTOP,'subpixel_antialias'); antialias.inputConnectors[0].connect(finish); antialias.par.quality='high'; antialias.nodeX=2970; antialias.nodeY=0
out=base.create(nullTOP,'OUT_CINEMATIC'); out.inputConnectors[0].connect(antialias); out.nodeX=3180; out.nodeY=0
out.viewer=True; base.par.opviewer=out; base.viewer=True
inspector=base.create(tableDAT,'SOURCE_EVENT'); inspector.nodeX=-600; inspector.nodeY=850
inspector.appendRow(['field','recorded value'])
for key,value in runtime.module.inspect(0).items():inspector.appendRow([key,value])

clock=base.create(executeDAT,'clock'); clock.text='def onFrameStart(frame):\n    op("runtime").module.update()\n    return\n'; clock.par.framestart=True
clock.text+='\ndef onExit():\n    op("io_runtime").module.close()\n'
clock.par.exit=True
clock.nodeX=-800; clock.nodeY=440

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

text_dat('README', '2000 TRACES / CINEMATIC TOUCHDESIGNER\n\nPlayback and camera: select this COMP and open Custom Parameters.\nOUT_CINEMATIC is the final linear-render / display-encoded output.\nEditable stages: recorded textures → native instanced HDR layers + curved plasma volume → background lensing → native Bloom / Blur TOP → film grade → native SMAA.\nCamera page: Start cinematic recording playback = 3 minute camera choreography. All controls and shaders remain editable.\nAll event coordinates and original indices are preserved in the data directory.\nNo browser, screenshot or video input.\nUDP page: Prepare loads silently; Play sends through the existing recorder. Stop and confirm OFF before closing.\n',-820,800)
base.allowCooking=True
runtime.module.update()
out.cook(force=True)
result={'path':base.path,'nodes':len(base.children),'errors':base.errors(recurse=True)}
