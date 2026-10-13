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

expressions = module('forge3d.style_expressions', source('python/forge3d/style_expressions.py'))
tree = ast.parse(source('python/forge3d/style.py'))
tree.body = [n for n in tree.body if not (isinstance(n, ast.ImportFrom) and n.level)]
# Annotations of the support-report function require these names, but the
# expression and color implementations are executed unmodified.
style = types.ModuleType('forge3d.style')
style.ValidationReport = object
sys.modules['forge3d.style'] = style
exec(compile(tree, 'native-style.py', 'exec'), style.__dict__)
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
native_paths = ['python/forge3d/style.py','python/forge3d/style_expressions.py','python/forge3d/bundle.py','python/forge3d/map_scene.py','src/style/sprite.rs','src/style/expressions/tests.rs','src/viewer/scene_review.rs']
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
(OUTPUT / 'native-contract.json').write_text(json.dumps(fixture, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
print(f'Executed {len(cases)} expressions and {len(colors)} colors; pinned {len(sources)} native sources and {sum(len(s["tests"]) for s in sources)} named tests.')
