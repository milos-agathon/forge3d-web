# W23_OUTPUTS: ["crates/forge3d-web/tests/fixtures/w20/layout-oracle.json","crates/forge3d-web/tests/fixtures/w20/native-oracle.json"]
"""Execute the pinned W20 Python sources and their original tests. No native renderer needed.

Only the unrelated W21 Pro check is replaced. Original native Rust projection
imports are unavailable; the browser tests exercise both projection functions.
"""
import ast
import base64
import io
import PIL
from PIL import Image, ImageDraw, ImageFont
import importlib
import json
from pathlib import Path
import sys
import types

import numpy as np
import pytest

root = Path(__file__).resolve().parents[1]
native = root / 'tests/fixtures/w20/native'
package = types.ModuleType('forge3d')
package.__path__ = [str(native / 'python/forge3d')]
sys.modules['forge3d'] = package
license_module = types.ModuleType('forge3d._license')
license_module._check_pro_access = lambda *args: None
sys.modules['forge3d._license'] = license_module
license_plugin = types.ModuleType('w20_license_fixture')
@pytest.fixture
def pro_license():
    yield
license_plugin.pro_license = pro_license

# Resolve the native font names to verified package bytes, independent of host fonts.
truetype = ImageFont.truetype
def package_font(font, *args, **kwargs):
    if str(font) in ('DejaVuSans.ttf', 'DejaVuSans-Bold.ttf'):
        font = str(root / 'assets/fonts' / font)
        kwargs.setdefault('layout_engine', ImageFont.Layout.BASIC)
    return truetype(font, *args, **kwargs)
ImageFont.truetype = package_font
files = sorted(p for p in (native / 'tests').glob('test_*.py') if not p.name.startswith('test_colormaps'))
code = pytest.main(['-q', '--confcutdir=' + str(native), *map(str, files)], plugins=[license_plugin])
if code:
    raise SystemExit(code)

plate = importlib.import_module('forge3d.map_plate')
legend = importlib.import_module('forge3d.legend')
scale = importlib.import_module('forge3d.scale_bar')
cm = importlib.import_module('forge3d.colormaps')
core = importlib.import_module('forge3d.colormaps.core')
vector = importlib.import_module('forge3d.export')
anchors = ['top', 'bottom', 'left', 'right', 'top-left', 'top-right', 'bottom-left', 'bottom-right', 'center']
p = plate.MapPlate()
out = {'palettes': {name: cm.get(name).rgba.tolist() for name in cm.available()}, 'anchors': [], 'scales': [], 'tests': [], 'licenseCheck': 'W21 stubbed; no W20 rendering code replaced'}
for region in [(10,20,811,622),(40,60,1400,920)]:
    for anchor in anchors:
        out['anchors'].append({'region':region,'size':[101,43],'anchor':anchor,'expected':p._position_element((101,43),anchor,plate.PlateRegion(*region))})
for lat in [0,45,70]:
    bbox = plate.BBox(0,lat,1,lat+1)
    mpp = scale.ScaleBar.compute_meters_per_pixel(bbox,1000)
    for units in ['m','km','mi','ft']:
        bar = scale.ScaleBar(mpp,scale.ScaleBarConfig(units=units))
        out['scales'].append({'lat':lat,'units':units,'mpp':mpp,'distance':bar._choose_nice_distance(164*mpp)})
out['linearGrayLegend'] = legend.Legend(np.full((2,4),[.25,.25,.25,1],dtype=np.float32),(0,1),legend.LegendConfig(bar_height=4,bar_width=1))._render_gradient_bar().reshape(-1).tolist()
for file in files:
    for cls in ast.parse(file.read_text(encoding='utf-8')).body:
        if isinstance(cls,ast.ClassDef):
            for test in cls.body:
                if isinstance(test,ast.FunctionDef) and test.name.startswith('test_'):
                    out['tests'].append({'source':file.name,'class':cls.name,'test':test.name})
scene = vector.VectorScene()
scene.add_polygon([(0,0),(100,0),(100,100),(0,100)],holes=[[(25,25),(75,25),(75,75),(25,75)]],fill_color=(1,0,0,1),stroke_width=0)
scene.add_polyline([(0,50),(100,50)],stroke_color=(0,0,1,1),stroke_width=2)
scene.add_label('Montaña & <Peak>',(50,80))
out['svg'] = vector.generate_svg(scene,width=200,height=100,bounds=vector.Bounds(0,0,100,100))
out['stopCases'] = []
for name, stops, count in [
    ('hex',[(0,'#ffffff80'),(1,'#ffffff80')],3),
    ('numericAlpha',[(0,(1,1,1,.5)),(1,(1,1,1,.5))],3),
    ('edge',[(0,'#000000'),(.5,'#000000'),(.5,'#ffffff'),(1,'#ffffff')],5),
    ('float32Edge',[(0,'#000000'),(.3,'#000000'),(.3,'#ffffff'),(1,'#ffffff')],11),
    ('extended',[(-.5,'#000000'),(1.5,'#ffffff')],3),
    ('constant',[(.5,'#336699')],3),
    ('clamped',[(.25,'#000000'),(.75,'#ffffff')],5),
]:
    out['stopCases'].append({'name':name,'stops':stops,'size':count,'rgba':core.from_stops(name,stops,count).rgba.reshape(-1).tolist()})
(root / 'tests/fixtures/w20/native-oracle.json').write_text(json.dumps(out,indent=2)+'\n', encoding='utf-8', newline='\n')
print('Recorded',len(out['tests']),'native test identities and independently evaluated palette/layout/export controls')

