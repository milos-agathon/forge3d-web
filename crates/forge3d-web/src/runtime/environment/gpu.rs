use super::reflection::ReflectionTargets;
use crate::{
    error::{map_core_error, WebError},
    runtime::Forge3DRuntime,
};
use forge3d_core::{environment::Environment, gpu::GpuContext};
use std::cell::{Cell, RefCell};
const SHADER: &str = concat!(include_str!("sky.wgsl"), include_str!("effects.wgsl"));
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub(super) struct Uniform {
    inverse: [[f32; 4]; 4],
    vp: [[f32; 4]; 4],
    previous: [[f32; 4]; 4],
    pub(super) p: [[f32; 4]; 19],
    pub(super) bits: [u32; 4],
}
pub(crate) struct Target {
    pub texture: wgpu::Texture,
    pub view: wgpu::TextureView,
}
impl Target {
    pub fn new(device: &wgpu::Device, w: u32, h: u32, format: wgpu::TextureFormat) -> Self {
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("forge3d-environment-target"),
            size: wgpu::Extent3d {
                width: w,
                height: h,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                | wgpu::TextureUsages::TEXTURE_BINDING
                | wgpu::TextureUsages::COPY_SRC
                | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        let view = texture.create_view(&Default::default());
        Self { texture, view }
    }
}
pub(crate) struct EnvironmentResources {
    pub snapshot: Environment,
    pub world: Target,
    water_primary: wgpu::RenderPipeline,
    water_surface: wgpu::RenderPipeline,
    pub original_lighting: Option<(forge3d_core::lighting::LightingState, Vec<u32>)>,
    effect: Target,
    history: Target,
    previous_depth: Target,
    uniform: wgpu::Buffer,
    payload: wgpu::Buffer,
    layout: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    ibl_layout: wgpu::BindGroupLayout,
    shadow_layout: wgpu::BindGroupLayout,
    shader: wgpu::ShaderModule,
    effect_pipeline: wgpu::RenderPipeline,
    depth_pipeline: wgpu::RenderPipeline,
    pipelines: RefCell<Vec<(wgpu::TextureFormat, wgpu::RenderPipeline)>>,
    pub reflection: ReflectionTargets,
    froxel: super::froxel::Froxel,
    pub history_valid: Cell<bool>,
    previous_vp: Cell<[[f32; 4]; 4]>,
    last_time: Cell<f32>,
    pub width: u32,
    pub height: u32,
}

pub(super) mod bindings;
mod init;
mod passes;
mod payload;
mod uniforms;
mod water;
use payload::pack;
