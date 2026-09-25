//! GPU resources for the terrain PBR/POM material (W07).
//!
//! The terrain group-0 layout always carries bindings 7-11; a terrain without
//! a material binds a disabled uniform and 1x1 placeholders, and its pipeline
//! is compiled without the `terrain_material` region.

use forge3d_core::gpu::GpuContext;
use forge3d_core::terrain_material::{
    assemble_aux_array, assemble_material_array, PomMode, SamplingAddress, SamplingFilter,
    TerrainMaterialDiagnostic, TerrainMaterialUniform,
};
use wasm_bindgen::JsValue;
use wgpu::util::DeviceExt;

use crate::terrain_material_input::TerrainMaterialOptions;

pub(super) const TERRAIN_MATERIAL_KEY: &str = "terrain:material";

/// What the runtime bound for the committed terrain material.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct TerrainMaterialReport {
    pub enabled: bool,
    pub layer_count: u32,
    pub textured_layers: Vec<bool>,
    pub texture_width: u32,
    pub texture_height: u32,
    pub mip_levels: u32,
    pub mask_bits: u32,
    pub detail_normal_map: bool,
    pub gpu_bytes: u64,
    pub diagnostics: Vec<TerrainMaterialDiagnostic>,
}

pub(super) struct TerrainMaterialResources {
    /// Whether the terrain shader runs the material region: always in screen
    /// mode (the native path, with the default material when none is set).
    pub shader_enabled: bool,
    pub uniform_buffer: wgpu::Buffer,
    pub albedo_view: wgpu::TextureView,
    pub albedo_sampler: wgpu::Sampler,
    pub aux_view: wgpu::TextureView,
    pub aux_sampler: wgpu::Sampler,
    pub report: TerrainMaterialReport,
}

/// Bytes the material occupies on the GPU, computed before any allocation so
/// the ledger can admit or reject it.
pub(super) struct TerrainMaterialPlan {
    pub uniform: TerrainMaterialUniform,
    pub albedo: forge3d_core::terrain_material::TerrainMaterialArray,
    pub aux: forge3d_core::terrain_material::TerrainAuxArray,
    pub report: TerrainMaterialReport,
}

fn uniform_bytes() -> u64 {
    std::mem::size_of::<TerrainMaterialUniform>() as u64
}

/// Plans the material arrays. `texture_budget` is what the ledger can admit
/// for the albedo mip chain after the terrain itself. A screen-mode terrain
/// without a material runs the native path with the default material.
pub(super) fn plan_material(
    material: Option<&TerrainMaterialOptions>,
    screen: bool,
    domain: [f32; 2],
    max_dimension: u32,
    texture_budget: u64,
) -> TerrainMaterialPlan {
    if material.is_none() && screen {
        let default = TerrainMaterialOptions {
            settings: forge3d_core::terrain_material::TerrainMaterialSettings::default(),
            layer_images: vec![None; 4],
            detail_normal: None,
            masks: [None, None, None],
        };
        let mut plan = plan_material(Some(&default), false, domain, max_dimension, texture_budget);
        plan.report.enabled = false;
        plan.report.layer_count = 0;
        plan.report.textured_layers.clear();
        plan.report.texture_width = 0;
        plan.report.texture_height = 0;
        plan.report.mip_levels = 0;
        plan.report.diagnostics.clear();
        return plan;
    }
    let Some(material) = material else {
        let albedo = assemble_material_array(
            &forge3d_core::terrain_material::terrain_default_layers()[..1],
            &[],
            1,
            u64::MAX,
        );
        let aux = assemble_aux_array(None, [None, None, None], 1);
        let gpu_bytes = uniform_bytes() + albedo.byte_len() + aux.byte_len();
        return TerrainMaterialPlan {
            uniform: TerrainMaterialUniform::disabled(),
            report: TerrainMaterialReport {
                enabled: false,
                layer_count: 0,
                textured_layers: Vec::new(),
                texture_width: 0,
                texture_height: 0,
                mip_levels: 0,
                mask_bits: 0,
                detail_normal_map: false,
                gpu_bytes,
                diagnostics: Vec::new(),
            },
            albedo,
            aux,
        };
    };
    let settings = &material.settings;
    let albedo = assemble_material_array(
        &settings.material_set,
        &material.layer_images,
        max_dimension,
        texture_budget,
    );
    let masks = [
        material.masks[0].as_ref(),
        material.masks[1].as_ref(),
        material.masks[2].as_ref(),
    ];
    let aux = assemble_aux_array(material.detail_normal.as_ref(), masks, max_dimension);
    let mut diagnostics = albedo.diagnostics.clone();
    diagnostics.extend(aux.diagnostics.iter().cloned());
    if settings.albedo_mode != forge3d_core::terrain_material::AlbedoMode::Colormap {
        for (index, textured) in albedo.textured_layers.iter().enumerate() {
            if !textured {
                diagnostics.push(TerrainMaterialDiagnostic {
                    code: "terrain-material-texture-missing",
                    message: format!(
                        "layer {index} has no texture; its flat base color fills the layer"
                    ),
                    layer: Some(index as u32),
                });
            }
        }
    }
    if settings.detail.detail_strength > 0.0 && !aux.has_detail_map {
        diagnostics.push(TerrainMaterialDiagnostic {
            code: "terrain-material-detail-normal-missing",
            message:
                "detail.strength is set but no detail normal map was provided; the map term is off"
                    .to_string(),
            layer: None,
        });
    }
    if settings.pom.enabled && settings.pom.mode != PomMode::Occlusion {
        diagnostics.push(TerrainMaterialDiagnostic {
            code: "terrain-material-pom-mode-approximated",
            message: "native terrain renders every POM mode with the occlusion ray march"
                .to_string(),
            layer: None,
        });
    }
    let uniform = settings.pack(domain, aux.mask_bits, aux.has_detail_map);
    let gpu_bytes = uniform_bytes() + albedo.byte_len() + aux.byte_len();
    TerrainMaterialPlan {
        uniform,
        report: TerrainMaterialReport {
            enabled: true,
            layer_count: albedo.layers,
            textured_layers: albedo.textured_layers.clone(),
            texture_width: albedo.width,
            texture_height: albedo.height,
            mip_levels: albedo.mip_levels(),
            mask_bits: aux.mask_bits,
            detail_normal_map: aux.has_detail_map,
            gpu_bytes,
            diagnostics,
        },
        albedo,
        aux,
    }
}

