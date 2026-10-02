use super::*;

pub(crate) fn masked_layout_entries(
    textured: bool,
    reflection: bool,
    aerial: bool,
) -> Vec<wgpu::BindGroupLayoutEntry> {
    let mut entries = if textured {
        crate::runtime::textures::texture_layout_entries().to_vec()
    } else {
        Vec::new()
    };
    if reflection || aerial {
        entries.push(wgpu::BindGroupLayoutEntry {
            binding: 6,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Uniform,
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        });
    }
    if reflection {
        entries.extend([
            wgpu::BindGroupLayoutEntry {
                binding: 7,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Float { filterable: true },
                    view_dimension: wgpu::TextureViewDimension::D2Array,
                    multisampled: false,
                },
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 8,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                count: None,
            },
        ]);
    }
    entries
}
pub(crate) fn masked_layout(
    device: &wgpu::Device,
    textured: bool,
    reflection: bool,
    aerial: bool,
) -> wgpu::BindGroupLayout {
    device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("terrain-masked-water-group2"),
        entries: &masked_layout_entries(textured, reflection, aerial),
    })
}
impl ReflectionTargets {
    pub fn material_group(&self, runtime: &Forge3DRuntime) -> Option<wgpu::BindGroup> {
        let terrain = runtime.terrain.as_ref()?;
        let reflection = terrain.features.masked_reflection();
        let aerial = terrain.features.aerial();
        if !reflection && !aerial {
            return None;
        }
        let context = runtime.context.as_ref()?;
        let textured = terrain.features.samples_scene_textures();
        let mut entries = if textured {
            runtime.textures.as_ref()?.masked_entries()
        } else {
            Vec::new()
        };
        entries.push(wgpu::BindGroupEntry {
            binding: 6,
            resource: runtime.environment.as_ref()?.uniform.as_entire_binding(),
        });
        if reflection {
            entries.extend([
                wgpu::BindGroupEntry {
                    binding: 7,
                    resource: wgpu::BindingResource::TextureView(&self.array_view),
                },
                wgpu::BindGroupEntry {
                    binding: 8,
                    resource: wgpu::BindingResource::Sampler(&self.sampler),
                },
            ]);
        }
        Some(
            context
                .device
                .create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("terrain-masked-water-group2"),
                    layout: &masked_layout(&context.device, textured, reflection, aerial),
                    entries: &entries,
                }),
        )
    }
}
