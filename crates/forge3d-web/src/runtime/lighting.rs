use std::collections::BTreeSet;

use forge3d_core::lighting::{
    AreaLightConfig, AreaLightMode, DirectionalLight, Light, LightingState, PackedLight,
    PointLight, RectAreaLight, SoftLightFalloff, SpotLight, LTC_LUT_SIZE, MAX_LIGHTS,
};
use forge3d_core::materials::{
    Material, MaterialSlot, MaterialState, PackedMaterial, MAX_MATERIALS,
};
use forge3d_core::memory::MemoryCategory;
use wgpu::util::DeviceExt;

use super::memory::MemoryLedger;
use super::Forge3DRuntime;
use crate::error::{map_core_error, Forge3DErrorCode, WebError};

pub(super) const LIGHTING_BUFFER_BYTES: u64 = (MAX_LIGHTS * std::mem::size_of::<PackedLight>())
    as u64
    + std::mem::size_of::<forge3d_core::lighting::LightingUniform>() as u64;
pub(super) const LTC_TEXTURE_BYTES: u64 = 2 * (LTC_LUT_SIZE * LTC_LUT_SIZE * 16) as u64;
pub(super) const MATERIAL_BUFFER_BYTES: u64 =
    (MAX_MATERIALS as usize * std::mem::size_of::<PackedMaterial>()
        + std::mem::size_of::<forge3d_core::materials::MaterialUniform>()) as u64;
pub(super) const LIGHTING_TOTAL_BYTES: u64 =
    LIGHTING_BUFFER_BYTES + LTC_TEXTURE_BYTES + MATERIAL_BUFFER_BYTES;

const LIGHTING_BUFFER_KEY: &str = "lighting:buffers";
const LIGHTING_LTC_KEY: &str = "lighting:ltc";
const MATERIAL_BUFFER_KEY: &str = "materials:buffers";

pub(super) fn lighting_memory_keys() -> [&'static str; 3] {
    [LIGHTING_BUFFER_KEY, LIGHTING_LTC_KEY, MATERIAL_BUFFER_KEY]
}

#[allow(dead_code)]
pub(super) struct LightingResources {
    pub lights_buffer: wgpu::Buffer,
    pub uniform_buffer: wgpu::Buffer,
    pub materials_buffer: wgpu::Buffer,
    pub material_uniform_buffer: wgpu::Buffer,
    pub ltc_matrix_view: wgpu::TextureView,
    pub ltc_amplitude_view: wgpu::TextureView,
    pub ltc_sampler: wgpu::Sampler,
    pub bind_group_layout: wgpu::BindGroupLayout,
    pub bind_group: wgpu::BindGroup,
    pub(super) state: LightingState,
    pub(super) light_ids: Vec<u32>,
    material_state: MaterialState,
}

