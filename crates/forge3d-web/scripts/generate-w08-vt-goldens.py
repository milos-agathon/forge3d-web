"""Generate the W08 `terrain-vt-v1` native golden set.

Renders the native ``test_tv20_virtual_texturing.py`` scene with the
installed forge3d (``TerrainRenderer``, screen mode) and stores under
``tests/golden/w08/``:

- ``vt-albedo-off.f32`` / ``vt-albedo-on.f32``: PRIMARY goldens — the
  native albedo AOV from ``renderer.render_with_aov`` (float32,
  row-major ``(h, w, 3)``, linear RGB in [0, 1], little-endian) with
  ``material.virtualTexture`` disabled/enabled. The albedo AOV isolates
  the virtual-texture output from the screen-path lighting/shadow
  fidelity, exactly like the native test_tv20 assertion.
- ``vt-noshadow-off.png`` / ``vt-noshadow-on.png``: SECONDARY goldens —
  beauty renders with ``ShadowSettings(enabled=False, ...)`` on both
  sides, removing the shadow-map coverage term.
- ``vt-off.png`` / ``vt-on.png``: native RGBA8 first frames with the
  shadowed beauty (diagnostic references only — the web comparison logs
  these SSIMs because they measure the pre-existing W07 screen-path
  shadow coverage, not VT).
- ``vt-heights.f32``: little-endian float32 heightmap, row-major (the
  native ``_build_heightmap(160)`` so the browser commits identical
  heights).
- ``vt-native.json``: render params, VT settings, source digests, file
  digests/shape for every artifact, native stats and the native mean
  absolute ``|on - off|`` deltas (albedo AOV and beauty).

The VT settings use a residency budget large enough that every
first-frame request fits (atlas 2048, residency 64 MB, virtual 2048,
use_feedback), so the ``vt-on`` golden is the deterministic first VT
frame.

Usage (native forge3d 1.38 interpreter)::

    python scripts/generate-w08-vt-goldens.py
"""

from __future__ import annotations

import hashlib
import json
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, "D:/forge3d/tests")

import forge3d as f3d
from forge3d.terrain_params import (
    AovSettings,
    PomSettings,
    ShadowSettings,
    TerrainVTSettings,
    VTLayerFamily,
    make_terrain_params_config,
)
from _terrain_runtime import _build_heightmap, _write_test_hdr

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "tests" / "golden" / "w08"

POM_OFF = PomSettings(False, "Occlusion", 0.0, 1, 1, 0, False, False)
AOV_ALBEDO = AovSettings(enabled=True, albedo=True, normal=False, depth=False)
SHADOWS_OFF = ShadowSettings(
    enabled=False,
    technique="pcf",
    resolution=1024,
    cascades=1,
    max_distance=100.0,
    softness=1.0,
    intensity=1.0,
    slope_scale_bias=1.0,
    depth_bias=0.0,
    normal_bias=0.0,
    min_variance=0.02,
    light_bleed_reduction=0.5,
    evsm_exponent=1.0,
    fade_start=0.9,
)

WIDTH = 224
HEIGHT = 160
TERRAIN_SIZE = 160
TERRAIN_SPAN = 8.0
Z_SCALE = 1.6
IBL_INTENSITY = 1.8
SUN = {"azimuthDeg": 136.0, "elevationDeg": 24.0, "intensity": 2.2}
CAMERA = {"radius": 4.0, "phiDeg": 142.0, "thetaDeg": 58.0, "fovDeg": 50.0}
CLIP = [0.1, 6000.0]
HDR_BLUE = 164
VT_MATERIAL_COUNT = 4
VIRTUAL_SIZE = 2048

