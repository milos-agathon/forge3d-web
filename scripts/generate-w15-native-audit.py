"""Freeze the W15 native suite inventory and its concrete browser adaptations."""
import ast
import hashlib
import json
import subprocess
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
FINAL = "1f4084af428dc699bdcd108b029736cb73903926"
HISTORICAL = "7b08af8"
DEEP = "bf8db93233e5158f6d226991fc5d230832c2d806"
GEOMETRY = "crates/forge3d-web/tests/unit/w15-geometry.test.ts"
CONTRACTS = "crates/forge3d-web/tests/unit/w15-native-contracts.test.ts"
BUILDINGS = "crates/forge3d-web/tests/unit/w15-buildings.test.ts"
IO = "crates/forge3d-web/tests/unit/w15-io.test.ts"
BROWSER = "crates/forge3d-web/tests/playwright/w15_geometry.spec.ts"
# Suite-level links record outcomes, not a claim that Python/backend APIs ship in ESM.
GROUPS = [
 (HISTORICAL, ["test_f1_extrude"], [(GEOMETRY,"square extrusion preserves native 24 vertices / 12 triangles"),(GEOMETRY,"dtype, dimensions, path, and non-finite input are typed errors")]),
 (HISTORICAL, ["test_f2_osm_buildings","test_f2_osm_geojson"], [(BUILDINGS,"GeoJSON buildings are actual indexed volumes with stable IDs/materials"),(CONTRACTS,"custom GeoJSON height keys and MultiPolygon IDs retain native geometry")]),
 (HISTORICAL, ["test_f3_thick_polyline","test_f17_curves_joins"], [(CONTRACTS,"miter bevel and round ribbon joins preserve native corner spans and counts"),(GEOMETRY,"planar UV displacement equals native XY sampling and bevel depth/width is consistent")]),
 (HISTORICAL, ["test_f4_obj_import","test_f4_obj_import_neg_indices","test_f5_groups_roundtrip","test_f5_obj_export"], [(IO,"OBJ negative indices, groups, materials, UVs and normal fidelity"),(BROWSER,"browser format fidelity, image/HDR IO and typed failures")]),
 (HISTORICAL, ["test_f4_obj_import_polygons"], [(IO,"OBJ fans triangulate, and normals are generated if absent"),(IO,"OBJ handles missing attributes and rejects corrupt references")]),
 (HISTORICAL, ["test_f6_stl_export"], [(IO,"binary and ASCII STL roundtrip geometry, facet count, and normals"),(BROWSER,"browser format fidelity, image/HDR IO and typed failures")]),
 (HISTORICAL, ["test_f7_multipolygonz_obj"], [(CONTRACTS,"MultiPolygonZ exports disjoint surfaces with native counts and normals"),(BUILDINGS,"MultiPolygonZ handles non-horizontal surfaces, holes and exact source elevations")]),
 (HISTORICAL, ["test_f8_weld"], [(CONTRACTS,"historical weld tolerances and collapsed vertex count are preserved"),(GEOMETRY,"weld preserves UV seams and removes collapsed triangles deterministically")]),
 (HISTORICAL, ["test_f9_primitives"], [(GEOMETRY,"exact topology and f32 attributes <=1e-5"),(GEOMETRY,"unit box has per-face normals/UVs and a closed geometric boundary")]),
 (HISTORICAL, ["test_f10_uv_unwrap"], [(GEOMETRY,"UV unwrap and merge retain shape and offsets"),(GEOMETRY,"native spherical unwrap uses bounding-box radius")]),
 (HISTORICAL, ["test_f11_subdivision"], [(GEOMETRY,"Loop subdivision matches native geometry and oriented topology"),(BROWSER,"real worker transfers both directions")]),
 (HISTORICAL, ["test_f11_subdivision_creases"], [(CONTRACTS,"crease edge positions follow the native smooth and midpoint rules")]),
 (HISTORICAL, ["test_f12_displacement","test_f12_uv_tangents"], [(GEOMETRY,"native displacement and normal recomputation"),(GEOMETRY,"planar UV displacement equals native XY sampling and bevel depth/width is consistent"),(CONTRACTS,"registered native TBN wrappers adapt to typed attributes and facade exports")]),
 (HISTORICAL, ["test_f14_transform"], [(GEOMETRY,"native pivot, reflection and inverse-transpose"),(GEOMETRY,"transforms reject singularity and retain ownership")]),
 (HISTORICAL, ["test_f15_validate"], [(GEOMETRY,"validation diagnoses invalid indices, duplicates, degenerates and non-manifold edges")]),
 (HISTORICAL, ["test_f16_instancing"], [(CONTRACTS,"native CPU instance expansion adapts to owned shared GPU batches"),(BROWSER,"UV textures and instanced TBN match transformed mesh")]),
 (HISTORICAL, ["test_f17_curves"], [(GEOMETRY,"native ribbon taper and joins"),(GEOMETRY,"native tube parallel transport, counts and caps")]),
 (HISTORICAL, ["test_f18_gltf_import"], [(IO,"independently encoded plain format"),(IO,"glTF external buffers use a resolver and aggregate budget")]),
 (FINAL, ["test_buildings_cityjson"], [(CONTRACTS,"native sample CityJSON contains all five real meshes and BuildingParts"),(BUILDINGS,"CityJSON transform/CRS/highest LOD/source axes are exact"),(CONTRACTS,"missing HTTP sources and malformed building formats return typed browser errors")]),
 (FINAL, ["test_buildings_extrude"], [(BUILDINGS,"GeoJSON buildings are actual indexed volumes with stable IDs/materials"),(CONTRACTS,"custom GeoJSON height keys and MultiPolygon IDs retain native geometry"),(CONTRACTS,"missing HTTP sources and malformed building formats return typed browser errors")]),
 (FINAL, ["test_buildings_materials"], [(CONTRACTS,"all native material value records and differentiation adapt without Python dataclasses"),(BUILDINGS,"native scalar presets, inference and color parsing")]),
 (FINAL, ["test_buildings_roof"], [(BUILDINGS,"native roof inference"),(BUILDINGS,"native roof defaults, priority, aliases, and Orthodox inference")]),
 (FINAL, ["test_mesh_tbn"], [(CONTRACTS,"registered native TBN wrappers adapt to typed attributes and facade exports"),(BROWSER,"UV textures and instanced TBN match transformed mesh")]),
 (FINAL, ["test_p1_building_workflow_support"], [(CONTRACTS,"empty building geometry and missing appearance assets cannot imply success"),(BUILDINGS,"valid assets/UVs still diagnose unsupported textured PBR; Pro is explicit"),(BUILDINGS,"GeoJSON buildings are actual indexed volumes with stable IDs/materials")]),
 (FINAL, ["test_p2_building_texture_diagnostics","test_p2_textured_building_mapscene"], [(BUILDINGS,"exact missing path/UV/format/scalar-fallback diagnostics never imply success"),(BUILDINGS,"blocking building diagnostics prevent scene mutation and scalar fallback")]),
 (FINAL, ["test_p2_building_texture_docs"], [("crates/forge3d-web/docs/geometry-mesh-io.md","A scalar fallback cannot be reported")]),
]
def blob(revision, path):
 return subprocess.check_output(["git","show",revision+":"+path],cwd=ROOT)
