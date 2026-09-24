"""Generate the W06 native AOV oracle fixture.

Renders the W04 `terrain_pbr_pom` screen-mode parity scene with the installed
native forge3d (`TerrainRenderer.render_with_aov`) and stores the float AOVs
the browser capture path must match:

- ``tests/golden/w06-aov-native.bin``: little-endian IEEE binary16 planes,
  row-major top to bottom, in order albedo RGB (H*W*3), normal XYZ (H*W*3),
  depth (H*W). Native AOV targets are Rgba16Float, so binary16 is lossless.
- ``tests/golden/w06-aov-native.json``: layout, provenance, parameters and
  SHA-256 digests of the planes and of the beauty frame rendered alongside
  (it reproduces the W04 golden ``w04-terrain-pbr-native.png`` to a mean
  absolute error below 1e-3 of a byte).

Usage (native forge3d 1.34 interpreter)::

    python scripts/generate-w06-aov-fixture.py

The scene mirrors ``examples/test-w04-parity.html``: 96x96 synthetic DEM,
five-stop colormap, 192x128 screen mode, sun azimuth 135 / elevation 24 /
intensity 2.4, 8x4 historical RGBE IBL at intensity 1, POM disabled.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import tempfile
from pathlib import Path

import numpy as np

import forge3d as f3d
from forge3d.terrain_params import PomSettings, make_terrain_params_config

ROOT = Path(__file__).resolve().parents[1]
GOLDEN = ROOT / "tests" / "golden"
WIDTH, HEIGHT = 192, 128
TERRAIN_SIZE = 96


def heightmap() -> np.ndarray:
    heights = np.zeros((TERRAIN_SIZE, TERRAIN_SIZE), dtype=np.float64)
    for row in range(TERRAIN_SIZE):
        y = -1 + 2 * row / (TERRAIN_SIZE - 1)
        for col in range(TERRAIN_SIZE):
            x = -1 + 2 * col / (TERRAIN_SIZE - 1)
            ridge = 0.52 * math.exp(-((x + 0.25) ** 2 * 6.5 + (y - 0.12) ** 2 * 10))
            basin = -0.18 * math.exp(-((x - 0.05) ** 2 * 20 + (y + 0.05) ** 2 * 24))
            spur = 0.22 * math.exp(-((x - 0.42) ** 2 * 28 + (y + 0.22) ** 2 * 18))
            heights[row, col] = ridge + basin + spur + 0.25 * (1 - y) + 0.1 * x
    span = max(heights.max() - heights.min(), 1e-6)
    return ((heights - heights.min()) / span).astype(np.float32)


def historical_hdr(path: str) -> None:
    with open(path, "wb") as handle:
        handle.write(b"#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 4 +X 8\n")
        for y in range(4):
            for x in range(8):
                handle.write(bytes([int(x / 7 * 255), int(y / 3 * 255), 128, 128]))


def main() -> None:
    hdr = os.path.join(tempfile.mkdtemp(), "w06_env.hdr")
    historical_hdr(hdr)
    cmap = f3d.Colormap1D.from_stops(
        stops=[
            (0.0, "#18391f"),
            (0.38, "#4e7c35"),
            (0.65, "#8f7a4a"),
            (0.82, "#b8ac88"),
            (1.0, "#f2f4f7"),
        ],
        domain=(0.0, 1.0),
    )
    params = f3d.TerrainRenderParams(
        make_terrain_params_config(
            size_px=(WIDTH, HEIGHT),
            render_scale=1.0,
            terrain_span=2.8,
            msaa_samples=1,
            z_scale=1.45,
            exposure=1.0,
            domain=(0.0, 1.0),
            albedo_mode="colormap",
            colormap_strength=1.0,
            ibl_enabled=True,
            light_azimuth_deg=135.0,
            light_elevation_deg=24.0,
            sun_intensity=2.4,
            cam_radius=5.0,
            cam_phi_deg=138.0,
            cam_theta_deg=63.0,
            fov_y_deg=54.0,
            camera_mode="screen",
            clip=(0.1, 6000.0),
            overlays=[f3d.OverlayLayer.from_colormap1d(cmap, strength=1.0)],
            pom=PomSettings(False, "Occlusion", 0.0, 1, 1, 0, False, False),
        )
    )
    renderer = f3d.TerrainRenderer(f3d.Session(window=False))
    frame, aov = renderer.render_with_aov(
        f3d.MaterialSet.terrain_default(),
        f3d.IBL.from_hdr(hdr, intensity=1.0),
        params,
        heightmap(),
    )
    beauty = np.ascontiguousarray(frame.to_numpy())
    planes = [
        np.ascontiguousarray(aov.albedo(), dtype=np.float32),
        np.ascontiguousarray(aov.normal(), dtype=np.float32),
        np.ascontiguousarray(aov.depth(), dtype=np.float32),
    ]
    half = [plane.astype("<f2") for plane in planes]
    for original, quantized in zip(planes, half):
        if not np.array_equal(original, quantized.astype(np.float32)):
            raise SystemExit("native AOVs are not exactly representable in binary16")
    payload = b"".join(plane.tobytes() for plane in half)
    GOLDEN.mkdir(parents=True, exist_ok=True)
    (GOLDEN / "w06-aov-native.bin").write_bytes(payload)
    manifest = {
        "fixture": "w06-aov-native",
        "provenance": {
            "generator": "crates/forge3d-web/scripts/generate-w06-aov-fixture.py",
            "native": f"forge3d {f3d.__version__} TerrainRenderer.render_with_aov",
            "nativeTests": ["1f4084a:tests/test_aov.py", "1f4084a:tests/test_exr_output.py"],
            "scene": "examples/test-w04-parity.html (W04 terrain_pbr_pom screen mode, POM disabled)",
        },
        "width": WIDTH,
        "height": HEIGHT,
        "encoding": "binary16-le",
        "planes": [
            {"name": "albedo", "channels": 3, "offset": 0},
            {"name": "normal", "channels": 3, "offset": WIDTH * HEIGHT * 3 * 2},
            {"name": "depth", "channels": 1, "offset": WIDTH * HEIGHT * 6 * 2},
        ],
        "conventions": {
            "albedo": "linear base color before lighting",
            "normal": "unit shading normal in the native screen-mode Z-up frame",
            "depth": "linear view depth normalized by clip (0.1, 6000)",
        },
        "clip": [0.1, 6000.0],
        "sha256": hashlib.sha256(payload).hexdigest(),
        "beautySha256": hashlib.sha256(beauty.tobytes()).hexdigest(),
        "tolerances": {"aovSsimMin": 0.98, "beautyGoldenSsimMin": 0.98},
    }
    (GOLDEN / "w06-aov-native.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({k: manifest[k] for k in ("sha256", "beautySha256")}, indent=2))


if __name__ == "__main__":
    main()
