"""Independent laspy/lazrs oracle plus byte-defined EPT/OGC fixtures. No browser decoder is used."""
from pathlib import Path
import sys, json, hashlib, struct, subprocess, ast, types
import numpy as np
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT.parents[1] / '.tools/python'))
import laspy
from w16_fixture_workload import build_branching_ept, build_overview_copc, topdown_view, additive_reference, in_frustum
from laspy import CopcReader
DEST = ROOT / 'tests/fixtures/w16'
DEST.mkdir(parents=True, exist_ok=True)
def digest(b): return hashlib.sha256(b).hexdigest()
def data_record(points):
    xyz = np.column_stack((points.x, points.y, points.z)).astype('<f8')
    colors = np.column_stack((points.red, points.green, points.blue)).astype(np.uint16) if 'red' in points.point_format.dimension_names else None
    rgb = (colors >> 8).astype(np.uint8) if colors is not None else None
    return xyz, rgb
def expectation(points):
    xyz, rgb = data_record(points)
    return {'count':len(points),'positionsSha256':digest(xyz.tobytes()),'colorsSha256':digest(rgb.tobytes()) if rgb is not None else None,
            'bounds':{'min':xyz.min(axis=0).tolist(),'max':xyz.max(axis=0).tolist()},'firstPositions':xyz[:3].reshape(-1).tolist(),
            'firstColors':rgb[:3].reshape(-1).tolist() if rgb is not None else None}
autzen=laspy.read(DEST/'autzen_trim.laz')
copc=laspy.read(DEST/'ellipsoid.copc.laz')
with CopcReader.open(DEST/'ellipsoid.copc.laz') as reader:
    root=reader.query(level=0)
    root_expected=expectation(root)
    copc_info={'center':reader.copc_info.center.tolist(), 'halfSize':reader.copc_info.halfsize, 'spacing':reader.copc_info.spacing}
xyz,rgb=data_record(autzen.points[:128])
ept=DEST/'ept';(ept/'ept-data').mkdir(parents=True,exist_ok=True);(ept/'ept-hierarchy').mkdir(exist_ok=True)
# Real Autzen coordinates encoded as asymmetric float64 EPT dimensions.
schema=[{'name':a,'type':'floating','size':8} for a in ['Z','X','Y']]+[{'name':a,'type':'unsigned','size':2} for a in ['Red','Green','Blue','Intensity']]
records=b''.join(struct.pack('<dddHHHH',p[2],p[0],p[1],*(list((rgb[i].astype(np.uint16)<<8)) if rgb is not None else [65535]*3),int(autzen.intensity[i])) for i,p in enumerate(xyz))
mins=xyz.min(axis=0);maxs=xyz.max(axis=0);span=float(max(maxs-mins));bounds=list(mins)+list(mins+span)
(ept/'ept.json').write_text(json.dumps({'bounds':bounds,'boundsConforming':list(mins)+list(maxs),'points':128,'span':128,'schema':schema,'dataType':'binary','hierarchyType':'json','srs':{'authority':'EPSG','horizontal':2992}}),encoding='utf8')
(ept/'ept-data/0-0-0-0.bin').write_bytes(records)
(ept/'ept-hierarchy/0-0-0-0.json').write_text('{"0-0-0-0":128}',encoding='utf8')
# W00 pins dimensions and budgets; this branching spatial layout is W16's design.
workload_meta = build_branching_ept(autzen, DEST)
workload=DEST/'workload-ept'; wspan=1024.
overview_path, overview_root, overview_data, overview_chunks = build_overview_copc(autzen, DEST)
overview_bounds = expectation(overview_data.points)['bounds']
overview_center = [(a+b)/2 for a,b in zip(overview_bounds['min'],overview_bounds['max'])]
overview_view = topdown_view(overview_center,4*max(np.array(overview_bounds['max'])-overview_bounds['min']),480,4/3)
overview_meta = {'count':len(overview_data.points),'chunks':overview_chunks,'root':expectation(overview_root),'bounds':overview_bounds,'view':overview_view,'options':{'mode':'add','pointBudget':5000},'derivation':'Two real Autzen patches; second translated in X. Coarse 512-point sample contains all XYZ extrema and every occupied octant; eight additive leaf buckets. Independently compressed and decoded by laspy/lazrs.'}
assert overview_meta['root']['bounds']==overview_bounds

