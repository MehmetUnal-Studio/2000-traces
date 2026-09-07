"""Build an editable, isolated native title branch inside the cinematic COMP.

Called by build_cinematic.py after SMAA, before OUT_CINEMATIC:
    title = build_title(base, antialias, core, glsl_top, parameter,
                        textTOP, compositeTOP)
    out.inputConnectors[0].connect(title)

Embed this file in a Text DAT and use DAT.module.build_title, or execute it
in the builder namespace. It owns no clock, camera, recording or UDP state.
Only the three native Text TOPs and their private composition are display
graphics. The returned title TOP is downstream of all existing scene optics.
"""


def _menu(node, name, preferred, optional=False):
    """Use the local TD menu rather than assuming renamed 2023/2025 tokens."""
    parameter = getattr(node.par, name, None)
    if parameter is None:
        if optional:
            return False
        raise RuntimeError('Missing Text TOP parameter: ' + name)
    names, labels = list(parameter.menuNames), list(parameter.menuLabels)
    # Font is a dynamic menu in current TD, a free string in some older builds.
    if name == 'font' and not names:
        parameter.val = preferred[0]
        return True
    for desired in preferred:
        for index, value in enumerate(names):
            if desired.casefold() in (value.casefold(), labels[index].casefold()):
                parameter.val = value
                return True
    if optional:
        return False
    raise RuntimeError('Unsupported Text TOP menu ' + name + ': ' + repr(names))


def _position(text, x, y):
    """TD 2025 renamed the Text TOP position tuple from 1/2 to x/y."""
    for current, legacy, value in [('positionx', 'position1', x), ('positiony', 'position2', y)]:
        parameter = getattr(text.par, current, None)
        if parameter is None:
            parameter = getattr(text.par, legacy)
        parameter.val = value


def build_title(base, scene, core, glsl_top, parameter, text_type, composite_type):
    """Return the final title compositor; leave the upstream render untouched."""
    page = base.appendCustomPage('Title')
    parameter(page, 'Toggle', 'Titleenabled', 'Stars of The Year background', True)
    parameter(page, 'Toggle', 'Titlefollow', 'Keep title facing the camera', True)
    parameter(page, 'Float', 'Titleopacity', 'Background title visibility', 0.12, 0, 0.65)
    parameter(page, 'Float', 'Titlewidth', 'Title width in space', 10.0, 2, 30)
    parameter(page, 'Float', 'Titledepth', 'Title distance behind artwork', 8.0, 4, 24)
    parameter(page, 'Float', 'Titlelift', 'Title vertical position', 2.0, -6, 8)
    parameter(page, 'Float', 'Titleazimuth', 'Title anchor azimuth', 15.0, -180, 180)
    parameter(page, 'Float', 'Titleelevation', 'Title anchor elevation', 12.0, -80, 80)

    # Native font operators are independently editable. Use platform fonts;
    # do not create a rasterized screenshot, logo cut-out, or bundled font file.
    specs = (
        ('title_stars', 'Stars', ('Arial', 'Helvetica Neue', 'Helvetica'),
         246, 0, 82, 'center', False, (0.89, 0.875, 0.82)),
        ('title_of', 'of', ('Baskerville', 'Times New Roman', 'Times'),
         142, 308, -99, 'left', True, (0.75, 0.65, 0.44)),
        ('title_year', 'The Year', ('Arial', 'Helvetica Neue', 'Helvetica'),
         142, 434, -99, 'left', False, (0.89, 0.875, 0.82)),
    )
    texts = []
    for index, (name, label, fonts, size, x, y, alignment, italic, color) in enumerate(specs):
        text = base.create(text_type, name)
        text.par.text = label
        text.par.outputresolution = 'custom'
        text.par.resolutionw = 1280
        text.par.resolutionh = 512
        _menu(text, 'font', fonts)
        _menu(text, 'dispmethod', ('scalable', 'polygon', 'automatic'))
        _menu(text, 'fontautosize', ('nofit',))
        _menu(text, 'fontsizexunit', ('pixels', 'pixel', 'absolute', 'abs'))
        _menu(text, 'positionunit', ('pixels', 'pixel', 'absolute', 'abs'))
        _menu(text, 'alignxmode', ('bbox',), optional=True)
        _menu(text, 'alignymode', ('bbox',), optional=True)
        text.par.fontsizex = size
        text.par.keepfontratio = True
        text.par.alignx = alignment
        text.par.aligny = 'center'
        _position(text, x, y)
        text.par.wordwrap = False
        text.par.bold = False
        text.par.italic = italic
        # Recent TD versions ignore legacy bold/italic toggles unless their
        # legacy switch is on. Prefer a real typeface to preserve the reference.
        faces = ('Italic',) if italic else ('Thin', 'Light', 'Regular')
        if not _menu(text, 'typeface', faces, optional=True):
            legacy = getattr(text.par, 'legacyfontselection', None)
            if legacy is not None:
                legacy.val = True
        text.par.bgalpha = 0
        text.par.fontalpha = 1
        text.par.multrgbbyalpha = True
        for channel, value in zip('rgb', color):
            getattr(text.par, 'fontcolor' + channel).val = value
        text.par.format = 'rgba16float'
        text.nodeX = 2780 + index * 170
        text.nodeY = -640
        text.color = (0.36, 0.31, 0.20)
        texts.append(text)

    # Disjoint native glyphs: add retains the premultiplied transparent pixels.
    lettering = base.create(composite_type, 'title_lettering')
    lettering.par.operand = 'add'
    for index, text in enumerate(texts):
        lettering.inputConnectors[index].connect(text)
    lettering.par.format = 'rgba16float'
    lettering.nodeX = 3300
    lettering.nodeY = -640
    title = glsl_top('cinematic_title', 'title.frag', [scene, lettering, core])
    title.nodeX = 3400
    title.nodeY = 0

    az = 'math.radians(parent().par.Titleazimuth.eval())'
    el = 'math.radians(parent().par.Titleelevation.eval())'
    expressions = {
        'uTitleNormal': [f'math.sin({az})*math.cos({el})', f'math.sin({el})',
                         f'math.cos({az})*math.cos({el})', 'int(parent().par.Titleenabled.eval())'],
        'uTitleRight': [f'math.cos({az})', '0', f'-math.sin({az})', '0'],
        'uTitleUp': [f'-math.sin({az})*math.sin({el})', f'math.cos({el})',
                     f'-math.cos({az})*math.sin({el})', '0'],
        'uTitleShape': ['parent().par.Titlewidth.eval()', 'parent().par.Titledepth.eval()',
                        'parent().par.Titlelift.eval()', 'parent().par.Titleopacity.eval()'],
    }
    for uniform,camera,sign in [('uTitleNormal','uCameraForward',-1),('uTitleRight','uCameraRight',1),('uTitleUp','uCameraUp',1)]:
        for axis in range(3):
            fixed=expressions[uniform][axis]
            expressions[uniform][axis]=f'({sign}*op("runtime").module.uniform("{camera}",{axis},absTime.frame)) if parent().par.Titlefollow else ({fixed})'
    for block in range(title.seq.vec.numBlocks):
        name = getattr(title.par, f'vec{block}name').eval()
        if name in expressions:
            for axis, expression in zip('xyzw', expressions[name]):
                getattr(title.par, f'vec{block}value{axis}').expr = expression
    return title