impl LightingResources {
    #[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
    pub(super) fn new(
        context: &forge3d_core::gpu::GpuContext,
        memory: &mut MemoryLedger,
        state: &LightingState,
        material_state: &MaterialState,
        light_ids: Vec<u32>,
    ) -> Result<Self, WebError> {
        if !memory.fits_after_release(&lighting_memory_keys(), LIGHTING_TOTAL_BYTES) {
            return Err(WebError::new(
                Forge3DErrorCode::ResourceLimitExceeded,
                format!(
                    "lighting resources require {LIGHTING_TOTAL_BYTES} bytes beyond the memory budget"
                ),
            ));
        }

        let lights_buffer = context.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("forge3d-web-lighting-lights"),
            size: (MAX_LIGHTS * std::mem::size_of::<PackedLight>()) as u64,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let uniform_buffer = context
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("forge3d-web-lighting-uniform"),
                contents: bytemuck::bytes_of(&state.uniform()),
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            });
        let materials_buffer = context.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("forge3d-web-materials"),
            size: (MAX_MATERIALS as usize * std::mem::size_of::<PackedMaterial>()) as u64,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let material_uniform_buffer =
            context
                .device
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("forge3d-web-material-uniform"),
                    contents: bytemuck::bytes_of(&material_state.uniform()),
                    usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                });

        let lut = forge3d_core::lighting::generate_ltc_lut();
        let ltc_matrix_view = upload_ltc_texture(
            context,
            "forge3d-web-lighting-ltc-matrix",
            bytemuck::cast_slice(&lut.matrix),
        );
        let amplitude_rgba: Vec<[f32; 4]> = lut
            .amplitude
            .iter()
            .map(|value| [*value, 0.0, 0.0, 0.0])
            .collect();
        let ltc_amplitude_view = upload_ltc_texture(
            context,
            "forge3d-web-lighting-ltc-amplitude",
            bytemuck::cast_slice(&amplitude_rgba),
        );
        let ltc_sampler = context.device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("forge3d-web-lighting-ltc-sampler"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Nearest,
            min_filter: wgpu::FilterMode::Nearest,
            mipmap_filter: wgpu::MipmapFilterMode::Nearest,
            ..wgpu::SamplerDescriptor::default()
        });

        let bind_group_layout =
            context
                .device
                .create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                    label: Some("forge3d-web-lighting-bind-group-layout"),
                    entries: &lighting_layout_entries(),
                });
        let bind_group = context
            .device
            .create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("forge3d-web-lighting-bind-group"),
                layout: &bind_group_layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: lights_buffer.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: uniform_buffer.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: wgpu::BindingResource::TextureView(&ltc_matrix_view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 3,
                        resource: wgpu::BindingResource::TextureView(&ltc_amplitude_view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 4,
                        resource: wgpu::BindingResource::Sampler(&ltc_sampler),
                    },
                    wgpu::BindGroupEntry {
                        binding: 5,
                        resource: materials_buffer.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 6,
                        resource: material_uniform_buffer.as_entire_binding(),
                    },
                ],
            });

        memory.replace(
            LIGHTING_BUFFER_KEY,
            MemoryCategory::Buffers,
            LIGHTING_BUFFER_BYTES,
        )?;
        memory.replace(
            LIGHTING_LTC_KEY,
            MemoryCategory::Textures,
            LTC_TEXTURE_BYTES,
        )?;
        memory.replace(
            MATERIAL_BUFFER_KEY,
            MemoryCategory::Buffers,
            MATERIAL_BUFFER_BYTES,
        )?;

        let resources = Self {
            lights_buffer,
            uniform_buffer,
            materials_buffer,
            material_uniform_buffer,
            ltc_matrix_view,
            ltc_amplitude_view,
            ltc_sampler,
            bind_group_layout,
            bind_group,
            state: state.clone(),
            light_ids,
            material_state: material_state.clone(),
        };
        resources.write_state(context, state);
        resources.write_materials(context, material_state);
        Ok(resources)
    }

    #[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
    pub(super) fn commit_state(
        &mut self,
        context: &forge3d_core::gpu::GpuContext,
        state: &LightingState,
        light_ids: Vec<u32>,
    ) {
        self.write_state(context, state);
        self.state = state.clone();
        self.light_ids = light_ids;
    }

    #[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
    fn write_state(&self, context: &forge3d_core::gpu::GpuContext, state: &LightingState) {
        let mut packed = [PackedLight {
            kind: 0,
            enabled: 0,
            casts_shadow: 0,
            falloff_mode: 0,
            color_intensity: [0.0; 4],
            position_range: [0.0; 4],
            direction_inner_cos: [0.0; 4],
            right_width: [0.0; 4],
            up_height: [0.0; 4],
            soft_params: [0.0; 4],
        }; MAX_LIGHTS];
        for (slot, light) in packed.iter_mut().zip(state.pack_lights()) {
            *slot = light;
        }
        context
            .queue
            .write_buffer(&self.lights_buffer, 0, bytemuck::bytes_of(&packed));
        context.queue.write_buffer(
            &self.uniform_buffer,
            0,
            bytemuck::bytes_of(&state.uniform()),
        );
    }

    #[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
    pub(super) fn commit_materials(
        &mut self,
        context: &forge3d_core::gpu::GpuContext,
        state: &MaterialState,
    ) {
        self.write_materials(context, state);
        self.material_state = state.clone();
    }

    #[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
    fn write_materials(&self, context: &forge3d_core::gpu::GpuContext, state: &MaterialState) {
        let mut packed = vec![
            PackedMaterial {
                brdf: 0,
                effective_brdf: 0,
                route_kind: 0,
                flags: 0,
                base_color: [0.0; 4],
                surface: [0.0; 4],
                lobes: [0.0; 4],
            };
            MAX_MATERIALS as usize
        ];
        for (slot, material) in packed.iter_mut().zip(state.pack_materials()) {
            *slot = material;
        }
        context
            .queue
            .write_buffer(&self.materials_buffer, 0, bytemuck::cast_slice(&packed));
        context.queue.write_buffer(
            &self.material_uniform_buffer,
            0,
            bytemuck::bytes_of(&state.uniform()),
        );
    }
}

#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
fn upload_ltc_texture(
    context: &forge3d_core::gpu::GpuContext,
    label: &'static str,
    texels: &[u8],
) -> wgpu::TextureView {
    let texture = context.device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d {
            width: LTC_LUT_SIZE as u32,
            height: LTC_LUT_SIZE as u32,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba32Float,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    context.queue.write_texture(
        wgpu::TexelCopyTextureInfo {
            texture: &texture,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        texels,
        wgpu::TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some((LTC_LUT_SIZE * 16) as u32),
            rows_per_image: Some(LTC_LUT_SIZE as u32),
        },
        wgpu::Extent3d {
            width: LTC_LUT_SIZE as u32,
            height: LTC_LUT_SIZE as u32,
            depth_or_array_layers: 1,
        },
    );
    texture.create_view(&wgpu::TextureViewDescriptor::default())
}

#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub(super) fn lighting_layout_entries() -> [wgpu::BindGroupLayoutEntry; 7] {
    [
        wgpu::BindGroupLayoutEntry {
            binding: 0,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Storage { read_only: true },
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        },
        wgpu::BindGroupLayoutEntry {
            binding: 1,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Uniform,
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        },
        wgpu::BindGroupLayoutEntry {
            binding: 2,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable: false },
                view_dimension: wgpu::TextureViewDimension::D2,
                multisampled: false,
            },
            count: None,
        },
        wgpu::BindGroupLayoutEntry {
            binding: 3,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable: false },
                view_dimension: wgpu::TextureViewDimension::D2,
                multisampled: false,
            },
            count: None,
        },
        wgpu::BindGroupLayoutEntry {
            binding: 4,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::NonFiltering),
            count: None,
        },
        wgpu::BindGroupLayoutEntry {
            binding: 5,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Storage { read_only: true },
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        },
        wgpu::BindGroupLayoutEntry {
            binding: 6,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Uniform,
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        },
    ]
}

