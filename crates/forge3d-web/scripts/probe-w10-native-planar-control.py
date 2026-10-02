from pathlib import Path
import ast, subprocess, tempfile
import numpy as np
import forge3d as f3d
from forge3d.terrain_params import PomSettings,ReflectionSettings,SkySettings,make_terrain_params_config
root=Path(__file__).resolve().parents[3]
source=subprocess.check_output(['git','show','1f4084a:tests/test_terrain_visual_goldens.py'],cwd=root).decode()
tree=ast.parse(source);functions={'_create_test_hdr','_build_heightmap','_build_overlay','_build_water_mask','_render_scene'}
exec(compile(ast.Module(body=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in functions],type_ignores=[]),'native-fixture','exec'),globals())
renderer=f3d.TerrainRenderer(f3d.Session(window=False))
with tempfile.TemporaryDirectory() as tmp:
 hdr=Path(tmp)/'env.hdr';_create_test_hdr(str(hdr));ibl=f3d.IBL.from_hdr(str(hdr),intensity=1)
 for mask_scale,theta,phi in [(1,42,142),(.8,42,142),(.8,63,138),(.8,5,0),(.8,85,0),(.8,85,90),(.8,42,0)]:
  kw=dict(water_mask=_build_water_mask()*mask_scale,light_elevation_deg=15,sun_intensity=2.8,size_px=(256,160),msaa_samples=4,cam_radius=4.3,cam_phi_deg=phi,cam_theta_deg=theta,albedo_mode='mix',colormap_strength=0.35)
  a=_render_scene(renderer,f3d.MaterialSet.terrain_default(),ibl,_build_heightmap(),_build_overlay(),reflection=ReflectionSettings(enabled=True,intensity=1,fresnel_power=0,wave_strength=0,shore_atten_width=.01),**kw).copy()
  b=_render_scene(renderer,f3d.MaterialSet.terrain_default(),ibl,_build_heightmap(),_build_overlay(),reflection=ReflectionSettings(enabled=False),**kw).copy()
  d=np.abs(a.astype(float)-b.astype(float));print(mask_scale,theta,phi,float(d.mean()),float(d.max()),int(np.any(d>1,axis=2).sum()))
