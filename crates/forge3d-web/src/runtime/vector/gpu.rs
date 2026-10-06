use std::{
    cell::RefCell,
    collections::HashMap,
    rc::{Rc, Weak},
};
use wgpu::util::DeviceExt;
#[derive(Default)]
struct Cache {
    device: Weak<wgpu::Device>,
    layouts: HashMap<String, wgpu::BindGroupLayout>,
    shaders: HashMap<String, wgpu::ShaderModule>,
    render: HashMap<String, wgpu::RenderPipeline>,
    compute: HashMap<String, wgpu::ComputePipeline>,
    pipelines: u64,
    vertices: u64,
}
thread_local! { static CACHES: RefCell<HashMap<usize, Cache>> = RefCell::new(HashMap::new()); }
fn key(device: &wgpu::Device) -> usize {
    device as *const wgpu::Device as usize
}
pub(super) fn register(device: &Rc<wgpu::Device>) {
    CACHES.with(|all| {
        let mut all = all.borrow_mut();
        all.retain(|_, c| c.device.strong_count() > 0);
        all.entry(key(device)).or_insert_with(|| Cache {
            device: Rc::downgrade(device),
            ..Default::default()
        });
    });
}
pub(super) fn counts(device: &wgpu::Device) -> (u64, u64) {
    CACHES.with(|all| {
        all.borrow()
            .get(&key(device))
            .map_or((0, 0), |c| (c.pipelines, c.vertices))
    })
}
pub(super) fn layout(
    device: &wgpu::Device,
    descriptor: &wgpu::BindGroupLayoutDescriptor<'_>,
) -> wgpu::BindGroupLayout {
    let cache_key = format!("{:?}", descriptor.entries);
    CACHES.with(|all| {
        let mut all = all.borrow_mut();
        let Some(c) = all.get_mut(&key(device)) else {
            return device.create_bind_group_layout(descriptor);
        };
        c.layouts
            .entry(cache_key)
            .or_insert_with(|| device.create_bind_group_layout(descriptor))
            .clone()
    })
}
pub(super) fn buffer(
    device: &wgpu::Device,
    label: &str,
    data: &[u8],
    usage: wgpu::BufferUsages,
) -> wgpu::Buffer {
    if ["vector:source", "vector:projected", "vector:scratch"].contains(&label) {
        CACHES.with(|all| {
            if let Some(c) = all.borrow_mut().get_mut(&key(device)) {
                c.vertices += 1;
            }
        });
    }
    device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some(label),
        contents: if data.is_empty() { &[0; 16] } else { data },
        usage: usage | wgpu::BufferUsages::COPY_DST,
    })
}
pub(super) fn storage(
    binding: u32,
    read_only: bool,
    visibility: wgpu::ShaderStages,
) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility,
        ty: wgpu::BindingType::Buffer {
            ty: wgpu::BufferBindingType::Storage { read_only },
            has_dynamic_offset: false,
            min_binding_size: None,
        },
        count: None,
    }
}
pub(super) fn uniform(binding: u32, visibility: wgpu::ShaderStages) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility,
        ty: wgpu::BindingType::Buffer {
            ty: wgpu::BufferBindingType::Uniform,
            has_dynamic_offset: false,
            min_binding_size: None,
        },
        count: None,
    }
}
pub(super) fn texture(binding: u32, uint: bool, filterable: bool) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::FRAGMENT,
        ty: wgpu::BindingType::Texture {
            sample_type: if uint {
                wgpu::TextureSampleType::Uint
            } else {
                wgpu::TextureSampleType::Float { filterable }
            },
            view_dimension: wgpu::TextureViewDimension::D2,
            multisampled: false,
        },
        count: None,
    }
}
pub(super) fn bind(
    device: &wgpu::Device,
    layout: &wgpu::BindGroupLayout,
    resources: &[wgpu::BindingResource<'_>],
) -> wgpu::BindGroup {
    device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("vector:group"),
        layout,
        entries: &resources
            .iter()
            .enumerate()
            .map(|(i, r)| wgpu::BindGroupEntry {
                binding: i as u32,
                resource: r.clone(),
            })
            .collect::<Vec<_>>(),
    })
}
pub(super) fn module(device: &wgpu::Device, source: &str) -> wgpu::ShaderModule {
    let create = || {
        device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("vector:shader"),
            source: wgpu::ShaderSource::Wgsl(source.into()),
        })
    };
    CACHES.with(|all| {
        let mut all = all.borrow_mut();
        let Some(c) = all.get_mut(&key(device)) else {
            return create();
        };
        c.shaders
            .entry(source.to_string())
            .or_insert_with(create)
            .clone()
    })
}
pub(super) fn pipeline(
    device: &wgpu::Device,
    layout: &wgpu::BindGroupLayout,
    shader: &wgpu::ShaderModule,
    entry: &str,
    targets: &[Option<wgpu::ColorTargetState>],
    depth: Option<bool>,
) -> wgpu::RenderPipeline {
    let cache_key = format!("{layout:?}:{shader:?}:{entry}:{targets:?}:{depth:?}");
    if let Some(p) = CACHES.with(|all| {
        all.borrow()
            .get(&key(device))
            .and_then(|c| c.render.get(&cache_key).cloned())
    }) {
        return p;
    }
    let pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("vector:pipeline-layout"),
        bind_group_layouts: &[Some(layout)],
        immediate_size: 0,
    });
    let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some(entry),
        layout: Some(&pl),
        vertex: wgpu::VertexState {
            module: shader,
            entry_point: Some("vs"),
            buffers: &[],
            compilation_options: Default::default(),
        },
        fragment: Some(wgpu::FragmentState {
            module: shader,
            entry_point: Some(entry),
            targets,
            compilation_options: Default::default(),
        }),
        primitive: wgpu::PrimitiveState {
            cull_mode: None,
            ..Default::default()
        },
        depth_stencil: depth.map(|write| wgpu::DepthStencilState {
            format: super::super::terrain::DEPTH_FORMAT,
            depth_write_enabled: Some(write),
            depth_compare: Some(wgpu::CompareFunction::LessEqual),
            stencil: Default::default(),
            bias: Default::default(),
        }),
        multisample: Default::default(),
        multiview_mask: None,
        cache: None,
    });
    CACHES.with(|all| {
        if let Some(c) = all.borrow_mut().get_mut(&key(device)) {
            c.pipelines += 1;
            c.render.insert(cache_key, pipeline.clone());
        }
    });
    pipeline
}
pub(super) fn target(
    format: wgpu::TextureFormat,
    blend: Option<wgpu::BlendState>,
) -> Option<wgpu::ColorTargetState> {
    Some(wgpu::ColorTargetState {
        format,
        blend,
        write_mask: wgpu::ColorWrites::ALL,
    })
}
pub(super) fn compute(
    device: &wgpu::Device,
    layout: &wgpu::BindGroupLayout,
    shader: &wgpu::ShaderModule,
    entry: &str,
) -> wgpu::ComputePipeline {
    let cache_key = format!("{layout:?}:{shader:?}:{entry}");
    if let Some(p) = CACHES.with(|all| {
        all.borrow()
            .get(&key(device))
            .and_then(|c| c.compute.get(&cache_key).cloned())
    }) {
        return p;
    }
    let pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("vector:compute-layout"),
        bind_group_layouts: &[Some(layout)],
        immediate_size: 0,
    });
    let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some(entry),
        layout: Some(&pl),
        module: shader,
        entry_point: Some(entry),
        compilation_options: Default::default(),
        cache: None,
    });
    CACHES.with(|all| {
        if let Some(c) = all.borrow_mut().get_mut(&key(device)) {
            c.pipelines += 1;
            c.compute.insert(cache_key, pipeline.clone());
        }
    });
    pipeline
}
pub(super) fn attachment(
    view: &wgpu::TextureView,
    clear: Option<wgpu::Color>,
) -> Option<wgpu::RenderPassColorAttachment<'_>> {
    Some(wgpu::RenderPassColorAttachment {
        view,
        depth_slice: None,
        resolve_target: None,
        ops: wgpu::Operations {
            load: clear.map_or(wgpu::LoadOp::Load, wgpu::LoadOp::Clear),
            store: wgpu::StoreOp::Store,
        },
    })
}
pub(super) fn pass<'a>(
    encoder: &'a mut wgpu::CommandEncoder,
    colors: &'a [Option<wgpu::RenderPassColorAttachment<'a>>],
    depth: Option<&'a wgpu::TextureView>,
    write: bool,
) -> wgpu::RenderPass<'a> {
    let _ = write;
    encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
        label: Some("vector:pass"),
        color_attachments: colors,
        depth_stencil_attachment: depth.map(|view| wgpu::RenderPassDepthStencilAttachment {
            view,
            depth_ops: Some(wgpu::Operations {
                load: wgpu::LoadOp::Load,
                store: wgpu::StoreOp::Store,
            }),
            stencil_ops: None,
        }),
        occlusion_query_set: None,
        timestamp_writes: None,
        multiview_mask: None,
    })
}
