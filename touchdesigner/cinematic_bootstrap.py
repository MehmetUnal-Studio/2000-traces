"""Temporary local helper for native cinematic development; removed on delivery."""
from pathlib import Path
from datetime import datetime
import json
ROOT=Path(TRACES_SOURCE_DIR)
folder=ROOT/'.build'
folder.mkdir(exist_ok=True);folder.chmod(0o700)
if op('/traces_import_tools'):raise RuntimeError('A build helper already exists')
stamp=datetime.now().strftime('%Y%m%d-%H%M%S')
# Keep relative recording paths valid while saving the exact current project.
project.save(str(Path(project.folder)/('Before Cinematic '+stamp+'.toe')),saveExternalToxs=False)
helper=op('/').create(baseCOMP,'traces_import_tools')
callback=helper.create(executeDAT,'local_build')
callback.text=(ROOT/'bootstrap.py').read_text().split("callback.text = '''",1)[1].split("'''",1)[0].replace('__BUILD_DIRECTORY__',repr(str(folder)))
callback.par.frameend=True
print('Cinematic build helper ready; original project backed up.')