#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub(super) fn apply_lighting_state(
    runtime: &mut Forge3DRuntime,
    state: &LightingState,
    light_ids: Vec<u32>,
) -> Result<(), WebError> {
    let context = runtime.context.clone().ok_or_else(|| {
        WebError::new(
            Forge3DErrorCode::RuntimeDisposed,
            "Runtime GPU context is not available",
        )
    })?;
    runtime.lighting.as_ref().ok_or_else(|| {
        WebError::new(
            Forge3DErrorCode::RuntimeDisposed,
            "Runtime lighting resources are not available",
        )
    })?;
    let prepared = match runtime.shadows.as_ref() {
        Some(shadows) => {
            let aspect = runtime.width as f32 / runtime.height.max(1) as f32;
            Some(super::shadows::prepare_shadow_state(
                &runtime.camera,
                aspect,
                state,
                &light_ids,
                shadows,
                runtime.terrain.as_ref(),
            )?)
        }
        None => None,
    };
    let lighting = runtime.lighting.as_mut().ok_or_else(|| {
        WebError::new(
            Forge3DErrorCode::RuntimeDisposed,
            "Runtime lighting resources are not available",
        )
    })?;
    lighting.commit_state(&context, state, light_ids);
    if let (Some(shadows), Some(prepared)) = (runtime.shadows.as_mut(), prepared) {
        prepared.write(&context, shadows);
    }
    Ok(())
}

#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub(super) fn apply_material_state(
    runtime: &mut Forge3DRuntime,
    state: &MaterialState,
    texture_sets: &std::collections::BTreeMap<u32, super::textures::ParsedTextureSet>,
) -> Result<(), WebError> {
    let context = runtime.context.clone().ok_or_else(|| {
        WebError::new(
            Forge3DErrorCode::RuntimeDisposed,
            "Runtime GPU context is not available",
        )
    })?;
    runtime.lighting.as_ref().ok_or_else(|| {
        WebError::new(
            Forge3DErrorCode::RuntimeDisposed,
            "Runtime lighting resources are not available",
        )
    })?;
    let mut planned = runtime.memory.clone();
    let textures = super::textures::build_texture_resources(
        &context,
        &planned,
        runtime.max_texture_dimension_2d,
        texture_sets,
    )?;
    planned.replace(
        super::textures::TEXTURE_FALLBACK_KEY,
        MemoryCategory::Textures,
        super::textures::FALLBACK_BYTES,
    )?;
    planned.replace(
        super::textures::TEXTURE_PAYLOAD_KEY,
        MemoryCategory::Textures,
        textures.payload_bytes,
    )?;
    runtime.memory = planned;
    let lighting = runtime
        .lighting
        .as_mut()
        .expect("lighting resources verified during material commit preparation");
    lighting.commit_materials(&context, state);
    super::textures::commit_textures(runtime, textures);
    if let (Some(scene), Some(ibl)) = (runtime.scene.as_mut(), runtime.ibl.as_ref()) {
        let textures = runtime.textures.as_ref().expect("textures committed");
        scene.encode_bundles(&context, textures, ibl);
    }
    Ok(())
}

#[cfg(target_arch = "wasm32")]
pub(super) fn set_materials_runtime(
    runtime: &mut Forge3DRuntime,
    snapshot: wasm_bindgen::JsValue,
) -> Result<(), WebError> {
    let parsed = super::textures::materials_and_textures_from_js(&snapshot)?;
    apply_material_state(runtime, &parsed.state, &parsed.texture_sets)
}

#[cfg(not(target_arch = "wasm32"))]
pub(super) fn set_materials_runtime(
    runtime: &mut Forge3DRuntime,
    snapshot: wasm_bindgen::JsValue,
) -> Result<(), WebError> {
    let _ = (runtime, snapshot);
    Err(WebError::new(
        Forge3DErrorCode::UnsupportedFeature,
        "Material commits are only available in wasm32 browser builds",
    ))
}

#[cfg(target_arch = "wasm32")]
#[allow(dead_code)]
pub(super) fn material_state_from_js(
    value: &wasm_bindgen::JsValue,
) -> Result<MaterialState, WebError> {
    super::textures::materials_and_textures_from_js(value).map(|parsed| parsed.state)
}

#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub(super) fn material_state_from_json(
    value: &serde_json::Value,
) -> Result<MaterialState, WebError> {
    let object = value
        .as_object()
        .ok_or_else(|| invalid("materials snapshot must be an object"))?;
    let _revision = mat_u64(object, "revision")?;
    let max_materials = mat_u64(object, "maxMaterials")?;
    if max_materials < 1 || max_materials > u64::from(MAX_MATERIALS) {
        return Err(invalid(
            "materials.maxMaterials must be an integer between 1 and 256",
        ));
    }
    let entries = object
        .get("materials")
        .and_then(|value| value.as_array())
        .ok_or_else(|| invalid("materials.materials must be an array"))?;
    let mut slots = Vec::with_capacity(entries.len());
    for entry in entries {
        let slot_object = entry
            .as_object()
            .ok_or_else(|| invalid("materials.materials entries must be objects"))?;
        let slot = mat_str(slot_object, "slot")?.to_string();
        let index = mat_u64(slot_object, "index")?;
        let material_object = slot_object
            .get("material")
            .and_then(|value| value.as_object())
            .ok_or_else(|| invalid("materials.materials.material must be an object"))?;
        slots.push(MaterialSlot {
            slot,
            index: index as u32,
            material: parse_material(material_object)?,
        });
    }
    let state = MaterialState {
        max_materials: max_materials as u32,
        slots,
    };
    state.validated().map_err(map_core_error)
}

