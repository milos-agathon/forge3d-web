"""Run the pinned native expression/color implementations; never use web output as the oracle."""
import ast
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import types

ROOT = Path(__file__).resolve().parents[3]
OUTPUT = Path(__file__).resolve().parents[1] / 'tests/fixtures/w19'
COMMIT = 'bf8db93233e5158f6d226991fc5d230832c2d806'

def source(path):
    return subprocess.check_output(['git', 'show', f'{COMMIT}:{path}'], cwd=ROOT)

def module(name, text):
    result = types.ModuleType(name)
    sys.modules[name] = result
    exec(compile(text, name, 'exec'), result.__dict__)
    return result

# The only shim is the W21 license check; all reference algorithms are original.
package = types.ModuleType('forge3d'); package.__path__ = []
sys.modules['forge3d'] = package
license_module = types.ModuleType('forge3d._license'); license_module._check_pro_access = lambda *a: None
sys.modules['forge3d._license'] = license_module
module('forge3d.diagnostics', source('python/forge3d/diagnostics.py'))
module('forge3d.terrain_params', source('python/forge3d/terrain_params.py'))
expressions = module('forge3d.style_expressions', source('python/forge3d/style_expressions.py'))
style = module('forge3d.style', source('python/forge3d/style.py'))
bundle = module('forge3d.bundle', source('python/forge3d/bundle.py'))
ctx = expressions.EvalContext(properties={'n': 7, 'kind': 'a', 'name': 'Road'}, zoom=10, geometry_type='LineString')
cases = [
    ['get','n'], ['has','missing'], ['at',1,['literal',[5,6]]], ['length','é🚀'], ['zoom'], ['geometry-type'],
    ['interpolate',['linear'],['zoom'],5,1,15,10], ['interpolate',['exponential',2],1,0,0,2,12],
    ['interpolate-lab',['linear'],5,0,['literal',[1,2,3]],10,['literal',[3,4,5]]],
    ['step',['zoom'],1,10,2,15,3], ['match',['get','kind'],['a','b'],5,0], ['case',['>',['get','n'],5],'yes','no'], ['coalesce',['get','missing'],['get','name']],
    ['+',1,2,3], ['-',2], ['-',5,2], ['*',2,3], ['/',12,3], ['/',1,0], ['%',-7,3], ['^',2,3],
    ['abs',-3], ['ceil',2.1], ['floor',2.9], ['round',2.5], ['round',-1.5], ['min',3,'invalid',1], ['max',3,1],
    ['ln',1], ['log10',100], ['log2',8], ['sin',0], ['cos',0], ['tan',0], ['sqrt',4], ['sqrt',-1],
    ['==',2,'2'], ['!=',2,3], ['<',2,3], ['<=',2,2], ['>',2,3], ['>=',2,2], ['all',True,1], ['any',False,True], ['!',False],
    ['concat','a',['get','missing'],'b'], ['downcase','ROAD'], ['upcase','road'], ['to-number','12'], ['to-number','bad'],
    ['to-boolean',0], ['typeof',['literal',[]]], ['to-string',12], ['rgb',255,0,0], ['rgba',0,255,0,.5], ['unknown',5]
]
colors = ['#fff','#000','#f008','#ff0000','#00ff0080','rgb(255, 0, 0)','rgba(0, 255, 0, 0.5)','rgb(100%,0%,0%)','hsl(0,100%,50%)','hsla(120,100%,50%,0.2)','black','white','red','green','gray','orange','transparent','invalid']
native_paths = ['python/forge3d/viewer.py','python/forge3d/diagnostics.py','python/forge3d/terrain_params.py','python/forge3d/style.py','python/forge3d/style_expressions.py','python/forge3d/bundle.py','python/forge3d/map_scene.py','src/style/sprite.rs','src/style/expressions/tests.rs','src/viewer/scene_review.rs']
tests = ['test_style_parser.py','test_style_render.py','test_style_pixel_diff.py','test_style_visual.py','test_bundle_roundtrip.py','test_bundle_render.py','test_bundle_cli.py','test_diagnostics_bundle_serialization.py','test_diagnostics_style_support.py','test_mapscene_save_bundle.py','test_p1_bundle_guardrails.py','test_p1_bundle_roundtrip.py']
native_paths += ['tests/' + p for p in tests]
OUTPUT.mkdir(parents=True, exist_ok=True)
sources = []
for path in native_paths:
    raw = source(path)
    destination = OUTPUT / 'native' / path
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(raw)
    sources.append({'path':path,'sha256':hashlib.sha256(raw).hexdigest(),'tests':re.findall(r'^\s*def (test_\w+)\(',raw.decode(),re.M) if path.startswith('tests/') else []})
