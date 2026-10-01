"""Regenerate W09 oracles directly from bf8db93, independent of the web port.

Requires NumPy and the offline Cargo cache. No native extension or GPU is used.
"""
from pathlib import Path
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import types
import argparse
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--output', type=Path, default=ROOT / 'crates/forge3d-web/tests/golden/w09')
args = parser.parse_args()
OUT = args.output
REV = "bf8db93"
OUT.mkdir(parents=True, exist_ok=True)

def native(path):
    return subprocess.check_output(["git", "-c", f"safe.directory={ROOT.as_posix()}", "show", f"{REV}:{path}"], cwd=ROOT).decode()

# Geometry is only a type annotation on the generator paths being exercised.
package = types.ModuleType("w09_native")
package.__path__ = []
sys.modules[package.__name__] = package
geometry = types.ModuleType("w09_native.geometry")
geometry.MeshBuffers = object
geometry._mesh_to_py = lambda mesh: mesh
sys.modules[geometry.__name__] = geometry
scatter = types.ModuleType("w09_native.terrain_scatter")
scatter.__package__ = "w09_native"
sys.modules[scatter.__name__] = scatter
source = native("python/forge3d/terrain_scatter.py")
exec(compile(source, "bf8db93:terrain_scatter.py", "exec"), scatter.__dict__)
heights = np.asarray([[r * .7 + c * .3 for c in range(9)] for r in range(7)], dtype=np.float32)
terrain = scatter.TerrainScatterSource(heights, terrain_width=64, z_scale=1.3)
random = scatter.seeded_random_transforms(terrain, count=32, seed=42, scale_range=(.8,1.4), yaw_range_deg=(0,360))
grid = scatter.grid_jitter_transforms(terrain, spacing=16, seed=123, jitter=.5, scale_range=(.8,1.4), yaw_range_deg=(0,360))
transform_truth = {"baseline": REV, "sourceSha256": hashlib.sha256(source.encode()).hexdigest(), "numpy": np.__version__,
    "width":9,"height":7,"heights":heights.ravel().tolist(),"terrainWidth":64,"zScale":1.3,
    "random":random.ravel().tolist(),"grid":grid.ravel().tolist()}
cases=[]
for name,mode,options in [
    ('random-filter-edge','random',dict(count=24,seed=42,edge_margin=10,filters=scatter.TerrainScatterFilters(min_elevation=1,max_elevation=5,max_slope_deg=15))),
    ('grid-filter-edge','grid',dict(spacing=8,seed=123,jitter=.5,edge_margin=10,filters=scatter.TerrainScatterFilters(min_elevation=1,max_elevation=5,max_slope_deg=15))),
    ('mask-edge','mask',dict(spacing=8,seed=123,jitter=.5,edge_margin=10)),
    ('mask-resampled-filter','mask',dict(spacing=8,seed=42,jitter=.5,edge_margin=4,filters=scatter.TerrainScatterFilters(min_elevation=1,max_elevation=5))),
]:
    options.update(scale_range=(.8,1.4),yaw_range_deg=(0,360))
    mask=np.asarray([[.1,.6,.9],[.8,.3,1]],dtype=np.float32) if name=='mask-resampled-filter' else np.full(heights.shape,.6,dtype=np.float32)
    if mode=='random': result=scatter.seeded_random_transforms(terrain,**options)
    elif mode=='grid': result=scatter.grid_jitter_transforms(terrain,**options)
    else: result=scatter.mask_density_transforms(terrain,mask,**options)
    cases.append(dict(name=name,mode=mode,transforms=result.ravel().tolist(),mask=mask.ravel().tolist() if mode=='mask' else None,maskWidth=mask.shape[1],maskHeight=mask.shape[0]))
transform_truth['cases']=cases
(OUT / "transforms.json").write_text(json.dumps(transform_truth, indent=2) + "\n")

