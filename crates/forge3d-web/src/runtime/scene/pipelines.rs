use super::geometry::{LitVertex, OverlayVertex};
use crate::runtime::terrain::DEPTH_FORMAT;

pub(crate) const WORLD_SHADER: &str = concat!(
    include_str!("../brdf.wgsl"),
    include_str!("../ibl_lighting.wgsl"),
    include_str!("../shadow_lighting.wgsl"),
    include_str!("../lighting.wgsl"),
    r#"
struct CameraUniform {
    view_projection: mat4x4<f32>,
    camera_position: vec4<f32>,
    camera_forward: vec4<f32>,
};

struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) color: vec4<f32>,
    @location(2) normal: vec3<f32>,
    @location(3) uv: vec2<f32>,
    @location(4) material_index: u32,
    @location(5) tangent: vec4<f32>,
};

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) color: vec4<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) uv: vec2<f32>,
    @location(3) world_position: vec3<f32>,
    @interpolate(flat) @location(4) material_index: u32,
    @location(5) tangent: vec4<f32>,
};

@group(0) @binding(0) var<uniform> camera: CameraUniform;

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    output.position = camera.view_projection * vec4<f32>(input.position, 1.0);
    output.color = input.color;
    output.normal = input.normal;
    output.uv = input.uv;
    output.world_position = input.position;
    output.material_index = input.material_index;
    output.tangent = input.tangent;
    return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
    // camera_forward.w flags an orthographic camera: parallel view rays.
    var view_vector = camera.camera_position.xyz - input.world_position;
    if (camera.camera_forward.w > 0.5) {
        view_vector = -camera.camera_forward.xyz;
    }
    let view_direction = forge3d_safe_direction(view_vector);
    let view_depth = dot(
        camera.camera_forward.xyz,
        input.world_position - camera.camera_position.xyz,
    );
    let lit = forge3d_evaluate_lighting(
        input.color.rgb,
        input.world_position,
        normalize(input.normal),
        view_direction,
        input.material_index,
        input.uv,
        input.tangent,
        view_depth,
    );
    let alpha = input.color.a
        * forge3d_material_alpha(input.material_index, input.uv);
    return vec4<f32>(lit, alpha);
}
"#,
);

pub(super) const OVERLAY_SHADER: &str = r#"
struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) color: vec4<f32>,
};

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) color: vec4<f32>,
};

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    output.position = vec4<f32>(input.position, 1.0);
    output.color = input.color;
    return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
    return input.color;
}
"#;

const LIT_VERTEX_ATTRIBUTES: [wgpu::VertexAttribute; 6] = wgpu::vertex_attr_array![
    0 => Float32x3,
    1 => Float32x4,
    2 => Float32x3,
    3 => Float32x2,
    4 => Uint32,
    5 => Float32x4
];
const OVERLAY_VERTEX_ATTRIBUTES: [wgpu::VertexAttribute; 2] =
    wgpu::vertex_attr_array![0 => Float32x3, 1 => Float32x4];

fn lit_vertex_layout() -> wgpu::VertexBufferLayout<'static> {
    wgpu::VertexBufferLayout {
        array_stride: std::mem::size_of::<LitVertex>() as wgpu::BufferAddress,
        step_mode: wgpu::VertexStepMode::Vertex,
        attributes: &LIT_VERTEX_ATTRIBUTES,
    }
}

fn overlay_vertex_layout() -> wgpu::VertexBufferLayout<'static> {
    wgpu::VertexBufferLayout {
        array_stride: std::mem::size_of::<OverlayVertex>() as wgpu::BufferAddress,
        step_mode: wgpu::VertexStepMode::Vertex,
        attributes: &OVERLAY_VERTEX_ATTRIBUTES,
    }
}