#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
fn parse_material(
    object: &serde_json::Map<String, serde_json::Value>,
) -> Result<Material, WebError> {
    let id = mat_str(object, "id")?.to_string();
    let route_object = object
        .get("route")
        .and_then(|value| value.as_object())
        .ok_or_else(|| invalid("materials.material.route must be an object"))?;
    let requested = mat_str(route_object, "requested")?;
    let route = forge3d_core::materials::resolve_brdf(requested).map_err(map_core_error)?;
    if mat_str(route_object, "model")? != route.model {
        return Err(invalid(
            "materials.material.route.model does not match the shared route table",
        ));
    }
    if mat_str(route_object, "effectiveModel")? != route.effective_model {
        return Err(invalid(
            "materials.material.route.effectiveModel does not match the shared route table",
        ));
    }
    let expected_implementation = match route.implementation {
        forge3d_core::materials::BrdfImplementation::Exact => "exact",
        forge3d_core::materials::BrdfImplementation::Alias => "alias",
        forge3d_core::materials::BrdfImplementation::Approximation => "approximation",
    };
    if mat_str(route_object, "implementation")? != expected_implementation {
        return Err(invalid(
            "materials.material.route.implementation does not match the shared route table",
        ));
    }
    match route_object.get("diagnostic") {
        None | Some(serde_json::Value::Null) => {
            if route.diagnostic.is_some() {
                return Err(invalid(
                    "materials.material.route.diagnostic does not match the shared route table",
                ));
            }
        }
        Some(value) => {
            let diagnostic = value
                .as_str()
                .ok_or_else(|| invalid("materials.material.route.diagnostic must be a string"))?;
            if route.diagnostic.as_deref() != Some(diagnostic) {
                return Err(invalid(
                    "materials.material.route.diagnostic does not match the shared route table",
                ));
            }
        }
    }
    if mat_str(object, "brdf")? != route.model {
        return Err(invalid(
            "materials.material.brdf must equal material.route.model",
        ));
    }
    let base_color = mat_vec4(object, "baseColor")?;
    Ok(Material {
        id,
        route,
        base_color,
        metallic: mat_f64_opt(object, "metallic", 0.0)? as f32,
        roughness: mat_f64_opt(object, "roughness", 0.5)? as f32,
        sheen: mat_f64_opt(object, "sheen", 0.0)? as f32,
        clearcoat: mat_f64_opt(object, "clearcoat", 0.0)? as f32,
        subsurface: mat_f64_opt(object, "subsurface", 0.0)? as f32,
        anisotropy: mat_f64_opt(object, "anisotropy", 0.0)? as f32,
        flags: 0,
    })
}

#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
fn mat_u64(
    object: &serde_json::Map<String, serde_json::Value>,
    field: &str,
) -> Result<u64, WebError> {
    object
        .get(field)
        .and_then(|value| value.as_u64())
        .ok_or_else(|| invalid(format!("materials.{field} must be a nonnegative integer")))
}

#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
fn mat_f64_opt(
    object: &serde_json::Map<String, serde_json::Value>,
    field: &str,
    default: f64,
) -> Result<f64, WebError> {
    match object.get(field) {
        None | Some(serde_json::Value::Null) => Ok(default),
        Some(value) => value
            .as_f64()
            .filter(|value| value.is_finite())
            .ok_or_else(|| invalid(format!("materials.{field} must be a finite number"))),
    }
}

#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
fn mat_str<'a>(
    object: &'a serde_json::Map<String, serde_json::Value>,
    field: &str,
) -> Result<&'a str, WebError> {
    object
        .get(field)
        .and_then(|value| value.as_str())
        .filter(|text| !text.is_empty())
        .ok_or_else(|| invalid(format!("materials.{field} must be a nonempty string")))
}

#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
fn mat_vec4(
    object: &serde_json::Map<String, serde_json::Value>,
    field: &str,
) -> Result<[f32; 4], WebError> {
    let array = object
        .get(field)
        .and_then(|value| value.as_array())
        .ok_or_else(|| invalid(format!("materials.{field} must be a 4-component vector")))?;
    if array.len() != 4 {
        return Err(invalid(format!(
            "materials.{field} must be a 4-component vector"
        )));
    }
    let mut out = [0.0_f32; 4];
    for (index, entry) in array.iter().enumerate() {
        out[index] = entry
            .as_f64()
            .filter(|value| value.is_finite())
            .ok_or_else(|| invalid(format!("materials.{field} components must be finite")))?
            as f32;
    }
    Ok(out)
}

#[cfg(target_arch = "wasm32")]
pub(super) fn set_lighting_runtime(
    runtime: &mut Forge3DRuntime,
    snapshot: wasm_bindgen::JsValue,
) -> Result<(), WebError> {
    let json: serde_json::Value = serde_wasm_bindgen::from_value(snapshot)
        .map_err(|error| invalid(format!("lighting snapshot is malformed: {error}")))?;
    let state = lighting_state_from_json(&json)?;
    let light_ids = lighting_light_ids_from_json(&json)?;
    apply_lighting_state(runtime, &state, light_ids)
}

#[cfg(not(target_arch = "wasm32"))]
pub(super) fn set_lighting_runtime(
    runtime: &mut Forge3DRuntime,
    snapshot: wasm_bindgen::JsValue,
) -> Result<(), WebError> {
    let _ = (runtime, snapshot);
    Err(WebError::new(
        Forge3DErrorCode::UnsupportedFeature,
        "Lighting commits are only available in wasm32 browser builds",
    ))
}

