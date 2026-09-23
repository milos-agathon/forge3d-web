use std::path::Path;

use glam::{Mat4, Vec3};
use serde_json::Value;

use super::animation::{CameraAnimation, CameraKeyframe, RenderConfig};
use super::controller::{CameraController, CameraMode, FlyInput};
use super::dof;
use super::projection::{self, ClipSpace};
use super::rigs::{
    TerrainClearance, TerrainOrbitRig, TerrainRailRig, TerrainRigSource, TerrainTargetFollowRig,
};
use super::screen;
use super::transforms;
use super::{CameraInput, CameraProjection};

/// W05 acceptance tolerance: 1e-5 absolute, relative above magnitude 1.
fn assert_close(actual: f64, expected: f64, context: &str) {
    let tolerance = 1e-5 * expected.abs().max(1.0);
    assert!(
        (actual - expected).abs() <= tolerance,
        "{context}: expected {expected}, got {actual}"
    );
}

fn fixture() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../forge3d-web/tests/golden/w05-camera-native.json");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("failed to read {}: {error}", path.display()));
    serde_json::from_str(&text).expect("W05 fixture must be valid JSON")
}

fn f(value: &Value) -> f64 {
    value.as_f64().expect("fixture value must be a number")
}

fn f32v(value: &Value) -> f32 {
    f(value) as f32
}

fn vec3(value: &Value) -> [f32; 3] {
    let items = value.as_array().expect("vector");
    [f32v(&items[0]), f32v(&items[1]), f32v(&items[2])]
}

fn rows(value: &Value) -> [[f32; 4]; 4] {
    let mut out = [[0.0; 4]; 4];
    for (r, row) in value.as_array().expect("matrix rows").iter().enumerate() {
        for (c, item) in row.as_array().expect("matrix row").iter().enumerate() {
            out[r][c] = f32v(item);
        }
    }
    out
}

fn assert_matrix(actual: Mat4, expected: &Value, context: &str) {
    let expected = rows(expected);
    let actual = transforms::to_rows(actual);
    for r in 0..4 {
        for c in 0..4 {
            assert_close(
                actual[r][c] as f64,
                expected[r][c] as f64,
                &format!("{context}[{r}][{c}]"),
            );
        }
    }
}

fn clip(value: &Value) -> ClipSpace {
    ClipSpace::parse(value.as_str().expect("clip space")).expect("valid clip space")
}

#[test]
fn projection_matches_native_oracle() {
    let fixture = fixture();
    let projection = &fixture["projection"];
    for case in projection["lookAt"].as_array().unwrap() {
        let result =
            projection::look_at(vec3(&case["eye"]), vec3(&case["target"]), vec3(&case["up"]));
        match case.get("error") {
            Some(message) => {
                let error = result.expect_err("native rejects this look-at").to_string();
                assert!(error.contains(message.as_str().unwrap()), "{error}");
            }
            None => assert_matrix(result.unwrap(), &case["matrix"], "lookAt"),
        }
    }
    for case in projection["perspective"].as_array().unwrap() {
        let matrix = projection::perspective(
            f32v(&case["fovYDegrees"]),
            f32v(&case["aspect"]),
            f32v(&case["near"]),
            f32v(&case["far"]),
            clip(&case["clipSpace"]),
        )
        .unwrap();
        assert_matrix(matrix, &case["matrix"], "perspective");
    }
    for case in projection["orthographic"].as_array().unwrap() {
        let matrix = projection::orthographic(
            f32v(&case["left"]),
            f32v(&case["right"]),
            f32v(&case["bottom"]),
            f32v(&case["top"]),
            f32v(&case["near"]),
            f32v(&case["far"]),
            clip(&case["clipSpace"]),
        )
        .unwrap();
        assert_matrix(matrix, &case["matrix"], "orthographic");
    }
    for case in projection["viewProjection"].as_array().unwrap() {
        let matrix = projection::view_projection(
            vec3(&case["eye"]),
            vec3(&case["target"]),
            vec3(&case["up"]),
            f32v(&case["fovYDegrees"]),
            f32v(&case["aspect"]),
            f32v(&case["near"]),
            f32v(&case["far"]),
            clip(&case["clipSpace"]),
        )
        .unwrap();
        assert_matrix(matrix, &case["matrix"], "viewProjection");
    }
}

