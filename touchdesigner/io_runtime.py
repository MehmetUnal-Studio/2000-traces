"""Embedded main-thread UI adapter; the recorder remains the UDP clock owner."""
client = None
message = ''
following = False


def pulse(name):
    global client, message, following
    c = parent()
    try:
        message = ''
        if name == 'Prepareudp':
            if client is None or client.snapshot()['closed']:
                client = op('replay_client').module.NativeReplayClient()
            layout = op('runtime').module.data()['layout']
            client.prepare(layout['source']['sessionId'], layout['durationMs'])
            c.par.Play = False
        elif client is None:
            if name != 'Stopudp':
                message = 'Önce Prepare ile kaydı hazırlayın.'
        elif name == 'Playudp':
            client.play(positionMs=c.par.Position.eval()*1000, speed=c.par.Speed.eval())
            c.par.Play = False
            following = True
        elif name == 'Pauseudp':
            client.pause()
        elif name == 'Stopudp':
            client.stop()
    except Exception as error:
        message = str(error)
    poll()


def poll():
    """Snapshot-only: never performs HTTP or calls TD from a worker thread."""
    global following
    c = parent()
    if client is None:
        text = message or 'OFF · Görsel oynatma / UDP kapalı'
        state = dict(locked=False, playing=False, positionMs=None)
    else:
        snap = client.snapshot()
        locked = snap['enabled'] or snap['busy'] or snap['potentialOutput']
        position = None
        if following:
            position = snap['positionMs']
            if not snap['busy'] and not snap['potentialOutput'] and snap['state'] != 'PLAYING':
                following = False
        if snap['playing']:
            following = True
            position = snap['positionMs']
        if snap['error']:
            text = snap['error'] + (' · STOP ile çıkışı doğrulayın' if snap['potentialOutput'] else '')
        elif message:
            text = message
        elif snap['busy']:
            text = 'İşlem bekleniyor…'
        elif not snap['enabled']:
            text = 'OFF · UDP çıkışı kapalı'
        elif snap['playing']:
            text = 'PLAYING · Kayıt saati → 127.0.0.1:6061'
        else:
            text = snap['state'] + ' · UDP sessiz / Play ile gönder'
        state = dict(locked=locked, playing=snap['playing'], positionMs=position)
    if c.par.Udpstatus.eval() != text:
        c.par.Udpstatus = text
    return state


def close():
    if client is not None:
        client.close()