#[cfg(target_arch = "wasm32")]
pub(super) fn lighting_state_from_js(
    value: &wasm_bindgen::JsValue,
) -> Result<LightingState, WebError> {
    let json: serde_json::Value = serde_wasm_bindgen::from_value(value.clone())
        .map_err(|error| invalid(format!("lighting snapshot is malformed: {error}")))?;
    lighting_state_from_json(&json)
}

/// Returns the per-light snapshot ids in declaration order so runtime state
/// (e.g. the shadow caster) can keep referring to a stable public id even
/// though the packed GPU light layout does not carry it.
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub(super) fn lighting_light_ids_from_json(
    value: &serde_json::Value,
) -> Result<Vec<u32>, WebError> {
    let object = value
        .as_object()
        .ok_or_else(|| invalid("lighting snapshot must be an object"))?;
    let lights = object
        .get("lights")
        .and_then(|value| value.as_array())
        .ok_or_else(|| invalid("lighting.lights must be an array"))?;
    lights
        .iter()
        .map(|entry| {
            let light_object = entry
                .as_object()
                .ok_or_else(|| invalid("lighting.lights entries must be objects"))?;
            u32::try_from(required_u64(light_object, "id")?)
                .map_err(|_| invalid("lighting.lights id is out of range"))
        })
        .collect()
}

#[cfg(target_arch = "wasm32")]
pub(super) fn lighting_light_ids_from_js(
    value: &wasm_bindgen::JsValue,
) -> Result<Vec<u32>, WebError> {
    let json: serde_json::Value = serde_wasm_bindgen::from_value(value.clone())
        .map_err(|error| invalid(format!("lighting snapshot is malformed: {error}")))?;
    lighting_light_ids_from_json(&json)
}

#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub(super) fn lighting_state_from_json(
    value: &serde_json::Value,
) -> Result<LightingState, WebError> {
    let object = value
        .as_object()
        .ok_or_else(|| invalid("lighting snapshot must be an object"))?;

    let revision = required_u64(object, "revision")?;
    let max_lights = required_u64(object, "maxLights")?;
    if max_lights < 1 || max_lights > MAX_LIGHTS as u64 {
        return Err(invalid(
            "lighting.maxLights must be an integer between 1 and 64",
        ));
    }
    let exposure = required_f64(object, "exposure")?;
    let debug_bounds = required_bool(object, "debugBounds")?;

    let area = object
        .get("areaLights")
        .and_then(|value| value.as_object())
        .ok_or_else(|| invalid("lighting.areaLights must be an object"))?;
    let mode = match required_str(area, "mode")? {
        "ltc" => AreaLightMode::Ltc,
        "sampled" => AreaLightMode::Sampled,
        other => {
            return Err(invalid(format!(
                "lighting.areaLights.mode must be ltc or sampled, got {other}"
            )))
        }
    };
    let sample_count = required_u64(area, "sampleCount")?;
    if ![1, 4, 8, 16].contains(&sample_count) {
        return Err(invalid(
            "lighting.areaLights.sampleCount must be 1, 4, 8, or 16",
        ));
    }
    let lut_size = required_u64(area, "lutSize")?;
    if lut_size != LTC_LUT_SIZE as u64 {
        return Err(invalid("lighting.areaLights.lutSize must be 64"));
    }

    let lights_value = object
        .get("lights")
        .and_then(|value| value.as_array())
        .ok_or_else(|| invalid("lighting.lights must be an array"))?;
    if lights_value.len() as u64 > max_lights {
        return Err(invalid("lighting.lights exceeds maxLights"));
    }
    let mut seen_ids = BTreeSet::new();
    let mut lights = Vec::with_capacity(lights_value.len());
    for entry in lights_value {
        let light_object = entry
            .as_object()
            .ok_or_else(|| invalid("lighting.lights entries must be objects"))?;
        let id = required_u64(light_object, "id")?;
        if !seen_ids.insert(id) {
            return Err(invalid("lighting.lights ids must be unique"));
        }
        lights.push(parse_light(light_object)?);
    }

    let _ = revision;
    let state = LightingState {
        max_lights: max_lights as u32,
        exposure: exposure as f32,
        debug_bounds,
        area: AreaLightConfig {
            mode,
            sample_count: sample_count as u32,
            lut_size: lut_size as u32,
        },
        lights,
    };
    state.validated().map_err(map_core_error)
}

#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
fn parse_light(object: &serde_json::Map<String, serde_json::Value>) -> Result<Light, WebError> {
    let color = required_vec3(object, "color")?;
    let intensity = required_f64(object, "intensity")? as f32;
    let enabled = required_bool(object, "enabled")?;
    let casts_shadow = required_bool(object, "castsShadow")?;
    match required_str(object, "type")? {
        "directional" => Ok(Light::Directional(DirectionalLight {
            color,
            intensity,
            enabled,
            casts_shadow,
            direction: required_vec3(object, "direction")?,
        })),
        "point" => Ok(Light::Point(PointLight {
            color,
            intensity,
            enabled,
            casts_shadow,
            position: required_vec3(object, "position")?,
            range: required_f64(object, "range")? as f32,
            inner_radius: optional_f64(object, "innerRadius", 0.0)? as f32,
            edge_softness: optional_f64(object, "edgeSoftness", 0.0)? as f32,
            falloff: parse_falloff(object)?,
            falloff_exponent: optional_f64(object, "falloffExponent", 2.0)? as f32,
        })),
        "spot" => Ok(Light::Spot(SpotLight {
            color,
            intensity,
            enabled,
            casts_shadow,
            position: required_vec3(object, "position")?,
            direction: required_vec3(object, "direction")?,
            range: required_f64(object, "range")? as f32,
            inner_cone_degrees: required_f64(object, "innerConeDegrees")? as f32,
            outer_cone_degrees: required_f64(object, "outerConeDegrees")? as f32,
            inner_radius: optional_f64(object, "innerRadius", 0.0)? as f32,
            edge_softness: optional_f64(object, "edgeSoftness", 0.0)? as f32,
            falloff: parse_falloff(object)?,
            falloff_exponent: optional_f64(object, "falloffExponent", 2.0)? as f32,
        })),
        "rect" => Ok(Light::Rect(RectAreaLight {
            color,
            intensity,
            enabled,
            casts_shadow,
            position: required_vec3(object, "position")?,
            right: required_vec3(object, "right")?,
            up: required_vec3(object, "up")?,
            width: required_f64(object, "width")? as f32,
            height: required_f64(object, "height")? as f32,
            range: required_f64(object, "range")? as f32,
            edge_softness: optional_f64(object, "edgeSoftness", 0.0)? as f32,
            two_sided: optional_bool(object, "twoSided", false)?,
        })),
        other => Err(invalid(format!(
            "lighting.lights type must be directional, point, spot, or rect; got {other}"
        ))),
    }
}