with tempfile.TemporaryDirectory(prefix="forge3d-w09-native-oracle-") as temporary:
    temp = Path(temporary)
    directory = temp / "src/terrain/probes"
    directory.mkdir(parents=True)
    digests = {}
    for name in ["types", "baker", "heightfield_baker", "reflection_baker"]:
        original = native(f"src/terrain/probes/{name}.rs")
        digests[name] = hashlib.sha256(original.encode()).hexdigest()
        (directory / f"{name}.rs").write_text(original)
    (temp / "Cargo.toml").write_text('[package]\nname="forge3d-w09-native-oracle"\nversion="0.0.0"\nedition="2021"\n[dependencies]\nthiserror="1"\nserde_json="1"\n')
    (temp / "src/main.rs").write_text(r'''
#![allow(dead_code)]
mod formats { pub mod hdr { pub struct HdrImage {pub width:u32,pub height:u32,pub data:Vec<f32>} } }
mod terrain { pub mod probes {pub mod types;pub mod baker;pub mod heightfield_baker;pub mod reflection_baker;} }
use terrain::probes::{types::*,baker::ProbeBaker,heightfield_baker::HeightfieldAnalyticalBaker,reflection_baker::*};
fn main() {
 let constant_env=formats::hdr::HdrImage{width:1,height:1,data:vec![0.6,0.75,1.0]};
 let material=ReflectionTerrainMaterial{albedo_mode:ReflectionAlbedoMode::Material,colormap_strength:0.0,raw_height_range:(0.0,1.0),overlay:None,grass_color:[0.3,0.4,0.2],dirt_color:[0.3,0.4,0.2],rock_color:[0.3,0.4,0.2],snow_color:[0.3,0.4,0.2],snow_enabled:false,snow_altitude_min:0.0,snow_altitude_blend:1.0,snow_slope_max_deg:45.0,snow_slope_blend_deg:1.0,snow_aspect_influence:0.0,rock_enabled:false,rock_slope_min_deg:45.0,rock_slope_blend_deg:1.0,wetness_enabled:false,wetness_strength:0.0,wetness_slope_influence:0.0};
 let mut cases=vec![];
 for scenario in 0..4 {
  let ridge=scenario==1;
  let asymmetric=scenario>=2;
  let env_data:Vec<f32>=(0..8*4).flat_map(|i|[0.1+(i%8) as f32*0.15,0.2+(i/8) as f32*0.4,0.3+((i*3)%7) as f32*0.1]).collect();
  let directional_env=formats::hdr::HdrImage{width:8,height:4,data:env_data.clone()};
  let env=if asymmetric{&directional_env}else{&constant_env};
  let rotation=if scenario==3{std::f32::consts::FRAC_PI_2}else{0.0};
  let position=if asymmetric{[9.0,-7.0,5.0]}else{[0.0,0.0,5.0]};
  let light=if asymmetric{[0.4,-0.3,0.8660254]}else{[0.0,0.0,1.0]};
  let heights:Vec<f32>=(0..33*33).map(|i|if asymmetric {let x=(i%33) as f32;let y=(i/33) as f32; if x<10.0 && y>15.0 {14.0}else if x>25.0 && y<8.0{7.0}else{0.0}}else if ridge && ((i%33) as f32-16.0).abs()>6.0 {20.0}else{0.0}).collect();
  let placement=ProbePlacement::new(ProbeGridDesc{origin:[0.0;2],spacing:[1.0;2],dims:[1,1],height_offset:5.0,influence_radius:1.0},vec![position]);
  let sh=HeightfieldAnalyticalBaker{heightfield:heights.clone(),height_dims:(33,33),terrain_span:[64.0;2],sky_color:[0.6,0.75,1.0],sky_intensity:1.0,ray_count:64,max_trace_distance:32.0}.bake(&placement).unwrap();
  let cube=HeightfieldReflectionBaker{heightfield:&heights,height_dims:(33,33),terrain_span:[64.0;2],z_scale:1.0,resolution:4,prefilter_sample_count:8,trace_steps:96,trace_refine_steps:8,max_trace_distance:32.0,material:material.clone(),lighting:ReflectionCaptureLighting{env_image:Some(env),env_intensity:1.0,env_rotation_rad:rotation,light_dir:light,light_color:[1.0;3],light_intensity:1.0}}.bake(&placement).unwrap();
  let coefficients:Vec<f32>=sh.probes[0].coeffs.iter().flatten().copied().collect();
  let mips:Vec<Vec<f32>>=cube.probes[0].mips.iter().map(|m|m.texels.iter().flatten().copied().collect()).collect();
  cases.push(serde_json::json!({"ridge":ridge,"name":(["flat","ridge","asymmetric","asymmetric-rotated"][scenario]),"heights":heights,"position":[position[0]+32.0,position[2],position[1]+32.0],"reflectionLighting":if asymmetric{serde_json::json!({"lightDirection":[light[0],light[2],light[1]],"environment":{"width":8,"height":4,"data":env_data},"environmentRotationDegrees":if scenario==3{90}else{0}})}else{serde_json::Value::Null},"coefficients":coefficients,"reflectionMips":mips}));
 }
 println!("{}",serde_json::json!({"cases":cases}));
}
''')
    env = dict(os.environ, CARGO_TARGET_DIR=r"C:\devin-target\forge3d-web")
    result = subprocess.check_output(["cargo","run","--offline","--quiet","--manifest-path",str(temp / "Cargo.toml")],env=env)
    truth = json.loads(result)
    truth.update(baseline=REV, sourceSha256=digests, width=33, height=33, terrainWidth=64,
                 position=[32,5,32], rays=64, resolution=4, reflectionSamples=8)
    (OUT / "probes.json").write_text(json.dumps(truth, indent=2)+"\n")