fn filter_mode(filter: SamplingFilter) -> wgpu::FilterMode {
    match filter {
        SamplingFilter::Linear => wgpu::FilterMode::Linear,
        SamplingFilter::Nearest => wgpu::FilterMode::Nearest,
    }
}

fn mipmap_filter_mode(filter: SamplingFilter) -> wgpu::MipmapFilterMode {
    match filter {
        SamplingFilter::Linear => wgpu::MipmapFilterMode::Linear,
        SamplingFilter::Nearest => wgpu::MipmapFilterMode::Nearest,
    }
}

fn address_mode(address: SamplingAddress) -> wgpu::AddressMode {
    match address {
        SamplingAddress::Repeat => wgpu::AddressMode::Repeat,
        SamplingAddress::ClampToEdge => wgpu::AddressMode::ClampToEdge,
        SamplingAddress::MirrorRepeat => wgpu::AddressMode::MirrorRepeat,
    }
}

fn upload_array(
    context: &GpuContext,
    label: &str,
    format: wgpu::TextureFormat,
    width: u32,
    height: u32,
    layers: u32,
    levels: &[Vec<u8>],
) -> wgpu::Texture {
    let texture = context.device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: layers,
        },
        mip_level_count: levels.len() as u32,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    let (mut w, mut h) = (width, height);
    for (mip, level) in levels.iter().enumerate() {
        context.queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &texture,
                mip_level: mip as u32,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            level,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(w * 4),
                rows_per_image: Some(h),
            },
            wgpu::Extent3d {
                width: w,
                height: h,
                depth_or_array_layers: layers,
            },
        );
        w = (w / 2).max(1);
        h = (h / 2).max(1);
    }
    texture
}