# Native equivalent: TerrainVTSettings(enabled=True, atlas_size=2048,
# residency_budget_mb=64.0, max_mip_levels=6, use_feedback=True,
# layers=[VTLayerFamily(family="albedo", virtual_size_px=(2048, 2048))]).
VT_SETTINGS_NATIVE = TerrainVTSettings(
    enabled=True,
    atlas_size=2048,
    residency_budget_mb=64.0,
    max_mip_levels=6,
    use_feedback=True,
    layers=[VTLayerFamily(family="albedo", virtual_size_px=(VIRTUAL_SIZE, VIRTUAL_SIZE))],
)
VT_SETTINGS_WEB = {
    "enabled": True,
    "atlasSize": 2048,
    "residencyBudgetMb": 64.0,
    "maxMipLevels": 6,
    "useFeedback": True,
    "layers": [{"family": "albedo", "virtualSizePx": [VIRTUAL_SIZE, VIRTUAL_SIZE]}],
}


def build_vt_source(size: int, material_index: int) -> np.ndarray:
    """`test_tv20_virtual_texturing.py::_build_vt_source`."""
    coords = np.linspace(0.0, 1.0, size, dtype=np.float32)
    xx, yy = np.meshgrid(coords, coords)
    stripe = 0.5 + 0.5 * np.sin(
        (xx * (material_index + 1.5) * 14.0 + yy * (material_index + 2.0) * 11.0) * np.pi
    )
    checker = (
        (
            np.floor(xx * (10 + material_index * 3))
            + np.floor(yy * (12 + material_index * 2))
        )
        % 2.0
    ).astype(np.float32)
    modulation = 0.30 + 0.70 * (0.55 * checker + 0.45 * stripe)
    palette = np.array(
        [
            [0.88, 0.18, 0.12],
            [0.14, 0.72, 0.22],
            [0.16, 0.34, 0.90],
            [0.92, 0.84, 0.18],
        ],
        dtype=np.float32,
    )
    base = palette[material_index % len(palette)]
    rgb = np.clip(
        base * modulation[..., None] + (1.0 - modulation[..., None]) * 0.08, 0.0, 1.0
    )
    alpha = np.ones((size, size, 1), dtype=np.float32)
    rgba = np.concatenate([rgb, alpha], axis=-1)
    return np.ascontiguousarray((rgba * 255.0).round().astype(np.uint8))


def source_fallback(source: np.ndarray) -> list[float]:
    rgb = source[..., :3].astype(np.float64).mean(axis=(0, 1)) / 255.0
    return [float(rgb[0]), float(rgb[1]), float(rgb[2]), 1.0]


def build_config(*, shadows=None, aov=None):
    config = make_terrain_params_config(
        size_px=(WIDTH, HEIGHT),
        render_scale=1.0,
        terrain_span=TERRAIN_SPAN,
        msaa_samples=1,
        z_scale=Z_SCALE,
        exposure=1.0,
        domain=(0.0, 1.0),
        albedo_mode="material",
        colormap_strength=0.0,
        ibl_enabled=True,
        ibl_intensity=IBL_INTENSITY,
        light_azimuth_deg=SUN["azimuthDeg"],
        light_elevation_deg=SUN["elevationDeg"],
        sun_intensity=SUN["intensity"],
        cam_radius=CAMERA["radius"],
        cam_phi_deg=CAMERA["phiDeg"],
        cam_theta_deg=CAMERA["thetaDeg"],
        fov_y_deg=CAMERA["fovDeg"],
        camera_mode="screen",
        clip=tuple(CLIP),
        shadows=shadows,
        pom=POM_OFF,
        aov=aov,
    )
    return config


def render_aov(renderer, ibl, heightmap, vt) -> tuple[np.ndarray, np.ndarray]:
    """Beauty frame + albedo AOV at the tv20 scene params."""
    config = build_config(aov=AOV_ALBEDO)
    config.vt = vt
    frame, aov_frame = renderer.render_with_aov(
        material_set=f3d.MaterialSet.terrain_default(),
        env_maps=ibl,
        params=f3d.TerrainRenderParams(config),
        heightmap=heightmap,
    )
    return (
        np.ascontiguousarray(frame.to_numpy()),
        np.ascontiguousarray(aov_frame.albedo()),
    )