def definitions(source):
 return [n.name for n in ast.walk(ast.parse(source)) if isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef)) and n.name.startswith("test_")]
for _,_,ports in GROUPS:
 for file,title in ports:
  if title not in (ROOT/file).read_text(encoding="utf-8"):
   raise ValueError(f"Missing browser port: {file}: {title}")
suites=[]
for revision,names,ports in GROUPS:
 for name in names:
  path="tests/"+name+".py";source=blob(revision,path)
  entry={"revision":revision,"nativePath":path,"sha256":hashlib.sha256(source).hexdigest(),"definitions":definitions(source),"ports":[{"file":p,"test":t} for p,t in ports],"adaptation":"Python/NumPy and synchronous filesystem IO become public ESM, owned f32/u32 buffers and asynchronous URL/File/Blob IO. Geometry uses the native source axes; rendering explicitly converts to Y-up."}
  if "mapscene" in name or "workflow_support" in name:
   entry["adaptation"]="W15 tests direct BuildingLayer geometry/metadata and blocking native diagnostics. The MapScene product wrapper belongs to W18; scalar native placeholder behavior becomes verified functional geometry, while textured requests and zero geometry stay explicit errors."
  if name=="test_mesh_tbn":
   canonical=blob(FINAL,"tests/test_api_contracts.py")
   cls=next(n for n in ast.parse(canonical).body if isinstance(n,ast.ClassDef) and n.name=="TestTbnFunctionsExported")
   entry["importedSuite"]={"revision":FINAL,"nativePath":"tests/test_api_contracts.py","sha256":hashlib.sha256(canonical).hexdigest(),"class":"TestTbnFunctionsExported","definitions":[n.name for n in cls.body if isinstance(n,ast.FunctionDef) and n.name.startswith("test_")]}
   entry["adaptation"]="PyO3 registration and dict fields become callable ESM exports and packed positions/normals/UVs/handed tangents. Native TBN plane width/height count points; primitive resolution counts cells, so use [width-1,height-1]. Correct W04 mirrored handedness is retained."
  suites.append(entry)
assetpath="assets/geojson/sample_buildings.city.json";asset=blob(DEEP,assetpath)
record={"schemaVersion":1,"deepNative":DEEP,"reconciliation":FINAL,"policy":"Source-audited native suite inventory with named browser outcome ports. This records explicit adaptations and owner boundaries; it does not claim Python/PyO3/MapScene APIs run in browsers. Independent executed numeric kernels are mesh-io-v1.json.","suites":suites,"assets":[{"revision":DEEP,"nativePath":assetpath,"file":"crates/forge3d-web/tests/fixtures/w15/native-sample-buildings.city.json","sha256":hashlib.sha256(asset).hexdigest()}]}
(ROOT/"docs/parity/w15-native-audit.json").write_text(json.dumps(record,indent=2)+"\n",encoding="utf-8")
print(f"Recorded {len(suites)} native suites; {sum(len(s['definitions'])+len(s.get('importedSuite',{}).get('definitions',[])) for s in suites)} definitions")
