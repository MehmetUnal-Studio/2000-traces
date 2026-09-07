"""Build native text and recorded XY inspector TOPs."""

def build_inspector(base,text_dat,source,text_type,script_type,composite_type):
    callbacks=text_dat('xy_graph_callbacks',source,-550,1200)
    graph=base.create(script_type,'xy_graph'); graph.par.callbacks=callbacks
    graph.par.resolutionw=320; graph.par.resolutionh=520
    graph.par.format='rgba32float'; graph.nodeX=-300; graph.nodeY=1200
    layers=[]
    def label(name,expression,size,y,color):
        node=base.create(text_type,name)
        node.par.text.expr=expression
        node.par.outputresolution='custom'; node.par.resolutionw=320; node.par.resolutionh=520
        node.par.font='Arial'; node.par.dispmethod='scalable'
        node.par.fontsizexunit='pixels'; node.par.fontsizex=size
        node.par.fontautosize='nofit'; node.par.alignx='left'; node.par.aligny='top'
        if hasattr(node.par,'positionx'): node.par.positionx=26; node.par.positiony=y-520
        else: node.par.position1=26; node.par.position2=y-520
        node.par.bgalpha=0; node.par.fontalpha=1; node.par.wordwrap=False
        for channel,value in zip('rgb',color):getattr(node.par,'fontcolor'+channel).val=value
        node.nodeX=-100+len(layers)*150; node.nodeY=1200
        layers.append(node)
    label('inspector_heading',repr('SEÇİLİ KOLTUK'),12,495,(.74,.66,.48))
    label('inspector_seat','op("interaction").module.ui("selectionLabel", absTime.frame)',30,471,(.82,.86,.87))
    label('inspector_detail','op("interaction").module.ui("inspectorText", absTime.frame)',14,235,(.63,.70,.75))
    label('inspector_axes',repr('Y                                                    X'),11,428,(.45,.55,.6))
    # Premultiplied text over opaque graph via native Over. With disjoint text
    # regions, additive composition preserves the dark panel background.
    out=base.create(composite_type,'XY_INSPECTOR'); out.par.operand='add'
    for index,node in enumerate([graph]+layers):out.inputConnectors[index].connect(node)
    out.nodeX=600;out.nodeY=1200
    return out