with tempfile.TemporaryDirectory(prefix="forge3d-w09-qem-oracle-") as temporary:
    temp = Path(temporary)
    simplify_source = native("src/geometry/simplify.rs")
    (temp / "simplify.rs").write_text(simplify_source, encoding="utf-8")
    (temp / "main.rs").write_text((ROOT / "scripts/w09-qem-oracle.rs").read_text(encoding="utf-8"), encoding="utf-8")
    executable = temp / ("oracle.exe" if os.name == "nt" else "oracle")
    subprocess.check_call(["rustc", "--edition=2021", str(temp / "main.rs"), "-o", str(executable)])
    results = json.loads(subprocess.check_output([str(executable)]))
    qem = dict(baseline=REV, sourceSha256=hashlib.sha256(simplify_source.encode()).hexdigest(),
               input=dict(width=6,height=5), results=results)
    (OUT / "qem.json").write_text(json.dumps(qem,indent=2)+"\n")
# Run exact historical CPU cluster/selection/wind functions. The harness replaces
# only GPU upload with JSON emission; it does not exercise a native GPU.
def item(text, marker):
    start=text.index(marker); opening=text.index("{",start); depth=1; end=opening+1
    while depth:
        depth += (text[end]=="{") - (text[end]=="}"); end += 1
    return text[start:end]