pub(super) fn create_world_pipeline(
    device: &wgpu::Device,
    format: wgpu::TextureFormat,
    camera_layout: &wgpu::BindGroupLayout,
    lighting_layout: &wgpu::BindGroupLayout,
    texture_layout: &wgpu::BindGroupLayout,
    ibl_layout: &wgpu::BindGroupLayout,
    shader: &wgpu::ShaderModule,
) -> wgpu::RenderPipeline {
    let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("forge3d-web-scene-world-pipeline-layout"),
        bind_group_layouts: &[
            Some(camera_layout),
            Some(lighting_layout),
            Some(texture_layout),
            Some(ibl_layout),
        ],
        immediate_size: 0,
    });
    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("forge3d-web-scene-world-pipeline"),
        layout: Some(&layout),
        vertex: wgpu::VertexState {
            module: shader,
            entry_point: Some("vs_main"),
            compilation_options: wgpu::PipelineCompilationOptions::default(),
            buffers: &[lit_vertex_layout()],
        },
        fragment: Some(wgpu::FragmentState {
            module: shader,
            entry_point: Some("fs_main"),
            compilation_options: wgpu::PipelineCompilationOptions::default(),
            targets: &[Some(wgpu::ColorTargetState {
                format,
                blend: None,
                write_mask: wgpu::ColorWrites::ALL,
            })],
        }),
        primitive: wgpu::PrimitiveState {
            topology: wgpu::PrimitiveTopology::TriangleList,
            strip_index_format: None,
            front_face: wgpu::FrontFace::Ccw,
            cull_mode: None,
            unclipped_depth: false,
            polygon_mode: wgpu::PolygonMode::Fill,
            conservative: false,
        },
        depth_stencil: Some(wgpu::DepthStencilState {
            format: DEPTH_FORMAT,
            depth_write_enabled: Some(true),
            depth_compare: Some(wgpu::CompareFunction::LessEqual),
            stencil: wgpu::StencilState::default(),
            bias: wgpu::DepthBiasState::default(),
        }),
        multisample: wgpu::MultisampleState::default(),
        multiview_mask: None,
        cache: None,
    })
}

pub(super) fn create_overlay_pipeline(
    device: &wgpu::Device,
    format: wgpu::TextureFormat,
    shader: &wgpu::ShaderModule,
) -> wgpu::RenderPipeline {
    let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("forge3d-web-scene-overlay-pipeline-layout"),
        bind_group_layouts: &[],
        immediate_size: 0,
    });
    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("forge3d-web-scene-overlay-pipeline"),
        layout: Some(&layout),
        vertex: wgpu::VertexState {
            module: shader,
            entry_point: Some("vs_main"),
            compilation_options: wgpu::PipelineCompilationOptions::default(),
            buffers: &[overlay_vertex_layout()],
        },
        fragment: Some(wgpu::FragmentState {
            module: shader,
            entry_point: Some("fs_main"),
            compilation_options: wgpu::PipelineCompilationOptions::default(),
            targets: &[Some(wgpu::ColorTargetState {
                format,
                blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                write_mask: wgpu::ColorWrites::ALL,
            })],
        }),
        primitive: wgpu::PrimitiveState {
            topology: wgpu::PrimitiveTopology::TriangleList,
            strip_index_format: None,
            front_face: wgpu::FrontFace::Ccw,
            cull_mode: None,
            unclipped_depth: false,
            polygon_mode: wgpu::PolygonMode::Fill,
            conservative: false,
        },
        depth_stencil: None,
        multisample: wgpu::MultisampleState::default(),
        multiview_mask: None,
        cache: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn world_shader_binds_the_shared_lighting_group() {
        assert!(WORLD_SHADER.contains("forge3d_evaluate_lighting"));
        assert!(WORLD_SHADER.contains("forge3d_eval_brdf"));
        assert!(WORLD_SHADER.contains("@group(1) @binding(0)"));
        assert!(WORLD_SHADER.contains("@group(1) @binding(4)"));
        assert!(WORLD_SHADER.contains("@group(1) @binding(5)"));
        assert!(WORLD_SHADER.contains("@group(1) @binding(6)"));
        assert!(!OVERLAY_SHADER.contains("forge3d_evaluate_lighting"));
    }

    #[test]
    fn world_shader_dispatches_all_thirteen_brdf_constants() {
        for model in 0u32..13 {
            assert!(
                WORLD_SHADER.contains(&format!("case {model}u")),
                "missing dispatch constant {model}"
            );
        }
        assert!(WORLD_SHADER.contains("material_index"));
    }

    #[test]
    fn vertex_layouts_match_the_struct_sizes() {
        assert_eq!(lit_vertex_layout().array_stride, 68);
        assert_eq!(LIT_VERTEX_ATTRIBUTES[4].offset, 48);
        assert_eq!(LIT_VERTEX_ATTRIBUTES[4].format, wgpu::VertexFormat::Uint32);
        assert_eq!(LIT_VERTEX_ATTRIBUTES[5].offset, 52);
        assert_eq!(
            LIT_VERTEX_ATTRIBUTES[5].format,
            wgpu::VertexFormat::Float32x4
        );
        assert_eq!(overlay_vertex_layout().array_stride, 28);
    }
}
