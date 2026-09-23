#![cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]

#[cfg(target_arch = "wasm32")]
use bytemuck::Zeroable;
#[cfg(target_arch = "wasm32")]
use forge3d_core::gpu::GpuContext;
use forge3d_core::lighting::{Light, LightingState};
#[cfg(target_arch = "wasm32")]
use forge3d_core::memory::MemoryCategory;
use forge3d_core::memory::OverflowPolicy;
#[cfg(target_arch = "wasm32")]
use forge3d_core::shadowing::{self, ShadowUniform};
use forge3d_core::shadowing::{
    CsmConfig, ShadowConfig, ShadowDebugView, ShadowFilter, MAX_SHADOW_CASCADES,
    SHADOW_DEPTH_UNIFORM_BYTES, SHADOW_MAP_MAX, SHADOW_MAP_MIN, SHADOW_UNIFORM_BYTES,
};
#[cfg(target_arch = "wasm32")]
use wgpu::util::DeviceExt;

use super::terrain::TerrainRenderResources;
use super::Forge3DRuntime;
#[cfg(target_arch = "wasm32")]
use crate::error::map_core_error;
use crate::error::{Forge3DErrorCode, WebError};

use wasm_bindgen::JsValue;

#[cfg(test)]
mod tests;

pub(super) const SHADOW_DEPTH_KEY: &str = "shadows:depth";
pub(super) const SHADOW_MOMENTS_KEY: &str = "shadows:moments";
pub(super) const SHADOW_UNIFORMS_KEY: &str = "shadows:uniforms";
const SHADOW_DEPTH_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Depth32Float;
const SHADOW_MOMENT_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba32Float;
const SHADOW_DEPTH_SHADER: &str = include_str!("shadow_depth.wgsl");
const SHADOW_MOMENTS_SHADER: &str = include_str!("shadow_moments.wgsl");

fn invalid(message: impl Into<String>) -> WebError {
    WebError::new(Forge3DErrorCode::InvalidInput, message.into())
}

fn resource_limit(message: impl Into<String>) -> WebError {
    WebError::new(Forge3DErrorCode::ResourceLimitExceeded, message.into())
}

#[derive(Debug, Clone, Default)]
pub(super) struct ParsedShadows {
    pub config: ShadowConfig,
    pub csm: CsmConfig,
}

#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
fn json_f64(
    object: &serde_json::Map<String, serde_json::Value>,
    field: &str,
) -> Result<f64, WebError> {
    object
        .get(field)
        .and_then(|value| value.as_f64())
        .ok_or_else(|| invalid(format!("shadows.{field} must be a finite number")))
}

#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
fn json_u64(
    object: &serde_json::Map<String, serde_json::Value>,
    field: &str,
) -> Result<u64, WebError> {
    object
        .get(field)
        .and_then(|value| value.as_u64())
        .ok_or_else(|| invalid(format!("shadows.{field} must be a nonnegative integer")))
}

#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
fn json_bool(
    object: &serde_json::Map<String, serde_json::Value>,
    field: &str,
) -> Result<bool, WebError> {
    object
        .get(field)
        .and_then(|value| value.as_bool())
        .ok_or_else(|| invalid(format!("shadows.{field} must be a boolean")))
}

#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
fn json_str<'a>(
    object: &'a serde_json::Map<String, serde_json::Value>,
    field: &str,
) -> Result<&'a str, WebError> {
    object
        .get(field)
        .and_then(|value| value.as_str())
        .ok_or_else(|| invalid(format!("shadows.{field} must be a string")))
}

#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
fn json_object<'a>(
    object: &'a serde_json::Map<String, serde_json::Value>,
    field: &str,
) -> Result<&'a serde_json::Map<String, serde_json::Value>, WebError> {
    object
        .get(field)
        .and_then(|value| value.as_object())
        .ok_or_else(|| invalid(format!("shadows.{field} must be an object")))
}