# Independent PIL pixels, real glyph metrics and actual blit rectangles.
arrow = importlib.import_module('forge3d.north_arrow')
controls = {'pillow': PIL.__version__, 'font': 'DejaVu 2.37 package bytes', 'layoutEngine': 'Pillow BASIC', 'metrics': [], 'images': {}, 'rects': []}
for size, text, bold in [(24,'Jí',False),(24,'Mountain atlas',False),(20,'Mountain atlas',False),(16,'Elevation',False),(14,'1000 m',False),(12,'10 km',False),(10,'3000 m',False),(14,'N',True)]:
    face = package_font('DejaVuSans-Bold.ttf' if bold else 'DejaVuSans.ttf',size)
    box = ImageDraw.Draw(Image.new('RGBA',(1,1))).textbbox((0,0),text,font=face)
    controls['metrics'].append({'size':size,'text':text,'bold':bold,'width':box[2]-box[0],'height':box[3]-box[1]})
def record(name, rgba):
    stream = io.BytesIO(); Image.fromarray(rgba).save(stream,format='PNG')
    controls['images'][name]={'width':rgba.shape[1],'height':rgba.shape[0],'png':base64.b64encode(stream.getvalue()).decode('ascii')}
    return rgba
leg = record('legend',legend.Legend(cm.get('forge3d:viridis').rgba,(0,3000),legend.LegendConfig(bar_height=140,font_size=10,title='Elevation')).render())
sb = record('scale',scale.ScaleBar(200,scale.ScaleBarConfig(width_px=140,font_size=10)).render())
# Wide label makes left-aligned scale-bar placement observable.
record('wideScale',scale.ScaleBar(1e5,scale.ScaleBarConfig(width_px=40,units='m')).render())
for angle in (0,30,90,-45):
    record('arrow'+str(angle),arrow.NorthArrow(arrow.NorthArrowConfig(size=40,rotation_deg=angle,font_size=10)).render())
map_image=np.full((80,120,4),[40,130,80,255],dtype=np.uint8)
inset=np.full((20,30,4),[25,50,150,255],dtype=np.uint8)
p=plate.MapPlate(plate.MapPlateConfig(width=480,height=320,margin=(45,120,35,20)))
p.set_map_region(map_image,plate.BBox(-122,46,-121,47));p.add_title('Mountain atlas',font_size=20)
record('title',p._render_title())
p.add_legend(leg);p.add_scale_bar(sb);p.add_north_arrow(controls_arrow:=arrow.NorthArrow(arrow.NorthArrowConfig(size=40,rotation_deg=30,font_size=10)).render());p.add_inset(inset,size=(60,40))
original_blit=p._blit
names=iter(['map','title','legend','scale-bar','north-arrow','inset'])
def capture(canvas,image,x,y):
    controls['rects'].append({'kind':next(names),'rect':[x,y,x+image.shape[1],y+image.shape[0]]})
    original_blit(canvas,image,x,y)
p._blit=capture
record('plate',p.compose())
(root/'tests/fixtures/w20/layout-oracle.json').write_text(json.dumps(controls,indent=2)+'\n',encoding='utf-8',newline='\n')

# Exhaustive composite inventory: Python cases, every Rust inline #[test], historical colormaps.
import hashlib
import re
ledger_path = root/'docs/w20-native-test-coverage.json'
ledger = json.loads(ledger_path.read_text(encoding='utf-8'))
ledger['schemaVersion'] = 2
ledger['fixtureSha256'] = hashlib.sha256((root/'tests/fixtures/w20/native-oracle.json').read_bytes()).hexdigest()
ledger['layoutFixtureSha256'] = hashlib.sha256((root/'tests/fixtures/w20/layout-oracle.json').read_bytes()).hexdigest()
ledger['tests'] = [c for c in ledger['tests'] if not c['source'].startswith(('src/', 'tests/'))]
for c in ledger['tests']:
    if c['source'] == 'test_map_plate_layout.py':
        c['evidence']['file'] = 'tests/browser/w20-native-plate-cases.js'
        c['adaptation'] = 'Executable page.evaluate case with counted assertions, run in source and installed package. Numeric/pixel/Blob assertions retain the native contract; independent PIL layout controls strengthen the native size checks.'
for file in sorted((native/'src/export').glob('*.rs')):
    source = 'src/export/'+file.name
    for test in re.findall(r'#\[test\]\s*fn (\w+)\(',file.read_text(encoding='utf-8')):
        ledger['tests'].append({'source':source,'class':'tests','test':test,'disposition':'native-semantic-port','evidence':{'file':'tests/unit/w20-native-extra.test.ts','test':source+'::tests::'+test},'adaptation':'Public Bounds/projection/SVG APIs preserve the native numerical and XML assertions. addScreenLabels retains native omission of invisible/unprojected labels and flips screen Y exactly once.'})
for file in sorted((native/'tests').glob('test_colormaps_*.py')):
    source='tests/'+file.name
    for test in ast.parse(file.read_text(encoding='utf-8')).body:
        if isinstance(test,ast.FunctionDef) and test.name.startswith('test_'):
            ledger['tests'].append({'source':source,'class':'tests','test':test.name,'disposition':'native-semantic-port','evidence':{'file':'tests/unit/w20-native-extra.test.ts','test':source+'::tests::'+test.name},'adaptation':'Preserve registry, Lab D65 lightness, determinism and CVD endpoint-distinction assertions. The historical invalid colorspacious tuple is replaced by the published Machado severity-100 forward matrix; no optional-dependency skip.'})
assert len(ledger['tests']) == 105
ledger_path.write_text(json.dumps(ledger,indent=2)+'\n',encoding='utf-8',newline='\n')