#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
fn parse_falloff(
    object: &serde_json::Map<String, serde_json::Value>,
) -> Result<SoftLightFalloff, WebError> {
    match object.get("falloff") {
        None | Some(serde_json::Value::Null) => Ok(SoftLightFalloff::Quadratic),
        Some(serde_json::Value::String(text)) => match text.as_str() {
            "linear" => Ok(SoftLightFalloff::Linear),
            "quadratic" => Ok(SoftLightFalloff::Quadratic),
            "cubic" => Ok(SoftLightFalloff::Cubic),
            "exponential" => Ok(SoftLightFalloff::Exponential),
            other => Err(invalid(format!(
                "light.falloff must be linear, quadratic, cubic, or exponential; got {other}"
            ))),
        },
        Some(_) => Err(invalid("light.falloff must be a string")),
    }
}

#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
fn required_u64(
    object: &serde_json::Map<String, serde_json::Value>,
    field: &str,
) -> Result<u64, WebError> {
    object
        .get(field)
        .and_then(|value| value.as_u64())
        .ok_or_else(|| invalid(format!("lighting.{field} must be a nonnegative integer")))
}

#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
fn required_f64(
    object: &serde_json::Map<String, serde_json::Value>,
    field: &str,
) -> Result<f64, WebError> {
    object
        .get(field)
        .and_then(|value| value.as_f64())
        .filter(|value| value.is_finite())
        .ok_or_else(|| invalid(format!("lighting.{field} must be a finite number")))
}

#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
fn optional_f64(
    object: &serde_json::Map<String, serde_json::Value>,
    field: &str,
    default: f64,
) -> Result<f64, WebError> {
    match object.get(field) {
        None | Some(serde_json::Value::Null) => Ok(default),
        Some(value) => value
            .as_f64()
            .filter(|value| value.is_finite())
            .ok_or_else(|| invalid(format!("lighting.{field} must be a finite number"))),
    }
}

#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
fn required_bool(
    object: &serde_json::Map<String, serde_json::Value>,
    field: &str,
) -> Result<bool, WebError> {
    object
        .get(field)
        .and_then(|value| value.as_bool())
        .ok_or_else(|| invalid(format!("lighting.{field} must be a boolean")))
}

#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
fn optional_bool(
    object: &serde_json::Map<String, serde_json::Value>,
    field: &str,
    default: bool,
) -> Result<bool, WebError> {
    match object.get(field) {
        None | Some(serde_json::Value::Null) => Ok(default),
        Some(value) => value
            .as_bool()
            .ok_or_else(|| invalid(format!("lighting.{field} must be a boolean"))),
    }
}

#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
fn required_str<'a>(
    object: &'a serde_json::Map<String, serde_json::Value>,
    field: &str,
) -> Result<&'a str, WebError> {
    object
        .get(field)
        .and_then(|value| value.as_str())
        .ok_or_else(|| invalid(format!("lighting.{field} must be a string")))
}

#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
fn required_vec3(
    object: &serde_json::Map<String, serde_json::Value>,
    field: &str,
) -> Result<[f32; 3], WebError> {
    let array = object
        .get(field)
        .and_then(|value| value.as_array())
        .ok_or_else(|| invalid(format!("lighting.{field} must be a 3-component vector")))?;
    if array.len() != 3 {
        return Err(invalid(format!(
            "lighting.{field} must be a 3-component vector"
        )));
    }
    let mut out = [0.0_f32; 3];
    for (index, entry) in array.iter().enumerate() {
        out[index] = entry
            .as_f64()
            .filter(|value| value.is_finite())
            .ok_or_else(|| invalid(format!("lighting.{field} components must be finite")))?
            as f32;
    }
    Ok(out)
}