fixture = {'commit':COMMIT,'context':{'properties':ctx.properties,'zoom':ctx.zoom,'geometryType':ctx.geometry_type},'expressions':[{'input':e,'expected':expressions.evaluate(e,ctx)} for e in cases],'colors':[{'input':c,'expected':style.parse_color(c)} for c in colors],'sources':sources}
# Include Python edge semantics, malformed arities and multiple contexts.
edge_cases = [
 ['to-boolean',['literal',[]]], ['to-boolean',['literal',{}]], ['to-string',True], ['to-string',['+',1,2]], ['concat',True,'/', ['/',6,2]], ['to-number',''], ['to-number','0x10'],
 ['=='], ['!='], ['case','x'], ['match','a','fb'], ['step',5,'d'], ['+',True,1], ['<',True,2], ['match',True,1,'yes','no'],
 ['get','n',['literal',{'n':99}]], ['has','n',['literal',{}]], ['get','missing',['literal',{'missing':1}]], ['has','missing',['literal',{'missing':1}]],
 ['==',True,1], ['==',['literal',{'x':[True]}],['literal',{'x':[1]}]], ['!',['literal',[]]], ['case',['literal',{}],1,2],
 ['at',-.5,['literal',['first']]], ['at',True,['literal',['a','b']]], ['to-string',['literal',[True,None]]], ['to-string',['rgb',255,0,0]], ['typeof',['rgb',255,0,0]],
 ['%',7,-3], ['to-number','1_000'], ['to-number',' .5 '], ['to-number',False], ['to-string',['*',3,1]], ['concat',['get','flag'],'/', ['to-string',['+',1,2]]],
]
contexts = [ctx, expressions.EvalContext(properties={'flag':True,'n':0},zoom=3.25,geometry_type='Point'), expressions.EvalContext(properties={},zoom=15,geometry_type='Polygon')]
fixture['edges'] = [{'id':f'edge-{i}-{j}', 'input':e,'context':{'properties':c.properties,'zoom':c.zoom,'geometryType':c.geometry_type},'expected':expressions.evaluate(e,c)} for i,e in enumerate(edge_cases) for j,c in enumerate(contexts)]
from dataclasses import asdict
paints = [
 ('fill-opacity','fill',{'fill-color':'#f008','fill-opacity':.5}), ('line-default','line',{}), ('line-opacity','line',{'line-color':'#00ff00','line-opacity':.5,'line-width':3}),
 ('circle-native-opacity','circle',{'circle-color':'#f00','circle-radius':8,'circle-opacity':.2}),
 ('road-color-by-class','line',{'line-color':['match',['get','class'],'motorway','#f00','primary','#ffa500','#888']}),
 ('road-width-by-zoom','line',{'line-width':['interpolate',['linear'],['zoom'],5,1,15,10]}),
 ('building-color-by-height','fill',{'fill-color':['step',['get','height'],'#e0e0e0',10,'#c0c0c0',50,'#a0a0a0',100,'#808080'],'fill-opacity':.8}),
]
fixture['paints'] = []
for id,kind,paint in paints:
 for j,(properties,zoom) in enumerate([({},5),({'class':'motorway','height':25},10),({'class':'primary','height':100},15)]):
  out=style.paint_to_vector_style(style.PaintProps(**{k.replace('-','_'):v for k,v in paint.items()}),properties,zoom)
  fixture['paints'].append({'id':f'{id}-{j}','layer':{'id':id,'type':kind,'paint':paint},'context':{'properties':properties,'zoom':zoom},'expected':asdict(out)})
fixture['labels'] = []
for i,(layout,paint) in enumerate([({},{}),({'text-size':20,'text-offset':[1,.5]},{}),({'text-size':['interpolate',['linear'],['zoom'],5,10,15,20],'text-offset':[-.5,1]}, {'text-color':'#333','text-opacity':.4,'text-halo-width':2})]):
 out=style.layout_to_label_style(style.LayoutProps(**{k.replace('-','_'):v for k,v in layout.items()}),style.PaintProps(**{k.replace('-','_'):v for k,v in paint.items()}),{},10)
 fixture['labels'].append({'id':f'label-{i}','layer':{'id':str(i),'type':'symbol','layout':layout,'paint':paint},'expected':asdict(out)})