/// Native messages use snake_case parameter names; the browser surface names
/// its own parameters but keeps the native wording.
fn browser_message(native: &str) -> String {
    let mut message = native.to_string();
    for (from, to) in [
        ("fovy_deg", "fovYDegrees"),
        (
            "zfar must be finite and > znear",
            "far must be finite and > near",
        ),
        ("znear", "near"),
        ("clip_space", "clipSpace"),
        ("focus_distance", "focusDistance"),
        ("focal_length", "focalLength"),
        ("auto_focus_speed", "autoFocusSpeed"),
        ("f_stop", "fStop"),
        ("target_path_xz", "targetPathXZ"),
        ("theta_start_deg", "thetaStartDeg"),
        ("samples_per_second", "samplesPerSecond"),
        ("path_xz", "pathXZ"),
    ] {
        message = message.replace(from, to);
    }
    message
}

#[test]
fn projection_errors_keep_native_wording() {
    let fixture = fixture();
    let errors = &fixture["projection"]["errors"];
    let expect = |result: crate::error::Result<Mat4>, key: &str| {
        let message = result.expect_err(key).to_string();
        let native = browser_message(errors[key].as_str().unwrap());
        assert!(message.contains(&native), "{key}: {message} !~ {native}");
    };
    expect(
        projection::perspective(180.0, 1.0, 0.1, 10.0, ClipSpace::Wgpu),
        "fovy",
    );
    expect(
        projection::perspective(45.0, 1.0, 0.0, 10.0, ClipSpace::Wgpu),
        "near",
    );
    expect(
        projection::perspective(45.0, 1.0, 1.0, 1.0, ClipSpace::Wgpu),
        "far",
    );
    expect(
        projection::perspective(45.0, 0.0, 0.1, 10.0, ClipSpace::Wgpu),
        "aspect",
    );
    expect(ClipSpace::parse("dx").map(|_| Mat4::IDENTITY), "clipSpace");
    expect(
        projection::look_at([0.0, f32::NAN, 0.0], [0.0, 0.0, -1.0], [0.0, 1.0, 0.0]),
        "vectorFinite",
    );
    expect(
        projection::look_at([0.0, 0.0, 0.0], [0.0, 5.0, 0.0], [0.0, 1.0, 0.0]),
        "upColinear",
    );
    expect(
        projection::orthographic(1.0, 1.0, -1.0, 1.0, 0.1, 10.0, ClipSpace::Wgpu),
        "orthoLeftRight",
    );
    expect(
        projection::orthographic(-1.0, 1.0, 2.0, 1.0, 0.1, 10.0, ClipSpace::Wgpu),
        "orthoBottomTop",
    );
}

#[test]
fn transforms_match_native_oracle() {
    let fixture = fixture();
    let t = &fixture["transforms"];
    for case in t["translate"].as_array().unwrap() {
        let a = case["args"].as_array().unwrap();
        assert_matrix(
            transforms::translate(f32v(&a[0]), f32v(&a[1]), f32v(&a[2])),
            &case["matrix"],
            "translate",
        );
    }
    for (key, function) in [
        ("rotateX", transforms::rotate_x as fn(f32) -> Mat4),
        ("rotateY", transforms::rotate_y),
        ("rotateZ", transforms::rotate_z),
    ] {
        for case in t[key].as_array().unwrap() {
            assert_matrix(function(f32v(&case["degrees"])), &case["matrix"], key);
        }
    }
    for case in t["scale"].as_array().unwrap() {
        let a = case["args"].as_array().unwrap();
        assert_matrix(
            transforms::scale(f32v(&a[0]), f32v(&a[1]), f32v(&a[2])),
            &case["matrix"],
            "scale",
        );
    }
    for case in t["scaleUniform"].as_array().unwrap() {
        assert_matrix(
            transforms::scale_uniform(f32v(&case["s"])),
            &case["matrix"],
            "scaleUniform",
        );
    }
    for case in t["composeTrs"].as_array().unwrap() {
        assert_matrix(
            transforms::compose_trs(
                vec3(&case["translation"]),
                vec3(&case["rotationDegrees"]),
                vec3(&case["scale"]),
            ),
            &case["matrix"],
            "composeTrs",
        );
    }
    for case in t["lookAtTransform"].as_array().unwrap() {
        assert_matrix(
            transforms::look_at_transform(
                vec3(&case["position"]),
                vec3(&case["target"]),
                vec3(&case["up"]),
            ),
            &case["matrix"],
            "lookAtTransform",
        );
    }
    for case in t["multiply"].as_array().unwrap() {
        let left = transforms::from_rows(rows(&case["left"]));
        let right = transforms::from_rows(rows(&case["right"]));
        assert_matrix(
            transforms::multiply(left, right),
            &case["matrix"],
            "multiply",
        );
    }
    for case in t["invert"].as_array().unwrap() {
        let input = transforms::from_rows(rows(&case["input"]));
        assert_matrix(
            transforms::invert(input).unwrap(),
            &case["matrix"],
            "invert",
        );
    }
    for case in t["normalMatrix"].as_array().unwrap() {
        let input = transforms::from_rows(rows(&case["input"]));
        assert_matrix(
            transforms::normal_matrix(input).unwrap(),
            &case["matrix"],
            "normalMatrix",
        );
    }
    assert!(transforms::invert(Mat4::ZERO).is_err());
    assert!(transforms::normal_matrix(transforms::scale(1.0, 0.0, 1.0)).is_err());
}

