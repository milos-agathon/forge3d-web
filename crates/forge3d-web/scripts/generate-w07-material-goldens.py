"""Generate the W07 `terrain-material-v1` native golden set.

Renders every terrain material toggle with the installed native forge3d
(`TerrainRenderer.render_terrain_pbr_pom`, screen mode) and stores:

- ``tests/golden/w07/<variant>.png``: native RGBA8 frames;
- ``tests/golden/w07/<scene>.f32``: little-endian float32 heightmaps, row-major;
- ``tests/golden/w07/terrain-material-native.json``: scenes, variants (native
  settings plus the equivalent browser ``terrain.material`` input), digests,
  the native mean absolute pixel delta of every toggle against its scene
  baseline and the browser acceptance thresholds.

Scenes mirror the native tests: ``w04`` is the W04 parity scene
(``examples/test-w04-parity.html``), ``tv4`` is
``1f4084a:tests/test_terrain_tv4_material_variation.py`` and ``tv10-*`` are
``1f4084a:tests/test_terrain_tv10_subsurface_materials.py``.

Usage (native forge3d 1.34 interpreter)::

    python scripts/generate-w07-material-goldens.py
"""

from __future__ import annotations

import hashlib
import io
import json
import math
import os
import subprocess
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image

import forge3d as f3d
from forge3d.terrain_params import (
    ClampSettings,
    DetailSettings,
    MaterialLayerSettings,
    MaterialNoiseSettings,
    PomSettings,
    TriplanarSettings,
    make_terrain_params_config,
)

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "tests" / "golden" / "w07"

POM_OFF = PomSettings(False, "Occlusion", 0.0, 1, 1, 0, False, False)


def w04_heights() -> np.ndarray:
    size = 96
    heights = np.zeros((size, size), dtype=np.float64)
    for row in range(size):
        y = -1 + 2 * row / (size - 1)
        for col in range(size):
            x = -1 + 2 * col / (size - 1)
            ridge = 0.52 * math.exp(-((x + 0.25) ** 2 * 6.5 + (y - 0.12) ** 2 * 10))
            basin = -0.18 * math.exp(-((x - 0.05) ** 2 * 20 + (y + 0.05) ** 2 * 24))
            spur = 0.22 * math.exp(-((x - 0.42) ** 2 * 28 + (y + 0.22) ** 2 * 18))
            heights[row, col] = ridge + basin + spur + 0.25 * (1 - y) + 0.1 * x
    span = max(heights.max() - heights.min(), 1e-6)
    return ((heights - heights.min()) / span).astype(np.float32)


def _grid(size: int):
    x = np.linspace(-1.0, 1.0, size, dtype=np.float32)
    y = np.linspace(-1.0, 1.0, size, dtype=np.float32)
    return np.meshgrid(x, y)


def _normalize(heightmap: np.ndarray) -> np.ndarray:
    heightmap = heightmap - float(heightmap.min())
    heightmap /= max(float(heightmap.max()), 1e-6)
    return heightmap.astype(np.float32)


def tv4_heights() -> np.ndarray:
    xx, yy = _grid(128)
    ridge = 0.58 * np.exp(-((xx + 0.20) ** 2 * 7.5 + (yy - 0.10) ** 2 * 11.0))
    basin = -0.20 * np.exp(-((xx - 0.04) ** 2 * 18.0 + (yy + 0.10) ** 2 * 25.0))
    spur = 0.26 * np.exp(-((xx - 0.42) ** 2 * 24.0 + (yy + 0.28) ** 2 * 16.0))
    shelf = 0.17 * np.exp(-((xx + 0.48) ** 2 * 28.0 + (yy + 0.38) ** 2 * 20.0))
    slope = 0.24 * (1.0 - yy) + 0.11 * xx
    return _normalize(ridge + basin + spur + shelf + slope)


