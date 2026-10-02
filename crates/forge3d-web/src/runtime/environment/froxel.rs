pub(super) struct Froxel {
    pub _texture: wgpu::Texture,
    pub view: wgpu::TextureView,
    layout: wgpu::BindGroupLayout,
    pipeline: wgpu::ComputePipeline,
    pub dims: [u32; 3],
}
impl Froxel {
    pub fn new(
        device: &wgpu::Device,
        w: u32,
        h: u32,
        steps: u32,
        enabled: bool,
        shader: &wgpu::ShaderModule,
        shadow_layout: &wgpu::BindGroupLayout,
    ) -> Self {
        let dims = if enabled {
            [w.div_ceil(8), h.div_ceil(8), steps]
        } else {
            [1, 1, 1]
        };
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("environment-froxel-scattering"),
            size: wgpu::Extent3d {
                width: dims[0],
                height: dims[1],
                depth_or_array_layers: dims[2],
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D3,
            format: wgpu::TextureFormat::Rgba16Float,
            usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        let view = texture.create_view(&Default::default());
        let entries = [
            wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 3,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Depth,
                    view_dimension: wgpu::TextureViewDimension::D2,
                    multisampled: false,
                },
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 10,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::StorageTexture {
                    access: wgpu::StorageTextureAccess::WriteOnly,
                    format: wgpu::TextureFormat::Rgba16Float,
                    view_dimension: wgpu::TextureViewDimension::D3,
                },
                count: None,
            },
        ];
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("environment-froxel-layout"),
            entries: &entries,
        });
        let pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("environment-froxel-pipeline-layout"),
            bind_group_layouts: &[Some(&layout), Some(shadow_layout)],
            immediate_size: 0,
        });
        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("environment-froxel-pipeline"),
            layout: Some(&pl),
            module: shader,
            entry_point: Some("cs_froxel"),
            compilation_options: Default::default(),
            cache: None,
        });
        Self {
            _texture: texture,
            view,
            layout,
            pipeline,
            dims,
        }
    }
    pub fn encode(
        &self,
        device: &wgpu::Device,
        encoder: &mut wgpu::CommandEncoder,
        uniform: &wgpu::Buffer,
        depth: &wgpu::TextureView,
        shadow: &wgpu::BindGroup,
    ) {
        let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("environment-froxel-group"),
            layout: &self.layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: uniform.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::TextureView(depth),
                },
                wgpu::BindGroupEntry {
                    binding: 10,
                    resource: wgpu::BindingResource::TextureView(&self.view),
                },
            ],
        });
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
            label: Some("environment-froxel-injection"),
            timestamp_writes: None,
        });
        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, &group, &[]);
        pass.set_bind_group(1, shadow, &[]);
        pass.dispatch_workgroups(
            self.dims[0].div_ceil(4),
            self.dims[1].div_ceil(4),
            self.dims[2].div_ceil(4),
        );
    }
}
