"""Compile archived native kernels, independently of the browser implementation."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
REVISION = 'bf8db93233e5158f6d226991fc5d230832c2d806'
MODULES = ['primitives', 'weld', 'subdivision', 'transform', 'displacement', 'curves', 'tangents']

with tempfile.TemporaryDirectory(prefix='forge3d-w15-native-') as directory:
    scratch = Path(directory)
    (scratch / 'src' / 'geometry').mkdir(parents=True)
    provenance = []
    for name in MODULES:
        path = f'src/geometry/{name}.rs'
        data = subprocess.check_output(['git', 'show', f'{REVISION}:{path}'], cwd=ROOT)
        compiled = data.replace(b'#[cfg(feature = "extension-module")]\n',b'') if name == 'subdivision' else data
        (scratch / path).write_bytes(compiled)
        provenance.append({'revision': REVISION, 'path': path, 'sha256': hashlib.sha256(data).hexdigest()})
    for path in ['src/mesh/tbn.rs','src/uv/unwrap.rs']:
        data = subprocess.check_output(['git','show',f'{REVISION}:{path}'],cwd=ROOT)
        provenance.append({'revision':REVISION,'path':path,'sha256':hashlib.sha256(data).hexdigest()})
        if path.endswith('tbn.rs'): (scratch/'src/tbn.rs').write_bytes(data)
        else:
            # Extract exact CPU kernels, excluding only PyO3 import/wrappers/cfg.
            source=data.decode();start=source.index('fn compute_bounds(');end=source.index('#[pyfunction]')
            kernel=source[start:end].replace('#[cfg(feature = "extension-module")]','')
            kernel=kernel.replace('fn spherical_unwrap','pub fn spherical_unwrap').replace('fn planar_unwrap','pub fn planar_unwrap')
            (scratch/'src/uv.rs').write_text('use crate::geometry::MeshBuffers;\n'+kernel,encoding='utf-8')
    (scratch / 'Cargo.toml').write_text('''[package]
name = "forge3d-w15-native-reference"
version = "0.0.0"
edition = "2021"
[features]
extension-module = []
[dependencies]
glam = "0.29"
serde_json = "1"
''', encoding='utf-8')
    (scratch / 'src/geometry/mod.rs').write_text('''
#[derive(Clone,Debug,Default)] pub struct MeshBuffers {pub positions:Vec<[f32;3]>,pub normals:Vec<[f32;3]>,pub uvs:Vec<[f32;2]>,pub tangents:Vec<[f32;4]>,pub indices:Vec<u32>}
impl MeshBuffers {pub fn new()->Self{Self::default()} pub fn with_capacity(_:usize,_:usize)->Self{Self::default()} pub fn vertex_count(&self)->usize{self.positions.len()} pub fn triangle_count(&self)->usize{self.indices.len()/3} pub fn is_empty(&self)->bool{self.positions.is_empty()||self.indices.is_empty()}}
#[derive(Debug)] pub struct GeometryError(String);impl GeometryError{pub fn new(s:impl Into<String>)->Self{Self(s.into())}}
pub type GeometryResult<T> = Result<T,GeometryError>;
pub mod primitives;pub mod weld;pub mod subdivision;pub mod transform;pub mod displacement;pub mod curves;pub mod tangents;
''', encoding='utf-8')
    (scratch / 'src/main.rs').write_text('''
#![allow(dead_code)]
mod geometry;mod tbn;mod uv;
use geometry::*;use serde_json::{json,Value};
fn mesh(m:&MeshBuffers)->Value{json!({"positions":m.positions.iter().flatten().collect::<Vec<_>>(),"normals":m.normals.iter().flatten().collect::<Vec<_>>(),"uvs":m.uvs.iter().flatten().collect::<Vec<_>>(),"indices":m.indices,"tangents":m.tangents.iter().flatten().collect::<Vec<_>>()})}
fn main(){let path=[[0.,0.,0.],[1.,0.,0.],[1.,1.,0.],[1.,1.,1.]];let plane=primitives::generate_plane(2,2);let mut displaced=plane.clone();displacement::displace_procedural(&mut displaced,0.2,2.0);let mut scaled=plane.clone();transform::scale_about_pivot(&mut scaled,glam::Vec3::new(-2.,3.,1.),glam::Vec3::new(1.,0.,0.)).unwrap();let welded=weld::weld_mesh(&plane,weld::WeldOptions::default());
let mut tbn_plane=plane.clone();let verts=plane.positions.iter().zip(&plane.normals).zip(&plane.uvs).map(|((p,n),uv)|tbn::TbnVertex{position:glam::Vec3::from(*p),normal:glam::Vec3::from(*n),uv:glam::Vec2::from(*uv)}).collect::<Vec<_>>();let tans=tbn::generate_tbn(&verts,&plane.indices);let mut legacy_tbn_plane=plane.clone();legacy_tbn_plane.tangents=tans.iter().map(|t|[t.tangent.x,t.tangent.y,t.tangent.z,t.handedness]).collect();tbn_plane.tangents=geometry::tangents::generate_tangents(&plane);
let mut mirrored=tbn_plane.clone();for uv in &mut mirrored.uvs {uv[0]=1.-uv[0];}let mv=verts.iter().map(|v|tbn::TbnVertex{uv:glam::Vec2::new(1.-v.uv.x,v.uv.y),..v.clone()}).collect::<Vec<_>>();let _ = mv;mirrored.tangents=geometry::tangents::generate_tangents(&mirrored);
let mut spherical=primitives::generate_sphere(6,8,0.5);uv::spherical_unwrap(&mut spherical);
let cases=json!({"plane":mesh(&plane),"legacyTbnPlane":mesh(&legacy_tbn_plane),"tbnPlane":mesh(&tbn_plane),"tbnMirrored":mesh(&mirrored),"sphericalUv":mesh(&spherical),"sphere":mesh(&primitives::generate_sphere(6,8,0.5)),"cylinder":mesh(&primitives::generate_cylinder(8,2,0.5,true)),"cone":mesh(&primitives::generate_cone(8,2,0.5,true)),"torus":mesh(&primitives::generate_torus(6,4,0.35,0.15)),"ribbon":mesh(&curves::generate_ribbon(&path,0.4,0.2,"miter",4.,None)),"tube":mesh(&curves::generate_tube(&path,0.4,0.2,8,true)),"subdivision":mesh(&subdivision::subdivide_triangles(&plane,1)),"adaptive":mesh(&subdivision::subdivide_adaptive(&plane,Some(0.2),None,3,None,true)),"displacement":mesh(&displaced),"scale":mesh(&scaled),"weld":mesh(&welded.mesh)});println!("{}",cases);}
''', encoding='utf-8')
    env = dict(os.environ, CARGO_TARGET_DIR=str(Path(os.environ['USERPROFILE']) / '.codex' / 'w15-native-target'))
    output = subprocess.check_output(['cargo', 'run', '--quiet', '--manifest-path', str(scratch / 'Cargo.toml')], cwd=ROOT, env=env)
    result = {'id': 'mesh-io-v1', 'provenance': provenance, 'tolerances': {'attributeMaxAbs': 1e-5, 'hausdorffSceneDiagonal': 1e-5, 'countsTopologyExact': True}, 'cases': json.loads(output)}
    dest = ROOT / 'crates/forge3d-web/tests/fixtures/w15/mesh-io-v1.json'
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8', newline='\n')
    print(f'Wrote {dest} ({len(result["cases"])} independently executed native cases)')