#[test]
fn dof_helpers_match_native_oracle() {
    let fixture = fixture();
    let d = &fixture["dof"];
    for case in d["fStopToAperture"].as_array().unwrap() {
        assert_close(
            dof::f_stop_to_aperture(f32v(&case["fStop"])).unwrap() as f64,
            f(&case["value"]),
            "fStopToAperture",
        );
    }
    for case in d["apertureToFStop"].as_array().unwrap() {
        assert_close(
            dof::aperture_to_f_stop(f32v(&case["aperture"])).unwrap() as f64,
            f(&case["value"]),
            "apertureToFStop",
        );
    }
    for case in d["hyperfocal"].as_array().unwrap() {
        let value = dof::hyperfocal_distance(
            f32v(&case["focalLength"]),
            f32v(&case["fStop"]),
            f32v(&case["circleOfConfusion"]),
        )
        .unwrap();
        assert_close(value as f64, f(&case["value"]), "hyperfocal");
    }
    for case in d["depthOfFieldRange"].as_array().unwrap() {
        let (near, far) = dof::depth_of_field_range(
            f32v(&case["focalLength"]),
            f32v(&case["fStop"]),
            f32v(&case["focusDistance"]),
            f32v(&case["circleOfConfusion"]),
        )
        .unwrap();
        let expected = case["value"].as_array().unwrap();
        assert_close(near as f64, f(&expected[0]), "dof near");
        match expected[1].as_f64() {
            Some(value) => assert_close(far as f64, value, "dof far"),
            None => assert!(far.is_infinite()),
        }
    }
    for case in d["circleOfConfusion"].as_array().unwrap() {
        let value = dof::circle_of_confusion(
            f32v(&case["depth"]),
            f32v(&case["focalLength"]),
            f32v(&case["aperture"]),
            f32v(&case["focusDistance"]),
            f32v(&case["sensorSize"]),
        )
        .unwrap();
        assert_close(value as f64, f(&case["value"]), "circleOfConfusion");
    }
    let params = dof::CameraDofParams::new(2.8, 10.0, 50.0, true, 3.5).unwrap();
    let expected = d["dofParams"]["value"].as_array().unwrap();
    assert_close(
        params.aperture as f64,
        f(&expected[0]),
        "dofParams.aperture",
    );
    assert_eq!(params.auto_focus, expected[3].as_bool().unwrap());
    let errors = &d["errors"];
    for (result, key) in [
        (dof::aperture_to_f_stop(0.0).map(|_| ()), "aperture"),
        (dof::f_stop_to_aperture(-1.0).map(|_| ()), "fStop"),
        (
            dof::depth_of_field_range(50.0, 2.8, 0.0, 0.03).map(|_| ()),
            "focusDistance",
        ),
        (
            dof::hyperfocal_distance(0.0, 2.8, 0.03).map(|_| ()),
            "focalLength",
        ),
        (
            dof::CameraDofParams::new(2.8, 10.0, 50.0, true, 0.0).map(|_| ()),
            "autoFocusSpeed",
        ),
    ] {
        let message = result.expect_err(key).to_string();
        let native = browser_message(errors[key].as_str().unwrap());
        assert!(message.contains(&native), "{key}: {message} !~ {native}");
    }
}

fn keyframe_from(value: &Value) -> CameraKeyframe {
    CameraKeyframe::new(
        f32v(&value["time"]),
        f32v(&value["phiDeg"]),
        f32v(&value["thetaDeg"]),
        f32v(&value["radius"]),
        f32v(&value["fovDeg"]),
        value["target"].as_array().map(|_| vec3(&value["target"])),
    )
    .unwrap()
}

fn assert_keyframe(actual: &CameraKeyframe, expected: &Value, context: &str) {
    assert_close(
        actual.time as f64,
        f(&expected["time"]),
        &format!("{context}.time"),
    );
    assert_close(
        actual.phi_deg as f64,
        f(&expected["phiDeg"]),
        &format!("{context}.phi"),
    );
    assert_close(
        actual.theta_deg as f64,
        f(&expected["thetaDeg"]),
        &format!("{context}.theta"),
    );
    assert_close(
        actual.radius as f64,
        f(&expected["radius"]),
        &format!("{context}.radius"),
    );
    assert_close(
        actual.fov_deg as f64,
        f(&expected["fovDeg"]),
        &format!("{context}.fov"),
    );
    assert_target(actual.target, &expected["target"], context);
}

