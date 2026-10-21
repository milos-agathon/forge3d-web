# W23_OUTPUTS: ["crates/forge3d-web/tests/fixtures/w20/text-layout-oracle.json"]
"""Independent Pillow BASIC controls; never imports the web metrics generator."""
from pathlib import Path
from PIL import ImageFont
import json, random
root=Path(__file__).resolve().parents[1]
rng=random.Random(20261014)
rows=[]
strings=['AVATAR','To To','WMWMWM','9999 m','Montaña','Ångström','gjpqy','fi ffi fl','0123456789','Rock & River','Jí','JAVATARí','AV'*40,'To'*40,'N'*40,'T'*40,'Little river','Elevation','123.45 km','Map plate','éÀÜ']
for bold in (False,True):
    path=root/'assets/fonts'/('DejaVuSans-Bold.ttf' if bold else 'DejaVuSans.ttf')
    for size in [1,2,8,9,10,11,12,13,14,16,20,24,31,36,64,72,100,128,255,256,512,999,1000,4096,16384]:
        face=ImageFont.truetype(path,size,layout_engine=ImageFont.Layout.BASIC)
        for text in strings + [''.join(chr(rng.randrange(32,592)) for _ in range(rng.randrange(1,41))) for _ in range(40)]:
            l,t,r,b=face.getbbox(text)
            rows.append({'text':text,'size':size,'bold':bold,'width':r-l,'height':b-t,'browser':not bold and size in (12,20,24) and text in strings})
(root/'tests/fixtures/w20/text-layout-oracle.json').write_text(json.dumps(rows,ensure_ascii=True,separators=(',',':'))+'\n',encoding='utf-8',newline='\n')
print('Recorded',len(rows),'independent native string bounds')