filters = [None,[],['>', 'n', 100],['==','n',7],['!=','n',7],['all',['has','n'],['==','n',7]],['any',['==','n',0],['has','n']],['!',['has','n']],['in','n',7,8],['has'],['==','n'],['none',['has','n']]]
fixture['filters'] = [{'id':f'filter-{i}', 'input':e,'properties':ctx.properties,'expected':style._evaluate_filter(e,ctx.properties)} for i,e in enumerate(filters)]
features = [{'type':'Feature','properties':{'n':7},'geometry':{'type':'LineString','coordinates':[[0,0,1],[2,1,3]]}}, {'type':'Feature','properties':{},'geometry':{'type':'Point','coordinates':[1,1,2]}}]
fixture['mappings'] = []
for i,layers in enumerate([
 [{'id':'casing','type':'line','paint':{'line-color':'#000','line-width':5}},{'id':'road','type':'line','paint':{'line-color':'#fff','line-width':2}},{'id':'town','type':'circle'}],
 [{'id':'default','type':'line','filter':['>','n',100]},{'id':'town','type':'circle'}],
 [{'id':'road','type':'line','paint':{'line-width':['interpolate',['linear'],['zoom'],5,1,15,10],'line-color':['match',['get','n'],7,'#f00','#888']}},{'id':'town','type':'circle'}],
]):
 spec={'version':8,'layers':layers}; output=style.vector_overlay_configs_from_style(spec,features,zoom=15)
 fixture['mappings'].append({'id':f'mapping-{i}','style':spec,'features':features,'zoom':15,'expected':[{'layer':o.name.split('.')[1],'primitive':o.primitive.value,'positions':[[v.x,v.y,v.z] for v in o.vertices],'color':[o.vertices[0].r,o.vertices[0].g,o.vertices[0].b,o.vertices[0].a], 'lineWidth':o.line_width,'pointSize':o.point_size} for o in output]})

# Generate a REAL native save/load archive; never manufacture the base key.
import tempfile, zipfile
with tempfile.TemporaryDirectory() as temporary:
 directory = Path(temporary); raster=directory/'ortho.png'; raster.write_bytes(b'native-raster'); dem=directory/'dem.tif'; dem.write_bytes(b'native-dem')
 scene = bundle.SceneState(base=bundle.SceneBaseState(preset={'exposure':1.25},camera_bookmarks=[bundle.CameraBookmark(name='overview',eye=(100,200,300),target=(0,0,0))],raster_overlays=[bundle.RasterOverlaySpec(name='ortho',path=str(raster),extent=(0,0,10,10),opacity=.75)],vector_overlays=[{'name':'triangle','primitive':'triangles','vertices':[[0,0,0],[1,0,0],[0,1,0]],'indices':[0,1,2]}],labels=[{'text':'Base','world_pos':[1,2,3]}]),review_layers=[bundle.ReviewLayer(id='notes',labels=[{'text':'Note','kind':'callout','anchor':[2,3,4]}])],variants=[bundle.SceneVariant(id='review',active_layer_ids=['notes'],preset={'exposure':3}),bundle.SceneVariant(id='empty',active_layer_ids=[],preset={}),bundle.SceneVariant(id='other',active_layer_ids=[],preset={'unknown':True})],active_variant_id='review')
 path=directory/'native.forge3d'; bundle.save_bundle(path,name='native-v2',scene_state=scene,dem_path=dem,colormap_name='viridis')
 # Deliberately disagreeing mirrors test native precedence on load.
 (path/'render/preset.json').write_text(json.dumps({'exposure':2.5})); (path/'camera/bookmarks.json').write_text(json.dumps([{'name':'mirror','eye':[4,5,6],'target':[0,0,0]}]))
 manifest=json.loads((path/'manifest.json').read_text()); manifest['created_at']='2026-06-04T00:00:00Z'
 for name in manifest['checksums']: manifest['checksums'][name]=hashlib.sha256((path/name).read_bytes()).hexdigest()
 (path/'manifest.json').write_text(json.dumps(manifest))
 loaded=bundle.load_bundle(path); fixture['nativeBundle']={'basePreset':loaded.scene_state.base.preset,'bookmarks':[b.to_dict() for b in loaded.camera_bookmarks],'colormap':loaded.manifest.terrain.colormap,'variants':[]}
 for variant in loaded.list_variants():
  loaded.apply_variant(variant.id); effective=loaded.effective_scene_state(); fixture['nativeBundle']['variants'].append({'id':variant.id,'preset':effective.preset,'labels':effective.labels,'rasterCount':len(effective.raster_overlays),'vectorCount':len(effective.vector_overlays)})
 with zipfile.ZipFile(OUTPUT/'native-v2.forge3d','w',zipfile.ZIP_DEFLATED) as archive:
  for file in sorted(path.rglob('*')):
   if file.is_file():
    info=zipfile.ZipInfo(file.relative_to(path).as_posix(),date_time=(2026,6,4,0,0,0)); info.compress_type=zipfile.ZIP_DEFLATED; archive.writestr(info,file.read_bytes())
from PIL import Image
Image.new('RGB', (8,8), (64,128,192)).save(OUTPUT/'native-snapshot.png')
from w19_native_replay import record_native_tests
fixture['testReplays'] = record_native_tests(sys.modules[__name__], style, expressions, bundle, OUTPUT)
(OUTPUT / 'native-contract.json').write_text(json.dumps(fixture, ensure_ascii=False, indent=2)+'\n', encoding='utf-8', newline='\n')
print(f'Executed {len(cases)} expressions and {len(colors)} colors; pinned {len(sources)} native sources and {sum(len(s["tests"]) for s in sources)} named tests.')
