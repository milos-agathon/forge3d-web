"""Generate the W05 native camera oracle fixture.

Runs against an installed native ``forge3d`` (1.34.x, whose ``animation.py``
and ``camera_rigs.py`` are byte-identical to the parity baseline ``1f4084a``)
and records matrices, depth-of-field helpers, validation messages, animation
samples and terrain rig bakes. The browser
package and ``forge3d-core`` compare against this file within the W05
tolerance (1e-5 scaled by magnitude), so it is regenerated only when the
native oracle changes:

    python crates/forge3d-web/scripts/generate-w05-camera-fixture.py

Matrices are stored row-major exactly as native NumPy returns them.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np

import forge3d
import forge3d._forge3d as native
from forge3d.animation import CameraAnimation, CameraKeyframe
from forge3d.camera_rigs import (
    TerrainClearance,
    TerrainOrbitRig,
    TerrainRailRig,
    TerrainTargetFollowRig,
)
from forge3d.terrain_scatter import TerrainScatterSource

OUTPUT = (
    Path(__file__).resolve().parents[1] / "tests" / "golden" / "w05-camera-native.json"
)


def matrix(value) -> list[list[float]]:
    array = np.asarray(value, dtype=np.float32)
    assert array.shape == (4, 4)
    return [[float(component) for component in row] for row in array]


def error_message(callable_) -> str:
    try:
        callable_()
    except Exception as error:  # noqa: BLE001 - the oracle records any failure text
        return str(error)
    raise AssertionError("expected native call to fail")


def projection_cases() -> dict:
    look_at = [
        {"eye": [0.0, 1.3, 2.4], "target": [0.0, 0.18, 0.0], "up": [0.0, 1.0, 0.0]},
        {"eye": [12.5, -3.0, 7.25], "target": [-1.0, 2.0, 0.5], "up": [0.0, 1.0, 0.0]},
        {"eye": [0.0, 0.0, 5.0], "target": [0.0, 0.0, 0.0], "up": [0.0, 0.0, 1.0 + 1e-3]},
        {"eye": [100.0, 250.0, -40.0], "target": [50.0, 0.0, 50.0], "up": [0.2, 1.0, -0.1]},
    ]
    look_at_cases = []
    for case in look_at:
        try:
            result = matrix(native.camera_look_at(tuple(case["eye"]), tuple(case["target"]), tuple(case["up"])))
            look_at_cases.append({**case, "matrix": result})
        except RuntimeError as error:
            look_at_cases.append({**case, "error": str(error)})

    perspective_cases = []
    for fovy, aspect, znear, zfar in [
        (45.0, 1.5, 0.1, 100.0),
        (46.0, 16.0 / 9.0, 0.01, 100.0),
        (90.0, 1.0, 1.0, 6000.0),
        (10.0, 0.5, 0.5, 2.0),
        (170.0, 2.0, 0.001, 1.0e5),
    ]:
        for clip in ("wgpu", "gl"):
            perspective_cases.append(
                {
                    "fovYDegrees": fovy,
                    "aspect": aspect,
                    "near": znear,
                    "far": zfar,
                    "clipSpace": clip,
                    "matrix": matrix(native.camera_perspective(fovy, aspect, znear, zfar, clip)),
                }
            )

    ortho_cases = []
    for left, right, bottom, top, znear, zfar in [
        (-1.0, 1.0, -1.0, 1.0, 0.1, 10.0),
        (-8.0, 12.0, -3.0, 5.0, 0.5, 250.0),
        (0.0, 1920.0, 0.0, 1080.0, 0.01, 1.0),
    ]:
        for clip in ("wgpu", "gl"):
            ortho_cases.append(
                {
                    "left": left,
                    "right": right,
                    "bottom": bottom,
                    "top": top,
                    "near": znear,
                    "far": zfar,
                    "clipSpace": clip,
                    "matrix": matrix(
                        native.camera_orthographic(left, right, bottom, top, znear, zfar, clip)
                    ),
                }
            )

    view_proj_cases = []
    for eye, target, up, fovy, aspect, znear, zfar in [
        ((0.0, 1.3, 2.4), (0.0, 0.18, 0.0), (0.0, 1.0, 0.0), 46.0, 16.0 / 9.0, 0.01, 100.0),
        ((3.0, 4.5, 7.0), (0.0, 0.6, 0.0), (0.0, 1.0, 0.0), 50.0, 4.0 / 3.0, 0.1, 100.0),
        ((-20.0, 35.0, 18.0), (5.0, 2.0, -3.0), (0.0, 1.0, 0.0), 60.0, 1.0, 0.5, 500.0),
    ]:
        for clip in ("wgpu", "gl"):
            view_proj_cases.append(
                {
                    "eye": list(eye),
                    "target": list(target),
                    "up": list(up),
                    "fovYDegrees": fovy,
                    "aspect": aspect,
                    "near": znear,
                    "far": zfar,
                    "clipSpace": clip,
                    "matrix": matrix(
                        native.camera_view_proj(eye, target, up, fovy, aspect, znear, zfar, clip)
                    ),
                }
            )

    errors = {
        "fovy": error_message(lambda: native.camera_perspective(180.0, 1.0, 0.1, 10.0)),
        "near": error_message(lambda: native.camera_perspective(45.0, 1.0, 0.0, 10.0)),
        "far": error_message(lambda: native.camera_perspective(45.0, 1.0, 1.0, 1.0)),
        "aspect": error_message(lambda: native.camera_perspective(45.0, 0.0, 0.1, 10.0)),
        "clipSpace": error_message(lambda: native.camera_perspective(45.0, 1.0, 0.1, 10.0, "dx")),
        "vectorFinite": error_message(
            lambda: native.camera_look_at((0.0, math.nan, 0.0), (0.0, 0.0, -1.0), (0.0, 1.0, 0.0))
        ),
        "upColinear": error_message(
            lambda: native.camera_look_at((0.0, 0.0, 0.0), (0.0, 5.0, 0.0), (0.0, 1.0, 0.0))
        ),
        "orthoLeftRight": error_message(
            lambda: native.camera_orthographic(1.0, 1.0, -1.0, 1.0, 0.1, 10.0)
        ),
        "orthoBottomTop": error_message(
            lambda: native.camera_orthographic(-1.0, 1.0, 2.0, 1.0, 0.1, 10.0)
        ),
    }
    return {
        "lookAt": look_at_cases,
        "perspective": perspective_cases,
        "orthographic": ortho_cases,
        "viewProjection": view_proj_cases,
        "errors": errors,
    }


def transform_cases() -> dict:
    compose = [
        ([1.0, 2.0, 3.0], [0.0, 0.0, 0.0], [1.0, 1.0, 1.0]),
        ([-4.0, 0.5, 9.0], [30.0, 45.0, 60.0], [2.0, 0.5, 1.5]),
        ([0.0, 0.0, 0.0], [90.0, -120.0, 15.0], [1.0, 3.0, -2.0]),
    ]
    left = native.compose_trs((1.0, 2.0, 3.0), (10.0, 20.0, 30.0), (1.0, 2.0, 0.5))
    right = native.look_at_transform((3.0, 1.0, -2.0), (0.0, 0.0, 0.0), (0.0, 1.0, 0.0))
    invertible = native.compose_trs((5.0, -1.0, 2.0), (15.0, 35.0, -70.0), (2.0, 0.25, 4.0))
    return {
        "translate": [
            {"args": [1.5, -2.0, 3.25], "matrix": matrix(native.translate(1.5, -2.0, 3.25))}
        ],
        "rotateX": [{"degrees": d, "matrix": matrix(native.rotate_x(d))} for d in (0.0, 30.0, 90.0, -135.0)],
        "rotateY": [{"degrees": d, "matrix": matrix(native.rotate_y(d))} for d in (0.0, 30.0, 90.0, -135.0)],
        "rotateZ": [{"degrees": d, "matrix": matrix(native.rotate_z(d))} for d in (0.0, 30.0, 90.0, -135.0)],
        "scale": [{"args": [2.0, 0.5, -3.0], "matrix": matrix(native.scale(2.0, 0.5, -3.0))}],
        "scaleUniform": [{"s": 1.75, "matrix": matrix(native.scale_uniform(1.75))}],
        "composeTrs": [
            {
                "translation": t,
                "rotationDegrees": r,
                "scale": s,
                "matrix": matrix(native.compose_trs(tuple(t), tuple(r), tuple(s))),
            }
            for t, r, s in compose
        ],
        "lookAtTransform": [
            {
                "position": [3.0, 1.0, -2.0],
                "target": [0.0, 0.0, 0.0],
                "up": [0.0, 1.0, 0.0],
                "matrix": matrix(right),
            },
            {
                "position": [-5.0, 8.0, 12.0],
                "target": [1.0, 2.0, 3.0],
                "up": [0.0, 1.0, 0.0],
                "matrix": matrix(
                    native.look_at_transform((-5.0, 8.0, 12.0), (1.0, 2.0, 3.0), (0.0, 1.0, 0.0))
                ),
            },
        ],
        "multiply": [
            {
                "left": matrix(left),
                "right": matrix(right),
                "matrix": matrix(native.multiply_matrices(left, right)),
            }
        ],
        "invert": [{"input": matrix(invertible), "matrix": matrix(native.invert_matrix(invertible))}],
        "normalMatrix": [
            {"input": matrix(invertible), "matrix": matrix(native.compute_normal_matrix(invertible))}
        ],
    }


def dof_cases() -> dict:
    return {
        "fStopToAperture": [
            {"fStop": f, "value": float(native.camera_f_stop_to_aperture(f))} for f in (1.4, 2.8, 8.0, 22.0)
        ],
        "apertureToFStop": [
            {"aperture": a, "value": float(native.camera_aperture_to_f_stop(a))} for a in (0.5, 0.125, 1 / 2.8)
        ],
        "hyperfocal": [
            {
                "focalLength": fl,
                "fStop": fs,
                "circleOfConfusion": coc,
                "value": float(native.camera_hyperfocal_distance(fl, fs, coc)),
            }
            for fl, fs, coc in ((50.0, 2.8, 0.03), (35.0, 8.0, 0.02), (85.0, 1.4, 0.03))
        ],
        "depthOfFieldRange": [
            {
                "focalLength": fl,
                "fStop": fs,
                "focusDistance": fd,
                "circleOfConfusion": coc,
                "value": [
                    None if math.isinf(v) else float(v)
                    for v in native.camera_depth_of_field_range(fl, fs, fd, coc)
                ],
            }
            for fl, fs, fd, coc in (
                (50.0, 2.8, 3000.0, 0.03),
                (35.0, 8.0, 10000.0, 0.03),
                (24.0, 16.0, 2000.0, 0.03),
            )
        ],
        "circleOfConfusion": [
            {
                "depth": d,
                "focalLength": fl,
                "aperture": a,
                "focusDistance": fd,
                "sensorSize": s,
                "value": float(native.camera_circle_of_confusion(d, fl, a, fd, s)),
            }
            for d, fl, a, fd, s in (
                (5.0, 0.05, 0.357, 3.0, 36.0),
                (3.0, 0.05, 0.357, 3.0, 36.0),
                (40.0, 0.035, 0.125, 10.0, 24.0),
            )
        ],
        "dofParams": {
            "value": list(native.camera_dof_params(2.8, 10.0, 50.0, True, 3.5)),
        },
        "errors": {
            "aperture": error_message(lambda: native.camera_aperture_to_f_stop(0.0)),
            "fStop": error_message(lambda: native.camera_f_stop_to_aperture(-1.0)),
            "focusDistance": error_message(lambda: native.camera_depth_of_field_range(50.0, 2.8, 0.0)),
            "focalLength": error_message(lambda: native.camera_hyperfocal_distance(0.0, 2.8)),
            "autoFocusSpeed": error_message(lambda: native.camera_dof_params(2.8, 10.0, 50.0, True, 0.0)),
        },
    }


def state_record(state) -> dict | None:
    if state is None:
        return None
    return {
        "phiDeg": float(state.phi_deg),
        "thetaDeg": float(state.theta_deg),
        "radius": float(state.radius),
        "fovDeg": float(state.fov_deg),
        "target": None if state.target is None else [float(v) for v in state.target],
    }


def keyframe_record(keyframe) -> dict:
    return {
        "time": float(keyframe.time),
        "phiDeg": float(keyframe.phi_deg),
        "thetaDeg": float(keyframe.theta_deg),
        "radius": float(keyframe.radius),
        "fovDeg": float(keyframe.fov_deg),
        "target": None if keyframe.target is None else [float(v) for v in keyframe.target],
    }


def animation_cases() -> list[dict]:
    scenarios = {
        "three-keyframes": [
            (0.0, 0.0, 45.0, 5000.0, 60.0, None),
            (2.5, 90.0, 30.0, 3000.0, 60.0, None),
            (5.0, 180.0, 45.0, 5000.0, 60.0, None),
        ],
        "targets": [
            (0.0, 0.0, 45.0, 1000.0, 60.0, (0.0, 10.0, 0.0)),
            (1.0, 90.0, 45.0, 1000.0, 60.0, (10.0, 20.0, 10.0)),
            (1.7, 135.0, 50.0, 800.0, 55.0, (12.0, 18.0, -4.0)),
        ],
        "mixed-target": [
            (0.0, 0.0, 45.0, 10.0, 50.0, (1.0, 2.0, 3.0)),
            (1.0, 45.0, 40.0, 12.0, 50.0, None),
            (2.0, 90.0, 35.0, 14.0, 45.0, (3.0, 2.0, 1.0)),
            (3.0, 120.0, 30.0, 16.0, 40.0, (4.0, 1.0, 0.0)),
        ],
        "unsorted-many": [
            (float(i), i * 36.0, 45.0 - i, 1000.0 + 25.0 * i, 60.0 - i * 0.5, None)
            for i in (7, 2, 9, 0, 4, 1, 8, 3, 6, 5)
        ],
        "duplicate-times": [
            (0.0, 0.0, 45.0, 10.0, 50.0, None),
            (1.0, 30.0, 45.0, 10.0, 50.0, None),
            (1.0, 60.0, 45.0, 10.0, 50.0, None),
            (2.0, 90.0, 45.0, 10.0, 50.0, None),
        ],
        "single": [(2.0, 45.0, 30.0, 1000.0, 60.0, None)],
        "offset-start": [
            (1.0, 0.0, 45.0, 1000.0, 60.0, None),
            (2.0, 90.0, 45.0, 1000.0, 60.0, None),
        ],
    }
    cases = []
    for name, keyframes in scenarios.items():
        anim = CameraAnimation()
        for time, phi, theta, radius, fov, target in keyframes:
            anim.add_keyframe(time=time, phi=phi, theta=theta, radius=radius, fov=fov, target=target)
        times = [-1.0, 0.0, 0.1, 0.25, 0.5, 0.75, 0.999, 1.0, 1.25, 1.5, 2.0, 2.5, 3.3, 4.5, 5.0, 9.0, 11.0]
        cases.append(
            {
                "name": name,
                "input": [
                    {
                        "time": t,
                        "phiDeg": p,
                        "thetaDeg": th,
                        "radius": r,
                        "fovDeg": f,
                        "target": None if tg is None else list(tg),
                    }
                    for t, p, th, r, f, tg in keyframes
                ],
                "keyframes": [keyframe_record(k) for k in anim.get_keyframes()],
                "duration": float(anim.duration),
                "frameCounts": {str(fps): int(anim.get_frame_count(fps)) for fps in (0, 1, 24, 30, 60)},
                "samples": [{"time": t, "state": state_record(anim.evaluate(t))} for t in times],
            }
        )
    empty = CameraAnimation()
    cases.append(
        {
            "name": "empty",
            "input": [],
            "keyframes": [],
            "duration": float(empty.duration),
            "frameCounts": {str(fps): int(empty.get_frame_count(fps)) for fps in (0, 1, 30)},
            "samples": [{"time": 0.0, "state": state_record(empty.evaluate(0.0))}],
        }
    )
    return cases


def heightmap_from_recipe(recipe: dict) -> np.ndarray:
    size = recipe["size"]
    heights = np.full((size[0], size[1]), recipe.get("fill", 0.0), dtype=np.float32)
    for patch in recipe.get("patches", []):
        heights[patch["row0"]:patch["row1"], patch["col0"]:patch["col1"]] = patch["value"]
    return heights


def dense_hotspot_recipe() -> dict:
    patches = []
    for row, col, value in (
        (52, 4, 34.4708345729944),
        (49, 58, 11.881316632473617),
        (60, 19, 10.809122929711776),
        (16, 41, 14.211712986254597),
        (44, 24, 25.336562926595498),
    ):
        patches.append(
            {
                "row0": max(0, row - 1),
                "row1": min(64, row + 2),
                "col0": max(0, col - 1),
                "col1": min(64, col + 2),
                "value": value,
            }
        )
    return {"size": [64, 64], "fill": 0.0, "patches": patches}


FLAT = {"size": [64, 64], "fill": 0.0, "patches": []}


def rig_cases() -> list[dict]:
    scenarios = [
        {
            "name": "orbit-deterministic",
            "kind": "orbit",
            "source": {"heightmap": FLAT, "zScale": 1.0, "terrainWidth": 100.0},
            "rig": {
                "targetXZ": [50.0, 50.0],
                "duration": 2.0,
                "radius": 20.0,
                "phiStartDeg": 0.0,
                "phiEndDeg": 90.0,
                "thetaStartDeg": 60.0,
                "fovStartDeg": 50.0,
                "clearance": {"minimumHeight": 2.0},
            },
            "samplesPerSecond": 10,
            "fps": 40,
        },
        {
            "name": "rail-constant-speed",
            "kind": "rail",
            "source": {"heightmap": FLAT, "zScale": 1.0, "terrainWidth": 100.0},
            "rig": {
                "pathXZ": [[10.0, 10.0], [90.0, 10.0]],
                "duration": 2.0,
                "cameraHeightOffset": 15.0,
                "lookAheadDistance": 10.0,
                "fovDeg": 55.0,
            },
            "samplesPerSecond": 8,
            "fps": 32,
        },
        {
            "name": "follow-behind-tangent",
            "kind": "follow",
            "source": {"heightmap": FLAT, "zScale": 1.0, "terrainWidth": 100.0},
            "rig": {
                "targetPathXZ": [[10.0, 30.0], [10.0, 90.0]],
                "duration": 2.0,
                "radius": 20.0,
                "thetaDeg": 60.0,
                "headingOffsetDeg": 180.0,
                "fovDeg": 45.0,
                "clearance": {"minimumHeight": 2.0},
            },
            "samplesPerSecond": 8,
            "fps": 32,
        },
        {
            "name": "clearance-lift",
            "kind": "orbit",
            "source": {
                "heightmap": {"size": [32, 32], "fill": 20.0, "patches": []},
                "zScale": 1.0,
                "terrainWidth": 100.0,
            },
            "rig": {
                "targetXZ": [50.0, 50.0],
                "duration": 1.0,
                "radius": 10.0,
                "phiStartDeg": 0.0,
                "phiEndDeg": 0.0,
                "thetaStartDeg": 90.0,
                "clearance": {"minimumHeight": 5.0},
            },
            "samplesPerSecond": 4,
            "fps": 16,
        },
        {
            "name": "orbit-hotspot-refine",
            "kind": "orbit",
            "source": {
                "heightmap": {
                    "size": [64, 64],
                    "fill": 0.0,
                    "patches": [{"row0": 44, "row1": 45, "col0": 31, "col1": 34, "value": 30.0}],
                },
                "zScale": 1.0,
                "terrainWidth": 100.0,
            },
            "rig": {
                "targetXZ": [50.0, 50.0],
                "duration": 1.0,
                "radius": 20.0,
                "phiStartDeg": 0.0,
                "phiEndDeg": 180.0,
                "thetaStartDeg": 90.0,
                "clearance": {"minimumHeight": 5.0, "maxRefinePasses": 8},
            },
            "samplesPerSecond": 1,
            "fps": 16,
        },
        {
            "name": "orbit-large-sweep-sparse",
            "kind": "orbit",
            "source": {"heightmap": FLAT, "zScale": 1.0, "terrainWidth": 100.0},
            "rig": {
                "targetXZ": [50.0, 50.0],
                "duration": 1.0,
                "radius": 20.0,
                "phiStartDeg": 0.0,
                "phiEndDeg": 270.0,
                "thetaStartDeg": 60.0,
            },
            "samplesPerSecond": 1,
            "fps": 8,
        },
        {
            "name": "orbit-multi-turn",
            "kind": "orbit",
            "source": {"heightmap": FLAT, "zScale": 1.0, "terrainWidth": 100.0},
            "rig": {
                "targetXZ": [50.0, 50.0],
                "duration": 1.0,
                "radius": 20.0,
                "phiStartDeg": 0.0,
                "phiEndDeg": 720.0,
                "thetaStartDeg": 60.0,
            },
            "samplesPerSecond": 1,
            "fps": 8,
        },
        {
            "name": "orbit-dense-verification",
            "kind": "orbit",
            "source": {"heightmap": dense_hotspot_recipe(), "zScale": 1.0, "terrainWidth": 100.0},
            "rig": {
                "targetXZ": [50.0, 50.0],
                "duration": 1.0,
                "radius": 25.528397973993567,
                "phiStartDeg": 176.51508390872843,
                "phiEndDeg": 317.25958154840686,
                "thetaStartDeg": 96.6071845743734,
                "thetaEndDeg": 88.03130490228422,
                "clearance": {"minimumHeight": 5.426188480387692, "maxRefinePasses": 8},
            },
            "samplesPerSecond": 3,
            "fps": 240,
        },
        {
            "name": "rail-corner-refine",
            "kind": "rail",
            "source": {"heightmap": FLAT, "zScale": 1.0, "terrainWidth": 100.0},
            "rig": {
                "pathXZ": [[0.0, 0.0], [50.0, 0.0], [50.0, 50.0]],
                "duration": 2.0,
                "cameraHeightOffset": 10.0,
                "lookAheadDistance": 0.0,
                "clearance": {"minimumHeight": 1.0, "maxRefinePasses": 8},
            },
            "samplesPerSecond": 4,
            "fps": 240,
        },
        {
            "name": "rail-path-end",
            "kind": "rail",
            "source": {"heightmap": FLAT, "zScale": 1.0, "terrainWidth": 100.0},
            "rig": {
                "pathXZ": [[10.0, 10.0], [90.0, 10.0]],
                "duration": 1.0,
                "cameraHeightOffset": 0.0,
                "lookAheadDistance": 20.0,
                "targetHeightOffset": 0.0,
            },
            "samplesPerSecond": 4,
            "fps": 16,
        },
        {
            "name": "rail-boundary-end",
            "kind": "rail",
            "source": {"heightmap": FLAT, "zScale": 1.0, "terrainWidth": 100.0},
            "rig": {
                "pathXZ": [[10.0, 10.0], [100.0, 10.0]],
                "duration": 1.0,
                "cameraHeightOffset": 0.0,
                "lookAheadDistance": 20.0,
                "targetHeightOffset": 0.0,
            },
            "samplesPerSecond": 4,
            "fps": 32,
        },
        {
            "name": "rail-scaled-terrain",
            "kind": "rail",
            "source": {
                "heightmap": {
                    "size": [48, 40],
                    "fill": 3.0,
                    "patches": [
                        {"row0": 10, "row1": 30, "col0": 8, "col1": 20, "value": 40.0},
                        {"row0": 30, "row1": 44, "col0": 22, "col1": 36, "value": 12.5},
                    ],
                },
                "zScale": 1.6,
                "terrainWidth": 250.0,
            },
            "rig": {
                "pathXZ": [[20.0, 30.0], [120.0, 60.0], [200.0, 200.0], [60.0, 220.0]],
                "duration": 4.0,
                "cameraHeightOffset": 12.0,
                "lookAheadDistance": 25.0,
                "lateralOffset": 6.0,
                "targetHeightOffset": 2.0,
                "fovDeg": 48.0,
                "clearance": {"minimumHeight": 8.0, "maxRefinePasses": 8},
            },
            "samplesPerSecond": 6,
            "fps": 30,
        },
        {
            "name": "follow-scaled-terrain",
            "kind": "follow",
            "source": {
                "heightmap": {
                    "size": [48, 40],
                    "fill": 3.0,
                    "patches": [
                        {"row0": 10, "row1": 30, "col0": 8, "col1": 20, "value": 40.0},
                        {"row0": 30, "row1": 44, "col0": 22, "col1": 36, "value": 12.5},
                    ],
                },
                "zScale": 1.6,
                "terrainWidth": 250.0,
            },
            "rig": {
                "targetPathXZ": [[60.0, 60.0], [160.0, 90.0], [190.0, 190.0]],
                "duration": 3.0,
                "radius": 35.0,
                "thetaDeg": 55.0,
                "headingOffsetDeg": 150.0,
                "targetHeightOffset": 1.0,
                "fovDeg": 50.0,
                "clearance": {"minimumHeight": 6.0, "maxRefinePasses": 8},
            },
            "samplesPerSecond": 5,
            "fps": 30,
        },
    ]

    cases = []
    for scenario in scenarios:
        recipe = scenario["source"]
        source = TerrainScatterSource(
            heightmap_from_recipe(recipe["heightmap"]),
            z_scale=recipe["zScale"],
            terrain_width=recipe["terrainWidth"],
        )
        params = dict(scenario["rig"])
        clearance_spec = params.pop("clearance", None)
        clearance = (
            TerrainClearance(
                minimum_height=clearance_spec.get("minimumHeight", 0.0),
                max_refine_passes=clearance_spec.get("maxRefinePasses", 8),
            )
            if clearance_spec is not None
            else TerrainClearance()
        )
        kind = scenario["kind"]
        if kind == "orbit":
            rig = TerrainOrbitRig(
                target_xz=tuple(params["targetXZ"]),
                duration=params["duration"],
                radius=params["radius"],
                phi_start_deg=params["phiStartDeg"],
                phi_end_deg=params["phiEndDeg"],
                theta_start_deg=params.get("thetaStartDeg", 45.0),
                theta_end_deg=params.get("thetaEndDeg"),
                radius_end=params.get("radiusEnd"),
                fov_start_deg=params.get("fovStartDeg", 55.0),
                fov_end_deg=params.get("fovEndDeg"),
                target_height_offset=params.get("targetHeightOffset", 0.0),
                clearance=clearance,
            )
        elif kind == "rail":
            rig = TerrainRailRig(
                path_xz=params["pathXZ"],
                duration=params["duration"],
                camera_height_offset=params["cameraHeightOffset"],
                look_ahead_distance=params["lookAheadDistance"],
                lateral_offset=params.get("lateralOffset", 0.0),
                target_height_offset=params.get("targetHeightOffset", 0.0),
                fov_deg=params.get("fovDeg", 55.0),
                clearance=clearance,
            )
        else:
            rig = TerrainTargetFollowRig(
                target_path_xz=params["targetPathXZ"],
                duration=params["duration"],
                radius=params["radius"],
                theta_deg=params.get("thetaDeg", 45.0),
                heading_offset_deg=params.get("headingOffsetDeg", 180.0),
                target_height_offset=params.get("targetHeightOffset", 0.0),
                fov_deg=params.get("fovDeg", 55.0),
                clearance=clearance,
            )
        animation = rig.bake(source, samples_per_second=scenario["samplesPerSecond"])
        fps = scenario["fps"]
        samples = [
            {"time": frame / fps, "state": state_record(animation.evaluate(frame / fps))}
            for frame in range(animation.get_frame_count(fps))
        ]
        cases.append(
            {
                **scenario,
                "keyframes": [keyframe_record(k) for k in animation.get_keyframes()],
                "frameCount": int(animation.get_frame_count(fps)),
                "samples": samples,
            }
        )
    return cases


def rig_errors() -> dict:
    flat = TerrainScatterSource(np.zeros((64, 64), dtype=np.float32), z_scale=1.0, terrain_width=100.0)
    return {
        "uniquePoints": error_message(
            lambda: TerrainRailRig(
                path_xz=[(10.0, 10.0), (10.0, 10.0)],
                duration=1.0,
                camera_height_offset=5.0,
                look_ahead_distance=1.0,
            )
        ),
        "terrainBounds": error_message(
            lambda: TerrainTargetFollowRig(
                target_path_xz=[(10.0, 10.0), (120.0, 10.0)], duration=1.0, radius=10.0
            ).bake(flat, samples_per_second=4)
        ),
        "polarAngle": error_message(
            lambda: TerrainOrbitRig(
                target_xz=(50.0, 50.0),
                duration=1.0,
                radius=10.0,
                phi_start_deg=0.0,
                phi_end_deg=90.0,
                theta_start_deg=180.0,
            )
        ),
        "samplesPerSecond": error_message(
            lambda: TerrainOrbitRig(
                target_xz=(50.0, 50.0), duration=1.0, radius=10.0, phi_start_deg=0.0, phi_end_deg=90.0
            ).bake(flat, samples_per_second=0)
        ),
    }


def main() -> None:
    fixture = {
        "fixtureId": "w05-camera-native-v1",
        "generator": "crates/forge3d-web/scripts/generate-w05-camera-fixture.py",
        "oracle": {
            "package": "forge3d",
            "version": forge3d.__version__,
            "baselineCommit": "1f4084af428dc699bdcd108b029736cb73903926",
            "note": (
                "animation.py/camera_rigs.py and the camera/transform bindings match the "
                "baseline sources; the 1.34 native CameraAnimation stores time/angles in f32 "
                "like 1f4084a but keeps radius/fov/target in f64 (differences < 1e-8 relative)"
            ),
        },
        "matrixLayout": "row-major",
        "tolerance": {"absolute": 1e-5, "relativeAbove": 1.0},
        "projection": projection_cases(),
        "transforms": transform_cases(),
        "dof": dof_cases(),
        "animation": animation_cases(),
        "rigs": rig_cases(),
        "rigErrors": rig_errors(),
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(fixture, indent=1, allow_nan=False) + "\n", encoding="utf-8")
    print(f"wrote {OUTPUT} ({OUTPUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
