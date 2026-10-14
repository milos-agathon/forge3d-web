"""Execute the pinned W20 Python sources and their original tests. No native renderer needed.

Only the unrelated W21 Pro check is replaced. Original native Rust projection
imports are unavailable; the browser tests exercise both projection functions.
"""
import ast
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

files = sorted((native / 'tests').glob('test_*.py'))
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
    for cls in ast.parse(file.read_text()).body:
        if isinstance(cls,ast.ClassDef):
            for test in cls.body:
                if isinstance(test,ast.FunctionDef) and test.name.startswith('test_'):
                    out['tests'].append({'source':file.name,'class':cls.name,'test':test.name})
scene = vector.VectorScene()
scene.add_polygon([(0,0),(100,0),(100,100),(0,100)],holes=[[(25,25),(75,25),(75,75),(25,75)]],fill_color=(1,0,0,1),stroke_width=0)
scene.add_polyline([(0,50),(100,50)],stroke_color=(0,0,1,1),stroke_width=2)
scene.add_label('Montaña & <Peak>',(50,80))
out['svg'] = vector.generate_svg(scene,width=200,height=100,bounds=vector.Bounds(0,0,100,100))
(root / 'tests/fixtures/w20/native-oracle.json').write_text(json.dumps(out,indent=2)+'\n', newline='\n')
print('Recorded',len(out['tests']),'native test identities and independently evaluated palette/layout/export controls')