def tile(magic,feature,binary,payload=b'',batch=None):
    ft=json.dumps(feature,separators=(',',':')).encode();ft+=b' '*(-(28+len(ft))%8)
    bt=b'' if batch is None else json.dumps(batch,separators=(',',':')).encode()
    if bt:bt+=b' '*(-(28+len(ft)+len(binary)+len(bt))%8)
    return magic+struct.pack('<IIIIII',1,28+len(ft)+len(binary)+len(bt)+len(payload),len(ft),len(binary),len(bt),0)+ft+binary+bt+payload
# PNTS includes RTC and RGB; no decoder-generated expected values.
position=np.array([[-.6,0,0],[0,0,0],[.6,0,0]],dtype='<f4')
colors=bytes([255,0,0,0,255,0,0,0,255]);binary=position.tobytes()+colors
binary+=b'\0'*(-len(binary)%8)
(DEST/'colored.pnts').write_bytes(tile(b'pnts',{'POINTS_LENGTH':3,'POSITION':{'byteOffset':0},'RGB':{'byteOffset':36}},binary))
quant=struct.pack('<HHHHHH',0,32768,65535,65535,0,32768)+bytes([255,255,0,0,255,255]);quant+=b'\0'*(-len(quant)%8)
(DEST/'quantized.pnts').write_bytes(tile(b'pnts',{'POINTS_LENGTH':2,'POSITION_QUANTIZED':{'byteOffset':0},'QUANTIZED_VOLUME_SCALE':[4,8,12],'QUANTIZED_VOLUME_OFFSET':[10,20,30],'RTC_CENTER':[10000000,20000000,30000000],'RGB':{'byteOffset':12}},quant))
glb=(ROOT/'tests/fixtures/w15/triangle.glb').read_bytes()
(DEST/'triangle.b3dm').write_bytes(tile(b'b3dm',{'BATCH_LENGTH':1,'RTC_CENTER':[4,5,6]},b'',glb,{'name':['native-triangle']}))
tiles={'asset':{'version':'1.0'},'geometricError':100,'root':{'boundingVolume':{'sphere':[0,0,0,2]},'geometricError':10,'refine':'ADD','content':{'uri':'colored.pnts'},'children':[{'boundingVolume':{'box':[4,5,6,2,0,0,0,2,0,0,0,2]},'geometricError':0,'content':{'uri':'triangle.b3dm'}}]}}
(DEST/'tileset.json').write_text(json.dumps(tiles),encoding='utf8')
(DEST/'external.json').write_text(json.dumps({'asset':{'version':'1.0'},'root':{'boundingVolume':{'sphere':[0,0,0,2]},'geometricError':10,'content':{'uri':'tileset.json'}}}),encoding='utf8')
# Hash-pin deepest native code/tests and retain the source so tests are portable.
commit='bf8db93233e5158f6d226991fc5d230832c2d806';native=[]
paths=['src/pointcloud/'+p+'.rs' for p in ['copc','copc_decode','ept','octree','renderer','traversal']]+['src/tiles3d/'+p+'.rs' for p in ['b3dm','pnts','bounds','sse','traversal','tileset','tile']]+['python/forge3d/pointcloud.py','python/forge3d/tiles3d.py']+['tests/'+p+'.py' for p in ['test_api_contracts','test_copc_laz_fixture','test_pointcloud_gpu_integration','test_pointcloud_lod','test_3dtiles_parse','test_3dtiles_sse']]
for path in paths:
    source=subprocess.check_output(['git','show',commit+':'+path],cwd=ROOT)
    output='native/'+path.replace('/','__');(DEST/output).parent.mkdir(exist_ok=True);(DEST/output).write_bytes(source)
    native.append({'commit':commit,'path':path,'fixture':output,'sha256':digest(source)})
