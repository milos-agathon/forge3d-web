use super::*;

pub(super) fn fallback(
    device: &wgpu::Device,
    format: wgpu::TextureFormat,
    dimension: wgpu::TextureViewDimension,
) -> wgpu::TextureView {
    device
        .create_texture(&wgpu::TextureDescriptor {
            label: Some("scatter-height-fallback"),
            size: wgpu::Extent3d {
                width: 1,
                height: 1,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage: wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        })
        .create_view(&wgpu::TextureViewDescriptor {
            dimension: Some(dimension),
            ..Default::default()
        })
}
pub(super) fn group(
    device: &wgpu::Device,
    layout: &wgpu::BindGroupLayout,
    camera: &wgpu::Buffer,
    settings: &wgpu::Buffer,
    height: &wgpu::TextureView,
    pages: &wgpu::TextureView,
) -> wgpu::BindGroup {
    device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("scatter-draw"),
        layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: camera.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: settings.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: wgpu::BindingResource::TextureView(height),
            },
            wgpu::BindGroupEntry {
                binding: 3,
                resource: wgpu::BindingResource::TextureView(pages),
            },
        ],
    })
}
pub(super) fn draw(
    context: &GpuContext,
    layout: &wgpu::BindGroupLayout,
    camera: &wgpu::Buffer,
    height: &wgpu::TextureView,
    pages: &wgpu::TextureView,
    mesh: &ScatterMesh,
    color: [f32; 4],
    capacity: usize,
) -> Draw {
    let vertices: Vec<LitVertex> = mesh
        .positions
        .chunks_exact(3)
        .zip(mesh.normals.chunks_exact(3))
        .map(|(p, n)| LitVertex {
            position: p.try_into().unwrap(),
            normal: n.try_into().unwrap(),
            color,
            uv: [0.0; 2],
            material_index: 0,
            tangent: [1.0, 0.0, 0.0, 1.0],
            object_id: 0,
            previous_position: p.try_into().unwrap(),
        })
        .collect();
    let vertex = context
        .device
        .create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("scatter-vertices"),
            contents: bytemuck::cast_slice(&vertices),
            usage: wgpu::BufferUsages::VERTEX,
        });
    let index = context
        .device
        .create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("scatter-indices"),
            contents: bytemuck::cast_slice(&mesh.indices),
            usage: wgpu::BufferUsages::INDEX,
        });
    let instances = context.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("scatter-instances"),
        size: (capacity * 80) as u64,
        usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let settings = context.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("scatter-settings"),
        size: std::mem::size_of::<Settings>() as u64,
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let bind = group(&context.device, layout, camera, &settings, height, pages);
    Draw {
        vertex,
        index,
        instances,
        settings,
        group: bind,
        index_count: mesh.indices.len() as u32,
        count: 0,
        max_height: mesh
            .positions
            .chunks_exact(3)
            .map(|p| p[1])
            .fold(0.0, f32::max),
    }
}
pub(super) fn pipelines(
    device: &wgpu::Device,
    layouts: [&wgpu::BindGroupLayout; 4],
    features: ShaderFeatures,
    format: wgpu::TextureFormat,
) -> (
    wgpu::RenderPipeline,
    wgpu::RenderPipeline,
    wgpu::RenderPipeline,
) {
    let normal = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("scatter-shader"),
        source: wgpu::ShaderSource::Wgsl(shader::shader(features).into()),
    });
    let capture = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("scatter-capture-shader"),
        source: wgpu::ShaderSource::Wgsl(shader::shader(features.with_capture()).into()),
    });
    (
        pipeline::create(
            device,
            layouts,
            &normal,
            format,
            None,
            features.capture_blend(),
        ),
        pipeline::create(
            device,
            layouts,
            &capture,
            format,
            Some(CapturePass::Primary),
            features.capture_blend(),
        ),
        pipeline::create(
            device,
            layouts,
            &capture,
            format,
            Some(CapturePass::Surface),
            features.capture_blend(),
        ),
    )
}