pub(super) fn shadows_from_json(value: &serde_json::Value) -> Result<ParsedShadows, WebError> {
    let object = value
        .as_object()
        .ok_or_else(|| invalid("shadows snapshot must be an object"))?;

    let config_object = json_object(object, "config")?;
    let enabled = json_bool(config_object, "enabled")?;
    let filter = ShadowFilter::from_name(json_str(config_object, "filter")?)
        .map_err(|error| invalid(error.to_string()))?;
    let map_size = json_u64(config_object, "mapSize")?;
    let config = ShadowConfig {
        enabled,
        filter,
        map_size: map_size as u32,
        depth_bias: json_f64(config_object, "depthBias")? as f32,
        normal_bias: json_f64(config_object, "normalBias")? as f32,
        slope_bias: json_f64(config_object, "slopeBias")? as f32,
        softness: json_f64(config_object, "softness")? as f32,
        pcss_blocker_radius: json_f64(config_object, "pcssBlockerRadius")? as f32,
        pcss_filter_radius: json_f64(config_object, "pcssFilterRadius")? as f32,
        light_size: json_f64(config_object, "lightSize")? as f32,
        moment_bias: json_f64(config_object, "momentBias")? as f32,
        light_bleed_reduction: json_f64(config_object, "lightBleedReduction")? as f32,
        evsm_positive_exponent: json_f64(config_object, "evsmPositiveExponent")? as f32,
        evsm_negative_exponent: json_f64(config_object, "evsmNegativeExponent")? as f32,
        peter_panning_offset: json_f64(config_object, "peterPanningOffset")? as f32,
    }
    .validated()
    .map_err(|error| invalid(error.to_string()))?;

    let csm_object = json_object(object, "csm")?;
    let csm = CsmConfig {
        enabled: json_bool(csm_object, "enabled")?,
        cascade_count: json_u64(csm_object, "cascadeCount")? as u32,
        max_distance: json_f64(csm_object, "maxDistance")? as f32,
        split_lambda: json_f64(csm_object, "splitLambda")? as f32,
        blend_range: json_f64(csm_object, "blendRange")? as f32,
        stabilize: json_bool(csm_object, "stabilize")?,
        debug_view: ShadowDebugView::from_name(json_str(csm_object, "debugView")?)
            .map_err(|error| invalid(error.to_string()))?,
    }
    .validated()
    .map_err(|error| invalid(error.to_string()))?;
    if csm.enabled && !(2..=MAX_SHADOW_CASCADES as u32).contains(&csm.cascade_count) {
        return Err(invalid("shadows.csm.cascadeCount must be between 2 and 4"));
    }
    if !csm.enabled && csm.cascade_count != 3 && !(2..=4u32).contains(&csm.cascade_count) {
        return Err(invalid("shadows.csm.cascadeCount must be between 2 and 4"));
    }

    let report = json_object(object, "report")?;
    let requested_filter = ShadowFilter::from_name(json_str(report, "requestedFilter")?)
        .map_err(|error| invalid(error.to_string()))?;
    if requested_filter != config.filter {
        return Err(invalid(
            "shadows.report.requestedFilter must match config.filter",
        ));
    }
    let effective_filter = ShadowFilter::from_name(json_str(report, "effectiveFilter")?)
        .map_err(|error| invalid(error.to_string()))?;
    if effective_filter != config.filter {
        return Err(invalid(
            "shadows.report.effectiveFilter must match config.filter",
        ));
    }
    if json_u64(report, "requestedMapSize")? as u32 != config.map_size {
        return Err(invalid(
            "shadows.report.requestedMapSize must match config.mapSize",
        ));
    }
    let effective_map_size = json_u64(report, "effectiveMapSize")? as u32;
    if !effective_map_size.is_power_of_two()
        || !(SHADOW_MAP_MIN..=SHADOW_MAP_MAX).contains(&effective_map_size)
    {
        return Err(invalid(
            "shadows.report.effectiveMapSize must be a power of two between 256 and 4096",
        ));
    }
    let csm_active = config.enabled && csm.enabled;
    if json_bool(report, "csmEnabled")? != csm_active {
        return Err(invalid(
            "shadows.report.csmEnabled must match the effective csm state",
        ));
    }
    let expected_cascades = if config.enabled {
        csm.effective_cascade_count()
    } else {
        1
    };
    if json_u64(report, "cascadeCount")? as u32 != expected_cascades {
        return Err(invalid(
            "shadows.report.cascadeCount must match the csm setting",
        ));
    }
    let moment_format = json_str(report, "momentFormat")?;
    let expected_moment = if config.enabled && effective_filter.requires_moments() {
        "rgba32float"
    } else {
        "none"
    };
    if moment_format != expected_moment {
        return Err(invalid(format!(
            "shadows.report.momentFormat must be {expected_moment} for this configuration"
        )));
    }
    match report.get("casterLightId") {
        Some(serde_json::Value::Null) => {}
        Some(value) => {
            let id = value.as_u64().ok_or_else(|| {
                invalid("shadows.report.casterLightId must be null or an integer")
            })?;
            if id > u32::MAX as u64 {
                return Err(invalid("shadows.report.casterLightId is out of range"));
            }
        }
        None => {
            return Err(invalid(
                "shadows.report.casterLightId must be null or an integer",
            ))
        }
    }
    let _ = json_str(report, "reason")?;

    Ok(ParsedShadows { config, csm })
}

#[cfg(target_arch = "wasm32")]
pub(super) fn shadows_from_js(value: &JsValue) -> Result<ParsedShadows, WebError> {
    let json: serde_json::Value = serde_wasm_bindgen::from_value(value.clone())
        .map_err(|error| invalid(format!("shadows snapshot is malformed: {error}")))?;
    shadows_from_json(&json)
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct ShadowCaster {
    pub index: usize,
    pub id: u32,
    pub direction: [f32; 3],
}

pub(super) fn select_caster(state: &LightingState, ids: &[u32]) -> Option<ShadowCaster> {
    state
        .lights
        .iter()
        .enumerate()
        .find_map(|(index, light)| match light {
            Light::Directional(directional) if directional.enabled && directional.casts_shadow => {
                Some(ShadowCaster {
                    index,
                    id: ids.get(index).copied().unwrap_or(index as u32),
                    direction: directional.direction,
                })
            }
            _ => None,
        })
}

#[derive(Clone, Debug)]
pub(super) struct ShadowReportState {
    pub requested_filter: String,
    pub effective_filter: String,
    pub requested_map_size: u32,
    pub effective_map_size: u32,
    pub csm_enabled: bool,
    pub cascade_count: u32,
    pub moment_format: &'static str,
    pub caster_light_id: Option<u32>,
    pub reason: String,
}

impl ShadowReportState {
    #[cfg(target_arch = "wasm32")]
    pub(super) fn to_js(&self) -> JsValue {
        let object = js_sys::Object::new();
        let value: JsValue = object.into();
        let set = |name: &str, field: &JsValue| {
            super::device_health::set_js_property(&value, name, field);
        };
        set(
            "requestedFilter",
            &JsValue::from_str(&self.requested_filter),
        );
        set(
            "effectiveFilter",
            &JsValue::from_str(&self.effective_filter),
        );
        set(
            "requestedMapSize",
            &JsValue::from_f64(self.requested_map_size as f64),
        );
        set(
            "effectiveMapSize",
            &JsValue::from_f64(self.effective_map_size as f64),
        );
        set("csmEnabled", &JsValue::from_bool(self.csm_enabled));
        set(
            "cascadeCount",
            &JsValue::from_f64(self.cascade_count as f64),
        );
        set("momentFormat", &JsValue::from_str(self.moment_format));
        set(
            "casterLightId",
            &self
                .caster_light_id
                .map(|id| JsValue::from_f64(id as f64))
                .unwrap_or(JsValue::NULL),
        );
        set("reason", &JsValue::from_str(&self.reason));
        value
    }
}

fn shadow_map_size_ladder(requested: u32, policy: OverflowPolicy) -> Vec<u32> {
    match policy {
        OverflowPolicy::Reject => vec![requested],
        OverflowPolicy::Downscale => {
            let mut sizes = vec![requested];
            let mut size = requested;
            while size > SHADOW_MAP_MIN {
                size /= 2;
                sizes.push(size);
            }
            sizes
        }
    }
}

fn shadow_texture_bytes(map_size: u32, cascades: u32, moments: bool) -> Option<u64> {
    let texels = u64::from(map_size).checked_mul(u64::from(map_size))?;
    let layers = u64::from(cascades.max(1));
    let depth = texels.checked_mul(4)?.checked_mul(layers)?;
    let moment = if moments {
        texels.checked_mul(16)?.checked_mul(layers)?
    } else {
        0
    };
    let uniforms = (SHADOW_UNIFORM_BYTES as u64)
        .checked_add(layers.checked_mul(SHADOW_DEPTH_UNIFORM_BYTES as u64)?)?;
    depth.checked_add(moment)?.checked_add(uniforms)
}

/// Shadow resources share the group-3 environment bind group with IBL because
/// the minimum guaranteed maxBindGroups limit is four.
pub(super) fn shadow_layout_entries() -> [wgpu::BindGroupLayoutEntry; 5] {
    [
        wgpu::BindGroupLayoutEntry {
            binding: 5,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Depth,
                view_dimension: wgpu::TextureViewDimension::D2Array,
                multisampled: false,
            },
            count: None,
        },
        wgpu::BindGroupLayoutEntry {
            binding: 6,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Comparison),
            count: None,
        },
        wgpu::BindGroupLayoutEntry {
            binding: 7,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::NonFiltering),
            count: None,
        },
        wgpu::BindGroupLayoutEntry {
            binding: 8,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable: false },
                view_dimension: wgpu::TextureViewDimension::D2Array,
                multisampled: false,
            },
            count: None,
        },
        wgpu::BindGroupLayoutEntry {
            binding: 9,
            visibility: wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Uniform,
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        },
    ]
}