def snow_heights() -> np.ndarray:
    xx, yy = _grid(160)
    ridge = 0.52 * np.exp(-((xx + 0.18) ** 2 * 7.0 + (yy - 0.06) ** 2 * 9.5))
    crest = 0.30 * np.exp(-((xx - 0.26) ** 2 * 16.0 + (yy + 0.20) ** 2 * 22.0))
    bowl = -0.18 * np.exp(-((xx - 0.02) ** 2 * 20.0 + (yy + 0.05) ** 2 * 28.0))
    shelf = 0.14 * np.exp(-((xx + 0.46) ** 2 * 24.0 + (yy + 0.34) ** 2 * 18.0))
    slope = 0.28 * (1.0 - yy) + 0.10 * xx
    return _normalize(ridge + crest + bowl + shelf + slope)


def tv10_golden_heights() -> np.ndarray:
    """`1f4084a:tests/test_terrain_tv10_goldens.py::_build_heightmap`."""
    xx, yy = _grid(144)
    massif = 0.64 * np.exp(-((xx + 0.18) ** 2 * 7.5 + (yy - 0.06) ** 2 * 11.5))
    cirque = 0.30 * np.exp(-((xx - 0.24) ** 2 * 20.0 + (yy + 0.18) ** 2 * 18.0))
    ridge = 0.22 * np.exp(-((xx - 0.48) ** 2 * 42.0 + (yy + 0.28) ** 2 * 22.0))
    basin = -0.18 * np.exp(-((xx + 0.06) ** 2 * 24.0 + (yy + 0.02) ** 2 * 24.0))
    slope = 0.26 * (1.0 - yy) + 0.10 * xx
    return _normalize(massif + cirque + ridge + basin + slope)


def glacier_heights() -> np.ndarray:
    xx, yy = _grid(160)
    body = 0.42 * np.exp(-((xx + 0.08) ** 2 * 4.0 + (yy + 0.18) ** 2 * 8.0))
    moraine = 0.24 * np.exp(-((xx - 0.36) ** 2 * 18.0 + (yy - 0.04) ** 2 * 26.0))
    basin = -0.16 * np.exp(-((xx + 0.10) ** 2 * 22.0 + (yy - 0.18) ** 2 * 16.0))
    tongue = 0.20 * np.exp(-((xx + 0.34) ** 2 * 11.0 + (yy - 0.42) ** 2 * 6.5))
    slope = 0.20 * (1.0 - yy) - 0.05 * xx
    return _normalize(body + moraine + basin + tongue + slope)


W04_STOPS = [(0.0, "#18391f"), (0.38, "#4e7c35"), (0.65, "#8f7a4a"), (0.82, "#b8ac88"), (1.0, "#f2f4f7")]
TV4_STOPS = [
    (0.0, "#17351b"), (0.20, "#3a632d"), (0.48, "#69733d"),
    (0.68, "#8f7b53"), (0.86, "#c2b29a"), (1.0, "#f4f7fb"),
]
TV10_GOLDEN_STOPS = [
    (0.0, "#1b381d"), (0.22, "#416a30"), (0.50, "#7d7a4b"),
    (0.72, "#b6a98d"), (1.0, "#f4f7fb"),
]
TV10_STOPS = [
    (0.0, "#23371f"), (0.22, "#476438"), (0.46, "#77805a"),
    (0.70, "#b1a07c"), (0.86, "#d8d4ce"), (1.0, "#f6f9ff"),
]


def scene(heights, size, span, z_scale, sun, camera, stops, hdr_blue, render_scale=None, msaa=None):
    extra = {}
    if render_scale is not None:
        # Native renders at size * render_scale, then blits with a linear sampler.
        extra["renderScale"] = render_scale
    if msaa is not None:
        extra["msaa"] = msaa
    return {
        **extra,
        "heights": heights,
        "width": size[0],
        "height": size[1],
        "terrainSpan": span,
        "zScale": z_scale,
        "sun": {"azimuthDeg": sun[0], "elevationDeg": sun[1], "intensity": sun[2]},
        "camera": {"radius": camera[0], "phiDeg": camera[1], "thetaDeg": camera[2], "fovDeg": camera[3]},
        "stops": [[position, color] for position, color in stops],
        "hdrBlue": hdr_blue,
        "clip": [0.1, 6000.0],
    }