# Execute pinned native public selection code, excluding only the unrelated
# relative diagnostics import. Expectations are never generated by the TS port.
def native_module(name, filename):
    tree=ast.parse((DEST/'native'/filename).read_text(encoding='utf8'))
    tree.body=[node for node in tree.body if not isinstance(node,ast.ImportFrom) or node.level==0]
    module=types.ModuleType(name);sys.modules[name]=module
    exec(compile(tree,filename,'exec'),module.__dict__)
    return module
pc_native=native_module('w16_native_points','python__forge3d__pointcloud.py')
tiles_native=native_module('w16_native_tiles','python__forge3d__tiles3d.py')
camera_records=[]
for source,dataset in [('copc',pc_native.CopcDataset(DEST/'ellipsoid.copc.laz')),('ept',pc_native.open_ept(ept/'ept.json'))]:
    center=dataset.bounds.center();span=max(dataset.bounds.size())
    for distance in [2,10000]:
        camera=[center[0]+span*.1,center[1]+span*.2,center[2]+span*distance]
        renderer=pc_native.PointCloudRenderer(point_budget=100000,viewport_height=1080,fov_y=np.pi/4)
        visible=renderer.get_visible_nodes(dataset,tuple(camera))
        camera_records.append({'source':source,'view':{'position':camera,'viewportHeight':1080,'fovY':float(np.pi/4)},'options':{'pointBudget':100000,'mode':'replace'},
          'nodes':[{'key':str(n.key),'pointCount':n.point_count,'sse':round(float(renderer._compute_screen_size(n.bounds,tuple(camera))),9)} for n in visible]})
wdataset=pc_native.open_ept(workload/'ept.json');wcenter=wdataset.bounds.center()
for i in range(64):
    angle=i/64*2*np.pi;distance=wspan*2**(-1+8*i/63)
    camera=[wcenter[0]+np.cos(angle)*wspan*.2,wcenter[1]+np.sin(angle)*wspan*.2,wcenter[2]+distance]
    renderer=pc_native.PointCloudRenderer(point_budget=1000000,viewport_height=1080,fov_y=np.pi/4)
    visible=renderer.get_visible_nodes(wdataset,tuple(camera))
    camera_records.append({'source':'workload-ept','oracle':'native-public-replace','view':{'position':camera,'viewportHeight':1080,'fovY':float(np.pi/4)},'options':{'pointBudget':1000000,'mode':'replace'},'nodes':[{'key':str(n.key),'pointCount':n.point_count,'sse':round(float(renderer._compute_screen_size(n.bounds,tuple(camera))),9)} for n in visible]})
# Native public API has neither ADD nor frustum selection. Retain the exact
# native REPLACE records above, and independently extend its SSE/priority with
# the required ADD policy and homogeneous-corner frustum oracle in Python.
add_options={'pointBudget':300000,'mode':'add','maxDepth':8,'minSpacing':.01,'sseThreshold':2}
add_records=[]
for i in range(64):
    angle=i/64*2*np.pi
    center=[wcenter[0]+np.cos(angle)*wspan*.28,wcenter[1]+np.sin(angle)*wspan*.28,wcenter[2]]
    view=topdown_view(center,wspan*(.85+.3*np.sin(angle*2)))
    renderer=pc_native.PointCloudRenderer(point_budget=add_options['pointBudget'],viewport_height=1080,fov_y=np.pi/4)
    nodes=additive_reference(wdataset,renderer,view,add_options)
    keys={n['key'] for n in nodes}
    for key in keys:
        d,x,y,z=map(int,key.split('-'))
        if d: assert f'{d-1}-{x//2}-{y//2}-{z//2}' in keys
    assert sum(n['pointCount'] for n in nodes)<=add_options['pointBudget']
    record={'source':'workload-ept','oracle':'independent-additive-policy/native-SSE','view':view,'options':add_options,'nodes':nodes}
    add_records.append(record)
    camera_records.append(record)