pub(super) struct ShadowResources {
    #[allow(dead_code)]
    depth_texture: wgpu::Texture,
    pub(super) depth_array_view: wgpu::TextureView,
    depth_layer_views: Vec<wgpu::TextureView>,
    #[allow(dead_code)]
    moment_texture: wgpu::Texture,
    pub(super) moment_view: wgpu::TextureView,
    pub(super) comparison_sampler: wgpu::Sampler,
    pub(super) plain_sampler: wgpu::Sampler,
    pub(super) uniform_buffer: wgpu::Buffer,
    cascade_buffers: Vec<wgpu::Buffer>,
    scene_depth_bind_groups: Vec<wgpu::BindGroup>,
    terrain_depth_bind_groups: Vec<wgpu::BindGroup>,
    scene_depth_pipeline: wgpu::RenderPipeline,
    terrain_depth_pipeline: wgpu::RenderPipeline,
    #[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
    terrain_screen_depth_pipeline: wgpu::RenderPipeline,
    #[allow(dead_code)]
    depth_layout: wgpu::BindGroupLayout,
    terrain_depth_layout: wgpu::BindGroupLayout,
    moment_pipeline: wgpu::ComputePipeline,
    moment_bind_group: wgpu::BindGroup,
    moments_uniform: wgpu::Buffer,
    pub(super) config: ShadowConfig,
    pub(super) csm: CsmConfig,
    effective_map_size: u32,
    pub(super) caster: Option<ShadowCaster>,
    report: ShadowReportState,
}

#[cfg(target_arch = "wasm32")]
impl ShadowResources {
    pub(super) fn disabled(context: &GpuContext) -> Self {
        Self::create(
            context,
            ShadowConfig::default(),
            CsmConfig::default(),
            SHADOW_MAP_MIN,
        )
    }

