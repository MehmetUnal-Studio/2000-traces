"""Developer QA, executed inside TouchDesigner; never starts UDP.

Samples rendered wall-frame intervals, not fixed project FPS or GPU timers.
Saves native screenshots and finite HDR/depth checks to an explicit QA folder.
Remove qa_validation before saving a delivery project.
"""
from pathlib import Path
qa_folder = Path(TRACES_QA_DIR) if 'TRACES_QA_DIR' in globals() else Path(project.folder) / 'output' / 'cinematic-qa'
qa_folder = qa_folder.expanduser().resolve()
base=op('/traces_cinematic')
if base is None: raise RuntimeError('Build the cinematic network first')
client=base.op('io_runtime').module.client
if client is not None and client.snapshot()['potentialOutput']:
    raise RuntimeError('Native render QA requires UDP output to be off')
if base.op('qa_validation') is not None: base.op('qa_validation').destroy()
qa=base.create(executeDAT,'qa_validation')
qa.text='''import time,json,math
from pathlib import Path
import numpy as np
folder=Path(__TRACES_QA_DIRECTORY__)
folder.mkdir(parents=True,exist_ok=True)
poses=[('overview',180,False,3.35,-18,6),('inclined',180,False,2.45,32,18),('approach',97.2,True,0,0,0),('near_orbit',129.6,True,0,0,0)]
index=0
samples=[]
previous=None
settle=0
results=[]
setup=True
begin_cooks=0

def onFrameStart(frame):
    global setup,settle,previous,begin_cooks
    if not setup: return
    c=parent(); name,position,director,distance,azimuth,elevation=poses[index]
    c.par.Play=False; c.par.Animate=True; c.par.Director=False
    op('runtime').module.update()
    c.par.Position=position; c.par.Director=director
    if not director: c.par.Distance=distance; c.par.Azimuth=azimuth; c.par.Elevation=elevation
    op('runtime').module.update()
    settle=time.perf_counter()+1.5; previous=None; setup=False
    begin_cooks=op('OUT_CINEMATIC').totalCooks

def onFrameEnd(frame):
    global index,samples,previous,setup
    out=op('OUT_CINEMATIC'); out.cook()
    now=time.perf_counter()
    if previous is not None and now>settle: samples.append((now-previous)*1000)
    previous=now
    if len(samples)<180: return
    c=parent(); rows=sorted(samples); name=poses[index][0]
    stats={}
    for node_name in ['starlight_layers','foreground','plasma_volume','plasma_depth','OUT_CINEMATIC']:
        node=op(node_name); pixels=node.numpyArray(delayed=False)
        stats[node_name]=dict(finite=bool(np.isfinite(pixels).all()),minimum=float(pixels.min()),maximum=float(pixels.max()))
    out.save(str(folder/(name+'.png')))
    results.append(dict(pose=name,sourceSeconds=c.par.Position.eval(),frames=len(rows),actualOutputCooks=out.totalCooks-begin_cooks,
        fps=1000*len(rows)/sum(rows),meanMs=sum(rows)/len(rows),p50Ms=rows[len(rows)//2],p95Ms=rows[int(len(rows)*.95)],
        output=[out.width,out.height],core=[op('plasma_volume').width,op('plasma_volume').height],buffers=stats,errors=c.errors(recurse=True)))
    index+=1; samples=[]; previous=None
    if index>=len(poses):
        event=op('runtime').module.inspect(1073690)
        (folder/'native-validation.json').write_text(json.dumps(dict(poses=results,sourceEvent=event,udpClientAbsent=op('io_runtime').module.client is None),indent=2))
        me.par.active=False
    else: setup=True
'''
qa.text = qa.text.replace('__TRACES_QA_DIRECTORY__', repr(str(qa_folder)))
qa.par.framestart=True;qa.par.frameend=True
result='Native visual/performance validation started: four views, 180 samples each.'