unique=len({tuple(sorted(n['key'] for n in r['nodes'])) for r in add_records})
assert unique>=32, unique
all_nodes=[wdataset.root_node()]
for node in all_nodes: all_nodes.extend(wdataset.children(node.key))
all_bounds=[n.bounds for n in all_nodes]
culled=[sum(not in_frustum(bounds,r['view']) for bounds in all_bounds) for r in add_records]
assert min(culled)>0
negative_options={**add_options,'pointBudget':wdataset.root_node().point_count-1}
assert additive_reference(wdataset,renderer,add_records[0]['view'],negative_options)==[]
assert additive_reference(wdataset,renderer,add_records[0]['view'],negative_options,allow_orphans=True)
workload_meta['selectionCoverage']={'uniqueAdditiveSets':unique,'minCulledNodes':min(culled),'maxCulledNodes':max(culled),'orphanNegativeControl':True}
overview_dataset=pc_native.CopcDataset(overview_path)
overview_meta['nodes']=additive_reference(overview_dataset,pc_native.PointCloudRenderer(point_budget=5000,viewport_height=480,fov_y=np.pi/4),overview_view,{**add_options,'pointBudget':5000})
assert overview_meta['nodes'][0]['key']=='0-0-0-0'

tile_records=[]
for camera in [[0,0,10],[0,0,10000]]:
    renderer=tiles_native.Tiles3dRenderer();renderer.set_viewport(1080,np.pi/4)
    visible=renderer.get_visible_tiles(tiles_native.load_tileset(DEST/'tileset.json'),tuple(camera))
    tile_records.append({'view':{'position':camera,'viewportHeight':1080,'fovY':float(np.pi/4)},'nodes':[{'uri':n.tile.content.uri,'depth':n.depth,'sse':round(float(n.sse),9)} for n in visible]})
manifest={'schemaVersion':1,'fixtureId':'copc-ept-tiles-v1','oracle':{'laspy':laspy.__version__,'lazrs':'0.8.2'},'autzen':expectation(autzen.points),'copc':expectation(copc.points),'copcRoot':root_expected,'copcInfo':copc_info,
 'ept':{'count':128,'positionsSha256':digest(xyz.tobytes()),'colorsSha256':digest(rgb.tobytes()) if rgb is not None else digest(bytes([255]*384))},
 'workloadEpt':workload_meta,'overviewCopc':overview_meta,
 'nativeSources':native,'upstream':json.loads((DEST/'upstream.json').read_text(encoding='utf-8-sig')),
 'cameraSelections':camera_records,'tileSelections':tile_records,'sseDecimalPlaces':9,
 'performance':{'durationMs':600000,'viewport':[1920,1080],'profiles':{'reference-discrete':{'p95Ms':16.7,'cpuBudgetBytes':1610612736,'gpuBudgetBytes':3221225472},'reference-integrated':{'p95Ms':33.3,'cpuBudgetBytes':1073741824,'gpuBudgetBytes':2147483648}},'localBudgetBytes':268435456,'localQualification':'Chromium preflight; publish exact adapter rather than inferring W00 hardware qualification'},
 'tolerances':{'boundsRelative':1e-5,'initialRangeFraction':0.25}}
manifest['files']=[{'path':str(p.relative_to(DEST)).replace('\\','/'),'bytes':p.stat().st_size,'sha256':digest(p.read_bytes())} for p in sorted(DEST.rglob('*')) if p.is_file() and p.name!='copc-ept-tiles-v1.json']
(DEST/'copc-ept-tiles-v1.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf8')
print(json.dumps({k:manifest[k] for k in ['autzen','copc','copcRoot','ept']},indent=2))
