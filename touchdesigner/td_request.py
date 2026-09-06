"""Developer-only file transport for the temporary native build helper."""
from pathlib import Path
import json
import sys
import time
import uuid

folder = Path(__file__).resolve().parent / '.build'
request = dict(id=str(uuid.uuid4()), code=sys.stdin.read())
temporary = folder / 'request.tmp'
temporary.write_text(json.dumps(request))
temporary.replace(folder / 'request.json')
deadline = time.monotonic() + 35
while time.monotonic() < deadline:
    try:
        response = json.loads((folder / 'response.json').read_text())
        if response['id'] == request['id']:
            print(json.dumps(response, indent=2))
            sys.exit(0 if response['ok'] else 1)
    except (FileNotFoundError, json.JSONDecodeError):
        pass
    time.sleep(0.05)
raise SystemExit('TouchDesigner build helper did not answer in 35 seconds.')