with tempfile.TemporaryDirectory(prefix="forge3d-w09-scatter-oracle-") as temporary:
    temp=Path(temporary); (temp/"src").mkdir()
    original=native("src/terrain/scatter.rs")
    helpers="\n".join(item(original, marker) for marker in [
        "fn grid_cell_key(","fn mesh_bounding_radius(","fn max_instance_scale(",
        "pub fn row_major_to_mat4(","fn select_level_index_from_distances("])
    cluster=item(original,"fn build_hlod_cache(")
    prefix=cluster[cluster.index("    let base_mesh_radius"):cluster.index("        // Upload to GPU")]
    cluster_fn="fn native_clusters(source_mesh:&MeshBuffers,transforms_rowmajor:&[[f32;16]],positions:&[[f32;3]],config:&HlodConfig)->Result<Vec<OracleCluster>> {\n"+prefix+"clusters.push(OracleCluster {center,radius,ids:instance_indices.clone(),mesh:simplified});} Ok(clusters)}"
    wind="\n".join(item(original,marker) for marker in ["pub struct ScatterWindSettingsNative {","pub struct ScatterWindUniforms {","pub fn compute_wind_uniforms("])
    wind=wind.replace("pub struct ScatterWindUniforms {","#[derive(Default)] pub struct ScatterWindUniforms {")
    active=item(original,"pub fn hlod_active_clusters(")
    shim=(ROOT/"scripts/w09-qem-oracle.rs").read_text(encoding="utf-8").split("fn source_mesh()")[0]
    (temp/"src/simplify.rs").write_text(native("src/geometry/simplify.rs"),encoding="utf-8")
    (temp/"src/main.rs").write_text(shim+"\nuse glam::{Mat4,Vec3};use std::collections::HashMap;use anyhow::{Result,anyhow};use historical::simplify_mesh;\n"+helpers+cluster_fn+wind+"\n"+item(original,"pub struct HlodConfig {")+"\n"+r'''
struct OracleCluster {center:Vec3,radius:f32,ids:Vec<usize>,mesh:MeshBuffers}
struct OracleCache {clusters:Vec<OracleCluster>,hlod_distance:f32}
struct OracleBatch {hlod_cache:Option<OracleCache>,max_draw_distance:f32}
'''+"impl OracleBatch {"+active+"}\n"+r'''
fn main(){
 let mesh=MeshBuffers{positions:vec![[-1.,0.,0.],[1.,0.,0.],[-1.,10.,0.],[1.,10.,0.]],normals:vec![[0.,0.,1.];4],indices:vec![0,1,2,2,1,3],..Default::default()};
 let instances=[([2.,3.,4.],30f32,0.5),([8.,3.,4.],-15.,1.3),([2.,40.,4.],0.,1.),([8.,40.,4.],90.,0.7),([70.,0.,0.],0.,1.)];
 let positions:Vec<[f32;3]>=instances.iter().map(|x|x.0).collect();
 let transforms:Vec<[f32;16]>=instances.iter().map(|&(p,yaw,scale)|{let(c,s)=(yaw.to_radians().cos()*scale,yaw.to_radians().sin()*scale);[c,0.,s,p[0],0.,scale,0.,p[1],-s,0.,c,p[2],0.,0.,0.,1.]}).collect();
 let config=HlodConfig{hlod_distance:40.,cluster_radius:16.,simplify_ratio:1.};
 let mut clusters=native_clusters(&mesh,&transforms,&positions,&config).unwrap();clusters.sort_by_key(|c|c.ids[0]);
 let records:Vec<_>=clusters.iter().map(|c|serde_json::json!({"ids":c.ids,"center":c.center.to_array(),"radius":c.radius,"positions":c.mesh.positions.iter().flatten().collect::<Vec<_>>(),"normals":c.mesh.normals.iter().flatten().collect::<Vec<_>>(),"indices":c.mesh.indices})).collect();
 let batch=OracleBatch{hlod_cache:Some(OracleCache{clusters,hlod_distance:40.}),max_draw_distance:100.};
 let eyes=[[0.,0.,20.],[0.,0.,100.],[0.,0.,140.],[0.,0.,250.]];
 let active:Vec<_>=eyes.iter().map(|&eye|batch.hlod_active_clusters(Vec3::from_array(eye))).collect();
 let distances=[0.,10.,10.001,25.,25.001,90.];let lod:Vec<_>=distances.iter().map(|&d|select_level_index_from_distances(&[10.,25.,f32::INFINITY],d)).collect();
 let settings=ScatterWindSettingsNative{enabled:true,direction_deg:123.,speed:0.5,amplitude:2.,rigidity:0.2,bend_start:0.1,bend_extent:0.8,gust_strength:1.,gust_frequency:0.3,fade_start:5.,fade_end:100.};
 let w=compute_wind_uniforms(&settings,0.37,12.,1.);
 println!("{}",serde_json::json!({"transforms":transforms.iter().flatten().collect::<Vec<_>>(),"clusters":records,"eyes":eyes,"activeClusters":active,"lodDistances":distances,"lodIndices":lod,"wind":{"phase":w.wind_phase,"vector":w.wind_vec_bounds,"fade":w.wind_bend_fade}}));
}
''',encoding="utf-8")
    (temp/"Cargo.toml").write_text('[package]\nname="forge3d-w09-scatter-oracle"\nversion="0.0.0"\nedition="2021"\n[dependencies]\nanyhow="1"\nglam="0.24"\nserde_json="1"\n',encoding="utf-8")
    result=subprocess.check_output(["cargo","run","--offline","--quiet","--manifest-path",str(temp/"Cargo.toml")],env=dict(os.environ,CARGO_TARGET_DIR=r"C:\devin-target\forge3d-web"))
    truth=json.loads(result);truth.update(baseline=REV,sourceSha256=hashlib.sha256(original.encode()).hexdigest(),scope="Historical CPU cluster building, selection, LOD and wind uniforms; no GPU upload")
    (OUT/"scatter-runtime.json").write_text(json.dumps(truth,indent=2)+"\n",encoding="utf-8")
shader=native("src/shaders/mesh_instanced.wgsl")
(OUT/"scatter-shader.json").write_text(json.dumps(dict(baseline=REV,path="src/shaders/mesh_instanced.wgsl",sourceSha256=hashlib.sha256(shader.encode()).hexdigest(),source=shader),indent=2)+"\n",encoding="utf-8")
print(f"Wrote independent native W09 fixtures to {OUT}")