SCENES = {
    "w04": scene(w04_heights, (192, 128), 2.8, 1.45, (135.0, 24.0, 2.4), (5.0, 138.0, 63.0, 54.0), W04_STOPS, 128),
    "tv4": scene(tv4_heights, (224, 160), 2.8, 1.35, (136.0, 20.0, 2.3), (5.2, 140.0, 58.0, 52.0), TV4_STOPS, 164),
    "tv10-snow": scene(snow_heights, (224, 160), 3.2, 1.45, (132.0, 11.0, 2.8), (5.6, 306.0, 58.0, 50.0), TV10_STOPS, 164),
    "tv10-wet": scene(snow_heights, (224, 160), 3.2, 1.45, (118.0, 10.0, 2.6), (5.6, 300.0, 56.0, 50.0), TV10_STOPS, 164),
    "tv10-glacier": scene(glacier_heights, (224, 160), 3.2, 1.45, (42.0, 8.0, 3.1), (5.6, 222.0, 54.0, 50.0), TV10_STOPS, 164),
    # Historical 1f4084a golden scenes (tests/test_terrain_tv10_goldens.py SCENE_A/B and
    # tests/test_terrain_visual_goldens.py terrain_pom).
    "tv10h-a": scene(tv10_golden_heights, (240, 160), 2.9, 1.45, (132.0, 11.0, 2.6), (4.2, 138.0, 42.0, 42.0), TV10_GOLDEN_STOPS, 180),
    "tv10h-b": scene(tv10_golden_heights, (240, 160), 2.9, 1.45, (214.0, 9.0, 2.8), (4.5, 218.0, 38.0, 40.0), TV10_GOLDEN_STOPS, 180),
    "pomh": scene(w04_heights, (256, 160), 2.8, 1.45, (135.0, 22.0, 2.4), (4.2, 142.0, 38.0, 54.0), W04_STOPS, 128,
                  render_scale=1.25, msaa=4),
}

TV4_SNOW = dict(snow_enabled=True, snow_altitude_min=0.72, snow_altitude_blend=0.14)
TV4_ROCK = dict(rock_enabled=True, rock_slope_min=36.0, rock_slope_blend=11.0)
TV4_WET = dict(wetness_enabled=True, wetness_strength=0.45, wetness_slope_influence=0.90)
TV10_SNOW = dict(snow_enabled=True, snow_altitude_min=0.60, snow_altitude_blend=0.18, snow_slope_max=58.0, snow_slope_blend=18.0)
TV10_WET = dict(wetness_enabled=True, wetness_strength=0.60, wetness_slope_influence=1.0)
TV10_GLACIER = dict(
    snow_enabled=True, snow_altitude_min=0.34, snow_altitude_blend=0.26,
    snow_slope_max=64.0, snow_slope_blend=22.0, snow_color=(0.88, 0.92, 0.96),
)

WEB_LAYER_KEYS = {
    "snow_enabled": ("snow", "enabled"),
    "snow_altitude_min": ("snow", "altitudeMin"),
    "snow_altitude_blend": ("snow", "altitudeBlend"),
    "snow_slope_max": ("snow", "slopeMax"),
    "snow_slope_blend": ("snow", "slopeBlend"),
    "snow_color": ("snow", "color"),
    "snow_subsurface_strength": ("snow", "subsurfaceStrength"),
    "snow_subsurface_tint": ("snow", "subsurfaceTint"),
    "rock_subsurface_strength": ("rock", "subsurfaceStrength"),
    "rock_subsurface_tint": ("rock", "subsurfaceTint"),
    "rock_enabled": ("rock", "enabled"),
    "rock_slope_min": ("rock", "slopeMin"),
    "rock_slope_blend": ("rock", "slopeBlend"),
    "wetness_enabled": ("wetness", "enabled"),
    "wetness_strength": ("wetness", "strength"),
    "wetness_slope_influence": ("wetness", "slopeInfluence"),
    "wetness_subsurface_strength": ("wetness", "subsurfaceStrength"),
    "wetness_subsurface_tint": ("wetness", "subsurfaceTint"),
}
WEB_NOISE_KEYS = {
    "macro_scale": "macroScale",
    "detail_scale": "detailScale",
    "octaves": "octaves",
    "snow_macro_amplitude": "snowMacroAmplitude",
    "snow_detail_amplitude": "snowDetailAmplitude",
    "rock_macro_amplitude": "rockMacroAmplitude",
    "rock_detail_amplitude": "rockDetailAmplitude",
    "wetness_macro_amplitude": "wetnessMacroAmplitude",
    "wetness_detail_amplitude": "wetnessDetailAmplitude",
}


