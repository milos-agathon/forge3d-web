use super::bindings::pipeline;
use super::water::water_pipeline;
use super::*;
use wgpu::util::DeviceExt;
impl EnvironmentResources {
    pub fn new(
        context: &GpuContext,
        snapshot: Environment,
        width: u32,
        height: u32,
        format: wgpu::TextureFormat,
    ) -> Self {
        let device = &context.device;
        let (ew, eh) = snapshot.effect_size(width, height);
        let world = Target::new(device, width, height, format);
        let effect = Target::new(device, ew, eh, wgpu::TextureFormat::Rgba16Float);
        let history = Target::new(device, ew, eh, wgpu::TextureFormat::Rgba16Float);
        let previous_depth = Target::new(device, ew, eh, wgpu::TextureFormat::R32Float);
        let uniform = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("environment-uniform"),
            size: if snapshot.water.iter().any(|w| w.terrain_mask) {
                608
            } else {
                512
            },
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let packed = pack(&snapshot);
        let payload = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("environment-density-and-masks"),
            contents: bytemuck::cast_slice(&packed),
            usage: wgpu::BufferUsages::STORAGE,
        });
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("environment-layout"),
            entries: &super::bindings::layout_entries(),
        });
        let shadow_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("environment-shadows-layout"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT | wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Depth,
                        view_dimension: wgpu::TextureViewDimension::D2Array,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT | wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
            ],
        });
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("environment-nearest-sampler"),
            ..Default::default()
        });
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("forge3d-environment-shader"),
            source: wgpu::ShaderSource::Wgsl(SHADER.into()),
        });
        let ibl_layout = crate::runtime::ibl::create_ibl_bind_group_layout(device);
        let effect_pipeline = pipeline(
            device,
            &layout,
            &shadow_layout,
            &ibl_layout,
            &shader,
            "fs_effect",
            wgpu::TextureFormat::Rgba16Float,
        );
        let depth_pipeline = pipeline(
            device,
            &layout,
            &shadow_layout,
            &ibl_layout,
            &shader,
            "fs_depth",
            wgpu::TextureFormat::R32Float,
        );
        let composite = pipeline(
            device,
            &layout,
            &shadow_layout,
            &ibl_layout,
            &shader,
            "fs_composite",
            format,
        );
        let froxel = crate::runtime::environment::froxel::Froxel::new(
            device,
            width,
            height,
            snapshot.steps,
            snapshot.volumetric_mode == "froxel",
            &shader,
            &shadow_layout,
        );
        let reflection = ReflectionTargets::new(context, &snapshot, width, height, format);
        Self {
            snapshot,
            world,
            water_primary: water_pipeline(
                device,
                &layout,
                &shadow_layout,
                &shader,
                "fs_water_primary",
                &[
                    wgpu::TextureFormat::R32Float,
                    wgpu::TextureFormat::R32Uint,
                    wgpu::TextureFormat::Rg32Float,
                ],
            ),
            water_surface: water_pipeline(
                device,
                &layout,
                &shadow_layout,
                &shader,
                "fs_water_surface",
                &[
                    wgpu::TextureFormat::Rgba32Float,
                    wgpu::TextureFormat::Rgba32Float,
                ],
            ),
            original_lighting: None,
            effect,
            history,
            previous_depth,
            uniform,
            payload,
            layout,
            sampler,
            ibl_layout,
            shadow_layout,
            shader,
            effect_pipeline,
            depth_pipeline,
            pipelines: RefCell::new(vec![(format, composite)]),
            reflection,
            froxel,
            history_valid: Cell::new(false),
            previous_vp: Cell::new(glam::Mat4::IDENTITY.to_cols_array_2d()),
            last_time: Cell::new(f32::NAN),
            width,
            height,
        }
    }
}
