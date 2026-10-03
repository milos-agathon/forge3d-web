use super::*;
impl Resources {
    pub(super) fn new(c: &GpuContext, packet: Packet, width: u32, height: u32, bytes: u64) -> Self {
        let d = &c.device;
        let storage = wgpu::BufferUsages::STORAGE;
        let vertices: Vec<_> = packet
            .vertices
            .iter()
            .map(|v| {
                let f = |i| {
                    [
                        v[i] as f32,
                        v[i + 1] as f32,
                        v[i + 2] as f32,
                        v[i + 3] as f32,
                    ]
                };
                VectorVertex {
                    position: f(0),
                    previous: f(4),
                    next: f(8),
                    offset: f(12),
                    color: f(16),
                    meta: [v[20] as u32, v[21] as u32, 0, 0],
                    atlas: f(24),
                    options: f(28),
                }
            })
            .collect();
        let padded = if vertices.is_empty() {
            vec![VectorVertex::default()]
        } else {
            vertices.clone()
        };
        let source = gpu::buffer(d, "vector:source", bytemuck::cast_slice(&padded), storage);
        let projected = gpu::buffer(
            d,
            "vector:projected",
            &vec![0; vertices.len().max(1) * 80],
            storage,
        );
        let scratch = gpu::buffer(
            d,
            "vector:scratch",
            &vec![0; vertices.len().max(1) * 80],
            storage,
        );
        let commands = gpu::buffer(
            d,
            "vector:commands",
            &vec![0; 16 + vertices.len() / 3 * 4],
            storage | wgpu::BufferUsages::INDIRECT,
        );
        let uniform = gpu::buffer(d, "vector:camera", &[0; 144], wgpu::BufferUsages::UNIFORM);
        let gpu = packet.culling != "cpu" && d.limits().max_storage_buffers_per_shader_stage >= 4;
        let compute = if gpu {
            let cs = wgpu::ShaderStages::COMPUTE;
            let layout = d.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("vector:compute"),
                entries: &[
                    gpu::storage(0, true, cs),
                    gpu::storage(1, false, cs),
                    gpu::storage(2, false, cs),
                    gpu::storage(3, false, cs),
                    gpu::uniform(4, cs),
                ],
            });
            let compute_shader = gpu::module(d, include_str!("project.wgsl"));
            let expand = gpu::compute(d, &layout, &compute_shader, "expand");
            let compact = gpu::compute(d, &layout, &compute_shader, "compact");
            let compute_group = gpu::bind(
                d,
                &layout,
                &[
                    source.as_entire_binding(),
                    scratch.as_entire_binding(),
                    projected.as_entire_binding(),
                    commands.as_entire_binding(),
                    uniform.as_entire_binding(),
                ],
            );
            Some(Compute {
                group: compute_group,
                expand,
                compact,
            })
        } else {
            None
        };
        let vf = wgpu::ShaderStages::VERTEX_FRAGMENT;
        let draw_layout = d.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("vector:draw"),
            entries: &[
                gpu::storage(0, true, wgpu::ShaderStages::VERTEX),
                gpu::uniform(1, vf),
                gpu::texture(2, false, true),
                wgpu::BindGroupLayoutEntry {
                    binding: 3,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
            ],
        });
        let atlas = Target::new(
            d,
            "vector:atlas",
            wgpu::TextureFormat::Rgba8UnormSrgb,
            packet.atlas.width,
            packet.atlas.height,
        );
        c.queue.write_texture(
            atlas.texture.as_image_copy(),
            &packet.atlas.rgba,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(packet.atlas.width * 4),
                rows_per_image: Some(packet.atlas.height),
            },
            wgpu::Extent3d {
                width: packet.atlas.width,
                height: packet.atlas.height,
                depth_or_array_layers: 1,
            },
        );
        let sampler = d.create_sampler(&wgpu::SamplerDescriptor {
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        let draw_group = gpu::bind(
            d,
            &draw_layout,
            &[
                projected.as_entire_binding(),
                uniform.as_entire_binding(),
                B::TextureView(&atlas.view),
                B::Sampler(&sampler),
            ],
        );
        let dual = c
            .device
            .features()
            .contains(wgpu::Features::DUAL_SOURCE_BLENDING);
        let (mode, reason) = resolve_mode(&packet.oit, dual);
        let mut draw_source = String::from("diagnostic(off, derivative_uniformity);\n");
        draw_source.push_str(include_str!("draw.wgsl"));
        if mode == "dual-source" {
            draw_source.insert_str(0, "enable dual_source_blending;\n");
            draw_source.push_str("\nstruct Dual { @location(0) @blend_src(0) color:vec4<f32>, @location(0) @blend_src(1) alpha:vec4<f32> }; @fragment fn fs_dual(v:Out)->Dual {let c=coverage(v);return Dual(vec4<f32>(c.rgb*c.a,c.a),vec4<f32>(c.a));}");
        }
        let shader = gpu::module(d, &draw_source);
        let add = wgpu::BlendState {
            color: wgpu::BlendComponent {
                src_factor: wgpu::BlendFactor::One,
                dst_factor: wgpu::BlendFactor::One,
                operation: wgpu::BlendOperation::Add,
            },
            alpha: wgpu::BlendComponent {
                src_factor: wgpu::BlendFactor::One,
                dst_factor: wgpu::BlendFactor::One,
                operation: wgpu::BlendOperation::Add,
            },
        };
        let reveal_blend = wgpu::BlendState {
            color: wgpu::BlendComponent {
                src_factor: wgpu::BlendFactor::Zero,
                dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
                operation: wgpu::BlendOperation::Add,
            },
            alpha: wgpu::BlendComponent {
                src_factor: wgpu::BlendFactor::Zero,
                dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
                operation: wgpu::BlendOperation::Add,
            },
        };
        let dual_blend = wgpu::BlendState {
            color: wgpu::BlendComponent {
                src_factor: wgpu::BlendFactor::One,
                dst_factor: wgpu::BlendFactor::OneMinusSrc1Alpha,
                operation: wgpu::BlendOperation::Add,
            },
            alpha: wgpu::BlendComponent {
                src_factor: wgpu::BlendFactor::One,
                dst_factor: wgpu::BlendFactor::OneMinusSrc1Alpha,
                operation: wgpu::BlendOperation::Add,
            },
        };
        let colors = if mode == "wboit" {
            vec![
                gpu::target(wgpu::TextureFormat::Rgba16Float, Some(add)),
                gpu::target(wgpu::TextureFormat::R16Float, Some(reveal_blend)),
            ]
        } else {
            vec![gpu::target(
                wgpu::TextureFormat::Rgba16Float,
                Some(if mode == "dual-source" {
                    dual_blend
                } else {
                    wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING
                }),
            )]
        };
        let color_pipeline = gpu::pipeline(
            d,
            &draw_layout,
            &shader,
            if mode == "wboit" {
                "fs_weighted"
            } else if mode == "dual-source" {
                "fs_dual"
            } else {
                "fs_standard"
            },
            &colors,
            Some(false),
        );
        let pick_pipeline = gpu::pipeline(
            d,
            &draw_layout,
            &shader,
            "fs_pick",
            &[
                gpu::target(wgpu::TextureFormat::R32Uint, None),
                gpu::target(wgpu::TextureFormat::R32Float, None),
                gpu::target(wgpu::TextureFormat::Rgba32Float, None),
            ],
            Some(true),
        );
        let aov_pipeline = gpu::pipeline(
            d,
            &draw_layout,
            &shader,
            "fs_aov",
            &[
                gpu::target(wgpu::TextureFormat::R32Float, None),
                gpu::target(wgpu::TextureFormat::R32Uint, None),
            ],
            Some(true),
        );
        let surface_pipeline = gpu::pipeline(
            d,
            &draw_layout,
            &shader,
            "fs_surface",
            &[
                gpu::target(wgpu::TextureFormat::Rgba32Float, None),
                gpu::target(wgpu::TextureFormat::Rgba32Float, None),
            ],
            Some(false),
        );
        let make = |name, format| Target::new(d, name, format, width, height);
        let highlight_values: Vec<_> = packet
            .highlights
            .iter()
            .map(|h| Highlight {
                ids: [h[0] as u32, h[1] as u32, h[2] as u32, 0],
                color: [h[4] as f32, h[5] as f32, h[6] as f32, h[7] as f32],
                options: [h[8] as f32, h[9] as f32, h[10] as f32, h[11] as f32],
            })
            .collect();
        let highlights = gpu::buffer(
            d,
            "vector:highlights",
            bytemuck::cast_slice(if highlight_values.is_empty() {
                std::slice::from_ref(&Highlight {
                    ids: [0; 4],
                    color: [0.; 4],
                    options: [0.; 4],
                })
            } else {
                &highlight_values
            }),
            storage,
        );
        let resolve_layout = d.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("vector:resolve"),
            entries: &[
                gpu::texture(0, false, false),
                gpu::texture(1, false, false),
                gpu::texture(2, true, false),
                gpu::texture(3, false, false),
                gpu::storage(4, true, wgpu::ShaderStages::FRAGMENT),
                gpu::uniform(5, wgpu::ShaderStages::FRAGMENT),
            ],
        });
        let resolve_shader = gpu::module(d, include_str!("resolve.wgsl"));
        Self {
            packet,
            vertices,
            uniform,
            projected,
            commands,
            compute,
            _source: source,
            _scratch: scratch,
            draw_group,
            color_pipeline,
            pick_pipeline,
            aov_pipeline,
            surface_pipeline,
            accum: make("vector:accum", wgpu::TextureFormat::Rgba16Float),
            reveal: make("vector:reveal", wgpu::TextureFormat::R16Float),
            id: make("vector:id", wgpu::TextureFormat::R32Uint),
            depth: make("vector:depth", wgpu::TextureFormat::R32Float),
            world: make("vector:world", wgpu::TextureFormat::Rgba32Float),
            background: make("vector:background", wgpu::TextureFormat::Rgba32Float),
            background16: make("vector:background16", wgpu::TextureFormat::Rgba16Float),
            highlights,
            resolve_layout,
            resolve_shader,
            resolve_pipelines: Default::default(),
            mode,
            reason,
            gpu,
            bytes,
            width,
            height,
        }
    }
}