fn assert_target(actual: Option<[f32; 3]>, expected: &Value, context: &str) {
    match (actual, expected.as_array()) {
        (None, None) => {}
        (Some(actual), Some(expected)) => {
            for axis in 0..3 {
                assert_close(
                    actual[axis] as f64,
                    f(&expected[axis]),
                    &format!("{context}.target[{axis}]"),
                );
            }
        }
        (actual, _) => panic!("{context}: target mismatch {actual:?} vs {expected}"),
    }
}

fn assert_state(animation: &CameraAnimation, sample: &Value, context: &str) {
    let time = f32v(&sample["time"]);
    let state = animation.evaluate(time);
    let expected = &sample["state"];
    match state {
        None => assert!(expected.is_null(), "{context}: expected a state"),
        Some(state) => {
            assert_close(
                state.phi_deg as f64,
                f(&expected["phiDeg"]),
                &format!("{context}@{time}.phi"),
            );
            assert_close(
                state.theta_deg as f64,
                f(&expected["thetaDeg"]),
                &format!("{context}@{time}.theta"),
            );
            assert_close(
                state.radius as f64,
                f(&expected["radius"]),
                &format!("{context}@{time}.radius"),
            );
            assert_close(
                state.fov_deg as f64,
                f(&expected["fovDeg"]),
                &format!("{context}@{time}.fov"),
            );
            assert_target(
                state.target,
                &expected["target"],
                &format!("{context}@{time}"),
            );
        }
    }
}

#[test]
fn animation_matches_native_oracle() {
    let fixture = fixture();
    for case in fixture["animation"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let mut animation = CameraAnimation::new();
        for keyframe in case["input"].as_array().unwrap() {
            animation.add_keyframe(keyframe_from(keyframe)).unwrap();
        }
        let expected = case["keyframes"].as_array().unwrap();
        assert_eq!(animation.keyframe_count(), expected.len(), "{name}");
        for (index, keyframe) in animation.keyframes().iter().enumerate() {
            assert_keyframe(keyframe, &expected[index], &format!("{name}[{index}]"));
        }
        assert_close(animation.duration() as f64, f(&case["duration"]), name);
        for (fps, count) in case["frameCounts"].as_object().unwrap() {
            assert_eq!(
                animation.frame_count(fps.parse().unwrap()) as u64,
                count.as_u64().unwrap(),
                "{name} frame count at {fps}"
            );
        }
        for sample in case["samples"].as_array().unwrap() {
            assert_state(&animation, sample, name);
        }
    }
}

#[test]
fn animation_edits_replace_clear_and_reject_non_finite() {
    let mut animation = CameraAnimation::new();
    animation
        .add_keyframe(CameraKeyframe::new(5.0, 180.0, 35.0, 3000.0, 60.0, None).unwrap())
        .unwrap();
    animation
        .replace_keyframes(vec![
            CameraKeyframe::new(2.0, 90.0, 40.0, 2000.0, 55.0, None).unwrap(),
            CameraKeyframe::new(0.0, 0.0, 45.0, 2500.0, 55.0, Some([1.0, 2.0, 3.0])).unwrap(),
        ])
        .unwrap();
    let times: Vec<f32> = animation.keyframes().iter().map(|k| k.time).collect();
    assert_eq!(times, vec![0.0, 2.0]);
    assert_eq!(animation.keyframes()[0].target, Some([1.0, 2.0, 3.0]));
    animation.clear_keyframes();
    assert_eq!(animation.keyframe_count(), 0);
    assert_eq!(animation.duration(), 0.0);
    assert!(animation.evaluate(0.0).is_none());
    assert!(CameraKeyframe::new(f32::NAN, 0.0, 0.0, 1.0, 45.0, None).is_err());
    assert!(
        CameraKeyframe::new(0.0, 0.0, 0.0, 1.0, 45.0, Some([0.0, f32::INFINITY, 0.0])).is_err()
    );
}

#[test]
fn render_config_names_frames_like_native() {
    let config = RenderConfig::default();
    assert_eq!(config.frame_file_name(0), "frame_0000.png");
    assert_eq!(config.frame_file_name(42), "frame_0042.png");
    assert_eq!(config.frame_file_name(9999), "frame_9999.png");
    assert_eq!(super::animation::render_progress_percent(50, 100), 0.5);
    assert_eq!(super::animation::render_progress_percent(0, 0), 0.0);
}

