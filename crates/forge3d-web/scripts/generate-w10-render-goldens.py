"""Render W10 acceptance images with installed native forge3d, never a browser.

Historical images are retained verbatim alongside repeatable installed-renderer
outputs. Their provenance and thresholds are distinct from browser regressions.
"""
from pathlib import Path
import ast
import hashlib
import importlib.util
import json
import subprocess
import tempfile
import os

import numpy as np
from PIL import Image
import forge3d as f3d
from forge3d.terrain_params import PomSettings, ReflectionSettings, SkySettings, make_terrain_params_config

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "tests/golden/w10/native"
COMMIT = "1f4084a"


def sha(data):
    return hashlib.sha256(data).hexdigest()


def main():
    if f3d.__version__ != "1.26.0":
        raise SystemExit("Build and install bf8db932's forge3d 1.26.0 in an isolated environment. Do not replace the user's current native installation.")
    wheel = Path(os.environ["W10_NATIVE_WHEEL"])
    OUT.mkdir(parents=True, exist_ok=True)
    source = subprocess.check_output(["git", "show", f"{COMMIT}:tests/test_terrain_visual_goldens.py"], cwd=ROOT).decode()
    tree = ast.parse(source)
    functions = {"_create_test_hdr", "_build_heightmap", "_build_overlay", "_build_water_mask", "_render_scene"}
    # Execute the original fixture helpers without pytest's collection guards.
    selected = ast.Module(body=[node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in functions], type_ignores=[])
    scope = dict(globals())
    exec(compile(selected, "native:test_terrain_visual_goldens.py", "exec"), scope)
    renderer = f3d.TerrainRenderer(f3d.Session(window=False))
    heights = scope["_build_heightmap"]()
    mask = scope["_build_water_mask"]()
    (OUT / "heights.f32").write_bytes(heights.astype("<f4").tobytes())
    (OUT / "water-mask.f32").write_bytes(mask.astype("<f4").tobytes())
    spec = importlib.util.spec_from_file_location("w07", ROOT / "scripts/generate-w07-material-goldens.py")
    w07 = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(w07)
    scene = {k: v for k, v in w07.SCENES["w04"].items() if k != "heights"}
    scene.update(terrainSize=96, heightsFile="heights.f32")
    variants = [
        ("baseline", {}, {}),
        ("terrain-atmosphere", dict(sky=SkySettings(enabled=True, turbidity=5.5, ground_albedo=0.35, sun_intensity=1.8, sun_size=1.6, aerial_density=2.8, sky_exposure=1.1), light_elevation_deg=12), dict(sky=dict(turbidity=5.5, groundAlbedo=0.35, sunIntensity=1.8, sunSize=1.6, aerialDensity=2.8, exposure=1.1), elevation=12)),
        ("terrain-water", dict(water_mask=mask, light_elevation_deg=18), dict(water=True, elevation=18)),
        ("terrain-water-reflection", dict(water_mask=mask, light_elevation_deg=15, sun_intensity=2.8, size_px=(256,160), msaa_samples=4, cam_radius=4.3, cam_phi_deg=142, cam_theta_deg=42, albedo_mode="mix", colormap_strength=0.35, reflection=ReflectionSettings(enabled=True,intensity=1,fresnel_power=3,wave_strength=0.05,shore_atten_width=0.12)), dict(water=True, reflection=True, elevation=15)),
    ]
    variants.append(("terrain-water-planar", dict(water_mask=mask*0.8, light_elevation_deg=15, sun_intensity=2.8, size_px=(256,160), msaa_samples=4, cam_radius=4.3, cam_phi_deg=142, cam_theta_deg=42, albedo_mode="mix", colormap_strength=0.35, reflection=ReflectionSettings(enabled=True,intensity=1,fresnel_power=0.1,wave_strength=0.2,shore_atten_width=0.01)), dict(water=True,reflection=True,elevation=15,maskScale=0.8,planar=dict(fresnelPower=0.1,waveDistortionStrength=0.2,shoreAttenuationWidth=0.01))))
    records = []
    with tempfile.TemporaryDirectory(prefix="w10-native-") as tmp:
        hdr = Path(tmp) / "environment.hdr"
        scope["_create_test_hdr"](str(hdr))
        ibl = f3d.IBL.from_hdr(str(hdr), intensity=1)
        for name, kwargs, web in variants:
            def render():
                return np.ascontiguousarray(scope["_render_scene"](renderer, f3d.MaterialSet.terrain_default(), ibl, heights, scope["_build_overlay"](), **kwargs))
            image = render()
            assert np.array_equal(image, render()), f"{name} native output is nondeterministic"
            Image.fromarray(image).save(OUT / f"{name}.png")
            (OUT / f"{name}.rgba").write_bytes(image.tobytes())
            record = dict(id=name, width=image.shape[1], height=image.shape[0], sha256=sha(image.tobytes()), web=web)
            if name == "terrain-water-planar":
                disabled_kwargs = dict(kwargs, reflection=ReflectionSettings(enabled=False))
                control = np.ascontiguousarray(scope["_render_scene"](renderer, f3d.MaterialSet.terrain_default(), ibl, heights, scope["_build_overlay"](), **disabled_kwargs))
                contribution = float(np.mean(np.abs(image.astype(float)-control.astype(float))))
                assert contribution > 0.5, "Native planar control has no contribution"
                Image.fromarray(control).save(OUT / "terrain-water-planar-disabled.png")
                (OUT / "terrain-water-planar-disabled.rgba").write_bytes(control.tobytes())
                record["reflectionControl"] = dict(sha256=sha(control.tobytes()), meanByteDifference=contribution)
            if name not in ("baseline", "terrain-water-planar"):
                native_path = "tests/golden/terrain/" + name.replace("-", "_") + ".png"
                original = subprocess.check_output(["git", "show", f"{COMMIT}:{native_path}"], cwd=ROOT)
                snapshot = OUT.parent / "source" / COMMIT / native_path
                snapshot.parent.mkdir(parents=True, exist_ok=True)
                snapshot.write_bytes(original)
                (OUT / f"{name}-historical.png").write_bytes(original)
                record["historical"] = dict(commit=COMMIT, path=native_path, sha256=sha(original))
            records.append(record)
            print(name, record["sha256"])
    # The pinned native Scene cloud shader has invalid semicolon struct fields.
    # Use the independently installed 1.34 public renderer for the cloud oracle;
    # record its version separately, without modifying native shader arithmetic.
    cloud_env = dict(os.environ, PYTHONPATH=os.environ["W10_NATIVE_CLOUD_PATH"])
    cloud_info = json.loads(subprocess.check_output(["python", str(ROOT/"scripts/generate-w10-cloud-golden.py")],env=cloud_env))
    records.append(dict(id="cloud", width=192, height=128, sha256=cloud_info["sha256"], native=cloud_info["native"], extensionSha256=cloud_info["extensionSha256"], web=dict(clearColor=[0.02,0.02,0.03,1],sunDirection=[0.5,0.8,0.6],sunIntensity=1,clouds=dict(renderPath="native",mode="volumetric",color=[0.58,0.72,0.92]))))
    manifest = dict(fixture="w10-native-scene-v1", provenance=dict(native=f"forge3d {f3d.__version__}", wheelSha256=sha(wheel.read_bytes()), generator="scripts/generate-w10-render-goldens.py", rendererSourceCommit="bf8db93233e5158f6d226991fc5d230832c2d806", sceneSourceCommit=COMMIT, sourceSha256=sha(source.encode())), tolerances=dict(ssimMin=0.98), scene=scene, variants=records)
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")


if __name__ == "__main__":
    main()
