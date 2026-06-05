"""Phase 15 Python/native semantic restoration checks.

These tests intentionally exercise behavior, not just symbol presence. They
lock the compatibility restoration against the shim patterns that can satisfy
API-contract tests while returning empty dictionaries or no-op renders.
"""

from __future__ import annotations

import math

import numpy as np
import pytest

pytest.importorskip("forge3d._forge3d")

from forge3d import _forge3d as _native


def test_camera_helpers_return_numeric_matrices():
    view = np.asarray(_native.camera_look_at((0.0, 0.0, 3.0), (0.0, 0.0, 0.0), (0.0, 1.0, 0.0)))
    proj = np.asarray(_native.camera_perspective(60.0, 1.0, 0.1, 100.0, "wgpu"))

    assert view.shape == (4, 4)
    assert proj.shape == (4, 4)
    assert np.isfinite(view).all()
    assert np.isfinite(proj).all()
    assert not isinstance(_native.camera_view_proj(view, proj), dict)

    with pytest.raises(ValueError):
        _native.camera_perspective(0.0, 1.0, 0.1, 100.0)


def test_geometry_and_obj_import_return_mesh_payloads(tmp_path):
    cube = _native.geometry_generate_primitive_py("cube", {"size": 2.0})
    assert isinstance(cube, dict)
    assert np.asarray(cube["positions"]).shape[1] == 3
    assert np.asarray(cube["indices"]).size >= 36

    obj = tmp_path / "tri.obj"
    obj.write_text(
        "\n".join(
            [
                "v 0 0 0",
                "v 1 0 0",
                "v 0 1 0",
                "f 1 2 3",
            ]
        ),
        encoding="utf-8",
    )

    imported = _native.io_import_obj_py(str(obj))
    mesh = imported["mesh"]
    assert np.asarray(mesh["positions"]).shape == (3, 3)
    assert np.asarray(mesh["indices"]).tolist() == [0, 1, 2]


def test_scene_height_camera_and_bloom_affect_render_output():
    scene = _native.Scene(16, 12)
    base = np.asarray(scene.render_rgba()).copy()

    heightmap = np.linspace(0.0, 1.0, 16 * 12, dtype=np.float32).reshape(12, 16)
    scene.set_height_from_r32f(heightmap, 16, 12)
    terrain = np.asarray(scene.render_rgba()).copy()

    scene.set_camera_look_at((1.0, 2.0, 3.0), (0.0, 0.0, 0.0), (0.0, 1.0, 0.0), 45.0, 0.1, 100.0)
    camera_changed = np.asarray(scene.render_rgba()).copy()

    scene.set_bloom_settings(threshold=0.05, softness=1.0, strength=2.0, radius=4.0)
    scene.enable_bloom()
    bloomed = np.asarray(scene.render_rgba())

    assert base.shape == (12, 16, 4)
    assert np.all(base[..., 3] == 255)
    assert np.abs(terrain.astype(np.int16) - base.astype(np.int16)).mean() > 0.05
    assert np.abs(camera_changed.astype(np.int16) - terrain.astype(np.int16)).mean() > 0.05
    assert np.abs(bloomed.astype(np.int16) - camera_changed.astype(np.int16)).mean() > 0.05


def test_sun_and_engine_info_are_real_payloads():
    sun = _native.sun_position(45.52, -122.68, "2024-06-21T20:00:00")
    assert hasattr(sun, "azimuth")
    assert hasattr(sun, "elevation")
    assert math.isfinite(sun.azimuth)
    assert math.isfinite(sun.elevation)
    assert -90.0 <= sun.elevation <= 90.0
    assert 0.0 <= sun.azimuth < 360.0

    utc = _native.sun_position_utc(45.52, -122.68, 2024, 6, 21, 20, 0, 0)
    assert utc.azimuth == pytest.approx(sun.azimuth, abs=1e-6)
    assert utc.elevation == pytest.approx(sun.elevation, abs=1e-6)

    info = _native.engine_info()
    assert info["crate"] == "forge3d-python"
    assert info["phase"] >= 15
    assert "compatibility" in info["renderer"]