def layers(variation=None, **kwargs):
    """Native MaterialLayerSettings plus the equivalent web `layers` input."""
    native = MaterialLayerSettings(
        **kwargs,
        **({"variation": MaterialNoiseSettings(**variation)} if variation else {}),
    )
    web: dict = {}
    for key, value in kwargs.items():
        group, field = WEB_LAYER_KEYS[key]
        web.setdefault(group, {})[field] = list(value) if isinstance(value, tuple) else value
    if variation:
        web["variation"] = {WEB_NOISE_KEYS[key]: value for key, value in variation.items()}
    return native, web


def variant(vid, scene_id, baseline, native=None, web=None, note="", historical=None):
    return {
        "historical": historical,
        "id": vid,
        "scene": scene_id,
        "baseline": baseline,
        "native": native or {},
        "material": web or {},
        "note": note,
    }


def build_variants():
    out = []
    # --- T05: terrain PBR, albedo routing, POM, height curve, clamps --------
    out.append(variant("w04-baseline", "w04", None, note="zero-feature material; equals the W04 golden"))
    out.append(variant("w04-albedo-material", "w04", "w04-baseline",
                       {"albedo_mode": "material"}, {"albedoMode": "material"}))
    out.append(variant("w04-albedo-mix", "w04", "w04-baseline",
                       {"albedo_mode": "mix", "colormap_strength": 0.5},
                       {"albedoMode": "mix", "colormapStrength": 0.5}))
    out.append(variant("w04-pom", "w04", "w04-baseline",
                       {"pom": PomSettings(True, "Occlusion", 0.04, 12, 40, 4, True, True)},
                       {"pom": {"enabled": True, "mode": "occlusion", "scale": 0.04, "minSteps": 12,
                                "maxSteps": 40, "refineSteps": 4, "shadow": True, "occlusion": True}}))
    out.append(variant("w04-height-curve-smoothstep", "w04", "w04-baseline",
                       {"height_curve_mode": "smoothstep", "height_curve_strength": 1.0},
                       {"heightCurve": {"mode": "smoothstep", "strength": 1.0}}))
    out.append(variant("w04-height-curve-pow", "w04", "w04-baseline",
                       {"height_curve_mode": "pow", "height_curve_strength": 0.8, "height_curve_power": 2.2},
                       {"heightCurve": {"mode": "pow", "strength": 0.8, "power": 2.2}}))
    lut = [float(round((i / 255.0) ** 0.5, 6)) for i in range(256)]
    out.append(variant("w04-height-curve-lut", "w04", "w04-baseline",
                       {"height_curve_mode": "lut", "height_curve_strength": 1.0,
                        "height_curve_lut": np.asarray(lut, dtype=np.float32)},
                       {"heightCurve": {"mode": "lut", "strength": 1.0, "lut": lut}}))
    out.append(variant("w04-normal-strength", "w04", "w04-baseline",
                       {"triplanar": TriplanarSettings(6.0, 4.0, 2.5)},
                       {"triplanar": {"scale": 6.0, "blendSharpness": 4.0, "normalStrength": 2.5}}))
    out.append(variant("w04-clamp-height", "w04", "w04-baseline",
                       {"clamp": ClampSettings((0.15, 0.8), (0.04, 1.0), (0.22, 0.38), (0.30, 1.0), (0.65, 1.0))},
                       {"clamp": {"heightRange": [0.15, 0.8]}}))
    # --- T07: micro-detail -----------------------------------------------------
    out.append(variant("w04-detail", "w04", "w04-baseline",
                       {"detail": DetailSettings(enabled=True, detail_scale=0.05, normal_strength=0.8,
                                                 albedo_noise=0.3, fade_start=50.0, fade_end=200.0)},
                       {"detail": {"enabled": True, "scale": 0.05, "normalStrength": 0.8,
                                   "albedoNoise": 0.3, "fadeStart": 50.0, "fadeEnd": 200.0}}))
    # --- T06: material layers, TV4 variation, TV10 subsurface -----------------
    out.append(variant("tv4-baseline", "tv4", None, note="zero-feature material"))
    for vid, kwargs, variation in [
        ("tv4-snow", TV4_SNOW, None),
        ("tv4-snow-variation", TV4_SNOW, dict(macro_scale=4.5, detail_scale=22.0, octaves=5,
                                              snow_macro_amplitude=0.26, snow_detail_amplitude=0.12)),
        ("tv4-rock-variation", TV4_ROCK, dict(macro_scale=3.2, detail_scale=18.0, octaves=4,
                                              rock_macro_amplitude=0.24, rock_detail_amplitude=0.18)),
        ("tv4-wetness", TV4_WET, None),
        ("tv4-wetness-variation", TV4_WET, dict(macro_scale=2.8, detail_scale=16.0, octaves=5,
                                                wetness_macro_amplitude=0.30, wetness_detail_amplitude=0.14)),
    ]:
        native, web = layers(variation, **kwargs)
        baseline = "tv4-baseline" if variation is None else vid.replace("-variation", "")
        if vid == "tv4-rock-variation":
            baseline = "tv4-baseline"  # screen-mode slope is 0: plain rock is inert natively
        out.append(variant(vid, "tv4", baseline, {"materials": native}, {"layers": web}))
    for vid, scene_id, kwargs, extra in [
        ("tv10-snow", "tv10-snow", TV10_SNOW, {}),
        ("tv10-snow-sss", "tv10-snow", TV10_SNOW,
         dict(snow_subsurface_strength=0.82, snow_subsurface_tint=(0.78, 0.88, 1.0))),
        ("tv10-wetness", "tv10-wet", TV10_WET, {}),
        ("tv10-wetness-sss", "tv10-wet", TV10_WET,
         dict(wetness_subsurface_strength=0.60, wetness_subsurface_tint=(0.72, 0.80, 0.88))),
        ("tv10-glacier", "tv10-glacier", TV10_GLACIER, {}),
        ("tv10-glacier-sss", "tv10-glacier", TV10_GLACIER,
         dict(snow_subsurface_strength=0.92, snow_subsurface_tint=(0.58, 0.80, 1.0))),
    ]:
        native, web = layers(None, **kwargs, **extra)
        baseline = None if not extra else vid.replace("-sss", "")
        out.append(variant(vid, scene_id, baseline, {"materials": native}, {"layers": web}))
    # --- Historical 1f4084a goldens, compared verbatim -------------------------
    tv10h_common = dict(
        snow_enabled=True, snow_altitude_min=0.78, snow_altitude_blend=0.24,
        snow_slope_max=58.0, snow_slope_blend=18.0,
        rock_enabled=True, rock_slope_min=38.0, rock_slope_blend=10.0,
        wetness_enabled=True, wetness_strength=0.18, wetness_slope_influence=0.45,
    )
    tv10h_sss = dict(
        snow_subsurface_strength=0.58, snow_subsurface_tint=(0.72, 0.85, 0.98),
        rock_subsurface_strength=0.04, rock_subsurface_tint=(0.45, 0.38, 0.30),
        wetness_subsurface_strength=0.16, wetness_subsurface_tint=(0.38, 0.27, 0.18),
    )
    tv10h_zero = dict(snow_subsurface_strength=0.0, rock_subsurface_strength=0.0,
                      wetness_subsurface_strength=0.0)
    mix_native = {"albedo_mode": "mix", "colormap_strength": 0.25}
    mix_web = {"albedoMode": "mix", "colormapStrength": 0.25}
    for vid, scene_id, baseline, extra, golden in [
        ("tv10h-zero-sss", "tv10h-a", None, tv10h_zero, "terrain_tv10_zero_sss.png"),
        ("tv10h-a-sss", "tv10h-a", "tv10h-zero-sss", tv10h_sss, "terrain_tv10_scene_a_sss.png"),
        ("tv10h-b-sss", "tv10h-b", None, tv10h_sss, "terrain_tv10_scene_b_sss.png"),
    ]:
        native, web = layers(None, **tv10h_common, **extra)
        out.append(variant(vid, scene_id, baseline, {**mix_native, "materials": native},
                           {**mix_web, "layers": web},
                           historical=f"1f4084a:tests/golden/terrain/{golden}"))
    out.append(variant(
        "pomh-material", "pomh", None,
        {"albedo_mode": "material", "colormap_strength": 0.0,
         "pom": PomSettings(True, "Occlusion", 0.05, 12, 40, 4, True, True)},
        {"albedoMode": "material", "colormapStrength": 0.0,
         "pom": {"enabled": True, "mode": "occlusion", "scale": 0.05, "minSteps": 12,
                 "maxSteps": 40, "refineSteps": 4, "shadow": True, "occlusion": True}},
        historical="1f4084a:tests/golden/terrain/terrain_pom.png"))
    return out