    fn create(context: &GpuContext, config: ShadowConfig, csm: CsmConfig, map_size: u32) -> Self {
        let device = &context.device;
        let cascade_count = if config.enabled {
            csm.effective_cascade_count()
        } else {
            1
        };

        let enabled = config.enabled;
        let (depth_size, layers) = if enabled {
            (map_size, cascade_count)
        } else {
            (1, 1)
        };
        let depth_texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("forge3d-shadow-depth"),
            size: wgpu::Extent3d {
                width: depth_size,
                height: depth_size,
                depth_or_array_layers: layers,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: SHADOW_DEPTH_FORMAT,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        let depth_array_view = depth_texture.create_view(&wgpu::TextureViewDescriptor {
            label: Some("forge3d-shadow-depth-array"),
            dimension: Some(wgpu::TextureViewDimension::D2Array),
            ..Default::default()
        });
        let depth_layer_views = (0..layers)
            .map(|layer| {
                depth_texture.create_view(&wgpu::TextureViewDescriptor {
                    label: Some("forge3d-shadow-depth-layer"),
                    dimension: Some(wgpu::TextureViewDimension::D2),
                    base_array_layer: layer,
                    array_layer_count: Some(1),
                    ..Default::default()
                })
            })
            .collect::<Vec<_>>();

        let moment_layers = layers;
        let moment_size = if enabled && config.requires_moments() {
            map_size
        } else {
            1
        };
        let moment_texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("forge3d-shadow-moments"),
            size: wgpu::Extent3d {
                width: moment_size,
                height: moment_size,
                depth_or_array_layers: moment_layers,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: SHADOW_MOMENT_FORMAT,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::STORAGE_BINDING,
            view_formats: &[],
        });
        let moment_view = moment_texture.create_view(&wgpu::TextureViewDescriptor {
            label: Some("forge3d-shadow-moment-array"),
            dimension: Some(wgpu::TextureViewDimension::D2Array),
            ..Default::default()
        });

        let comparison_sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("forge3d-shadow-compare"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Nearest,
            min_filter: wgpu::FilterMode::Nearest,
            mipmap_filter: wgpu::MipmapFilterMode::Nearest,
            compare: Some(wgpu::CompareFunction::LessEqual),
            ..Default::default()
        });
        let plain_sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("forge3d-shadow-plain"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Nearest,
            min_filter: wgpu::FilterMode::Nearest,
            mipmap_filter: wgpu::MipmapFilterMode::Nearest,
            ..Default::default()
        });

        let uniform_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("forge3d-shadow-uniform"),
            contents: bytemuck::bytes_of(&ShadowUniform::zeroed()),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });
        let cascade_buffers = (0..cascade_count)
            .map(|_| {
                device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("forge3d-shadow-cascade-uniform"),
                    contents: bytemuck::bytes_of(&shadowing::ShadowDepthUniform::zeroed()),
                    usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                })
            })
            .collect::<Vec<_>>();

        let depth_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("forge3d-shadow-scene-depth-layout"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            }],
        });
        let scene_depth_bind_groups = cascade_buffers
            .iter()
            .map(|buffer| {
                device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("forge3d-shadow-scene-depth-bind-group"),
                    layout: &depth_layout,
                    entries: &[wgpu::BindGroupEntry {
                        binding: 0,
                        resource: buffer.as_entire_binding(),
                    }],
                })
            })
            .collect::<Vec<_>>();

        let terrain_depth_layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("forge3d-shadow-terrain-depth-layout"),
                entries: &[
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::VERTEX,
                        ty: wgpu::BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Float { filterable: false },
                            view_dimension: wgpu::TextureViewDimension::D2,
                            multisampled: false,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 1,
                        visibility: wgpu::ShaderStages::VERTEX,
                        ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::NonFiltering),
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 2,
                        visibility: wgpu::ShaderStages::VERTEX,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 3,
                        visibility: wgpu::ShaderStages::VERTEX,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    },
                ],
            });

        let depth_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("forge3d-shadow-depth-shader"),
            source: wgpu::ShaderSource::Wgsl(SHADOW_DEPTH_SHADER.into()),
        });
        let scene_depth_layout_pipeline =
            device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("forge3d-shadow-scene-depth-pipeline-layout"),
                bind_group_layouts: &[Some(&depth_layout)],
                immediate_size: 0,
            });
        let depth_bias_state = wgpu::DepthBiasState {
            constant: (config.depth_bias * 16_777_216.0).round() as i32,
            slope_scale: config.slope_bias,
            clamp: 0.0,
        };
        let scene_depth_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("forge3d-shadow-scene-depth-pipeline"),
            layout: Some(&scene_depth_layout_pipeline),
            vertex: wgpu::VertexState {
                module: &depth_shader,
                entry_point: Some("vs_scene_depth"),
                compilation_options: wgpu::PipelineCompilationOptions::default(),
                buffers: &[wgpu::VertexBufferLayout {
                    array_stride: std::mem::size_of::<super::scene::LitVertex>()
                        as wgpu::BufferAddress,
                    step_mode: wgpu::VertexStepMode::Vertex,
                    attributes: &[wgpu::VertexAttribute {
                        offset: 0,
                        shader_location: 0,
                        format: wgpu::VertexFormat::Float32x3,
                    }],
                }],
            },
            fragment: None,
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
                strip_index_format: None,
                front_face: wgpu::FrontFace::Ccw,
                cull_mode: None,
                unclipped_depth: false,
                polygon_mode: wgpu::PolygonMode::Fill,
                conservative: false,
            },
            depth_stencil: Some(wgpu::DepthStencilState {
                format: SHADOW_DEPTH_FORMAT,
                depth_write_enabled: Some(true),
                depth_compare: Some(wgpu::CompareFunction::LessEqual),
                stencil: wgpu::StencilState::default(),
                bias: depth_bias_state,
            }),
            multisample: wgpu::MultisampleState::default(),
            multiview_mask: None,
            cache: None,
        });
        let terrain_depth_layout_pipeline =
            device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("forge3d-shadow-terrain-depth-pipeline-layout"),
                bind_group_layouts: &[Some(&terrain_depth_layout)],
                immediate_size: 0,
            });
        let terrain_depth_pipeline =
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("forge3d-shadow-terrain-depth-pipeline"),
                layout: Some(&terrain_depth_layout_pipeline),
                vertex: wgpu::VertexState {
                    module: &depth_shader,
                    entry_point: Some("vs_terrain_depth"),
                    compilation_options: wgpu::PipelineCompilationOptions::default(),
                    buffers: &[wgpu::VertexBufferLayout {
                        array_stride: std::mem::size_of::<super::terrain::TerrainVertex>()
                            as wgpu::BufferAddress,
                        step_mode: wgpu::VertexStepMode::Vertex,
                        attributes: &[
                            wgpu::VertexAttribute {
                                offset: 0,
                                shader_location: 0,
                                format: wgpu::VertexFormat::Float32x3,
                            },
                            wgpu::VertexAttribute {
                                offset: std::mem::size_of::<[f32; 3]>() as wgpu::BufferAddress,
                                shader_location: 1,
                                format: wgpu::VertexFormat::Float32x2,
                            },
                        ],
                    }],
                },
                fragment: None,
                primitive: wgpu::PrimitiveState {
                    topology: wgpu::PrimitiveTopology::TriangleList,
                    strip_index_format: None,
                    front_face: wgpu::FrontFace::Ccw,
                    cull_mode: None,
                    unclipped_depth: false,
                    polygon_mode: wgpu::PolygonMode::Fill,
                    conservative: false,
                },
                depth_stencil: Some(wgpu::DepthStencilState {
                    format: SHADOW_DEPTH_FORMAT,
                    depth_write_enabled: Some(true),
                    depth_compare: Some(wgpu::CompareFunction::LessEqual),
                    stencil: wgpu::StencilState::default(),
                    bias: depth_bias_state,
                }),
                multisample: wgpu::MultisampleState::default(),
                multiview_mask: None,
                cache: None,
            });
        // Historical native screen-mode caster state: back-face culling,
        // Less depth compare, and fixed hardware depth bias.
        let terrain_screen_depth_pipeline =
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("forge3d-shadow-terrain-screen-depth-pipeline"),
                layout: Some(&terrain_depth_layout_pipeline),
                vertex: wgpu::VertexState {
                    module: &depth_shader,
                    entry_point: Some("vs_terrain_depth"),
                    compilation_options: wgpu::PipelineCompilationOptions::default(),
                    buffers: &[wgpu::VertexBufferLayout {
                        array_stride: std::mem::size_of::<super::terrain::TerrainVertex>()
                            as wgpu::BufferAddress,
                        step_mode: wgpu::VertexStepMode::Vertex,
                        attributes: &[
                            wgpu::VertexAttribute {
                                offset: 0,
                                shader_location: 0,
                                format: wgpu::VertexFormat::Float32x3,
                            },
                            wgpu::VertexAttribute {
                                offset: std::mem::size_of::<[f32; 3]>() as wgpu::BufferAddress,
                                shader_location: 1,
                                format: wgpu::VertexFormat::Float32x2,
                            },
                        ],
                    }],
                },
                fragment: None,
                primitive: wgpu::PrimitiveState {
                    topology: wgpu::PrimitiveTopology::TriangleList,
                    strip_index_format: None,
                    front_face: wgpu::FrontFace::Ccw,
                    cull_mode: Some(wgpu::Face::Back),
                    unclipped_depth: false,
                    polygon_mode: wgpu::PolygonMode::Fill,
                    conservative: false,
                },
                depth_stencil: Some(wgpu::DepthStencilState {
                    format: SHADOW_DEPTH_FORMAT,
                    depth_write_enabled: Some(true),
                    depth_compare: Some(wgpu::CompareFunction::Less),
                    stencil: wgpu::StencilState::default(),
                    bias: wgpu::DepthBiasState {
                        constant: 2,
                        slope_scale: 2.0,
                        clamp: 0.0,
                    },
                }),
                multisample: wgpu::MultisampleState::default(),
                multiview_mask: None,
                cache: None,
            });

        let moment_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("forge3d-shadow-moments-layout"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Depth,
                        view_dimension: wgpu::TextureViewDimension::D2Array,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::StorageTexture {
                        access: wgpu::StorageTextureAccess::WriteOnly,
                        format: SHADOW_MOMENT_FORMAT,
                        view_dimension: wgpu::TextureViewDimension::D2Array,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
            ],
        });
        let moments_uniform = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("forge3d-shadow-moments-uniform"),
            contents: bytemuck::bytes_of(&[0u32; 4]),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });
        let moment_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("forge3d-shadow-moments-bind-group"),
            layout: &moment_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&depth_array_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(&moment_view),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: moments_uniform.as_entire_binding(),
                },
            ],
        });
        let moments_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("forge3d-shadow-moments-shader"),
            source: wgpu::ShaderSource::Wgsl(SHADOW_MOMENTS_SHADER.into()),
        });
        let moment_pipeline_layout =
            device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("forge3d-shadow-moments-pipeline-layout"),
                bind_group_layouts: &[Some(&moment_layout)],
                immediate_size: 0,
            });
        let moment_pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("forge3d-shadow-moments-pipeline"),
            layout: Some(&moment_pipeline_layout),
            module: &moments_shader,
            entry_point: Some("moments_encode"),
            compilation_options: wgpu::PipelineCompilationOptions::default(),
            cache: None,
        });

        let moment_format = if enabled && config.requires_moments() {
            "rgba32float"
        } else {
            "none"
        };
        Self {
            depth_texture,
            depth_array_view,
            depth_layer_views,
            moment_texture,
            moment_view,
            comparison_sampler,
            plain_sampler,
            uniform_buffer,
            cascade_buffers,
            scene_depth_bind_groups,
            terrain_depth_bind_groups: Vec::new(),
            scene_depth_pipeline,
            terrain_depth_pipeline,
            terrain_screen_depth_pipeline,
            depth_layout,
            terrain_depth_layout,
            moment_pipeline,
            moment_bind_group,
            moments_uniform,
            config,
            csm,
            effective_map_size: map_size,
            caster: None,
            report: ShadowReportState {
                requested_filter: config.filter.name().to_string(),
                effective_filter: config.filter.name().to_string(),
                requested_map_size: config.map_size,
                effective_map_size: map_size,
                csm_enabled: enabled && csm.enabled,
                cascade_count,
                moment_format,
                caster_light_id: None,
                reason: if enabled {
                    "requested configuration".to_string()
                } else {
                    "shadows disabled".to_string()
                },
            },
        }
    }

    pub(super) fn report(&self) -> &ShadowReportState {
        &self.report
    }

    fn effective_enabled(&self) -> bool {
        self.config.enabled && self.caster.is_some()
    }
}

