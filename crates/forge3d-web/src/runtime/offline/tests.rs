use super::*;

#[test]
fn capture_passes_fit_the_default_color_attachment_budget() {
    // WebGPU default maxColorAttachmentBytesPerSample is 32.
    for pass in [CapturePass::Primary, CapturePass::Surface] {
        let bytes: u32 = pass
            .formats()
            .iter()
            .map(|format| format.target_pixel_byte_cost().expect("renderable"))
            .sum();
        assert!(bytes <= 32, "{pass:?} uses {bytes} bytes per sample");
        assert!(pass.formats().len() <= 8);
    }
    assert_eq!(CapturePass::Primary.entry_point(), "fs_capture_primary");
    assert_eq!(CapturePass::Surface.entry_point(), "fs_capture_surface");
    assert!(CAPTURE_OVERLAY_FORMAT
        .guaranteed_format_features(wgpu::Features::empty())
        .flags
        .contains(wgpu::TextureFormatFeatureFlags::BLENDABLE));
}

#[test]
fn uniform_layouts_match_wgsl_structs() {
    assert_eq!(std::mem::size_of::<GridParams>(), 16);
    assert_eq!(std::mem::size_of::<TonemapParams>(), 32);
    assert_eq!(std::mem::size_of::<DenoiseParams>(), 48);
    assert_eq!(
        std::mem::size_of::<crate::runtime::terrain::CaptureCameraUniform>(),
        256
    );
}

#[test]
fn planned_target_bytes_follow_selected_layers() {
    let base = CaptureTargets::planned_bytes(10, 10, false, false);
    assert_eq!(base, 100 * 52 + 40);
    assert_eq!(
        CaptureTargets::planned_bytes(10, 10, true, false),
        100 * 84 + 8
    );
    assert_eq!(CaptureTargets::planned_bytes(10, 10, true, true), 100 * 92);
}

fn validate(label: &str, source: &str) {
    let module = naga::front::wgsl::parse_str(source)
        .unwrap_or_else(|error| panic!("{label}: {}", error.emit_to_string(source)));
    naga::valid::Validator::new(
        naga::valid::ValidationFlags::all(),
        naga::valid::Capabilities::all(),
    )
    .validate(&module)
    .unwrap_or_else(|error| panic!("{label}: {error:?}"));
}

#[test]
fn offline_compute_shaders_are_valid_wgsl() {
    validate("accumulate", gpu::ACCUMULATE_SHADER);
    validate("luminance", gpu::LUMINANCE_SHADER);
    validate("resolve", gpu::RESOLVE_SHADER);
    validate("tonemap", gpu::TONEMAP_SHADER);
    validate("denoise", gpu::DENOISE_SHADER);
}

#[test]
fn tonemap_shader_lanes_match_core_operator_lanes() {
    use forge3d_core::offline::tonemap::TonemapOperator;
    for (name, lane) in [
        ("reinhard", 0),
        ("reinhard-extended", 1),
        ("aces", 2),
        ("uncharted2", 3),
        ("exposure", 4),
        ("filmic-terrain", 5),
        ("display", 6),
    ] {
        assert_eq!(TonemapOperator::parse(name).unwrap().lane(), lane);
    }
    assert!(gpu::TONEMAP_SHADER.contains("const LANE_DISPLAY: u32 = 6u;"));
}

#[test]
fn capture_variants_add_entry_points_only_when_requested() {
    use crate::runtime::shader_variants::{specialize, ShaderFeatures};
    let base = ShaderFeatures::ALL;
    let terrain = specialize(crate::runtime::terrain::TERRAIN_SHADER, base);
    assert!(terrain.contains("fn fs_capture_primary"));
    assert!(terrain.contains("@invariant"));
    let world = specialize(crate::runtime::scene::pipelines::WORLD_SHADER, base);
    assert!(world.contains("fn fs_capture_surface"));
    assert!(world.contains("@location(6) object_id: u32"));
}

#[test]
fn grid_uniforms_share_the_rust_field_order() {
    // GridParams is written as [width, height, value, flags]; every compute
    // shader that binds it must declare `flags` as the fourth member.
    for (label, source) in [
        ("accumulate", gpu::ACCUMULATE_SHADER),
        ("resolve", gpu::RESOLVE_SHADER),
    ] {
        let start = source.find("Params {").expect(label);
        let body = &source[start..source[start..].find('}').unwrap() + start];
        let fields: Vec<&str> = body
            .lines()
            .skip(1)
            .map(|line| line.trim().split(':').next().unwrap_or(""))
            .filter(|name| !name.is_empty())
            .collect();
        assert_eq!(fields.len(), 4, "{label}: {fields:?}");
        assert_eq!(fields[0], "width", "{label}");
        assert_eq!(fields[1], "height", "{label}");
        assert_eq!(fields[3], "flags", "{label}");
    }
}