fn heightmap(recipe: &Value) -> (Vec<f32>, usize, usize) {
    let size = recipe["size"].as_array().unwrap();
    let rows_count = size[0].as_u64().unwrap() as usize;
    let cols = size[1].as_u64().unwrap() as usize;
    let fill = f32v(&recipe["fill"]);
    let mut heights = vec![fill; rows_count * cols];
    for patch in recipe["patches"].as_array().unwrap() {
        for row in
            patch["row0"].as_u64().unwrap() as usize..patch["row1"].as_u64().unwrap() as usize
        {
            for col in
                patch["col0"].as_u64().unwrap() as usize..patch["col1"].as_u64().unwrap() as usize
            {
                heights[row * cols + col] = f32v(&patch["value"]);
            }
        }
    }
    (heights, cols, rows_count)
}

fn source_from(value: &Value) -> TerrainRigSource {
    let (heights, width, height) = heightmap(&value["heightmap"]);
    TerrainRigSource::new(
        &heights,
        width,
        height,
        f(&value["zScale"]),
        Some(f(&value["terrainWidth"])),
    )
    .unwrap()
}

fn clearance_from(rig: &Value) -> TerrainClearance {
    match rig.get("clearance") {
        None => TerrainClearance::default(),
        Some(spec) => TerrainClearance::new(
            spec.get("minimumHeight").map(f).unwrap_or(0.0),
            spec.get("maxRefinePasses")
                .and_then(Value::as_u64)
                .unwrap_or(8) as u32,
        )
        .unwrap(),
    }
}

fn path(value: &Value) -> Vec<(f64, f64)> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|point| {
            let items = point.as_array().unwrap();
            (f(&items[0]), f(&items[1]))
        })
        .collect()
}

fn opt(rig: &Value, key: &str) -> Option<f64> {
    rig.get(key).and_then(Value::as_f64)
}

fn bake_case(case: &Value) -> CameraAnimation {
    let source = source_from(&case["source"]);
    let rig = &case["rig"];
    let sps = case["samplesPerSecond"].as_u64().unwrap() as u32;
    match case["kind"].as_str().unwrap() {
        "orbit" => {
            let target = rig["targetXZ"].as_array().unwrap();
            TerrainOrbitRig::new(
                (f(&target[0]), f(&target[1])),
                f(&rig["duration"]),
                f(&rig["radius"]),
                f(&rig["phiStartDeg"]),
                f(&rig["phiEndDeg"]),
                opt(rig, "thetaStartDeg").unwrap_or(45.0),
                opt(rig, "thetaEndDeg"),
                opt(rig, "radiusEnd"),
                opt(rig, "fovStartDeg").unwrap_or(55.0),
                opt(rig, "fovEndDeg"),
                opt(rig, "targetHeightOffset").unwrap_or(0.0),
                clearance_from(rig),
            )
            .unwrap()
            .bake(&source, sps)
            .unwrap()
        }
        "rail" => TerrainRailRig::new(
            &path(&rig["pathXZ"]),
            f(&rig["duration"]),
            f(&rig["cameraHeightOffset"]),
            f(&rig["lookAheadDistance"]),
            opt(rig, "lateralOffset").unwrap_or(0.0),
            opt(rig, "targetHeightOffset").unwrap_or(0.0),
            opt(rig, "fovDeg").unwrap_or(55.0),
            clearance_from(rig),
        )
        .unwrap()
        .bake(&source, sps)
        .unwrap(),
        "follow" => TerrainTargetFollowRig::new(
            &path(&rig["targetPathXZ"]),
            f(&rig["duration"]),
            f(&rig["radius"]),
            opt(rig, "thetaDeg").unwrap_or(45.0),
            opt(rig, "headingOffsetDeg").unwrap_or(180.0),
            opt(rig, "targetHeightOffset").unwrap_or(0.0),
            opt(rig, "fovDeg").unwrap_or(55.0),
            clearance_from(rig),
        )
        .unwrap()
        .bake(&source, sps)
        .unwrap(),
        other => panic!("unknown rig kind {other}"),
    }
}

#[test]
fn rigs_bake_native_keyframes_and_sample_paths() {
    let fixture = fixture();
    for case in fixture["rigs"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let animation = bake_case(case);
        let expected = case["keyframes"].as_array().unwrap();
        assert_eq!(
            animation.keyframe_count(),
            expected.len(),
            "{name} keyframe count"
        );
        for (index, keyframe) in animation.keyframes().iter().enumerate() {
            assert_keyframe(keyframe, &expected[index], &format!("{name}[{index}]"));
        }
        let fps = case["fps"].as_u64().unwrap() as u32;
        assert_eq!(
            animation.frame_count(fps) as u64,
            case["frameCount"].as_u64().unwrap(),
            "{name}"
        );
        for sample in case["samples"].as_array().unwrap() {
            assert_state(&animation, sample, name);
        }
    }
}