impl ShadowResources {
    #[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
    pub(super) fn ledger_bytes(&self) -> Result<(u64, u64, u64), WebError> {
        shadow_ledger_bytes(
            &self.config,
            self.effective_map_size,
            self.cascade_buffers.len().max(1) as u32,
        )
    }
}

#[cfg(target_arch = "wasm32")]
pub(super) fn rebuild_terrain_depth_binding(runtime: &mut Forge3DRuntime) {
    let (Some(shadows), Some(terrain)) = (runtime.shadows.as_mut(), runtime.terrain.as_ref())
    else {
        return;
    };
    let Some(context) = runtime.context.as_ref() else {
        return;
    };
    let height_view = terrain
        .height_texture
        .create_view(&wgpu::TextureViewDescriptor {
            label: Some("forge3d-shadow-terrain-height"),
            dimension: Some(wgpu::TextureViewDimension::D2),
            ..Default::default()
        });
    shadows.terrain_depth_bind_groups = shadows
        .cascade_buffers
        .iter()
        .map(|buffer| {
            context
                .device
                .create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("forge3d-shadow-terrain-depth-bind-group"),
                    layout: &shadows.terrain_depth_layout,
                    entries: &[
                        wgpu::BindGroupEntry {
                            binding: 0,
                            resource: wgpu::BindingResource::TextureView(&height_view),
                        },
                        wgpu::BindGroupEntry {
                            binding: 1,
                            resource: wgpu::BindingResource::Sampler(&shadows.plain_sampler),
                        },
                        wgpu::BindGroupEntry {
                            binding: 2,
                            resource: terrain.params_buffer.as_entire_binding(),
                        },
                        wgpu::BindGroupEntry {
                            binding: 3,
                            resource: buffer.as_entire_binding(),
                        },
                    ],
                })
        })
        .collect();
}

#[cfg(target_arch = "wasm32")]
pub(super) struct PreparedShadowState {
    caster: Option<ShadowCaster>,
    matrices: Vec<[[f32; 4]; 4]>,
    uniform: ShadowUniform,
    moments_uniform: [u32; 4],
    reason: String,
}

#[cfg(target_arch = "wasm32")]
impl PreparedShadowState {
    pub(super) fn write(self, context: &GpuContext, shadows: &mut ShadowResources) {
        for (index, matrix) in self.matrices.iter().enumerate() {
            context.queue.write_buffer(
                &shadows.cascade_buffers[index],
                0,
                bytemuck::bytes_of(&shadowing::ShadowDepthUniform { matrix: *matrix }),
            );
        }
        context.queue.write_buffer(
            &shadows.uniform_buffer,
            0,
            bytemuck::bytes_of(&self.uniform),
        );
        context.queue.write_buffer(
            &shadows.moments_uniform,
            0,
            bytemuck::bytes_of(&self.moments_uniform),
        );
        shadows.caster = self.caster;
        // Disabled shadows cast from no light; match the scene-side report.
        shadows.report.caster_light_id = self
            .caster
            .filter(|_| shadows.config.enabled)
            .map(|caster| caster.id);
        shadows.report.reason = self.reason;
    }
}

