"""Embedded native viewer callbacks; all artwork state belongs to interaction.

This DAT is a child of /traces_cinematic. The seat source is SEATS, with one
header row and columns label/lane. It never enables or sends UDP directly.
"""


def _base():
    return me.parent()


def _interaction():
    return _base().op('interaction').module


def _popup(opened=None):
    popup = _base().op('VIEWPORT/seats')
    if popup is not None:
        popup.par.display = not bool(popup.par.display.eval()) if opened is None else bool(opened)


def onOffToOn(panelValue):
    owner = panelValue.owner
    action = owner.fetch('tracesAction', '')
    if action == 'Seats':
        _popup()
    elif action == 'Closeseats':
        _popup(False)
    elif action:
        _popup(False)
        _interaction().action(action)
    return


def onValueChange(panelValue):
    owner = panelValue.owner
    if owner.name == 'seek':
        # UI-driven value expression updates must never seek the recording.
        # Consume a seek only while the user holds the slider's left button.
        if bool(owner.panel.lselect):
            _interaction().seek(max(0.0, min(1.0, float(owner.panel.u))))
    elif panelValue.name == 'wheel':
        if float(panelValue.val) != 0:
            _interaction().panel_event(panelValue)
    else:
        _interaction().panel_event(panelValue)
    return


def onInitTable(comp, attribs):
    attribs.rowHeight = 30
    attribs.colWidth = 232
    attribs.fontSizeX = 14
    attribs.textColor = (.82, .86, .88, 1)
    attribs.bgColor = (.025, .035, .048, 1)
    attribs.textOffsetX = 14
    return


def onInitCol(comp, col, attribs):
    return


def onInitRow(comp, row, attribs):
    if row % 2:
        attribs.bgColor = (.033, .044, .058, 1)
    return


def onInitCell(comp, row, col, attribs):
    table = _base().op('SEATS')
    if table is not None and 0 <= row + 1 < table.numRows:
        attribs.text = str(table[row + 1, 0].val)
    return


def onSelect(comp, startRow, startCol, startCoords, endRow, endCol, endCoords, start, end):
    # Commit a completed click, not a pointer drag used to scroll the list.
    if not end or startRow != endRow or endRow < 0:
        return
    table = _base().op('SEATS')
    if table is None or endRow + 1 >= table.numRows:
        return
    _interaction().select_lane(int(table[endRow + 1, 1].val))
    _popup(False)
    return


def onRollover(comp, row, col, coords, prevRow, prevCol, prevCoords):
    if prevRow >= 0 and prevCol >= 0:
        comp.cellAttribs[prevRow, prevCol].bgColor = (
            (.033, .044, .058, 1) if prevRow % 2 else (.025, .035, .048, 1))
    if row >= 0 and col >= 0:
        comp.cellAttribs[row, col].bgColor = (.10, .13, .16, 1)
    return


def onRadio(comp, row, col, prevRow, prevCol):
    return


def onFocus(comp, row, col, prevRow, prevCol):
    return


def onEdit(comp, row, col, val):
    return