def historical_png(ref: str) -> bytes:
    return subprocess.run(["git", "show", ref], cwd=ROOT, check=True, capture_output=True).stdout


def ssim(a: np.ndarray, b: np.ndarray) -> float:
    """Gaussian (11, sigma 1.5) SSIM over RGB, matching the browser probe."""
    coords = np.arange(11) - 5
    kernel = np.exp(-0.5 * (coords / 1.5) ** 2)
    kernel /= kernel.sum()

    def blur(channel):
        rows = np.apply_along_axis(lambda r: np.convolve(r, kernel, mode="same"), 1, channel)
        return np.apply_along_axis(lambda c: np.convolve(c, kernel, mode="same"), 0, rows)

    c1, c2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2
    total = 0.0
    for channel in range(3):
        x = a[..., channel].astype(np.float64)
        y = b[..., channel].astype(np.float64)
        mx, my = blur(x), blur(y)
        sxx, syy, sxy = blur(x * x) - mx * mx, blur(y * y) - my * my, blur(x * y) - mx * my
        total += float(np.mean(((2 * mx * my + c1) * (2 * sxy + c2))
                               / ((mx * mx + my * my + c1) * (sxx + syy + c2))))
    return total / 3.0


def historical_hdr(path: str, blue: int) -> None:
    with open(path, "wb") as handle:
        handle.write(b"#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 4 +X 8\n")
        for y in range(4):
            for x in range(8):
                handle.write(bytes([int(x / 7 * 255), int(y / 3 * 255), blue, 128]))