#[cfg(target_arch = "wasm32")]
fn screen_terrain_light_matrix(
    terrain: &TerrainRenderResources,
    travel: [f32; 3],
) -> [[f32; 4]; 4] {
    // Historical native screen-mode light matrix: fixed Z-up terrain bounds,
    // independent of the camera; identical for every cascade.
    let span = terrain.params.spacing[0] * terrain.height_width.max(2).saturating_sub(1) as f32;
    let exaggeration = terrain.params.exaggeration;
    let light_dir = glam::Vec3::new(travel[0], -travel[2], travel[1]).normalize();
    let light_up = if light_dir.z.abs() > 0.99 {
        glam::Vec3::Y
    } else {
        glam::Vec3::Z
    };
    let half = span * 0.5;
    let terrain_min = glam::Vec3::new(-half, -half, 0.0);
    let terrain_max = glam::Vec3::new(half, half, exaggeration);
    let center = (terrain_min + terrain_max) * 0.5;
    let diagonal = (terrain_max - terrain_min).length();
    let eye = center - light_dir * (diagonal * 2.0);
    let view = glam::Mat4::look_to_rh(eye, light_dir, light_up);
    let mut light_min = glam::Vec3::splat(f32::MAX);
    let mut light_max = glam::Vec3::splat(f32::MIN);
    for cx in [terrain_min.x, terrain_max.x] {
        for cy in [terrain_min.y, terrain_max.y] {
            for cz in [terrain_min.z, terrain_max.z] {
                let corner = (view * glam::Vec4::new(cx, cy, cz, 1.0)).truncate();
                light_min = light_min.min(corner);
                light_max = light_max.max(corner);
            }
        }
    }
    let padding = span * 0.3;
    light_min -= glam::Vec3::splat(padding);
    light_max += glam::Vec3::splat(padding);
    let z_padding = span * 0.1;
    let near = -light_max.z - z_padding;
    let far = -light_min.z + z_padding;
    let projection = glam::Mat4::orthographic_rh(
        light_min.x,
        light_max.x,
        light_min.y,
        light_max.y,
        near,
        far,
    );
    (projection * view).to_cols_array_2d()
}

#[cfg(target_arch = "wasm32")]
pub(super) fn prepare_shadow_state(
    camera: &forge3d_core::camera::CameraInput,
    aspect: f32,
    lighting: &LightingState,
    light_ids: &[u32],
    shadows: &ShadowResources,
    terrain: Option<&TerrainRenderResources>,
) -> Result<PreparedShadowState, WebError> {
    let caster = select_caster(lighting, light_ids);
    let enabled = shadows.config.enabled && caster.is_some();
    let direction = caster
        .map(|caster| caster.direction)
        .unwrap_or([0.0, -1.0, 0.0]);
    let cascade_count = shadows.cascade_buffers.len().max(1);
    let mut effective_config = shadows.config;
    effective_config.map_size = shadows.effective_map_size;
    let splits = shadowing::shadow_split_distances(camera.near, camera.far, &shadows.csm)
        .map_err(map_core_error)?;
    let screen_terrain = terrain.filter(|terrain| terrain.render_mode == 1);
    let cascades = if enabled && screen_terrain.is_none() {
        shadowing::build_shadow_cascades(camera, aspect, direction, &effective_config, &shadows.csm)
            .map_err(map_core_error)?
    } else {
        Vec::new()
    };
    let mut matrices: Vec<[[f32; 4]; 4]> = cascades
        .iter()
        .map(|cascade| cascade.matrix)
        .chain(std::iter::repeat([[0.0; 4]; 4]))
        .take(cascade_count)
        .collect();
    if enabled {
        if let Some(terrain) = screen_terrain {
            let matrix = screen_terrain_light_matrix(terrain, direction);
            for slot in matrices.iter_mut() {
                *slot = matrix;
            }
        }
    }
    let uniform = shadowing::pack_shadow_uniform(
        &matrices,
        &splits,
        direction,
        &effective_config,
        &shadows.csm,
        enabled,
    );
    let moments_uniform = [
        shadows.config.filter.lane(),
        cascade_count as u32,
        shadows.config.evsm_positive_exponent.to_bits(),
        shadows.config.evsm_negative_exponent.to_bits(),
    ];
    let reason = if !shadows.config.enabled {
        "shadows disabled".to_string()
    } else if caster.is_none() {
        "no shadow-casting directional light".to_string()
    } else if shadows.effective_map_size != shadows.config.map_size {
        "memory budget".to_string()
    } else {
        "requested configuration".to_string()
    };
    Ok(PreparedShadowState {
        caster,
        matrices,
        uniform,
        moments_uniform,
        reason,
    })
}

#[cfg(target_arch = "wasm32")]
pub(super) fn refresh_shadow_state(runtime: &mut Forge3DRuntime) -> Result<(), WebError> {
    let prepared = {
        let (Some(shadows), Some(lighting)) = (runtime.shadows.as_ref(), runtime.lighting.as_ref())
        else {
            return Ok(());
        };
        let aspect = runtime.width as f32 / runtime.height.max(1) as f32;
        prepare_shadow_state(
            &runtime.camera,
            aspect,
            &lighting.state,
            &lighting.light_ids,
            shadows,
            runtime.terrain.as_ref(),
        )?
    };
    let (Some(shadows), Some(context)) = (runtime.shadows.as_mut(), runtime.context.as_ref())
    else {
        return Ok(());
    };
    prepared.write(context, shadows);
    Ok(())
}