#[test]
fn rig_bakes_are_deterministic_and_never_violate_clearance() {
    let fixture = fixture();
    for case in fixture["rigs"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let first = bake_case(case);
        let second = bake_case(case);
        assert_eq!(first, second, "{name} must bake bit-identically");
        let source = source_from(&case["source"]);
        let minimum = clearance_from(&case["rig"]).minimum_height;
        let fps = case["fps"].as_u64().unwrap() as u32;
        for frame in 0..first.frame_count(fps) {
            let time = frame as f32 / fps as f32;
            let state = first.evaluate(time).unwrap();
            let target = state.target.expect("rig states keep their target");
            let eye = state.eye(target);
            let width = source.terrain_width();
            for axis in [0, 2] {
                assert!(
                    eye[axis] >= -1e-4 && eye[axis] <= width + 1e-4,
                    "{name} eye left bounds"
                );
            }
            let safe = source.height_at(eye[0], eye[2]) + minimum;
            assert!(
                eye[1] + super::rigs::CLEARANCE_TOLERANCE >= safe,
                "{name} violated clearance at {time}"
            );
        }
    }
}

#[test]
fn clamped_rig_playback_never_violates_clearance_between_samples() {
    let fixture = fixture();
    for case in fixture["rigs"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let animation = bake_case(case);
        let source = source_from(&case["source"]);
        let minimum = clearance_from(&case["rig"]).minimum_height;
        // 997 Hz is coprime with every verification rate.
        let steps = (animation.duration() as f64 * 997.0).ceil() as u32;
        for index in 0..=steps {
            let time = index as f32 / 997.0;
            let eye = source
                .eye_at(&animation, time, Some(minimum))
                .unwrap()
                .unwrap()
                .eye;
            assert!(
                eye[1] >= source.height_at(eye[0], eye[2]) + minimum,
                "{name} violated clearance at {time}"
            );
        }
    }
    let empty = CameraAnimation::new();
    let flat = TerrainRigSource::new(&[0.0; 4], 2, 2, 1.0, None).unwrap();
    assert!(flat.eye_at(&empty, 0.0, None).unwrap().is_none());
    let mut untargeted = CameraAnimation::new();
    untargeted
        .add_keyframe(CameraKeyframe::new(0.0, 0.0, 45.0, 5.0, 50.0, None).unwrap())
        .unwrap();
    assert!(flat.eye_at(&untargeted, 0.0, None).is_err());
}

#[test]
fn rig_validation_matches_native_errors() {
    let fixture = fixture();
    let errors = &fixture["rigErrors"];
    let flat = TerrainRigSource::new(&vec![0.0; 64 * 64], 64, 64, 1.0, Some(100.0)).unwrap();
    let check = |result: crate::error::Result<()>, key: &str| {
        let message = result.expect_err(key).to_string();
        let native = browser_message(errors[key].as_str().unwrap());
        assert!(message.contains(&native), "{key}: {message} !~ {native}");
    };
    check(
        TerrainRailRig::new(
            &[(10.0, 10.0), (10.0, 10.0)],
            1.0,
            5.0,
            1.0,
            0.0,
            0.0,
            55.0,
            TerrainClearance::default(),
        )
        .map(|_| ()),
        "uniquePoints",
    );
    check(
        TerrainTargetFollowRig::new(
            &[(10.0, 10.0), (120.0, 10.0)],
            1.0,
            10.0,
            45.0,
            180.0,
            0.0,
            55.0,
            TerrainClearance::default(),
        )
        .unwrap()
        .bake(&flat, 4)
        .map(|_| ()),
        "terrainBounds",
    );
    check(
        TerrainOrbitRig::new(
            (50.0, 50.0),
            1.0,
            10.0,
            0.0,
            90.0,
            180.0,
            None,
            None,
            55.0,
            None,
            0.0,
            TerrainClearance::default(),
        )
        .map(|_| ()),
        "polarAngle",
    );
    check(
        TerrainOrbitRig::new(
            (50.0, 50.0),
            1.0,
            10.0,
            0.0,
            90.0,
            45.0,
            None,
            None,
            55.0,
            None,
            0.0,
            TerrainClearance::default(),
        )
        .unwrap()
        .bake(&flat, 0)
        .map(|_| ()),
        "samplesPerSecond",
    );
    assert!(TerrainOrbitRig::new(
        (50.0, 50.0),
        1.0,
        10.0,
        0.0,
        90.0,
        45.0,
        Some(180.0),
        None,
        55.0,
        None,
        0.0,
        TerrainClearance::default()
    )
    .is_err());
    assert!(TerrainClearance::new(-1.0, 8).is_err());
    assert!(TerrainRigSource::new(&[f32::NAN; 4], 2, 2, 1.0, None).is_err());
    assert!(TerrainRigSource::new(&[0.0; 3], 2, 2, 1.0, None).is_err());
}

