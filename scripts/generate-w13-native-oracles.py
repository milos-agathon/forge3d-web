"""Regenerate W13 contract oracles by running the original native Python tests.
Requires Python + pytest only. Native code is read from immutable Git objects;
no GPU, installed forge3d extension, or browser implementation is consulted.
"""
import importlib.util
import inspect
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import types

ROOT = Path(__file__).resolve().parents[1]
BASELINE = subprocess.check_output(['git','rev-parse','1f4084a'],cwd=ROOT,text=True).strip()
TESTS = ['contract','determinism','keepouts','payloads','point_candidates','polygon_candidates','priority','rejection_reasons','terrain']
EXTRA = ['test_label_plan_quickstart.py','test_p1_label_layer_geometry.py','test_p1_label_layer_crs_terrain.py','test_p1_label_expressions_plan_diagnostics.py','test_mapscene_label_plan_integration.py','test_p2_advanced_label_rules.py','test_p2_advanced_labels_repeated_curved.py','test_p2_complex_shaping_decision.py']
CASES = []

def source(path):
    return subprocess.check_output(['git','show',f'{BASELINE}:{path}'],cwd=ROOT,text=True,encoding='utf-8')

def serial(value):
    if hasattr(value,'to_dict'): return serial(value.to_dict())
    if isinstance(value,dict): return {str(k):serial(v) for k,v in value.items()}
    if isinstance(value,set): return [serial(v) for v in sorted(value,key=str)]
    if isinstance(value,(tuple,list)): return [serial(v) for v in value]
    if value is None or isinstance(value,(str,int,float,bool)): return value
    raise TypeError(type(value).__name__)

def normalize(value):
    # Native ordering keys contain Python JSON float spellings. Candidate IDs,
    # array order, scores, anchors, diagnostics and all observable reasons remain.
    if isinstance(value,dict): return {k:normalize(v) for k,v in value.items() if k!='ordering_key'}
    if isinstance(value,list): return [normalize(v) for v in value]
    return value