#[cfg(target_arch = "wasm32")]
pub(super) fn encode_shadow_passes(runtime: &Forge3DRuntime, encoder: &mut wgpu::CommandEncoder) {
    let Some(shadows) = runtime.shadows.as_ref() else {
        return;
    };
    if !shadows.effective_enabled() {
        return;
    }
    let scene_buffer = runtime
        .scene
        .as_ref()
        .and_then(|scene| scene.world_vertex_buffer.as_ref());
    for (index, view) in shadows.depth_layer_views.iter().enumerate() {
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("forge3d-shadow-depth-pass"),
            color_attachments: &[],
            depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                view,
                depth_ops: Some(wgpu::Operations {
                    load: wgpu::LoadOp::Clear(1.0),
                    store: wgpu::StoreOp::Store,
                }),
                stencil_ops: None,
            }),
            occlusion_query_set: None,
            timestamp_writes: None,
            multiview_mask: None,
        });
        if let Some(buffer) = scene_buffer {
            let scene = runtime.scene.as_ref();
            pass.set_pipeline(&shadows.scene_depth_pipeline);
            pass.set_bind_group(0, &shadows.scene_depth_bind_groups[index], &[]);
            pass.set_vertex_buffer(0, buffer.slice(..));
            if let Some(scene) = scene {
                for range in &scene.world_ranges {
                    pass.draw(
                        range.first_vertex..range.first_vertex + range.vertex_count,
                        0..1,
                    );
                }
            }
        }
        if let Some(terrain) = runtime.terrain.as_ref() {
            if let Some(bind_group) = shadows.terrain_depth_bind_groups.get(index) {
                if terrain.render_mode == 1 {
                    pass.set_pipeline(&shadows.terrain_screen_depth_pipeline);
                } else {
                    pass.set_pipeline(&shadows.terrain_depth_pipeline);
                }
                pass.set_bind_group(0, bind_group, &[]);
                pass.set_vertex_buffer(0, terrain.vertex_buffer.slice(..));
                pass.set_index_buffer(terrain.index_buffer.slice(..), wgpu::IndexFormat::Uint32);
                pass.draw_indexed(0..terrain.index_count, 0, 0..1);
            }
        }
    }
    if shadows.config.requires_moments() {
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
            label: Some("forge3d-shadow-moments-pass"),
            timestamp_writes: None,
        });
        pass.set_pipeline(&shadows.moment_pipeline);
        pass.set_bind_group(0, &shadows.moment_bind_group, &[]);
        let workgroups = shadows.effective_map_size.div_ceil(8);
        pass.dispatch_workgroups(workgroups, workgroups, shadows.cascade_buffers.len() as u32);
    }
}

fn admit_shadow_map_size(
    memory: &super::memory::MemoryLedger,
    overflow_policy: OverflowPolicy,
    max_texture_dimension_2d: u32,
    parsed: &ParsedShadows,
) -> Result<u32, WebError> {
    if !parsed.config.enabled {
        return Ok(parsed.config.map_size);
    }
    let cascades = parsed.csm.effective_cascade_count();
    let moments = parsed.config.requires_moments();
    for size in shadow_map_size_ladder(parsed.config.map_size, overflow_policy) {
        if size > max_texture_dimension_2d {
            continue;
        }
        let bytes = shadow_texture_bytes(size, cascades, moments)
            .ok_or_else(|| resource_limit("shadow allocation size overflowed"))?;
        if memory.fits_after_release(
            &[SHADOW_DEPTH_KEY, SHADOW_MOMENTS_KEY, SHADOW_UNIFORMS_KEY],
            bytes,
        ) {
            return Ok(size);
        }
    }
    Err(resource_limit(format!(
        "shadow map size {} does not fit the memory budget",
        parsed.config.map_size
    )))
}

#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub(super) fn shadow_ledger_bytes(
    config: &ShadowConfig,
    map_size: u32,
    cascades: u32,
) -> Result<(u64, u64, u64), WebError> {
    let enabled = config.enabled;
    let (size, layers) = if enabled {
        (map_size, cascades.max(1))
    } else {
        (1, 1)
    };
    let texels = u64::from(size)
        .checked_mul(u64::from(size))
        .ok_or_else(|| resource_limit("shadow ledger bytes overflowed"))?;
    let depth = texels
        .checked_mul(4)
        .and_then(|value| value.checked_mul(u64::from(layers)))
        .ok_or_else(|| resource_limit("shadow ledger bytes overflowed"))?;
    let moment_size = if enabled && config.requires_moments() {
        size
    } else {
        1
    };
    let moments = u64::from(moment_size)
        .checked_mul(u64::from(moment_size))
        .and_then(|value| value.checked_mul(16))
        .and_then(|value| value.checked_mul(u64::from(layers)))
        .ok_or_else(|| resource_limit("shadow ledger bytes overflowed"))?;
    let uniforms = (SHADOW_UNIFORM_BYTES as u64)
        .checked_add(u64::from(layers) * SHADOW_DEPTH_UNIFORM_BYTES as u64)
        .and_then(|value| value.checked_add(16))
        .ok_or_else(|| resource_limit("shadow ledger bytes overflowed"))?;
    Ok((depth, moments, uniforms))
}

#[cfg(target_arch = "wasm32")]
pub(super) fn build_shadow_resources(
    context: &GpuContext,
    memory: &super::memory::MemoryLedger,
    overflow_policy: OverflowPolicy,
    max_texture_dimension_2d: u32,
    parsed: &ParsedShadows,
) -> Result<ShadowResources, WebError> {
    let map_size =
        admit_shadow_map_size(memory, overflow_policy, max_texture_dimension_2d, parsed)?;
    Ok(ShadowResources::create(
        context,
        parsed.config,
        parsed.csm,
        map_size,
    ))
}

pub(super) fn commit_shadows(runtime: &mut Forge3DRuntime, resources: ShadowResources) {
    runtime.shadows = Some(resources);
}

#[cfg(target_arch = "wasm32")]
pub(super) fn rebuild_environment_bind_group(runtime: &mut Forge3DRuntime, context: &GpuContext) {
    let (Some(ibl), Some(shadows)) = (runtime.ibl.as_mut(), runtime.shadows.as_ref()) else {
        return;
    };
    ibl.bind_group = context
        .device
        .create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("forge3d-environment-bind-group"),
            layout: &ibl.bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&ibl.specular_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(&ibl.irradiance_view),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::Sampler(&ibl.sampler),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::TextureView(&ibl.brdf_lut_view),
                },
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: ibl.uniform_buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 5,
                    resource: wgpu::BindingResource::TextureView(&shadows.depth_array_view),
                },
                wgpu::BindGroupEntry {
                    binding: 6,
                    resource: wgpu::BindingResource::Sampler(&shadows.comparison_sampler),
                },
                wgpu::BindGroupEntry {
                    binding: 7,
                    resource: wgpu::BindingResource::Sampler(&shadows.plain_sampler),
                },
                wgpu::BindGroupEntry {
                    binding: 8,
                    resource: wgpu::BindingResource::TextureView(&shadows.moment_view),
                },
                wgpu::BindGroupEntry {
                    binding: 9,
                    resource: shadows.uniform_buffer.as_entire_binding(),
                },
            ],
        });
}