#[test]
fn terrain_source_fills_nodata_and_samples_bilinearly() {
    let source = TerrainRigSource::new(&[1.0, f32::NAN, 3.0, 5.0], 2, 2, 2.0, Some(10.0)).unwrap();
    assert_eq!(source.min_height(), 1.0);
    // NaN is filled with the minimum finite sample (1.0 -> scaled 0).
    assert_close(source.height_at(10.0, 0.0), 0.0, "filled nodata");
    assert_close(
        source.height_at(5.0, 5.0),
        (0.0 + 0.0 + 4.0 + 8.0) / 4.0,
        "center",
    );
    assert_close(
        super::rigs::viewer_orbit_radius(10.0, 1.9, 5.0).unwrap(),
        19.0,
        "orbit radius",
    );
    assert_close(
        super::rigs::viewer_orbit_radius(1.0, 1.9, 5.0).unwrap(),
        5.0,
        "orbit minimum",
    );
}

#[test]
fn camera_input_orthographic_projection_and_extents() {
    let camera = CameraInput::with_projection(
        [0.0, 10.0, 10.0],
        [0.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
        45.0,
        0.1,
        100.0,
        CameraProjection::Orthographic { height: 8.0 },
    )
    .unwrap();
    let projection = camera.projection_matrix(2.0).unwrap();
    let expected =
        projection::orthographic(-8.0, 8.0, -4.0, 4.0, 0.1, 100.0, ClipSpace::Wgpu).unwrap();
    assert!(projection.abs_diff_eq(expected, 1e-6));
    assert_eq!(camera.half_extents_at(1.0, 2.0), (8.0, 4.0));
    assert_eq!(camera.half_extents_at(50.0, 2.0), (8.0, 4.0));
    let perspective = CameraInput::default();
    let (w, h) = perspective.half_extents_at(10.0, 2.0);
    assert!((h - 10.0 * 23.0_f32.to_radians().tan()).abs() < 1e-5 && (w - 2.0 * h).abs() < 1e-5);
    assert!(CameraInput::with_projection(
        [0.0, 1.0, 1.0],
        [0.0; 3],
        [0.0, 1.0, 0.0],
        45.0,
        0.1,
        10.0,
        CameraProjection::Orthographic { height: 0.0 },
    )
    .is_err());
    // Perspective output is unchanged from the pre-W05 look-at/perspective_rh path.
    let legacy = glam::Mat4::perspective_rh(46.0_f32.to_radians(), 1.5, 0.01, 100.0)
        * glam::Mat4::look_at_rh(Vec3::new(0.0, 1.3, 2.4), Vec3::new(0.0, 0.18, 0.0), Vec3::Y);
    assert_eq!(
        perspective.view_projection_matrix(1.5).unwrap(),
        legacy.to_cols_array_2d()
    );
}

#[test]
fn camera_input_rejects_colinear_up_and_keeps_legacy_messages() {
    let error = CameraInput::new([0.0, 5.0, 0.0], [0.0; 3], [0.0, 1.0, 0.0], 45.0, 0.1, 10.0)
        .unwrap_err()
        .to_string();
    assert!(error.contains("colinear"), "{error}");
    let error = CameraInput::new(
        [0.0, f32::NAN, 2.0],
        [0.0; 3],
        [0.0, 1.0, 0.0],
        45.0,
        0.01,
        100.0,
    )
    .unwrap_err()
    .to_string();
    assert!(error.contains("position"));
    let error = CameraInput::new([0.0, 1.0, 2.0], [0.0; 3], [0.0, 1.0, 0.0], 45.0, 10.0, 1.0)
        .unwrap_err()
        .to_string();
    assert!(error.contains("far"));
}

#[test]
fn world_screen_round_trip_and_picking_ray() {
    let camera = CameraInput::new(
        [3.0, 4.0, 5.0],
        [0.0, 0.5, 0.0],
        [0.0, 1.0, 0.0],
        50.0,
        0.1,
        100.0,
    )
    .unwrap();
    let view_projection =
        Mat4::from_cols_array_2d(&camera.view_projection_matrix(640.0 / 480.0).unwrap());
    let inverse = view_projection.inverse();
    let target = screen::world_to_screen(view_projection, [0.0, 0.5, 0.0], 640.0, 480.0)
        .unwrap()
        .expect("target is in front of the camera");
    assert!((target.x - 320.0).abs() < 1e-3 && (target.y - 240.0).abs() < 1e-3);
    for point in [[1.0, 0.0, -1.0], [-2.0, 1.5, 0.5], [0.25, 3.0, 1.0]] {
        let projected = screen::world_to_screen(view_projection, point, 640.0, 480.0)
            .unwrap()
            .unwrap();
        let back = screen::screen_to_world(
            inverse,
            projected.x,
            projected.y,
            projected.depth,
            640.0,
            480.0,
        )
        .unwrap();
        for axis in 0..3 {
            assert!(
                (back[axis] - point[axis]).abs() < 1e-3,
                "{back:?} vs {point:?}"
            );
        }
        let ray = screen::screen_ray(inverse, projected.x, projected.y, 640.0, 480.0).unwrap();
        let to_point = Vec3::from_array(point) - Vec3::from_array(ray.origin);
        let along = to_point.dot(Vec3::from_array(ray.direction));
        let closest = Vec3::from_array(ray.point_at(along));
        assert!((closest - Vec3::from_array(point)).length() < 1e-3);
    }
    let behind = screen::world_to_screen(view_projection, [6.0, 8.0, 10.0], 640.0, 480.0).unwrap();
    assert!(behind.is_none());
    assert!(screen::world_to_screen(view_projection, [0.0; 3], 0.0, 480.0).is_err());
}

#[test]
fn controller_switches_modes_without_jumping_the_view() {
    let mut controller = CameraController::new();
    controller.set_orbit_pose_target(Vec3::new(1.0, 2.0, 3.0), 10.0, 0.7, 0.4);
    let eye = controller.eye();
    let forward = (controller.target() - eye).normalize();
    controller.set_mode(CameraMode::Fps);
    assert!((controller.eye() - eye).length() < 1e-5);
    assert!(((controller.target() - controller.eye()).normalize() - forward).length() < 1e-5);
    controller.set_mode(CameraMode::Orbit);
    assert!((controller.eye() - eye).length() < 1e-4);
    assert!((controller.target() - Vec3::new(1.0, 2.0, 3.0)).length() < 1e-4);
    assert_eq!(controller.toggle_mode(), CameraMode::Fps);
}

#[test]
fn fps_controller_moves_with_native_axes_and_speed() {
    let mut controller = CameraController::new();
    controller.set_look_at(Vec3::new(0.0, 5.0, 10.0), Vec3::new(0.0, 5.0, 0.0), Vec3::Y);
    controller.set_mode(CameraMode::Fps);
    let start = controller.eye();
    controller.update(
        0.5,
        FlyInput {
            forward: true,
            ..FlyInput::default()
        },
    );
    // Forward is -Z; speed 5 units/s for 0.5 s.
    assert!((controller.eye() - (start + Vec3::new(0.0, 0.0, -2.5))).length() < 1e-5);
    controller.update(
        0.5,
        FlyInput {
            right: true,
            up: true,
            boost: true,
            ..FlyInput::default()
        },
    );
    let expected = start + Vec3::new(5.0, 5.0, -2.5);
    assert!(
        (controller.eye() - expected).length() < 1e-4,
        "{:?}",
        controller.eye()
    );
    assert_eq!(
        FlyInput {
            forward: true,
            backward: true,
            ..FlyInput::default()
        }
        .axes(),
        (0.0, 0.0, 0.0)
    );
    // Orbit mode ignores fly movement and FPS ignores scroll zoom (native routing).
    controller.handle_mouse_scroll(1.0);
    controller.set_mode(CameraMode::Orbit);
    let orbit_eye = controller.eye();
    controller.update(
        1.0,
        FlyInput {
            forward: true,
            ..FlyInput::default()
        },
    );
    assert_eq!(controller.eye(), orbit_eye);
}

#[test]
fn mouse_drag_rotates_active_controller_with_pitch_clamp() {
    let mut controller = CameraController::new();
    controller.mouse_pressed = true;
    controller.handle_mouse_move(0.0, 0.0);
    controller.handle_mouse_move(-100.0, -1000.0);
    assert!((controller.orbit().yaw - 0.5).abs() < 1e-6);
    assert!(controller.orbit().pitch <= std::f32::consts::FRAC_PI_2 - 0.01 + 1e-6);
    let camera = controller
        .camera_input(45.0, 0.1, 100.0, CameraProjection::Perspective)
        .unwrap();
    assert!(camera.view_projection_matrix(1.0).is_ok());
}