#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
fn invalid(message: impl Into<String>) -> WebError {
    WebError::new(Forge3DErrorCode::InvalidInput, message.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot_json(lights: serde_json::Value) -> serde_json::Value {
        serde_json::json!({
            "revision": 0,
            "maxLights": 64,
            "exposure": 1.0,
            "debugBounds": false,
            "areaLights": { "mode": "ltc", "sampleCount": 4, "lutSize": 64 },
            "lights": lights,
        })
    }

    fn point_light_json() -> serde_json::Value {
        serde_json::json!({
            "id": 0,
            "type": "point",
            "color": [1.0, 0.5, 0.25],
            "intensity": 2.0,
            "enabled": true,
            "castsShadow": false,
            "position": [1.0, 2.0, 3.0],
            "range": 12.0,
            "innerRadius": 1.0,
            "edgeSoftness": 0.5,
            "falloff": "cubic",
            "falloffExponent": 3.0,
        })
    }

    #[test]
    fn lighting_byte_accounting_matches_the_gpu_layout() {
        assert_eq!(std::mem::size_of::<PackedLight>(), 112);
        assert_eq!(std::mem::size_of::<PackedMaterial>(), 64);
        assert_eq!(LIGHTING_BUFFER_BYTES, 64 * 112 + 32);
        assert_eq!(LTC_TEXTURE_BYTES, 2 * 64 * 64 * 16);
        assert_eq!(MATERIAL_BUFFER_BYTES, 256 * 64 + 16);
        assert_eq!(LIGHTING_TOTAL_BYTES, 154_672);
        assert_eq!(lighting_memory_keys().len(), 3);
    }

    #[test]
    fn parses_and_validates_direct_snapshots() {
        let state =
            lighting_state_from_json(&snapshot_json(serde_json::json!([point_light_json()])))
                .expect("valid snapshot");
        assert_eq!(state.lights.len(), 1);
        assert_eq!(state.max_lights, 64);
        assert!((state.exposure - 1.0).abs() < f32::EPSILON);
        assert_eq!(state.area.mode, AreaLightMode::Ltc);
        assert_eq!(state.area.sample_count, 4);
        match &state.lights[0] {
            Light::Point(light) => {
                assert_eq!(light.falloff, SoftLightFalloff::Cubic);
                assert!((light.range - 12.0).abs() < f32::EPSILON);
            }
            other => panic!("expected point light, got {other:?}"),
        }
        assert_eq!(state.uniform().light_count, 1);
        assert_eq!(state.pack_lights()[0].kind, 1);
    }

    #[test]
    fn normalizes_directions_and_rect_bases_from_snapshots() {
        let state = lighting_state_from_json(&snapshot_json(serde_json::json!([
            {
                "id": 0,
                "type": "directional",
                "color": [1.0, 1.0, 1.0],
                "intensity": 3.0,
                "enabled": true,
                "castsShadow": true,
                "direction": [0.0, -4.0, 0.0],
            },
            {
                "id": 1,
                "type": "rect",
                "color": [1.0, 1.0, 1.0],
                "intensity": 1.0,
                "enabled": true,
                "castsShadow": false,
                "position": [0.0, 8.0, 0.0],
                "right": [2.0, 0.0, 0.0],
                "up": [0.5, 1.0, 0.0],
                "width": 16.0,
                "height": 16.0,
                "range": 25.0,
                "edgeSoftness": 0.0,
                "twoSided": false,
            }
        ])))
        .expect("valid snapshot");
        match &state.lights[0] {
            Light::Directional(light) => {
                assert_eq!(light.direction, [0.0, -1.0, 0.0]);
            }
            other => panic!("expected directional light, got {other:?}"),
        }
        match &state.lights[1] {
            Light::Rect(light) => {
                assert_eq!(light.right, [1.0, 0.0, 0.0]);
                assert!((light.up[0]).abs() < 1e-6);
                assert!((light.up[1] - 1.0).abs() < 1e-6);
            }
            other => panic!("expected rect light, got {other:?}"),
        }
    }

    #[test]
    fn rejects_malformed_snapshots() {
        let reject = |mutate: &dyn Fn(&mut serde_json::Value)| {
            let mut value = snapshot_json(serde_json::json!([point_light_json()]));
            mutate(&mut value);
            assert!(lighting_state_from_json(&value).is_err());
        };
        reject(&|value| value["maxLights"] = serde_json::json!(0));
        reject(&|value| value["maxLights"] = serde_json::json!(128));
        reject(&|value| value["exposure"] = serde_json::json!(-1.0));
        reject(&|value| value["debugBounds"] = serde_json::json!("yes"));
        reject(&|value| value["areaLights"]["mode"] = serde_json::json!("fits"));
        reject(&|value| value["areaLights"]["sampleCount"] = serde_json::json!(3));
        reject(&|value| value["areaLights"]["lutSize"] = serde_json::json!(32));
        reject(&|value| value["lights"][0]["type"] = serde_json::json!("mystery"));
        reject(&|value| value["lights"][0]["range"] = serde_json::json!(0.0));
        reject(&|value| value["lights"][0]["color"] = serde_json::json!([1.5, 0.0, 0.0]));
        reject(&|value| value["lights"][0]["id"] = serde_json::json!(-1));
        reject(&|value| {
            let duplicate = value["lights"][0].clone();
            value["lights"].as_array_mut().unwrap().push(duplicate);
        });
        reject(&|value| value["lights"] = serde_json::json!({}));
        assert!(lighting_state_from_json(&serde_json::json!(42)).is_err());
    }

    #[test]
    fn terrain_shader_binds_the_shared_lighting_group() {
        assert!(crate::runtime::terrain::TERRAIN_SHADER.contains("forge3d_evaluate_lighting"));
        assert!(crate::runtime::terrain::TERRAIN_SHADER.contains("@group(1) @binding(0)"));
        assert!(crate::runtime::terrain::TERRAIN_SHADER.contains("@group(1) @binding(4)"));
        assert!(crate::runtime::terrain::TERRAIN_SHADER.contains("@group(1) @binding(5)"));
        assert!(crate::runtime::terrain::TERRAIN_SHADER.contains("@group(1) @binding(6)"));
        assert!(!crate::runtime::terrain::TERRAIN_SHADER.contains("shade_relief"));
        for model in 0u32..13 {
            assert!(
                crate::runtime::terrain::TERRAIN_SHADER.contains(&format!("case {model}u")),
                "missing dispatch constant {model}"
            );
        }
    }

    fn material_snapshot_json(materials: serde_json::Value) -> serde_json::Value {
        serde_json::json!({
            "revision": 1,
            "maxMaterials": 256,
            "materials": materials,
        })
    }

    fn route_json(requested: &str) -> serde_json::Value {
        let route = forge3d_core::materials::resolve_brdf(requested).expect("test route resolves");
        let implementation = match route.implementation {
            forge3d_core::materials::BrdfImplementation::Exact => "exact",
            forge3d_core::materials::BrdfImplementation::Alias => "alias",
            forge3d_core::materials::BrdfImplementation::Approximation => "approximation",
        };
        let mut value = serde_json::json!({
            "requested": route.requested,
            "model": route.model,
            "effectiveModel": route.effective_model,
            "implementation": implementation,
        });
        if let Some(diagnostic) = route.diagnostic {
            value["diagnostic"] = serde_json::json!(diagnostic);
        }
        value
    }

    fn default_material_json() -> serde_json::Value {
        serde_json::json!({
            "slot": "default",
            "index": 0,
            "material": {
                "id": "default",
                "brdf": "cooktorrance-ggx",
                "route": route_json("cooktorrance-ggx"),
                "baseColor": [1.0, 1.0, 1.0, 1.0],
                "metallic": 0.0,
                "roughness": 0.5,
                "sheen": 0.0,
                "clearcoat": 0.0,
                "subsurface": 0.0,
                "anisotropy": 0.0,
            },
        })
    }

    #[test]
    fn materials_snapshot_parses_and_validates() {
        let mut hero = default_material_json();
        hero["slot"] = serde_json::json!("hero");
        hero["index"] = serde_json::json!(1);
        hero["material"]["id"] = serde_json::json!("hero-mat");
        hero["material"]["brdf"] = serde_json::json!("subsurface");
        hero["material"]["route"] = route_json("sss");
        hero["material"]["subsurface"] = serde_json::json!(0.7);
        let state = material_state_from_json(&material_snapshot_json(serde_json::json!([
            default_material_json(),
            hero,
        ])))
        .expect("valid material snapshot");
        assert_eq!(state.slots.len(), 2);
        assert_eq!(state.slots[1].index, 1);
        assert_eq!(state.slots[1].material.route.requested, "sss");
        assert_eq!(state.slots[1].material.route.model, "subsurface");
        assert_eq!(
            state.slots[1].material.route.effective_model,
            "disney-principled"
        );
        assert_eq!(
            state.slots[1].material.route.implementation,
            forge3d_core::materials::BrdfImplementation::Approximation
        );
        assert_eq!(
            state.slots[1].material.route.diagnostic.as_deref(),
            Some(
                "subsurface is approximated by disney-principled with the subsurface lobe; input alias sss resolves to subsurface"
            )
        );
        let packed = state.pack_materials();
        assert_eq!(
            packed[1].brdf,
            forge3d_core::materials::BrdfModel::Subsurface as u32
        );
        assert_eq!(
            packed[1].effective_brdf,
            forge3d_core::materials::BrdfModel::DisneyPrincipled as u32
        );
        assert_eq!(state.uniform().material_count, 2);
    }

    #[test]
    fn materials_snapshot_rejects_malformed() {
        let reject = |mutate: &dyn Fn(&mut serde_json::Value)| {
            let mut value = material_snapshot_json(serde_json::json!([default_material_json()]));
            mutate(&mut value);
            assert!(material_state_from_json(&value).is_err());
        };
        reject(&|value| value["maxMaterials"] = serde_json::json!(0));
        reject(&|value| value["maxMaterials"] = serde_json::json!(512));
        reject(&|value| value["materials"] = serde_json::json!([]));
        reject(&|value| value["materials"][0]["index"] = serde_json::json!(3));
        reject(&|value| value["materials"][0]["material"]["brdf"] = serde_json::json!("custom"));
        reject(&|value| {
            value["materials"][0]["material"]["route"]["requested"] = serde_json::json!("ward")
        });
        reject(&|value| {
            value["materials"][0]["material"]["route"]["model"] = serde_json::json!("phong")
        });
        reject(&|value| {
            value["materials"][0]["material"]["route"]["effectiveModel"] =
                serde_json::json!("phong")
        });
        reject(&|value| {
            value["materials"][0]["material"]["route"]["implementation"] =
                serde_json::json!("alias")
        });
        reject(&|value| {
            value["materials"][0]["material"]["route"]["diagnostic"] = serde_json::json!("tampered")
        });
        reject(&|value| {
            let mut hero = default_material_json();
            hero["slot"] = serde_json::json!("hero");
            hero["index"] = serde_json::json!(1);
            hero["material"]["brdf"] = serde_json::json!("subsurface");
            hero["material"]["route"] = route_json("sss");
            hero["material"]["route"]["diagnostic"] = serde_json::json!("tampered");
            value["materials"].as_array_mut().unwrap().push(hero);
        });
        reject(&|value| {
            value["materials"][0]["material"]["baseColor"] = serde_json::json!([1.5, 0.0, 0.0, 1.0])
        });
        reject(&|value| {
            let mut duplicate = value["materials"][0].clone();
            duplicate["slot"] = serde_json::json!("copy");
            value["materials"].as_array_mut().unwrap().push(duplicate);
        });
        assert!(material_state_from_json(&serde_json::json!(42)).is_err());
    }
}