def render(renderer, spec, heights, hdr_path, native):
    cmap = f3d.Colormap1D.from_stops(stops=[tuple(stop) for stop in spec["stops"]], domain=(0.0, 1.0))
    kwargs = dict(
        size_px=(spec["width"], spec["height"]),
        render_scale=spec.get("renderScale", 1.0),
        terrain_span=spec["terrainSpan"],
        msaa_samples=spec.get("msaa", 1),
        z_scale=spec["zScale"],
        exposure=1.0,
        domain=(0.0, 1.0),
        albedo_mode="colormap",
        colormap_strength=1.0,
        ibl_enabled=True,
        light_azimuth_deg=spec["sun"]["azimuthDeg"],
        light_elevation_deg=spec["sun"]["elevationDeg"],
        sun_intensity=spec["sun"]["intensity"],
        cam_radius=spec["camera"]["radius"],
        cam_phi_deg=spec["camera"]["phiDeg"],
        cam_theta_deg=spec["camera"]["thetaDeg"],
        fov_y_deg=spec["camera"]["fovDeg"],
        camera_mode="screen",
        clip=tuple(spec["clip"]),
        overlays=[f3d.OverlayLayer.from_colormap1d(cmap, strength=1.0)],
        pom=POM_OFF,
    )
    kwargs.update(native)
    params = f3d.TerrainRenderParams(make_terrain_params_config(**kwargs))
    frame = renderer.render_terrain_pbr_pom(
        material_set=f3d.MaterialSet.terrain_default(),
        env_maps=f3d.IBL.from_hdr(hdr_path, intensity=1.0),
        params=params,
        heightmap=heights,
        target=None,
    )
    return np.ascontiguousarray(frame.to_numpy())


