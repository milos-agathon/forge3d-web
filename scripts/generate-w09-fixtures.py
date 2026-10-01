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
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "crates/forge3d-web/tests/golden/w09"
REV = "bf8db93"
OUT.mkdir(parents=True, exist_ok=True)

def native(path):
    return subprocess.check_output(["git", "show", f"{REV}:{path}"], cwd=ROOT).decode()

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
 let env=formats::hdr::HdrImage{width:1,height:1,data:vec![0.6,0.75,1.0]};
 let material=ReflectionTerrainMaterial{albedo_mode:ReflectionAlbedoMode::Material,colormap_strength:0.0,raw_height_range:(0.0,1.0),overlay:None,grass_color:[0.3,0.4,0.2],dirt_color:[0.3,0.4,0.2],rock_color:[0.3,0.4,0.2],snow_color:[0.3,0.4,0.2],snow_enabled:false,snow_altitude_min:0.0,snow_altitude_blend:1.0,snow_slope_max_deg:45.0,snow_slope_blend_deg:1.0,snow_aspect_influence:0.0,rock_enabled:false,rock_slope_min_deg:45.0,rock_slope_blend_deg:1.0,wetness_enabled:false,wetness_strength:0.0,wetness_slope_influence:0.0};
 let mut cases=vec![];
 for ridge in [false,true] {
  let heights:Vec<f32>=(0..33*33).map(|i|if ridge && ((i%33) as f32-16.0).abs()>6.0 {20.0}else{0.0}).collect();
  let placement=ProbePlacement::new(ProbeGridDesc{origin:[0.0;2],spacing:[1.0;2],dims:[1,1],height_offset:5.0,influence_radius:1.0},vec![[0.0,0.0,5.0]]);
  let sh=HeightfieldAnalyticalBaker{heightfield:heights.clone(),height_dims:(33,33),terrain_span:[64.0;2],sky_color:[0.6,0.75,1.0],sky_intensity:1.0,ray_count:64,max_trace_distance:32.0}.bake(&placement).unwrap();
  let cube=HeightfieldReflectionBaker{heightfield:&heights,height_dims:(33,33),terrain_span:[64.0;2],z_scale:1.0,resolution:4,prefilter_sample_count:8,trace_steps:96,trace_refine_steps:8,max_trace_distance:32.0,material:material.clone(),lighting:ReflectionCaptureLighting{env_image:Some(&env),env_intensity:1.0,env_rotation_rad:0.0,light_dir:[0.0,0.0,1.0],light_color:[1.0;3],light_intensity:1.0}}.bake(&placement).unwrap();
  let coefficients:Vec<f32>=sh.probes[0].coeffs.iter().flatten().copied().collect();
  let mips:Vec<Vec<f32>>=cube.probes[0].mips.iter().map(|m|m.texels.iter().flatten().copied().collect()).collect();
  cases.push(serde_json::json!({"ridge":ridge,"heights":heights,"coefficients":coefficients,"reflectionMips":mips}));
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
print(f"Wrote independent native W09 fixtures to {OUT}")