#[cfg(target_arch = "wasm32")]
pub(super) fn rebind_shadow_dependents(runtime: &mut Forge3DRuntime, context: &GpuContext) {
    rebuild_environment_bind_group(runtime, context);
    if let (Some(scene), Some(textures), Some(ibl)) = (
        runtime.scene.as_mut(),
        runtime.textures.as_ref(),
        runtime.ibl.as_ref(),
    ) {
        scene.encode_bundles(context, textures, ibl);
    }
    rebuild_terrain_depth_binding(runtime);
}

#[cfg(target_arch = "wasm32")]
pub(super) fn apply_parsed_shadows(
    runtime: &mut Forge3DRuntime,
    parsed: &ParsedShadows,
) -> Result<(), WebError> {
    let context = runtime.context.clone().ok_or_else(|| {
        WebError::new(
            Forge3DErrorCode::RuntimeDisposed,
            "Runtime GPU context is not available",
        )
    })?;
    let mut planned = runtime.memory.clone();
    let resources = build_shadow_resources(
        &context,
        &planned,
        runtime.overflow_policy,
        runtime.max_texture_dimension_2d,
        parsed,
    )?;
    let (depth_bytes, moment_bytes, uniform_bytes) = resources.ledger_bytes()?;
    planned.replace(SHADOW_DEPTH_KEY, MemoryCategory::Textures, depth_bytes)?;
    planned.replace(SHADOW_MOMENTS_KEY, MemoryCategory::Textures, moment_bytes)?;
    planned.replace(SHADOW_UNIFORMS_KEY, MemoryCategory::Buffers, uniform_bytes)?;
    let prepared = match runtime.lighting.as_ref() {
        Some(lighting) => {
            let aspect = runtime.width as f32 / runtime.height.max(1) as f32;
            Some(prepare_shadow_state(
                &runtime.camera,
                aspect,
                &lighting.state,
                &lighting.light_ids,
                &resources,
                runtime.terrain.as_ref(),
            )?)
        }
        None => None,
    };
    runtime.memory = planned;
    let mut resources = resources;
    if let Some(prepared) = prepared {
        prepared.write(&context, &mut resources);
    }
    commit_shadows(runtime, resources);
    rebind_shadow_dependents(runtime, &context);
    Ok(())
}

#[cfg(target_arch = "wasm32")]
pub(super) fn set_shadows_runtime(
    runtime: &mut Forge3DRuntime,
    snapshot: JsValue,
) -> Result<(), WebError> {
    let parsed = shadows_from_js(&snapshot)?;
    apply_parsed_shadows(runtime, &parsed)
}

#[cfg(not(target_arch = "wasm32"))]
pub(super) struct PreparedShadowState;

#[cfg(not(target_arch = "wasm32"))]
impl PreparedShadowState {
    pub(super) fn write(
        self,
        context: &forge3d_core::gpu::GpuContext,
        shadows: &mut ShadowResources,
    ) {
        let _ = (context, shadows);
    }
}

#[cfg(not(target_arch = "wasm32"))]
pub(super) fn prepare_shadow_state(
    camera: &forge3d_core::camera::CameraInput,
    aspect: f32,
    lighting: &LightingState,
    light_ids: &[u32],
    shadows: &ShadowResources,
    terrain: Option<&TerrainRenderResources>,
) -> Result<PreparedShadowState, WebError> {
    let _ = (camera, aspect, lighting, light_ids, shadows, terrain);
    Err(WebError::new(
        Forge3DErrorCode::UnsupportedFeature,
        "Shadow commits are only available in wasm32 browser builds",
    ))
}

#[cfg(not(target_arch = "wasm32"))]
pub(super) fn build_shadow_resources(
    context: &forge3d_core::gpu::GpuContext,
    memory: &super::memory::MemoryLedger,
    overflow_policy: OverflowPolicy,
    max_texture_dimension_2d: u32,
    parsed: &ParsedShadows,
) -> Result<ShadowResources, WebError> {
    let _ = (
        context,
        memory,
        overflow_policy,
        max_texture_dimension_2d,
        parsed,
    );
    Err(WebError::new(
        Forge3DErrorCode::UnsupportedFeature,
        "Shadow commits are only available in wasm32 browser builds",
    ))
}

#[cfg(not(target_arch = "wasm32"))]
pub(super) fn rebind_shadow_dependents(
    runtime: &mut Forge3DRuntime,
    context: &forge3d_core::gpu::GpuContext,
) {
    let _ = (runtime, context);
}

#[cfg(not(target_arch = "wasm32"))]
pub(super) fn encode_shadow_passes(runtime: &Forge3DRuntime, encoder: &mut wgpu::CommandEncoder) {
    let _ = (runtime, encoder);
}

#[cfg(not(target_arch = "wasm32"))]
pub(super) fn set_shadows_runtime(
    runtime: &mut Forge3DRuntime,
    snapshot: wasm_bindgen::JsValue,
) -> Result<(), WebError> {
    let _ = (runtime, snapshot);
    Err(WebError::new(
        Forge3DErrorCode::UnsupportedFeature,
        "Shadow commits are only available in wasm32 browser builds",
    ))
}

#[cfg(not(target_arch = "wasm32"))]
pub(super) fn apply_parsed_shadows(
    runtime: &mut Forge3DRuntime,
    parsed: &ParsedShadows,
) -> Result<(), WebError> {
    let _ = (runtime, parsed);
    Ok(())
}

#[cfg(not(target_arch = "wasm32"))]
pub(super) fn rebuild_terrain_depth_binding(_runtime: &mut Forge3DRuntime) {}

#[cfg(not(target_arch = "wasm32"))]
pub(super) fn refresh_shadow_state(_runtime: &mut Forge3DRuntime) -> Result<(), WebError> {
    Ok(())
}

#[cfg(target_arch = "wasm32")]
pub(super) fn shadow_report_js(runtime: &Forge3DRuntime) -> JsValue {
    runtime
        .shadows
        .as_ref()
        .map(|shadows| shadows.report().to_js())
        .unwrap_or(JsValue::NULL)
}

#[cfg(not(target_arch = "wasm32"))]
pub(super) fn shadow_report_js(runtime: &Forge3DRuntime) -> JsValue {
    let _ = runtime;
    JsValue::NULL
}