def render_beauty(renderer, ibl, heightmap, vt, shadows) -> np.ndarray:
    config = build_config(shadows=shadows)
    config.vt = vt
    frame = renderer.render_terrain_pbr_pom(
        material_set=f3d.MaterialSet.terrain_default(),
        env_maps=ibl,
        params=f3d.TerrainRenderParams(config),
        heightmap=heightmap,
        target=None,
    )
    return np.ascontiguousarray(frame.to_numpy())


def mean_abs_diff(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.mean(np.abs(a[..., :3].astype(np.float32) - b[..., :3].astype(np.float32))))


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def f32_bytes(frame: np.ndarray) -> bytes:
    return np.ascontiguousarray(frame.astype("<f4")).tobytes()


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        hdr_path = Path(tmp) / "env.hdr"
        _write_test_hdr(hdr_path)
        ibl = f3d.IBL.from_hdr(str(hdr_path), intensity=1.0)
        renderer = f3d.TerrainRenderer(f3d.Session(window=False))
        heightmap = _build_heightmap(TERRAIN_SIZE)

        renderer.clear_material_vt_sources()
        sources = []
        for index in range(VT_MATERIAL_COUNT):
            source = build_vt_source(VIRTUAL_SIZE, index)
            fallback = source_fallback(source)
            renderer.register_material_vt_source(
                index, "albedo", source, (VIRTUAL_SIZE, VIRTUAL_SIZE), fallback
            )
            png_name = f"vt-src-{index}.png"
            Image.fromarray(source, mode="RGBA").save(
                OUT / png_name, compress_level=9
            )
            sources.append(
                {
                    "materialIndex": index,
                    "fallback": fallback,
                    "png": png_name,
                    "sha256": sha(source.tobytes()),
                }
            )

        # Primary: albedo AOV (+ shadowed beauty diagnostics) via
        # render_with_aov at the tv20 params, VT off then VT on.
        off, off_albedo = render_aov(renderer, ibl, heightmap, None)
        off_again, off_albedo_again = render_aov(renderer, ibl, heightmap, None)
        if not (np.array_equal(off, off_again) and np.array_equal(off_albedo, off_albedo_again)):
            raise SystemExit("vt-off: native render is not deterministic")

        on, on_albedo = render_aov(renderer, ibl, heightmap, VT_SETTINGS_NATIVE)
        on_stats = renderer.get_material_vt_stats()
        on_again, on_albedo_again = render_aov(renderer, ibl, heightmap, VT_SETTINGS_NATIVE)
        if not (np.array_equal(on, on_again) and np.array_equal(on_albedo, on_albedo_again)):
            raise SystemExit("vt-on: native render is not deterministic")

        albedo_delta = mean_abs_diff(off_albedo, on_albedo)
        if albedo_delta <= 0.0:
            raise SystemExit("vt-on: no native albedo-AOV delta vs vt-off")

        # Secondary: shadowless beauty (shadows disabled on both sides).
        off_ns = render_beauty(renderer, ibl, heightmap, None, SHADOWS_OFF)
        on_ns = render_beauty(renderer, ibl, heightmap, VT_SETTINGS_NATIVE, SHADOWS_OFF)
        ns_delta = mean_abs_diff(off_ns, on_ns)

        delta = mean_abs_diff(off, on)
        if delta <= 0.0:
            raise SystemExit("vt-on: no native pixel delta vs vt-off")

        Image.fromarray(off, mode="RGBA").save(OUT / "vt-off.png", compress_level=9)
        Image.fromarray(on, mode="RGBA").save(OUT / "vt-on.png", compress_level=9)
        Image.fromarray(off_ns, mode="RGBA").save(
            OUT / "vt-noshadow-off.png", compress_level=9
        )
        Image.fromarray(on_ns, mode="RGBA").save(
            OUT / "vt-noshadow-on.png", compress_level=9
        )
        (OUT / "vt-albedo-off.f32").write_bytes(f32_bytes(off_albedo))
        (OUT / "vt-albedo-on.f32").write_bytes(f32_bytes(on_albedo))
        (OUT / "vt-heights.f32").write_bytes(heightmap.astype("<f4").tobytes())

        stats_out = {
            key: float(on_stats[key])
            for key in (
                "resident_pages",
                "total_pages",
                "cache_budget_pages",
                "cache_misses",
                "tiles_streamed",
                "source_count",
            )
            if key in on_stats
        }
        manifest = {
            "fixture": "terrain-vt-v1",
            "provenance": {
                "generator": "crates/forge3d-web/scripts/generate-w08-vt-goldens.py",
                "native": f"forge3d {f3d.__version__} TerrainRenderer (render_with_aov + render_terrain_pbr_pom, screen mode)",
                "nativeTests": ["1f4084a:tests/test_tv20_virtual_texturing.py"],
                "materialSet": "MaterialSet.terrain_default()",
            },
            "tolerances": {"ssimMin": 0.98, "albedoMeanAbsMax": 0.01},
            "scene": {
                "width": WIDTH,
                "height": HEIGHT,
                "terrainSize": TERRAIN_SIZE,
                "terrainSpan": TERRAIN_SPAN,
                "zScale": Z_SCALE,
                "domain": [0.0, 1.0],
                "albedoMode": "material",
                "colormapStrength": 0.0,
                "sun": SUN,
                "iblIntensity": IBL_INTENSITY,
                "hdrBlue": HDR_BLUE,
                "camera": CAMERA,
                "clip": CLIP,
                "cameraMode": "screen",
                "heightsFile": "vt-heights.f32",
                "heightsSha256": sha(heightmap.astype("<f4").tobytes()),
            },
            "virtualTexture": VT_SETTINGS_WEB,
            "virtualSize": VIRTUAL_SIZE,
            "materialCount": VT_MATERIAL_COUNT,
            "sources": sources,
            "albedoAov": {
                "comment": (
                    "primary golden: float32 little-endian row-major (h, w, 3) "
                    "linear RGB albedo AOV in [0, 1] — isolates VT output from "
                    "screen-path shadow fidelity (native test_tv20 assertion)"
                ),
                "dtype": "float32-le",
                "shape": [off_albedo.shape[0], off_albedo.shape[1], off_albedo.shape[2]],
                "off": {
                    "file": "vt-albedo-off.f32",
                    "sha256": sha(f32_bytes(off_albedo)),
                },
                "on": {
                    "file": "vt-albedo-on.f32",
                    "sha256": sha(f32_bytes(on_albedo)),
                },
                "nativeDelta": round(albedo_delta, 4),
            },
            "shadowlessBeauty": {
                "comment": (
                    "secondary golden: beauty with ShadowSettings(enabled=False) "
                    "on both sides — removes shadow coverage from the comparison"
                ),
                "off": {"png": "vt-noshadow-off.png", "sha256": sha(off_ns.tobytes())},
                "on": {"png": "vt-noshadow-on.png", "sha256": sha(on_ns.tobytes())},
                "nativeDelta": round(ns_delta, 4),
            },
            "variants": [
                {
                    "id": "vt-off",
                    "png": "vt-off.png",
                    "sha256": sha(off.tobytes()),
                    "diagnostic": "shadowed beauty — pre-existing W07 screen-path comparison",
                },
                {
                    "id": "vt-on",
                    "png": "vt-on.png",
                    "sha256": sha(on.tobytes()),
                    "nativeDelta": round(delta, 4),
                    "diagnostic": "shadowed beauty — pre-existing W07 screen-path comparison",
                    "stats": stats_out,
                },
            ],
        }
        (OUT / "vt-native.json").write_text(json.dumps(manifest, indent=2) + "\n")
        print(f"vt-off           sha256={sha(off.tobytes())}")
        print(f"vt-on            sha256={sha(on.tobytes())}  mean|on-off|={delta:.4f}")
        print(f"albedo off/on    sha256={sha(f32_bytes(off_albedo))} / {sha(f32_bytes(on_albedo))}  mean|d|={albedo_delta:.4f}")
        print(f"noshadow off/on  sha256={sha(off_ns.tobytes())} / {sha(on_ns.tobytes())}  mean|d|={ns_delta:.4f}")
        print(f"stats            {stats_out}")


if __name__ == "__main__":
    main()