impl TerrainMaterialResources {
    pub(super) fn new(
        context: &GpuContext,
        plan: TerrainMaterialPlan,
        material: Option<&TerrainMaterialOptions>,
        screen: bool,
    ) -> Self {
        let uniform_buffer = context
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("forge3d-web-terrain-material-uniform"),
                contents: bytemuck::bytes_of(&plan.uniform),
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            });
        // Native `GpuMaterialSet` stores albedo as Rgba8UnormSrgb, including
        // the flat base-color fill of untextured layers.
        let albedo = upload_array(
            context,
            "forge3d-web-terrain-material-albedo",
            wgpu::TextureFormat::Rgba8UnormSrgb,
            plan.albedo.width,
            plan.albedo.height,
            plan.albedo.layers,
            &plan.albedo.levels,
        );
        let mut aux_layers = plan.aux.normal.clone();
        aux_layers.extend_from_slice(&plan.aux.masks);
        let aux = upload_array(
            context,
            "forge3d-web-terrain-material-aux",
            wgpu::TextureFormat::Rgba8Unorm,
            plan.aux.width,
            plan.aux.height,
            2,
            &[aux_layers],
        );
        let array_view = |texture: &wgpu::Texture| {
            texture.create_view(&wgpu::TextureViewDescriptor {
                dimension: Some(wgpu::TextureViewDimension::D2Array),
                ..wgpu::TextureViewDescriptor::default()
            })
        };
        let sampling = material
            .map(|material| material.settings.sampling.clone())
            .unwrap_or_default();
        let linear_min = sampling.min_filter == SamplingFilter::Linear;
        let linear_mag = sampling.mag_filter == SamplingFilter::Linear;
        let linear_mip = sampling.mip_filter == SamplingFilter::Linear;
        // WebGPU only permits anisotropy with all-linear filtering.
        let anisotropy = if linear_min && linear_mag && linear_mip {
            sampling.anisotropy.clamp(1, 16) as u16
        } else {
            1
        };
        let albedo_sampler = context.device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("forge3d-web-terrain-material-sampler"),
            address_mode_u: address_mode(sampling.address_u),
            address_mode_v: address_mode(sampling.address_v),
            address_mode_w: address_mode(sampling.address_w),
            mag_filter: filter_mode(sampling.mag_filter),
            min_filter: filter_mode(sampling.min_filter),
            mipmap_filter: mipmap_filter_mode(sampling.mip_filter),
            anisotropy_clamp: anisotropy,
            ..wgpu::SamplerDescriptor::default()
        });
        let aux_sampler = context.device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("forge3d-web-terrain-material-aux-sampler"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::MipmapFilterMode::Nearest,
            ..wgpu::SamplerDescriptor::default()
        });
        Self {
            shader_enabled: plan.report.enabled || screen,
            uniform_buffer,
            albedo_view: array_view(&albedo),
            albedo_sampler,
            aux_view: array_view(&aux),
            aux_sampler,
            report: plan.report,
        }
    }

    pub(super) fn bind_group_entries(&self) -> [wgpu::BindGroupEntry<'_>; 5] {
        [
            wgpu::BindGroupEntry {
                binding: 7,
                resource: self.uniform_buffer.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 8,
                resource: wgpu::BindingResource::TextureView(&self.albedo_view),
            },
            wgpu::BindGroupEntry {
                binding: 9,
                resource: wgpu::BindingResource::Sampler(&self.albedo_sampler),
            },
            wgpu::BindGroupEntry {
                binding: 10,
                resource: wgpu::BindingResource::TextureView(&self.aux_view),
            },
            wgpu::BindGroupEntry {
                binding: 11,
                resource: wgpu::BindingResource::Sampler(&self.aux_sampler),
            },
        ]
    }
}

/// Group-0 layout entries for bindings 7-11.
pub(super) fn material_layout_entries() -> [wgpu::BindGroupLayoutEntry; 5] {
    let array_texture = |binding: u32| wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::FRAGMENT,
        ty: wgpu::BindingType::Texture {
            sample_type: wgpu::TextureSampleType::Float { filterable: true },
            view_dimension: wgpu::TextureViewDimension::D2Array,
            multisampled: false,
        },
        count: None,
    };
    let sampler = |binding: u32| wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::FRAGMENT,
        ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
        count: None,
    };
    [
        wgpu::BindGroupLayoutEntry {
            binding: 7,
            visibility: wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Uniform,
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        },
        array_texture(8),
        sampler(9),
        array_texture(10),
        sampler(11),
    ]
}

#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
fn set(target: &js_sys::Object, name: &str, value: &JsValue) {
    let _ = js_sys::Reflect::set(target, &JsValue::from_str(name), value);
}