with tempfile.TemporaryDirectory(prefix='forge3d-w13-oracle-') as temp:
    base=Path(temp)
    package=types.ModuleType('forge3d');package.__path__=[str(base)];sys.modules['forge3d']=package
    for name in ['diagnostics','label_plan','style_expressions','map_scene']:
        path=base/f'{name}.py';path.write_text(source(f'python/forge3d/{name}.py'),encoding='utf-8')
        spec=importlib.util.spec_from_file_location(f'forge3d.{name}',path);module=importlib.util.module_from_spec(spec);sys.modules[spec.name]=module;spec.loader.exec_module(module)
        setattr(package,name,module)
    for name in package.diagnostics.__all__: setattr(package,name,getattr(package.diagnostics,name))
    native=package.label_plan
    for name in native.__all__: setattr(package,name,getattr(native,name))
    for name in package.map_scene.__all__: setattr(package,name,getattr(package.map_scene,name))
    crs=types.ModuleType('forge3d.crs');crs.transform_coords=lambda coords,*args:coords;sys.modules['forge3d.crs']=crs;package.crs=crs
    FEATURE_CASES=[]
    original_features=package.map_scene.LabelLayer.from_features
    def record_features(cls,features,**kwargs):
        features=list(features);result=original_features(features,**kwargs)
        inputs=dict(kwargs);inputs['features']=features
        if 'terrain_sampler' in inputs: inputs['terrain_sampler']='elevation=x+y+z'
        if inputs.get('target_crs') and inputs.get('crs')!=inputs.get('target_crs'): inputs['transform_coords']='xy=[1000,2000]'
        caller=next((f for f in inspect.stack() if f.function.startswith('test_')),None)
        FEATURE_CASES.append({'source':f'tests/{Path(caller.filename).name}:{caller.function}' if caller else 'unknown','input':serial(inputs),'expected':serial(result.to_dict())})
        return result
    package.map_scene.LabelLayer.from_features=classmethod(record_features)
    original=native.LabelPlan.compile
    def record(**kwargs):
        result=original(**kwargs)
        inputs=dict(kwargs);inputs['camera']={}
        terrain=inputs.get('terrain')
        if terrain is not None and not isinstance(terrain,dict):
            samples={}
            for label in result.accepted:
                samples[label.label_id]=dict(label.candidate.terrain_sample)
            for label in result.rejected:
                if 'terrain_sample' in label.details: samples[label.label_id]=dict(label.details['terrain_sample'])
            inputs['terrain']={'samples':samples}
        caller=next((f for f in inspect.stack() if f.function.startswith('test_')),None)
        CASES.append({'source':f'tests/{Path(caller.filename).name}:{caller.function}' if caller else 'unknown','input':serial(inputs),'expected':normalize(result.to_dict())})
        return result
    native.LabelPlan.compile=staticmethod(record)
    paths=[]
    for file in [f'test_label_plan_{name}.py' for name in TESTS]+EXTRA:
        path=base/file;path.write_text(source(f'tests/{file}'),encoding='utf-8');paths.append(str(path))
    import pytest
    status=pytest.main(['-q','--confcutdir',str(base),'-k','not docs and not support_docs and not quickstart_names',*paths])
    if status: raise SystemExit(status)

    # Review regressions are additional probes of the immutable implementation,
    # not invented expected payloads and not counted as original pytest tests.
    review_labels = [
        {'id':'c','text':'River','position':[10,10],'placement_preset':'Curved'},
        {'id':'c','text':'River','position':[10,10],'placement_preset':'CURVED'},
        {'id':'c','text':'Road','geometry':{'type':'LineString','coordinates':[[10,10],[90,10]]},'placement_preset':'Road'},
        {'id':'c','text':'Ridge','geometry':{'type':'LineString','coordinates':[[10,10],[90,10]]},'placement_preset':'line','terrain_mode':'required'},
        {'id':'c','text':'Ridge','geometry':{'type':'LineString','coordinates':[[10,10],[90,10]]},'repeat_distance':20,'requires_terrain':True},
        {'id':'c','text':'Null','geometry':{'type':'Point','coordinates':[None,5]}},
    ]
    for label in review_labels:
        native.LabelPlan.compile(labels=[label], camera={}, viewport=[100,100])
        CASES[-1]['source']='review regression via pinned native LabelPlan.compile'
    class MissingTerrain:
        def sample(self,*args): return None
    native.LabelPlan.compile(labels=[{'id':'c','text':'DEM','position':[10,10],'terrain_mode':'required'}],camera={},viewport=[100,100],terrain=MissingTerrain())
    CASES[-1]['source']='review no-data sampler via pinned native LabelPlan.compile'
    for features,kwargs in [
        ([{'id':'flat','type':'Point','coordinates':[10,20],'name':'Flat'}], {}),
        ([{'id':'crs','geometry':{'type':'Point','coordinates':[10,20]},'properties':{'name':'Same'}}], {'crs':'EPSG:4326','target_crs':'epsg:4326'}),
        ([{'id':'null','geometry':{'type':'Point','coordinates':[10,20]},'properties':{'name':None}}], {}),
    ]:
        package.map_scene.LabelLayer.from_features(features,**kwargs)
        FEATURE_CASES[-1]['source']='review regression via pinned native LabelLayer.from_features'
    package.map_scene.LabelLayer.from_features([{'id':'no-data','type':'Point','coordinates':[10,20],'name':'DEM'}],terrain_sampling='required',terrain_sampler=lambda *args:None)
    FEATURE_CASES[-1]['source']='review no-data sampler via pinned native LabelLayer.from_features'
    FEATURE_CASES[-1]['input']['terrain_sampler']='no-data'

output=ROOT/'crates/forge3d-web/tests/fixtures/w13/native-label-plan.json'
output.parent.mkdir(parents=True,exist_ok=True)
output.write_text(json.dumps({'baseline':BASELINE,'normalization':'Only ordering_key strings are excluded, because Python and JavaScript JSON spell integer-valued floats differently. All output array orders, IDs, numeric values, diagnostics and reasons are compared.','cases':CASES},indent=2,ensure_ascii=True)+'\n',encoding='utf-8')
print(f'Wrote {len(CASES)} native LabelPlan oracle calls')

feature_output=output.with_name('native-label-features.json')
feature_output.write_text(json.dumps({'baseline':BASELINE,'cases':FEATURE_CASES},indent=2,ensure_ascii=True)+'\n',encoding='utf-8')
print(f'Wrote {len(FEATURE_CASES)} native feature oracle calls')
