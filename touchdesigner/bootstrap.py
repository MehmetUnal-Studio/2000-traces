"""Temporary local build helper, invoked from TouchDesigner's Python Textport.

Only polls a private local directory. Remove the helper COMP after the build;
the saved artwork is self-contained and does not need this automation helper.
"""
from pathlib import Path
import json

ROOT = Path(TRACES_SOURCE_DIR) if 'TRACES_SOURCE_DIR' in globals() else Path(__file__).resolve().parent
folder = ROOT / '.build'
folder.mkdir(exist_ok=True)
folder.chmod(0o700)
if op('/traces_import_tools'):
    raise RuntimeError('A build helper already exists; inspect before replacing it.')

(ROOT / 'backups').mkdir(exist_ok=True)
project.save(str(ROOT / 'backups' / 'before-native-import.toe'))
helper = op('/').create(baseCOMP, 'traces_import_tools')
helper.nodeX = -700
helper.nodeY = -400
callback = helper.create(executeDAT, 'local_build')
callback.text = '''from pathlib import Path
import json, traceback
folder = Path(__BUILD_DIRECTORY__)
pending = folder / 'request.json'
last = json.loads(pending.read_text()).get('id') if pending.exists() else None
def onFrameEnd(frame):
    global last
    path = folder / 'request.json'
    if not path.exists(): return
    request = json.loads(path.read_text())
    if request['id'] == last: return
    last = request['id']
    scope = dict(globals())
    try:
        exec(compile(request['code'], '<native-traces-build>', 'exec'), scope)
        response = dict(id=last, ok=True, result=scope.get('result'))
    except Exception:
        response = dict(id=last, ok=False, error=traceback.format_exc())
    (folder / 'response.json').write_text(json.dumps(response, default=str))
    return
'''
callback.text = callback.text.replace('__BUILD_DIRECTORY__', repr(str(folder)))
callback.par.frameend = True
(folder / 'bootstrap.json').write_text(json.dumps({
    'name': project.name, 'folder': project.folder, 'version': app.version,
    'roots': [(child.path, child.type) for child in op('/').children]
}, default=str))
print('2000 TRACES native import helper ready; original project backed up.')
