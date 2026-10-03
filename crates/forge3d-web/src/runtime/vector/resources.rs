use super::*;
impl Resources {
    pub(super) fn new(c: &GpuContext, packet: Packet, width: u32, height: u32, bytes: u64) -> Self {
        let d = &c.device;
        gpu::register(d);
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
            storage | wgpu::BufferUsages::COPY_SRC,
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
            &vec![0; command_bytes(vertices.len() / 3) as usize],
            storage | wgpu::BufferUsages::INDIRECT | wgpu::BufferUsages::COPY_SRC,
        );
        let uniform = gpu::buffer(d, "vector:camera", &[0; 144], wgpu::BufferUsages::UNIFORM);
        let gpu = packet.culling != "cpu" && d.limits().max_storage_buffers_per_shader_stage >= 4;
        let compute = if gpu {
            let cs = wgpu::ShaderStages::COMPUTE;
            let layout = gpu::layout(
                d,
                &wgpu::BindGroupLayoutDescriptor {
                    label: Some("vector:compute"),
                    entries: &[
                        gpu::storage(0, true, cs),
                        gpu::storage(1, false, cs),
                        gpu::storage(2, false, cs),
                        gpu::storage(3, false, cs),
                        gpu::uniform(4, cs),
                    ],
                },
            );
            let compute_shader = gpu::module(d, include_str!("project.wgsl"));
            let expand = gpu::compute(d, &layout, &compute_shader, "expand");
            let scan_triangles = gpu::compute(d, &layout, &compute_shader, "scan_triangles");
            let scan_blocks = gpu::compute(d, &layout, &compute_shader, "scan_blocks");
            let scan_supers = gpu::compute(d, &layout, &compute_shader, "scan_supers");
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
                scan_triangles,
                scan_blocks,
                scan_supers,
                compact,
            })
        } else {
            None
        };
        let vf = wgpu::ShaderStages::VERTEX_FRAGMENT;
        let draw_layout = gpu::layout(
            d,
            &wgpu::BindGroupLayoutDescriptor {
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
            },
        );
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
            // Native 1f4084a medium quality: controls.rs and
            // oit_dual_source.wgsl. WebGPU marks the native color1 output
            // as the second blend source of location 0.
            draw_source.push_str("\nstruct Dual { @location(0) @blend_src(0) color:vec4<f32>, @location(0) @blend_src(1) alpha:vec4<f32> }; @fragment fn fs_dual(v:Out)->Dual {if(v.color.a>=1.0){discard;}let c=coverage(v);let normalized_depth=clamp(v.clip.z*0.5+0.5,0.0,1.0);let depth_weight=clamp(c.a*pow(1.0-normalized_depth,2.0),0.001,1000.0);let alpha=pow(c.a,1.1);return Dual(vec4<f32>(c.rgb*alpha,alpha),vec4<f32>(alpha,depth_weight,1.0,1.0/8.0));}");
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
        let opaque_pipeline = gpu::pipeline(
            d,
            &draw_layout,
            &shader,
            "fs_opaque",
            &[gpu::target(
                wgpu::TextureFormat::Rgba16Float,
                Some(wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING),
            )],
            Some(true),
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
        let highlight_values = highlight_values(&packet.highlights);
        let (highlight_count, highlight_radius, highlight_bound) =
            highlight_settings(&highlight_values);
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
        let highlight_layout = gpu::layout(
            d,
            &wgpu::BindGroupLayoutDescriptor {
                label: Some("vector:highlight-cache"),
                entries: &[
                    gpu::texture(0, false, false),
                    gpu::texture(1, false, false),
                    gpu::texture(2, true, false),
                    gpu::texture(3, false, false),
                    gpu::storage(4, true, wgpu::ShaderStages::FRAGMENT),
                    gpu::uniform(5, wgpu::ShaderStages::FRAGMENT),
                    gpu::texture(6, false, false),
                    gpu::storage(7, true, wgpu::ShaderStages::FRAGMENT),
                ],
            },
        );
        let resolve_layout = gpu::layout(
            d,
            &wgpu::BindGroupLayoutDescriptor {
                label: Some("vector:resolve"),
                entries: &[
                    gpu::texture(0, false, false),
                    gpu::texture(1, false, false),
                    gpu::texture(2, true, false),
                    gpu::texture(3, false, false),
                    gpu::storage(4, true, wgpu::ShaderStages::FRAGMENT),
                    gpu::uniform(5, wgpu::ShaderStages::FRAGMENT),
                    gpu::texture(6, false, false),
                    gpu::storage(7, true, wgpu::ShaderStages::FRAGMENT),
                    gpu::texture(8, false, false),
                    gpu::texture(9, false, false),
                ],
            },
        );
        let resolve_shader = gpu::module(d, include_str!("resolve.wgsl"));
        let highlight_pipeline = gpu::pipeline(
            d,
            &highlight_layout,
            &resolve_shader,
            "fs_highlight",
            &[
                gpu::target(wgpu::TextureFormat::Rgba16Float, None),
                gpu::target(wgpu::TextureFormat::Rgba16Float, None),
            ],
            None,
        );
        let highlight_bounds = gpu::buffer(d, "vector:highlight-bounds", &[0; 16], storage);
        let cs = wgpu::ShaderStages::COMPUTE;
        let bounds_layout = gpu::layout(
            d,
            &wgpu::BindGroupLayoutDescriptor {
                label: Some("vector:highlight-bounds"),
                entries: &[
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: cs,
                        ty: wgpu::BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Uint,
                            view_dimension: wgpu::TextureViewDimension::D2,
                            multisampled: false,
                        },
                        count: None,
                    },
                    gpu::storage(1, true, cs),
                    gpu::storage(2, false, cs),
                    gpu::uniform(3, cs),
                ],
            },
        );
        let bounds_shader = gpu::module(d, include_str!("highlight-bounds.wgsl"));
        let bounds_reset = gpu::compute(d, &bounds_layout, &bounds_shader, "reset");
        let bounds_reduce = gpu::compute(d, &bounds_layout, &bounds_shader, "reduce");
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
            opaque_pipeline,
            pick_pipeline,
            aov_pipeline,
            surface_pipeline,
            accum: make("vector:accum", wgpu::TextureFormat::Rgba16Float),
            opaque: make("vector:opaque", wgpu::TextureFormat::Rgba16Float),
            reveal: make("vector:reveal", wgpu::TextureFormat::R16Float),
            id: make("vector:id", wgpu::TextureFormat::R32Uint),
            depth: make("vector:depth", wgpu::TextureFormat::R32Float),
            world: make("vector:world", wgpu::TextureFormat::Rgba32Float),
            background: make("vector:background", wgpu::TextureFormat::Rgba32Float),
            background16: make("vector:background16", wgpu::TextureFormat::Rgba16Float),
            highlights,
            highlight_count,
            highlight_radius,
            highlight_bound,
            highlight_bounds,
            bounds_layout,
            bounds_reset,
            bounds_reduce,
            highlight_overlay: make("vector:highlight-overlay", wgpu::TextureFormat::Rgba16Float),
            highlight_tint: make("vector:highlight-tint", wgpu::TextureFormat::Rgba16Float),
            highlight_layout,
            highlight_pipeline,
            highlight_bounds_dirty: std::cell::Cell::new(true),
            resolve_layout,
            resolve_shader,
            resolve_pipelines: Default::default(),
            mode,
            reason,
            gpu,
            bytes,
            width,
            height,
            pick_dirty: std::cell::Cell::new(true),
            pick_renders: std::cell::Cell::new(0),
            pick_readback_peak: std::cell::Cell::new(0),
        }
    }
}
