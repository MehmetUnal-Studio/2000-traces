"""Build the native interactive OUT_CINEMATIC window and control bar.

Call after OUT_CINEMATIC, XY_INSPECTOR, interaction and SEATS exist:
    build_viewer(base, callbacks_source, containerCOMP, buttonCOMP, sliderCOMP,
                 listCOMP, windowCOMP, panelExecuteDAT, textDAT)

Returns the Window COMP. It does not open a window, save a project, restart
playback, change the camera or transmit UDP. Caller handles opening/delivery.
"""


def _optional(node, name, value):
    parameter = getattr(node.par, name, None)
    if parameter is not None:
        parameter.val = value


def _menu(node, name, names):
    parameter = getattr(node.par, name, None)
    if parameter is None:
        return False
    for name in names:
        if name in parameter.menuNames:
            parameter.val = name
            return True
    return False


def _color(node, prefix, color):
    for channel, value in zip('rgb', color):
        _optional(node, prefix + channel, value)


def _rect(node, x, y, width, height):
    node.par.x = x
    node.par.y = y
    node.par.w = width
    node.par.h = height
    _optional(node, 'reposition', 'off')
    for name in ('resizel', 'resizer', 'resizeb', 'resizet'):
        _optional(node, name, False)


def build_viewer(base, callbacks_source, container_type, button_type,
                 slider_type, list_type, window_type, panel_execute_type,
                 text_dat_type):
    """Build sibling output/panel branches using explicitly supplied TD types.

    interaction.ui fields: playLabel, directorLabel, soloLabel, timeLabel,
    selectionLabel, helpLabel, inspectorVisible, progress. String fields are
    displayed literally. progress is 0..1, inspectorVisible is a boolean.
    """
    for name in ('WINDOW_CINEMATIC', 'VIEWPORT', 'viewer_callbacks',
                 'viewer_button_events', 'viewer_scene_events', 'viewer_seek_events'):
        previous = base.op(name)
        if previous is not None:
            if name == 'WINDOW_CINEMATIC':
                previous.par.winclose.pulse()
            previous.destroy()

    callbacks = base.create(text_dat_type, 'viewer_callbacks')
    callbacks.text = callbacks_source
    callbacks.nodeX = -1400
    callbacks.nodeY = -1100

    viewport = base.create(container_type, 'VIEWPORT')
    _rect(viewport, 0, 0, 1280, 800)
    viewport.par.align = 'none'
    viewport.par.bgalpha = 1
    _color(viewport, 'bgcolor', (.006, .010, .016))
    viewport.nodeX = 3750
    viewport.nodeY = 0
    viewport.viewer = True

    scene = viewport.create(container_type, 'scene')
    _rect(scene, 0, 80, 1280, 720)
    scene.par.top = '../OUT_CINEMATIC'
    scene.par.topfill = 'best'
    scene.par.bgalpha = 1
    scene.par.mousewheel = True
    for suffix in ('left', 'middle', 'right'):
        getattr(scene.par, 'uvbuttons' + suffix).val = True
    _menu(scene, 'drag', ('dragno',))
    scene.par.mouserel = False
    scene.nodeX = 0
    scene.nodeY = 180

    bar = viewport.create(container_type, 'bar')
    _rect(bar, 0, 0, 1280, 80)
    bar.par.align = 'none'
    bar.par.bgalpha = 1
    _color(bar, 'bgcolor', (.018, .025, .035))
    bar.nodeX = 0
    bar.nodeY = 0
    buttons = []

    def button(parent_node, name, label, x, y, width, height=30, action=None, field=None):
        node = parent_node.create(button_type, name)
        node.name = name
        _rect(node, x, y, width, height)
        node.par.label = label
        node.par.buttontype = 'momentary'
        node.par.fontsize = 13
        _menu(node, 'scaletofit', ('onlyshrink', 'never'))
        _color(node, 'color', (.70, .74, .76))
        _color(node, 'bgcolor', (.06, .08, .10))
        node.par.bgalpha = .9 if action else 0
        _optional(node, 'dodisablecolor', False)
        if action:
            node.store('tracesAction', action)
            buttons.append(node)
        else:
            node.par.enable = False
            _optional(node, 'clickthrough', True)
        if field:
            ancestor = parent_node
            depth = 1
            while ancestor != base:
                ancestor = ancestor.parent()
                depth += 1
            node.par.label.expr = f"str(parent({depth}).op('interaction').module.ui({field!r}, absTime.frame))"
        node.nodeX = x
        node.nodeY = y
        return node

    button(bar, 'Play', 'Oynat', 16, 40, 82, action='Play', field='playLabel')
    button(bar, 'Restart', 'Başa dön', 106, 40, 94, action='Restart')
    button(bar, 'Director', 'Sinematik kamera', 208, 40, 148,
           action='Director', field='directorLabel')
    button(bar, 'Fit', 'Kadrajı sıfırla', 364, 40, 120, action='Fit')
    button(bar, 'Seats', 'Koltuk seç', 504, 40, 154,
           action='Seats', field='selectionLabel')
    button(bar, 'Soloselection', 'Yalnızca seçili', 666, 40, 146,
           action='Soloselection', field='soloLabel')
    button(bar, 'Clearselection', 'Seçimi kaldır', 820, 40, 126,
           action='Clearselection')
    button(bar, 'hint', 'Sürükle: dön · Shift: kaydır · Tekerlek: yaklaş',
           954, 40, 310, field='helpLabel')
    button(bar, 'time', '00:00 / 03:00', 16, 8, 132, 24, field='timeLabel')

    seek = bar.create(slider_type, 'seek')
    seek.name = 'seek'
    _rect(seek, 164, 12, 1100, 18)
    _menu(seek, 'slidertype', ('slideru', 'u'))
    _optional(seek, 'label', '')
    _color(seek, 'color', (.72, .67, .52))
    _color(seek, 'bgcolor', (.08, .10, .13))
    seek.par.bgalpha = 1
    # Keep automatic playback updates out of the seek callback, which checks
    # lselect. User dragging uses panel.u rather than overwriting this binding.
    seek.par.value0.expr = "float(parent(3).op('interaction').module.ui('progress', absTime.frame))"
    seek.nodeX = 164
    seek.nodeY = -80

    inspector = viewport.create(container_type, 'inspector')
    _rect(inspector, 926, 110, 334, 510)
    inspector.par.top = '../XY_INSPECTOR'
    inspector.par.topfill = 'best'
    inspector.par.bgalpha = .96
    _color(inspector, 'bgcolor', (.014, .024, .038))
    inspector.par.layer = 10
    inspector.par.display.expr = "bool(parent(2).op('interaction').module.ui('inspectorVisible', absTime.frame))"
    inspector.nodeX = 1380
    inspector.nodeY = 180

    seats = viewport.create(container_type, 'seats')
    _rect(seats, 500, 80, 268, 444)
    seats.par.bgalpha = 1
    _color(seats, 'bgcolor', (.025, .035, .048))
    seats.par.layer = 20
    seats.par.display = False
    seats.nodeX = 1660
    seats.nodeY = 180
    button(seats, 'label', 'KAYITLI KOLTUKLAR', 8, 404, 208, 32)
    button(seats, 'close', '×', 230, 406, 28, 28, action='Closeseats')
    listing = seats.create(list_type, 'list')
    _rect(listing, 8, 8, 252, 388)
    listing.par.cols = 1
    listing.par.rows.expr = "max(0, parent(3).op('SEATS').numRows - 1)"
    listing.par.callbacks = callbacks
    listing.par.vscrollbar = True
    listing.par.hscrollbar = False
    listing.par.bgalpha = 1
    listing.nodeX = 0
    listing.nodeY = 0

    def events(name, panels, values, off_to_on=False):
        if len(panels)>1:
            return [events(name+'_'+str(index),[panel],values,off_to_on) for index,panel in enumerate(panels)]
        node = base.create(panel_execute_type, name)
        node.par.active = False
        node.par.panels = panels[0]
        node.par.panelvalue = values
        for toggle in ('offtoon', 'whileon', 'ontooff', 'whileoff', 'valuechange'):
            getattr(node.par, toggle).val = False
        node.par.offtoon = off_to_on
        node.par.valuechange = not off_to_on
        node.text = '''def onOffToOn(panelValue):
    return parent().op('viewer_callbacks').module.onOffToOn(panelValue)
def onValueChange(panelValue):
    return parent().op('viewer_callbacks').module.onValueChange(panelValue)
'''
        node.par.active = True
        return node

    events('viewer_button_events', buttons, 'state', True)
    events('viewer_scene_events', [scene], 'wheel key u v lselect mselect rselect')
    events('viewer_seek_events', [seek], 'u lselect')

    window = base.create(window_type, 'WINDOW_CINEMATIC')
    window.par.winop = 'VIEWPORT'
    window.par.title = '2000 TRACES · Interactive Cinema'
    window.par.size = 'automatic'
    window.par.borders = True
    window.par.interact = True
    window.par.justifyh = 'center'
    window.par.justifyv = 'center'
    _menu(window, 'dpiscaling', ('usedpiscale',))
    _menu(window, 'cursorvisible', ('alwaysvisible',))
    _optional(window, 'alwaysontop', False)
    _optional(window, 'closeescape', True)
    window.nodeX = 3940
    window.nodeY = 0
    return window
