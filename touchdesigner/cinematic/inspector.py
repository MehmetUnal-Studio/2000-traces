"""Native Script TOP background and exact recorded XY trace for the inspector."""
import numpy as np

def onCook(scriptOp):
    image=np.zeros((520,320,4),dtype=np.float32)
    image[:]=(.027,.038,.054,.97)
    image[[0,-1],:]=(.18,.22,.27,1); image[:,[0,-1]]=(.18,.22,.27,1)
    x0,x1,y0,y1=30,290,266,410
    for x in np.linspace(x0,x1,5).astype(int): image[y0:y1+1,x]=(.11,.15,.19,1)
    for y in np.linspace(y0,y1,5).astype(int): image[y,x0:x1+1]=(.11,.15,.19,1)
    state=op('interaction').module.selection
    point=state.get('selected') if state else None
    if point:
        trail=point['trail']
        for first,second in zip(trail,trail[1:]):
            a=(x0+first['x']*(x1-x0),y0+first['y']*(y1-y0))
            b=(x0+second['x']*(x1-x0),y0+second['y']*(y1-y0))
            count=max(2,int(max(abs(a[0]-b[0]),abs(a[1]-b[1]))*2))
            xx=np.rint(np.linspace(a[0],b[0],count)).astype(int)
            yy=np.rint(np.linspace(a[1],b[1],count)).astype(int)
            image[yy,xx]=(.55,.69,.76,1)
        x=x0+point['x']*(x1-x0); y=y0+point['y']*(y1-y0)
        yy,xx=np.ogrid[:520,:320]
        image[(xx-x)**2+(yy-y)**2<17]=(.93,.83,.60,1)
    scriptOp.copyNumpyArray(image)