/// `TerrainMaterialReport` as the public JS object.
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub(super) fn report_js(report: Option<&TerrainMaterialReport>) -> JsValue {
    let out = js_sys::Object::new();
    let empty = TerrainMaterialReport {
        enabled: false,
        layer_count: 0,
        textured_layers: Vec::new(),
        texture_width: 0,
        texture_height: 0,
        mip_levels: 0,
        mask_bits: 0,
        detail_normal_map: false,
        gpu_bytes: 0,
        diagnostics: Vec::new(),
    };
    let report = report.unwrap_or(&empty);
    set(&out, "enabled", &JsValue::from_bool(report.enabled));
    set(
        &out,
        "layerCount",
        &JsValue::from_f64(f64::from(report.layer_count)),
    );
    let textured = js_sys::Array::new();
    for flag in &report.textured_layers {
        textured.push(&JsValue::from_bool(*flag));
    }
    set(&out, "texturedLayers", &textured);
    set(
        &out,
        "textureWidth",
        &JsValue::from_f64(f64::from(report.texture_width)),
    );
    set(
        &out,
        "textureHeight",
        &JsValue::from_f64(f64::from(report.texture_height)),
    );
    set(
        &out,
        "mipLevels",
        &JsValue::from_f64(f64::from(report.mip_levels)),
    );
    let masks = js_sys::Array::new();
    for (bit, name) in ["snow", "rock", "wetness"].iter().enumerate() {
        if report.mask_bits & (1 << bit) != 0 {
            masks.push(&JsValue::from_str(name));
        }
    }
    set(&out, "maskChannels", &masks);
    set(
        &out,
        "detailNormalMap",
        &JsValue::from_bool(report.detail_normal_map),
    );
    set(
        &out,
        "gpuBytes",
        &JsValue::from_f64(report.gpu_bytes as f64),
    );
    let diagnostics = js_sys::Array::new();
    for diagnostic in &report.diagnostics {
        let entry = js_sys::Object::new();
        set(&entry, "code", &JsValue::from_str(diagnostic.code));
        set(&entry, "message", &JsValue::from_str(&diagnostic.message));
        if let Some(layer) = diagnostic.layer {
            set(&entry, "layer", &JsValue::from_f64(f64::from(layer)));
        }
        diagnostics.push(&entry);
    }
    set(&out, "diagnostics", &diagnostics);
    out.into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disabled_plan_is_tiny_and_reports_disabled() {
        let plan = plan_material(None, false, [0.0, 1.0], 8192, u64::MAX);
        assert!(!plan.report.enabled);
        assert_eq!(plan.uniform.control[0], 0.0);
        assert_eq!(
            (plan.albedo.width, plan.albedo.height, plan.albedo.layers),
            (1, 1, 1)
        );
        assert_eq!((plan.aux.width, plan.aux.height), (1, 1));
        assert_eq!(plan.report.gpu_bytes, uniform_bytes() + 4 + 8);
    }

    #[test]
    fn screen_terrains_without_a_material_pack_the_default_material() {
        let plan = plan_material(None, true, [0.0, 1.0], 8192, u64::MAX);
        assert!(!plan.report.enabled);
        assert_eq!(plan.uniform.control[0], 1.0);
        let default = forge3d_core::terrain_material::TerrainMaterialSettings::default().pack(
            [0.0, 1.0],
            0,
            false,
        );
        assert_eq!(
            bytemuck::bytes_of(&plan.uniform),
            bytemuck::bytes_of(&default)
        );
        assert_eq!(plan.albedo.layers, 4);
        assert!(plan.report.diagnostics.is_empty());
    }

    #[test]
    fn material_plan_reports_fallbacks_and_approximations() {
        let mut settings = forge3d_core::terrain_material::TerrainMaterialSettings::default();
        settings.albedo_mode = forge3d_core::terrain_material::AlbedoMode::Material;
        settings.pom.enabled = true;
        settings.pom.mode = PomMode::Relief;
        settings.detail.detail_strength = 0.5;
        let options = TerrainMaterialOptions {
            layer_images: vec![None; settings.material_set.len()],
            settings,
            detail_normal: None,
            masks: [None, None, None],
        };
        let plan = plan_material(Some(&options), false, [10.0, 20.0], 8192, u64::MAX);
        assert!(plan.report.enabled);
        assert_eq!(plan.uniform.control[0], 1.0);
        assert_eq!(plan.report.layer_count, 4);
        let codes: Vec<&str> = plan.report.diagnostics.iter().map(|d| d.code).collect();
        assert_eq!(
            codes,
            vec![
                "terrain-material-texture-missing",
                "terrain-material-texture-missing",
                "terrain-material-texture-missing",
                "terrain-material-texture-missing",
                "terrain-material-detail-normal-missing",
                "terrain-material-pom-mode-approximated",
            ]
        );
        // The default height range resolves to the terrain domain.
        assert_eq!(plan.uniform.clamp0[0..2], [10.0, 20.0]);
    }
}