def mean_abs_diff(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.mean(np.abs(a[..., :3].astype(np.float32) - b[..., :3].astype(np.float32))))


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    tmp = tempfile.mkdtemp()
    renderer = f3d.TerrainRenderer(f3d.Session(window=False))
    heights_cache: dict = {}
    scenes_out = {}
    for scene_id, spec in SCENES.items():
        builder = spec["heights"]
        key = builder.__name__
        if key not in heights_cache:
            heights_cache[key] = builder()
            (OUT / f"{key}.f32").write_bytes(heights_cache[key].astype("<f4").tobytes())
        size = heights_cache[key].shape[0]
        scenes_out[scene_id] = {
            **{k: v for k, v in spec.items() if k != "heights"},
            "heightsFile": f"{key}.f32",
            "terrainSize": size,
            "heightsSha256": sha(heights_cache[key].astype("<f4").tobytes()),
        }
    frames = {}
    variants_out = []
    for entry in build_variants():
        spec = SCENES[entry["scene"]]
        hdr = os.path.join(tmp, f"env_{spec['hdrBlue']}.hdr")
        historical_hdr(hdr, spec["hdrBlue"])
        heights = heights_cache[spec["heights"].__name__]
        frame = render(renderer, spec, heights, hdr, entry["native"])
        frames[entry["id"]] = frame
        png = OUT / f"{entry['id']}.png"
        golden = frame
        if entry["historical"]:
            # The historical golden is stored verbatim; the oracle render only
            # supplies determinism, deltas and its own agreement score.
            raw = historical_png(entry["historical"])
            png.write_bytes(raw)
            golden = np.asarray(Image.open(io.BytesIO(raw)).convert("RGBA"))
            if golden.shape != frame.shape:
                raise SystemExit(f"{entry['id']}: historical shape {golden.shape} != {frame.shape}")
        else:
            Image.fromarray(frame, mode="RGBA").save(png, optimize=False, compress_level=9)
        # Determinism: a second native render must be identical.
        again = render(renderer, spec, heights, hdr, entry["native"])
        if not np.array_equal(frame, again):
            raise SystemExit(f"{entry['id']}: native render is not deterministic")
        record = {
            "id": entry["id"],
            "scene": entry["scene"],
            "baseline": entry["baseline"],
            "material": entry["material"],
            "note": entry["note"],
            "png": png.name,
            "sha256": sha(golden.tobytes()),
        }
        if entry["historical"]:
            record["historical"] = entry["historical"]
            record["oracleSsim"] = round(ssim(frame, golden), 6)
        if entry["baseline"] is not None:
            delta = mean_abs_diff(frame, frames[entry["baseline"]])
            if delta <= 0.0:
                raise SystemExit(f"{entry['id']}: toggle has no native pixel delta")
            record["nativeDelta"] = round(delta, 4)
            # Browser acceptance: the toggle must move at least half as far
            # from its baseline as it does natively.
            record["minDelta"] = round(delta * 0.5, 4)
        variants_out.append(record)
        print(f"{entry['id']:32s} delta={record.get('nativeDelta', 0):8.4f}")
    manifest = {
        "fixture": "terrain-material-v1",
        "provenance": {
            "generator": "crates/forge3d-web/scripts/generate-w07-material-goldens.py",
            "native": f"forge3d {f3d.__version__} TerrainRenderer.render_terrain_pbr_pom (screen mode)",
            "nativeTests": [
                "1f4084a:tests/test_terrain_viewer_pbr.py",
                "1f4084a:tests/test_terrain_materials.py",
                "1f4084a:tests/test_terrain_tv4_material_variation.py",
                "1f4084a:tests/test_terrain_tv10_subsurface_materials.py",
            ],
            "materialSet": "MaterialSet.terrain_default()",
        },
        "tolerances": {"ssimMin": 0.98, "deltaFraction": 0.5},
        "scenes": scenes_out,
        "variants": variants_out,
    }
    (OUT / "terrain-material-native.json").write_text(json.dumps(manifest, indent=2) + "\n")


if __name__ == "__main__":
    main()
