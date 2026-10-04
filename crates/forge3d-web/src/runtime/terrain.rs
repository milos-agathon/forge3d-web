use forge3d_core::gpu::GpuContext;
use forge3d_core::memory::{MemoryCategory, OverflowPolicy, QualityLevel};
use forge3d_core::terrain::{HeightfieldAoConfig, SunVisibilityConfig, TerrainDebugView};
use wasm_bindgen::prelude::*;
use wgpu::util::DeviceExt;

use super::memory::{
    downscaled_dimension, quality_ladder_from, quality_scale_percent, resample_heightmap,
    LedgerDowngrade,
};
use super::Forge3DRuntime;
use crate::error::{map_core_error, Forge3DErrorCode, WebError};
use crate::inputs::{
    CameraOptions, ResizeOptions, TerrainColorRampOptions, TerrainHeightmapOptions,
    TerrainPhysicalLimits,
};

pub(super) const TERRAIN_MESH_KEY: &str = "terrain:mesh";
pub(super) const TERRAIN_HEIGHTMAP_KEY: &str = "terrain:heightmap";
pub(super) const TERRAIN_UNIFORMS_KEY: &str = "terrain:uniforms";
pub(super) const TERRAIN_AO_KEY: &str = "terrain:height-ao";
pub(super) const TERRAIN_SUN_KEY: &str = "terrain:sun-visibility";
pub(super) const TERRAIN_ANALYSIS_FALLBACK_KEY: &str = "terrain:analysis-fallback";
pub(super) const TERRAIN_ANALYSIS_FALLBACK_BYTES: u64 = 4;
pub(super) const DEPTH_TEXTURE_KEY: &str = "depth";
// W08 (E0): fragment-visible sampled-texture budget. Outside W08 the terrain
// pipeline samples 11 textures (group 0 heightmap/AO/sun/material albedo+aux,
// the LTC LUT, the IBL and shadow maps); only a textured material 0 adds the
// five scene `TextureSet` textures of group 2. The W08 slots stack on top:
// the height page table (binding 13), then the overlay array (14), then the
// VT page table (17). Untextured terrain therefore fits every W08 slot in
// the WebGPU default of 16; textured terrain needs 17 / 18 / 19.
pub(super) const TERRAIN_BASE_SAMPLED_TEXTURES: u32 = 11;
pub(super) const TERRAIN_SCENE_TEXTURE_SLOTS: u32 = 5;
pub(super) const W08_SAMPLED_TEXTURES_CLIPMAP: u32 =
    TERRAIN_BASE_SAMPLED_TEXTURES + TERRAIN_SCENE_TEXTURE_SLOTS;
pub(super) const W08_STORAGE_BUFFERS_VT: u32 = 3;
pub(super) const W09_STORAGE_BUFFERS_VT_PROBES: u32 = 4;

/// Which stacked W08 group-0 slots a terrain pipeline profile can declare.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct W08Slots {
    /// Binding 13 (streamed height page table).
    pub(super) page_table: bool,
    /// Bindings 14-16 (overlay composite, sampler, uniform).
    pub(super) overlays: bool,
    /// Bindings 17-19 (VT page table, uniform, feedback ring).
    pub(super) vt: bool,
}

impl W08Slots {
    /// Slots that fit the negotiated limits for the untextured
    /// (`scene_textures == false`) or textured pipeline profile.
    pub(super) fn for_limits(sampled: u32, storage_buffers: u32, scene_textures: bool) -> Self {
        Self::for_limits_with_probes(sampled, storage_buffers, scene_textures, false)
    }

    pub(super) fn for_limits_with_probes(
        sampled: u32,
        storage_buffers: u32,
        scene_textures: bool,
        probes: bool,
    ) -> Self {
        let headroom = sampled.saturating_sub(Self::base(scene_textures));
        let vt_storage = if probes {
            W09_STORAGE_BUFFERS_VT_PROBES
        } else {
            W08_STORAGE_BUFFERS_VT
        };
        Self {
            page_table: headroom >= 1,
            overlays: headroom >= 2,
            vt: headroom >= 3 && storage_buffers >= vt_storage,
        }
    }

    pub(super) fn of_device(device: &wgpu::Device, scene_textures: bool, probes: bool) -> Self {
        let limits = device.limits();
        Self::for_limits_with_probes(
            limits.max_sampled_textures_per_shader_stage,
            limits.max_storage_buffers_per_shader_stage,
            scene_textures,
            probes,
        )
    }

    fn base(scene_textures: bool) -> u32 {
        TERRAIN_BASE_SAMPLED_TEXTURES
            + if scene_textures {
                TERRAIN_SCENE_TEXTURE_SLOTS
            } else {
                0
            }
    }

    /// Sampled-texture limit the `stack`-th W08 slot (1 = page table,
    /// 2 = overlays, 3 = VT) needs in the given profile.
    pub(super) fn required(scene_textures: bool, stack: u32) -> u32 {
        Self::base(scene_textures) + stack
    }

    /// Whether a group-0 binding belongs to this profile's layout.
    pub(super) fn keeps(self, binding: u32) -> bool {
        match binding {
            13 => self.page_table,
            14..=16 => self.overlays,
            17..=19 => self.vt,
            _ => true,
        }
    }
}

/// Typed `UNSUPPORTED_FEATURE` for a W08 feature the profile cannot bind.
pub(super) fn w08_limit_error(
    feature: &str,
    stack: u32,
    scene_textures: bool,
    sampled: u32,
    probes: bool,
) -> WebError {
    let storage = if stack == 3 {
        let required = if probes {
            W09_STORAGE_BUFFERS_VT_PROBES
        } else {
            W08_STORAGE_BUFFERS_VT
        };
        format!(" and maxStorageBuffersPerShaderStage >= {required}")
    } else {
        String::new()
    };
    let textured = if scene_textures {
        format!(
            " (terrain material 0 is textured, which binds {TERRAIN_SCENE_TEXTURE_SLOTS} more sampled textures)"
        )
    } else {
        String::new()
    };
    WebError::new(
        Forge3DErrorCode::UnsupportedFeature,
        format!(
            "{feature} requires maxSampledTexturesPerShaderStage >= {}{storage}, device has {sampled}{textured}",
            W08Slots::required(scene_textures, stack)
        ),
    )
}
pub(super) const TERRAIN_CLIPMAP_KEY: &str = "terrain:clipmap";
pub(super) const TERRAIN_HEIGHT_STREAM_KEY: &str = "terrain:height-stream";
pub(super) const TERRAIN_LOD_SELECT_KEY: &str = "terrain:lod-select";
pub(super) const TERRAIN_OVERLAYS_KEY: &str = "terrain:overlays";
pub(super) const TERRAIN_VT_KEY: &str = "terrain:vt";
pub(super) const TERRAIN_UNIFORM_BYTES: u64 = (std::mem::size_of::<CameraUniform>()
    + std::mem::size_of::<ColorRampUniform>()
    + std::mem::size_of::<TerrainParamsUniform>())
    as u64;
pub(super) const DEPTH_BYTES_PER_PIXEL: u64 = 4;

pub(super) fn depth_texture_bytes(width: u32, height: u32) -> Option<u64> {
    u64::from(width)
        .checked_mul(u64::from(height))
        .and_then(|pixels| pixels.checked_mul(DEPTH_BYTES_PER_PIXEL))
}

pub(super) fn analysis_texture_bytes(
    width: u32,
    height: u32,
    resolution_scale: f32,
) -> Option<u64> {
    let out_w = (width as f64 * resolution_scale as f64).round().max(1.0) as u64;
    let out_h = (height as f64 * resolution_scale as f64).round().max(1.0) as u64;
    out_w
        .checked_mul(out_h)
        .and_then(|pixels| pixels.checked_mul(4))
}

/// Pre-checked W08 ledger sizes of one terrain commit.
struct W08Bytes {
    clipmap: u64,
    height_stream: u64,
    lod_select: u64,
    overlays: u64,
    vt: u64,
}

impl W08Bytes {
    fn total(&self) -> u64 {
        self.clipmap
            .saturating_add(self.height_stream)
            .saturating_add(self.lod_select)
            .saturating_add(self.overlays)
            .saturating_add(self.vt)
    }
}

pub(super) fn terrain_memory_keys() -> [&'static str; 12] {
    [
        TERRAIN_MESH_KEY,
        TERRAIN_HEIGHTMAP_KEY,
        TERRAIN_UNIFORMS_KEY,
        TERRAIN_AO_KEY,
        TERRAIN_SUN_KEY,
        TERRAIN_ANALYSIS_FALLBACK_KEY,
        super::terrain_material::TERRAIN_MATERIAL_KEY,
        TERRAIN_CLIPMAP_KEY,
        TERRAIN_HEIGHT_STREAM_KEY,
        TERRAIN_LOD_SELECT_KEY,
        TERRAIN_OVERLAYS_KEY,
        TERRAIN_VT_KEY,
    ]
}

fn terrain_gpu_bytes(
    allocation: &crate::inputs::TerrainAllocation,
) -> Result<(u64, u64, u64), WebError> {
    let mesh = allocation
        .vertex_bytes
        .checked_add(allocation.index_bytes)
        .ok_or_else(|| {
            WebError::new(
                Forge3DErrorCode::ResourceLimitExceeded,
                "terrain mesh byte accounting overflowed",
            )
        })?;
    Ok((mesh, allocation.sample_bytes, TERRAIN_UNIFORM_BYTES))
}

fn terrain_total_bytes(
    allocation: &crate::inputs::TerrainAllocation,
    ao_bytes: u64,
    sun_bytes: u64,
) -> Result<u64, WebError> {
    let (mesh, texture, uniforms) = terrain_gpu_bytes(allocation)?;
    mesh.checked_add(texture)
        .and_then(|value| value.checked_add(uniforms))
        .and_then(|value| value.checked_add(ao_bytes))
        .and_then(|value| value.checked_add(sun_bytes))
        .and_then(|value| value.checked_add(TERRAIN_ANALYSIS_FALLBACK_BYTES))
        .ok_or_else(|| {
            WebError::new(
                Forge3DErrorCode::ResourceLimitExceeded,
                "terrain byte accounting overflowed",
            )
        })
}

fn analysis_output_bytes(
    config_enabled: bool,
    resolution_scale: f32,
    width: u32,
    height: u32,
) -> Result<u64, WebError> {
    if !config_enabled {
        return Ok(0);
    }
    analysis_texture_bytes(width, height, resolution_scale).ok_or_else(|| {
        WebError::new(
            Forge3DErrorCode::ResourceLimitExceeded,
            "terrain analysis byte accounting overflowed",
        )
    })
}

struct TerrainCandidate {
    options: TerrainHeightmapOptions,
    allocation: crate::inputs::TerrainAllocation,
    total_bytes: u64,
    ao_bytes: u64,
    sun_bytes: u64,
    effective_quality: QualityLevel,
    requested_bytes: u64,
}

fn select_terrain_candidate(
    runtime: &Forge3DRuntime,
    mut terrain: TerrainHeightmapOptions,
    height_ao: &HeightfieldAoConfig,
    sun_visibility: &SunVisibilityConfig,
) -> Result<TerrainCandidate, WebError> {
    let limits = TerrainPhysicalLimits {
        max_texture_dimension_2d: runtime.max_texture_dimension_2d,
        max_buffer_size: runtime.max_buffer_size,
    };
    // Clipmap geometry builds its own fixed-size mesh; committed heights for
    // streaming are the coarsest pyramid level and must not be resampled.
    let clipmap = terrain.geometry.as_ref().is_some_and(|geometry| {
        geometry.mode == Some(crate::inputs::TerrainGeometryModeOption::Clipmap)
    }) || terrain.streaming.is_some();
    let requested = runtime.requested_quality;
    let requested_allocation = crate::inputs::validate_terrain_allocation(
        terrain.width,
        terrain.height,
        terrain.heights.len(),
        limits,
        !clipmap,
    )?;
    let requested_bytes = terrain_total_bytes(
        &requested_allocation,
        analysis_output_bytes(
            height_ao.enabled,
            height_ao.resolution_scale,
            terrain.width,
            terrain.height,
        )?,
        analysis_output_bytes(
            sun_visibility.enabled,
            sun_visibility.resolution_scale,
            terrain.width,
            terrain.height,
        )?,
    )?;
    let ladder = quality_ladder_from(requested);
    let levels: &[QualityLevel] = match runtime.overflow_policy {
        OverflowPolicy::Reject => &ladder[..1],
        // Height payloads are never resampled under clipmap geometry: for
        // streaming they are the coarsest pyramid level.
        OverflowPolicy::Downscale if !clipmap => ladder,
        OverflowPolicy::Downscale => &ladder[..1],
    };
    for level in levels {
        let relative =
            quality_scale_percent(*level) as f64 / quality_scale_percent(requested) as f64;
        let (width, height) = if relative >= 1.0 {
            (terrain.width, terrain.height)
        } else {
            (
                downscaled_dimension(terrain.width, relative),
                downscaled_dimension(terrain.height, relative),
            )
        };
        let allocation = crate::inputs::validate_terrain_allocation(
            width,
            height,
            (width * height) as usize,
            limits,
            !clipmap,
        )?;
        let ao_bytes =
            analysis_output_bytes(height_ao.enabled, height_ao.resolution_scale, width, height)?;
        let sun_bytes = analysis_output_bytes(
            sun_visibility.enabled,
            sun_visibility.resolution_scale,
            width,
            height,
        )?;
        let total = terrain_total_bytes(&allocation, ao_bytes, sun_bytes)?;
        if runtime
            .memory
            .fits_after_release(&terrain_memory_keys(), total)
        {
            let (heights, spacing) = if relative >= 1.0 {
                (std::mem::take(&mut terrain.heights), terrain.spacing)
            } else {
                let scale_x = if terrain.width > 1 && width > 1 {
                    (terrain.width - 1) as f32 / (width - 1) as f32
                } else {
                    1.0
                };
                let scale_z = if terrain.height > 1 && height > 1 {
                    (terrain.height - 1) as f32 / (height - 1) as f32
                } else {
                    1.0
                };
                (
                    resample_heightmap(
                        &terrain.heights,
                        terrain.width,
                        terrain.height,
                        width,
                        height,
                    ),
                    terrain
                        .spacing
                        .map(|spacing| [spacing[0] * scale_x, spacing[1] * scale_z]),
                )
            };
            return Ok(TerrainCandidate {
                options: TerrainHeightmapOptions {
                    width,
                    height,
                    heights,
                    color_ramp: terrain.color_ramp.clone(),
                    spacing,
                    exaggeration: terrain.exaggeration,
                    domain: terrain.domain,
                    nodata: terrain.nodata,
                    crs: terrain.crs.clone(),
                    height_ao: terrain.height_ao.clone(),
                    sun_visibility: terrain.sun_visibility.clone(),
                    debug_view: terrain.debug_view,
                    render_mode: terrain.render_mode,
                    material: terrain.material.take(),
                    geometry: terrain.geometry.take(),
                    bounds: terrain.bounds,
                    streaming: terrain.streaming.take(),
                    overlays: terrain.overlays.take(),
                },
                allocation,
                total_bytes: total,
                ao_bytes,
                sun_bytes,
                effective_quality: *level,
                requested_bytes,
            });
        }
    }
    Err(WebError::new(
        Forge3DErrorCode::ResourceLimitExceeded,
        format!(
            "terrain requires {requested_bytes} bytes beyond the memory budget even at the lowest quality level"
        ),
    ))
}

pub(super) fn set_terrain_runtime(
    runtime: &mut Forge3DRuntime,
    terrain: JsValue,
) -> Result<(), WebError> {
    let terrain = TerrainHeightmapOptions::from_js_value_with_limits(
        terrain,
        crate::inputs::TerrainPhysicalLimits {
            max_texture_dimension_2d: runtime.max_texture_dimension_2d,
            max_buffer_size: runtime.max_buffer_size,
        },
    )?;
    set_terrain_options_runtime(runtime, terrain)
}

pub(super) fn set_terrain_options_runtime(
    runtime: &mut Forge3DRuntime,
    terrain: TerrainHeightmapOptions,
) -> Result<(), WebError> {
    let context = runtime.context.clone().ok_or_else(|| {
        WebError::new(
            Forge3DErrorCode::RuntimeDisposed,
            "Runtime GPU context is not available",
        )
    })?;
    let surface_format = runtime
        .surface_state
        .as_ref()
        .map(|state| state.config.format)
        .ok_or_else(|| {
            WebError::new(
                Forge3DErrorCode::RuntimeDisposed,
                "Runtime surface state is not available",
            )
        })?;

    let height_ao = terrain.height_ao.to_config()?;
    let sun_visibility = terrain.sun_visibility.to_config()?;
    let debug_view = terrain
        .debug_view
        .map(crate::inputs::TerrainDebugViewOption::to_core)
        .unwrap_or(TerrainDebugView::None);
    let features = super::shader_variants::runtime_terrain_lighting_features(runtime)?;
    let mut candidate = select_terrain_candidate(runtime, terrain, &height_ao, &sun_visibility)?;
    let color_ramp = candidate.options.color_ramp.clone();
    let material = candidate.options.material.take();
    let overlays_input = candidate.options.overlays.take();
    let validated = candidate.options.validate()?;
    // W08 (E0): the extended group-0 layout needs the negotiated
    // maxSampledTexturesPerShaderStage budget of this terrain's profile.
    let sampled = runtime.max_sampled_textures_per_shader_stage;
    let scene_textures = features.samples_scene_textures();
    let probes = features.probes();
    let slots = W08Slots::of_device(&context.device, scene_textures, probes);
    if validated.input.clipmap_geometry().is_some() && sampled < W08_SAMPLED_TEXTURES_CLIPMAP {
        return Err(WebError::new(
            Forge3DErrorCode::UnsupportedFeature,
            format!(
                "terrain clipmap requires maxSampledTexturesPerShaderStage >= {W08_SAMPLED_TEXTURES_CLIPMAP}, device has {sampled}"
            ),
        ));
    }
    if validated.input.streaming.is_some() && !slots.page_table {
        return Err(w08_limit_error(
            "terrain streaming",
            1,
            scene_textures,
            sampled,
            probes,
        ));
    }
    // W08 (E5): visible overlays need the extended sampled-texture budget;
    // disabled/invisible overlay inputs are no-ops and never gate.
    let overlay_settings = overlays_input
        .as_ref()
        .filter(|settings| settings.enabled && settings.has_visible_layers());
    if overlay_settings.is_some() && !slots.overlays {
        return Err(w08_limit_error(
            "terrain overlays",
            2,
            scene_textures,
            sampled,
            probes,
        ));
    }
    // W08 (E6): material VT — blocking diagnostics first (an invalid
    // declaration reports `vt_unsupported_family` etc. on every device),
    // then the capability gate; both reject before anything is allocated.
    let vt_settings = material
        .as_ref()
        .and_then(|options| options.virtual_texture.as_ref())
        .filter(|settings| settings.enabled);
    if let Some(settings) = vt_settings {
        let report = forge3d_core::terrain_vt::validate_terrain_vt_support(settings, None);
        if !report.diagnostics.is_empty() {
            let details = serde::Serialize::serialize(
                &vt_support_report_json(&report),
                &serde_wasm_bindgen::Serializer::json_compatible(),
            )
            .unwrap_or(JsValue::NULL);
            return Err(WebError::with_details(
                Forge3DErrorCode::UnsupportedFeature,
                format!(
                    "terrain virtual texturing has blocking diagnostics: {}",
                    report
                        .diagnostics
                        .iter()
                        .map(|diagnostic| {
                            format!("{} ({})", diagnostic.code, diagnostic.object_id)
                        })
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
                details,
            ));
        }
    }
    if vt_settings.is_some() && !slots.vt {
        return Err(w08_limit_error(
            "terrain virtual texturing",
            3,
            scene_textures,
            sampled,
            probes,
        ));
    }
    // W08 (E0): the streaming height atlas and the VT atlas are single 2D
    // textures; both must fit maxTextureDimension2D (typed
    // RESOURCE_LIMIT_EXCEEDED instead of a device validation error).
    if let Some(streaming) = validated.input.streaming.as_ref() {
        streaming
            .validate_atlas_dimension(runtime.max_texture_dimension_2d)
            .map_err(map_core_error)?;
    }
    if let Some(settings) = vt_settings {
        settings
            .validate_atlas_dimension(runtime.max_texture_dimension_2d)
            .map_err(map_core_error)?;
    }
    // Material textures take what the ledger can still admit after the
    // terrain; the core assembler halves them (not below 256) to fit.
    let material_budget = runtime
        .memory
        .budget_bytes()
        .saturating_sub(runtime.memory.current_bytes())
        .saturating_add(
            terrain_memory_keys()
                .iter()
                .filter_map(|key| runtime.memory.admitted_bytes(key))
                .sum::<u64>(),
        )
        .saturating_sub(candidate.total_bytes);
    let screen = validated.input.render_mode == forge3d_core::terrain::TerrainRenderMode::Screen;
    let material_plan = super::terrain_material::plan_material(
        material.as_ref(),
        screen,
        validated.input.domain,
        runtime.max_texture_dimension_2d,
        material_budget,
    );
    let material_bytes = material_plan.report.gpu_bytes;
    if !runtime.memory.fits_after_release(
        &terrain_memory_keys(),
        candidate.total_bytes.saturating_add(material_bytes),
    ) {
        return Err(WebError::new(
            Forge3DErrorCode::ResourceLimitExceeded,
            format!(
                "terrain material requires {material_bytes} bytes beyond the memory budget after the terrain"
            ),
        ));
    }
    // W08 (E5): plan the overlay composites with the terrain georeference.
    // Streamed heightfields resolve to the virtual finest dims (coarse
    // base x 2^(lod_count-1), capped by max_dim per the design).
    let overlay_plan = match overlay_settings {
        Some(settings) => {
            let georef = forge3d_core::terrain_overlay::TerrainGeoreference {
                crs: validated.input.crs.clone(),
                bounds: validated
                    .input
                    .bounds
                    .map(|b| [b[0] as f64, b[1] as f64, b[2] as f64, b[3] as f64]),
            };
            let (terrain_w, terrain_h) = match &validated.input.streaming {
                Some(streaming) => (
                    (u64::from(validated.input.width) << (streaming.lod_count - 1))
                        .min(u64::from(runtime.max_texture_dimension_2d))
                        as u32,
                    (u64::from(validated.input.height) << (streaming.lod_count - 1))
                        .min(u64::from(runtime.max_texture_dimension_2d))
                        as u32,
                ),
                None => (validated.input.width, validated.input.height),
            };
            let overlay_budget = material_budget.saturating_sub(material_bytes);
            let plan = forge3d_core::terrain_overlay::plan_overlays(
                settings,
                &georef,
                terrain_w,
                terrain_h,
                runtime.max_texture_dimension_2d,
                overlay_budget,
            )
            .map_err(map_core_error)?;
            (!plan.layers.is_empty()).then_some(plan)
        }
        None => None,
    };
    // W08 (E6): VT albedo runtime — the registry feeds prepared sources;
    // page-table layers = material_count x max_mip.
    let vt_plan = match vt_settings {
        Some(settings) => {
            let layer = settings.selected_layer().ok_or_else(|| {
                WebError::new(
                    Forge3DErrorCode::UnsupportedFeature,
                    "terrain virtual texturing requires the albedo family",
                )
            })?;
            let material_count = material
                .as_ref()
                .map(|options| options.settings.material_set.len() as u32)
                .unwrap_or(1)
                .max(1);
            let plan = super::terrain_vt::TerrainVtPlan::new(
                &runtime.vt_registry,
                layer,
                settings,
                material_count,
            )?;
            Some((plan, layer, settings))
        }
        None => None,
    };
    // W08 (E7): the clipmap mesh is CPU state; build it once here so its
    // buffer sizes join the pre-check.
    let clipmap_state = match validated.input.clipmap_geometry() {
        Some(geometry) => Some(super::terrain_w08::ClipmapGeometryState::new(
            geometry,
            &validated.input,
            [runtime.camera.position[0], runtime.camera.position[2]],
        )?),
        None => None,
    };
    // W08 pre-check: every W08 allocation is sized from the validated
    // inputs and admitted together with the terrain and material before
    // anything is created, so a rejected commit leaves the ledger and the
    // committed terrain exactly as they were.
    let (stream_bytes, lod_select_bytes) = match validated.input.streaming.as_ref() {
        Some(streaming) => (
            super::terrain_w08::streaming_gpu_bytes(streaming)?,
            super::terrain_w08::streaming_lod_select_gpu_bytes(streaming)?,
        ),
        None => (0, 0),
    };
    let w08_bytes = W08Bytes {
        clipmap: clipmap_state
            .as_ref()
            .map_or(0, super::terrain_w08::ClipmapGeometryState::gpu_bytes),
        height_stream: stream_bytes,
        lod_select: lod_select_bytes,
        overlays: overlay_plan
            .as_ref()
            .map_or(0, TerrainOverlayState::gpu_bytes_for),
        vt: vt_plan.as_ref().map_or(0, |(plan, _, _)| plan.gpu_bytes),
    };
    let required = candidate
        .total_bytes
        .saturating_add(material_bytes)
        .saturating_add(w08_bytes.total());
    if !runtime
        .memory
        .fits_after_release(&terrain_memory_keys(), required)
    {
        return Err(WebError::new(
            Forge3DErrorCode::ResourceLimitExceeded,
            format!(
                "terrain W08 resources (clipmap {}, height-stream {}, lod-select {}, overlays {}, vt {} bytes) exceed the memory budget after the terrain and material",
                w08_bytes.clipmap,
                w08_bytes.height_stream,
                w08_bytes.lod_select,
                w08_bytes.overlays,
                w08_bytes.vt,
            ),
        ));
    }
    let material_resources = super::terrain_material::TerrainMaterialResources::new(
        &context,
        material_plan,
        material.as_ref(),
        screen,
    );
    let overlays = overlay_plan.map(|plan| TerrainOverlayState::new(&context, plan));
    let vt = match vt_plan {
        Some((plan, layer, settings)) => Some(super::terrain_vt::TerrainVtState::new(
            &context, plan, layer, settings,
        )?),
        None => None,
    };
    let resources = TerrainRenderResources::new(
        &context,
        surface_format,
        &validated.input,
        &color_ramp,
        &height_ao,
        &sun_visibility,
        debug_view,
        runtime.clear_color,
        &runtime.camera,
        runtime.width,
        runtime.height,
        runtime.terrain_pipeline_cache.as_mut().ok_or_else(|| {
            WebError::new(
                Forge3DErrorCode::RuntimeDisposed,
                "Runtime terrain pipeline cache is not available",
            )
        })?,
        features,
        material_resources,
        overlays,
        vt,
        clipmap_state,
    )?;
    let (mesh_bytes, texture_bytes, uniform_bytes) = terrain_gpu_bytes(&candidate.allocation)?;
    // W08 (E7): clipmap mesh + geometry uniform + shadow proxy, streamed
    // atlas/page-table, and the LOD-select buffers all get their own ledger
    // keys. The committed dense base texture stays under
    // `terrain:heightmap` in streaming mode (it is the analysis/shadow
    // input); the streamed key covers the atlas + page table. The charges
    // are the pre-checked sizes (same functions), swapped in atomically.
    debug_assert_eq!(resources.clipmap_gpu_bytes(), w08_bytes.clipmap);
    debug_assert_eq!(resources.streaming_gpu_bytes(), w08_bytes.height_stream);
    debug_assert_eq!(resources.lod_select_gpu_bytes(), w08_bytes.lod_select);
    debug_assert_eq!(resources.overlay_gpu_bytes(), w08_bytes.overlays);
    debug_assert_eq!(resources.vt_gpu_bytes(), w08_bytes.vt);
    runtime.memory.replace_all(&[
        (TERRAIN_MESH_KEY, MemoryCategory::Buffers, mesh_bytes),
        (
            TERRAIN_HEIGHTMAP_KEY,
            MemoryCategory::Textures,
            texture_bytes,
        ),
        (TERRAIN_UNIFORMS_KEY, MemoryCategory::Buffers, uniform_bytes),
        (TERRAIN_AO_KEY, MemoryCategory::Textures, candidate.ao_bytes),
        (
            TERRAIN_SUN_KEY,
            MemoryCategory::Textures,
            candidate.sun_bytes,
        ),
        (
            TERRAIN_ANALYSIS_FALLBACK_KEY,
            MemoryCategory::Textures,
            TERRAIN_ANALYSIS_FALLBACK_BYTES,
        ),
        (
            super::terrain_material::TERRAIN_MATERIAL_KEY,
            MemoryCategory::Textures,
            material_bytes,
        ),
        (
            TERRAIN_CLIPMAP_KEY,
            MemoryCategory::Buffers,
            resources.clipmap_gpu_bytes(),
        ),
        (
            TERRAIN_HEIGHT_STREAM_KEY,
            MemoryCategory::Textures,
            resources.streaming_gpu_bytes(),
        ),
        (
            TERRAIN_LOD_SELECT_KEY,
            MemoryCategory::Buffers,
            resources.lod_select_gpu_bytes(),
        ),
        // W08 (E5/E6): overlay composite array + VT atlas/page-table.
        (
            TERRAIN_OVERLAYS_KEY,
            MemoryCategory::Textures,
            resources.overlay_gpu_bytes(),
        ),
        (
            TERRAIN_VT_KEY,
            MemoryCategory::Textures,
            resources.vt_gpu_bytes(),
        ),
    ])?;
    if candidate.effective_quality != runtime.requested_quality {
        runtime.memory.record_downgrade(LedgerDowngrade {
            requested: runtime.requested_quality,
            effective: candidate.effective_quality,
            requested_bytes: candidate.requested_bytes,
            admitted_bytes: candidate.total_bytes,
        });
    }
    runtime.terrain = Some(resources);
    super::shadows::rebuild_terrain_depth_binding(runtime);
    Ok(())
}

pub(super) fn set_camera_runtime(
    runtime: &mut Forge3DRuntime,
    camera: JsValue,
) -> Result<(), WebError> {
    let context = runtime.context.as_ref().ok_or_else(|| {
        WebError::new(
            Forge3DErrorCode::RuntimeDisposed,
            "Runtime GPU context is not available",
        )
    })?;

    let camera = CameraOptions::from_js_value(camera)?.validate()?;
    let prepared_shadows = match (runtime.shadows.as_ref(), runtime.lighting.as_ref()) {
        (Some(shadows), Some(lighting)) => {
            let aspect = runtime.width as f32 / runtime.height.max(1) as f32;
            Some(super::shadows::prepare_shadow_state(
                &camera,
                aspect,
                &lighting.state,
                &lighting.light_ids,
                shadows,
                runtime.terrain.as_ref(),
            )?)
        }
        _ => None,
    };
    if let Some(terrain) = runtime.terrain.as_ref() {
        terrain.update_camera(context, &camera, runtime.width, runtime.height)?;
    }
    if let Some(scene) = runtime.scene.as_ref() {
        scene.update_camera(context, &camera, runtime.width, runtime.height)?;
    }
    runtime.camera = camera;
    if let Some(e) = &runtime.environment {
        e.history_valid.set(false);
    }
    if let (Some(shadows), Some(prepared)) = (runtime.shadows.as_mut(), prepared_shadows) {
        prepared.write(context, shadows);
    }
    // Pick targets and highlight bounds contain pixels from the previous view.
    // Invalidate only after the complete camera update succeeds.
    super::vector::invalidate_pick(runtime);
    Ok(())
}

pub(super) fn resize_runtime(runtime: &mut Forge3DRuntime, size: JsValue) -> Result<(), WebError> {
    let context = runtime.context.clone().ok_or_else(|| {
        WebError::new(
            Forge3DErrorCode::RuntimeDisposed,
            "Runtime GPU context is not available",
        )
    })?;

    let (width, height) = ResizeOptions::from_js_value(size)?.pixel_size()?;
    if width > runtime.max_texture_dimension_2d || height > runtime.max_texture_dimension_2d {
        return Err(WebError::new(
            Forge3DErrorCode::ResourceLimitExceeded,
            format!(
                "canvas dimensions {width}x{height} exceed maxTextureDimension2D {}",
                runtime.max_texture_dimension_2d
            ),
        ));
    }
    let depth_bytes = depth_texture_bytes(width, height).ok_or_else(|| {
        WebError::new(
            Forge3DErrorCode::ResourceLimitExceeded,
            "depth texture byte accounting overflowed",
        )
    })?;
    if !runtime
        .memory
        .fits_after_release(&[DEPTH_TEXTURE_KEY], depth_bytes)
    {
        return Err(WebError::new(
            Forge3DErrorCode::ResourceLimitExceeded,
            format!("resized depth texture of {depth_bytes} bytes exceeds the memory budget"),
        ));
    }
    let prepared_shadows = match (runtime.shadows.as_ref(), runtime.lighting.as_ref()) {
        (Some(shadows), Some(lighting)) => {
            let aspect = width as f32 / height.max(1) as f32;
            Some(super::shadows::prepare_shadow_state(
                &runtime.camera,
                aspect,
                &lighting.state,
                &lighting.light_ids,
                shadows,
                runtime.terrain.as_ref(),
            )?)
        }
        _ => None,
    };
    let mut resized_memory = runtime.memory.clone();
    let environment_bytes = runtime
        .environment
        .as_ref()
        .map_or(0, |e| e.snapshot.gpu_bytes(width, height));
    resized_memory.replace_all(&[
        (
            super::vector::KEY,
            MemoryCategory::Textures,
            super::vector::texture_bytes(
                runtime.vectors.as_ref().map(|v| v.packet()),
                width,
                height,
            ),
        ),
        (
            super::vector::BUFFER_KEY,
            MemoryCategory::Buffers,
            super::vector::planned_bytes(
                runtime.vectors.as_ref().map(|v| v.packet()),
                width,
                height,
            ) - super::vector::texture_bytes(
                runtime.vectors.as_ref().map(|v| v.packet()),
                width,
                height,
            ),
        ),
        (DEPTH_TEXTURE_KEY, MemoryCategory::Textures, depth_bytes),
        (
            super::postfx::KEY,
            MemoryCategory::Textures,
            runtime.postfx.as_ref().map_or(0, |fx| {
                super::postfx::planned_bytes(
                    &fx.config,
                    width,
                    height,
                    runtime.environment.is_some(),
                    runtime.scatter.as_ref().is_some_and(|s| s.transparent()),
                )
            }),
        ),
        (
            super::environment::KEY,
            MemoryCategory::Textures,
            environment_bytes,
        ),
    ])?;
    let resized_vectors =
        super::vector::prepare_resize(runtime, &mut resized_memory, width, height)?;
    let resized_environment =
        super::environment::prepare_resize(runtime, width, height, &mut resized_memory)?;
    let resized_postfx = super::postfx::prepare_resize(runtime, width, height)?;
    let surface_state = runtime.surface_state.as_mut().ok_or_else(|| {
        WebError::new(
            Forge3DErrorCode::RuntimeDisposed,
            "Runtime surface state is not available",
        )
    })?;
    runtime.canvas.set_width(width);
    runtime.canvas.set_height(height);
    surface_state
        .resize(&context, width, height)
        .map_err(map_core_error)?;
    runtime.width = width;
    runtime.height = height;
    runtime.memory = resized_memory;
    runtime.environment = resized_environment;
    runtime.postfx = resized_postfx;
    runtime.vectors = resized_vectors;
    runtime.depth_attachment = Some(DepthAttachment::new(&context, width, height));
    runtime
        .memory
        .replace(DEPTH_TEXTURE_KEY, MemoryCategory::Textures, depth_bytes)?;

    if let Some(terrain) = runtime.terrain.as_ref() {
        terrain.update_camera(&context, &runtime.camera, width, height)?;
    }
    if let Some(scene) = runtime.scene.as_mut() {
        scene.update_camera(&context, &runtime.camera, width, height)?;
        if let (Some(textures), Some(ibl)) = (runtime.textures.as_ref(), runtime.ibl.as_ref()) {
            scene.rebuild_overlays(&context, textures, ibl, width, height);
        }
    }
    if let (Some(shadows), Some(prepared)) = (runtime.shadows.as_mut(), prepared_shadows) {
        prepared.write(&context, shadows);
    }
    Ok(())
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub(super) struct TerrainVertex {
    pub(super) position: [f32; 3],
    pub(super) uv: [f32; 2],
}

pub(super) const DEPTH_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Depth24Plus;

pub(super) struct DepthAttachment {
    #[allow(dead_code)]
    texture: wgpu::Texture,
    pub(super) view: wgpu::TextureView,
}

impl DepthAttachment {
    pub(super) fn new(context: &GpuContext, width: u32, height: u32) -> Self {
        let texture = context.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("forge3d-web-terrain-depth"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: DEPTH_FORMAT,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        Self { texture, view }
    }
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub(super) struct CameraUniform {
    pub(super) view_projection: [[f32; 4]; 4],
    pub(super) camera_position: [f32; 4],
    pub(super) camera_forward: [f32; 4],
}

const MAX_COLOR_RAMP_STOPS: usize = 8;
pub(super) const TERRAIN_SKIRT_DEPTH: f32 = 0.24;

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub(super) struct ColorRampUniform {
    pub(super) stops: [[f32; 4]; MAX_COLOR_RAMP_STOPS],
    pub(super) stop_count: u32,
    // WGSL uniform layout aligns the following vec3<u32> member to 16 bytes:
    // 128 bytes of stops + 4 stop-count bytes + 12 padding bytes + 16 clear-color bytes.
    pub(super) _stop_count_alignment_padding: [u32; 3],
    pub(super) clear_color: [f32; 4],
}

impl ColorRampUniform {
    fn from_options(options: &TerrainColorRampOptions, clear_color: [f32; 4]) -> Self {
        let mut stops = [[0.0; 4]; MAX_COLOR_RAMP_STOPS];
        for (index, stop) in options.stops.iter().take(MAX_COLOR_RAMP_STOPS).enumerate() {
            stops[index] = [stop.color[0], stop.color[1], stop.color[2], stop.position];
        }
        Self {
            stops,
            stop_count: options.stops.len().min(MAX_COLOR_RAMP_STOPS) as u32,
            _stop_count_alignment_padding: [0; 3],
            clear_color,
        }
    }
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub(super) struct TerrainParamsUniform {
    pub(super) spacing: [f32; 2],
    pub(super) exaggeration: f32,
    pub(super) domain_min: f32,
    pub(super) inv_domain_span: f32,
    pub(super) nodata_value: f32,
    pub(super) has_nodata: f32,
    pub(super) debug_view: u32,
    pub(super) render_mode: u32,
    pub(super) output_srgb: u32,
    pub(super) _padding: [u32; 2],
}

impl TerrainParamsUniform {
    fn from_input(
        terrain: &forge3d_core::terrain::TerrainHeightmapInput,
        debug_view: TerrainDebugView,
        surface_format: wgpu::TextureFormat,
    ) -> Self {
        Self {
            spacing: terrain.spacing,
            exaggeration: terrain.exaggeration,
            domain_min: terrain.domain[0],
            inv_domain_span: 1.0 / (terrain.domain[1] - terrain.domain[0]),
            nodata_value: terrain.nodata.unwrap_or(f32::NAN),
            has_nodata: if terrain.nodata.is_some_and(|value| !value.is_nan()) {
                1.0
            } else {
                0.0
            },
            debug_view: match debug_view {
                TerrainDebugView::None => 0,
                TerrainDebugView::HeightAo => 1,
                TerrainDebugView::SunVisibility => 2,
            },
            render_mode: match terrain.render_mode {
                forge3d_core::terrain::TerrainRenderMode::Perspective => 0,
                forge3d_core::terrain::TerrainRenderMode::Screen => 1,
            },
            output_srgb: u32::from(matches!(
                surface_format,
                wgpu::TextureFormat::Rgba8UnormSrgb | wgpu::TextureFormat::Bgra8UnormSrgb
            )),
            _padding: [0; 2],
        }
    }
}

pub(super) struct TerrainAnalysisOutput {
    pub(super) texture: wgpu::Texture,
    pub(super) view: wgpu::TextureView,
    pub(super) width: u32,
    pub(super) height: u32,
}

/// Group-0 layout for one pipeline profile, shared by the init-time
/// validation pipeline and every terrain bind group of that profile.
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub(super) fn terrain_bind_group_layout(
    device: &wgpu::Device,
    slots: W08Slots,
) -> wgpu::BindGroupLayout {
    let entries = terrain_layout_entries(slots);
    device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("forge3d-web-terrain-bind-group-layout"),
        entries: &entries,
    })
}

/// Group-0 layout entries for the W08 `slots` of a pipeline profile.
///
/// W08 (E0): binding 12 (`TerrainGeometryUniform`) is always present —
/// grid-mode bind groups fill it with a zeroed uniform so shaders never
/// read it — and the stacked W08 slots (13, 14-16, 17-19) are appended when
/// the profile's sampled-texture budget covers them.
pub(super) fn terrain_layout_entries(slots: W08Slots) -> Vec<wgpu::BindGroupLayoutEntry> {
    let material = super::terrain_material::material_layout_entries();
    let mut entries = vec![
        wgpu::BindGroupLayoutEntry {
            binding: 0,
            visibility: wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable: false },
                view_dimension: wgpu::TextureViewDimension::D2,
                multisampled: false,
            },
            count: None,
        },
        wgpu::BindGroupLayoutEntry {
            binding: 1,
            visibility: wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::NonFiltering),
            count: None,
        },
        wgpu::BindGroupLayoutEntry {
            binding: 2,
            visibility: wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Uniform,
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        },
        wgpu::BindGroupLayoutEntry {
            binding: 3,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Uniform,
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        },
        wgpu::BindGroupLayoutEntry {
            binding: 4,
            visibility: wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Uniform,
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        },
        wgpu::BindGroupLayoutEntry {
            binding: 5,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable: false },
                view_dimension: wgpu::TextureViewDimension::D2,
                multisampled: false,
            },
            count: None,
        },
        wgpu::BindGroupLayoutEntry {
            binding: 6,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable: false },
                view_dimension: wgpu::TextureViewDimension::D2,
                multisampled: false,
            },
            count: None,
        },
        material[0],
        material[1],
        material[2],
        material[3],
        material[4],
        // W08 (E2/E3): clipmap + streaming parameters. Always bound — a
        // zeroed uniform for plain grid inputs — so one layout serves every
        // terrain variant.
        wgpu::BindGroupLayoutEntry {
            binding: 12,
            visibility: wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Uniform,
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        },
    ];
    if slots.page_table {
        // W08 (E3): `height_page_table` — u32 array, one layer per lod. The
        // streaming-aware height helpers run in both vertex and fragment
        // code, so both stages need visibility.
        entries.push(wgpu::BindGroupLayoutEntry {
            binding: 13,
            visibility: wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Uint,
                view_dimension: wgpu::TextureViewDimension::D2Array,
                multisampled: false,
            },
            count: None,
        });
    }
    // W08 (E5): overlay composite texture + sampler + control/modes uniform
    // (bindings 14-16). Entries exist whenever the negotiated limit covers
    // them — off-by-default states bind 1x1 transparent fallbacks.
    if slots.overlays {
        entries.extend([
            wgpu::BindGroupLayoutEntry {
                binding: 14,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Float { filterable: true },
                    view_dimension: wgpu::TextureViewDimension::D2Array,
                    multisampled: false,
                },
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 15,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 16,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            },
        ]);
    }
    // W08 (E6): VT page table (unfilterable RGBA32Float), VT uniforms and
    // the fragment-written feedback ring (bindings 17-19).
    if slots.vt {
        entries.extend([
            wgpu::BindGroupLayoutEntry {
                binding: 17,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Float { filterable: false },
                    view_dimension: wgpu::TextureViewDimension::D2Array,
                    multisampled: false,
                },
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 18,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 19,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Storage { read_only: false },
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            },
        ]);
    }
    entries
}

/// Feature-specialized terrain pipelines for one runtime, keyed by shader
/// features and surface format. Init-time validation compiles the variant for
/// the default state; terrain commits and renders reuse or add variants.
///
/// Two pipeline profiles share the cache: *untextured* variants (material 0
/// has no scene textures) bind an empty group 2, which leaves room for every
/// W08 slot within the WebGPU default limit; *textured* variants bind the
/// scene `TextureSet` and a group 0 trimmed to the W08 slots that still fit.
pub(super) struct TerrainPipelineCache {
    /// Group 0 of the untextured profile.
    pub(super) bind_group_layout: wgpu::BindGroupLayout,
    /// W08 slots of the untextured profile.
    pub(super) slots: W08Slots,
    /// Group 0 of the textured profile when it differs from the untextured one.
    textured_bind_group_layout: wgpu::BindGroupLayout,
    /// W08 slots of the textured profile.
    pub(super) textured_slots: W08Slots,
    /// Probe variants reserve one additional fragment storage buffer.
    probe_bind_group_layout: wgpu::BindGroupLayout,
    probe_slots: W08Slots,
    probe_textured_bind_group_layout: wgpu::BindGroupLayout,
    probe_textured_slots: W08Slots,
    /// Empty group 2 bound by untextured variants.
    pub(super) empty_bind_group: wgpu::BindGroup,
    pipeline_layout: wgpu::PipelineLayout,
    textured_pipeline_layout: wgpu::PipelineLayout,
    probe_pipeline_layout: wgpu::PipelineLayout,
    probe_textured_pipeline_layout: wgpu::PipelineLayout,
    masked_layouts: Vec<wgpu::PipelineLayout>,
    variants: std::collections::HashMap<(u64, wgpu::TextureFormat), TerrainPipelineVariant>,
    /// Offline capture pipelines keyed by capture-specialized features.
    capture_variants:
        std::collections::HashMap<(u64, super::offline::CapturePass), wgpu::RenderPipeline>,
}

#[derive(Clone)]
pub(super) struct TerrainPipelineVariant {
    pub(super) features: ShaderFeatures,
    pub(super) pipeline: wgpu::RenderPipeline,
}

impl TerrainPipelineCache {
    #[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
    pub(super) fn new(
        device: &wgpu::Device,
        lighting_layout: &wgpu::BindGroupLayout,
        probe_lighting_layout: &wgpu::BindGroupLayout,
        texture_layout: &wgpu::BindGroupLayout,
        ibl_layout: &wgpu::BindGroupLayout,
    ) -> Self {
        let slots = W08Slots::of_device(device, false, false);
        let textured_slots = W08Slots::of_device(device, true, false);
        let probe_slots = W08Slots::of_device(device, false, true);
        let probe_textured_slots = W08Slots::of_device(device, true, true);
        let bind_group_layout = terrain_bind_group_layout(device, slots);
        let textured_bind_group_layout = terrain_bind_group_layout(device, textured_slots);
        let probe_bind_group_layout = terrain_bind_group_layout(device, probe_slots);
        let probe_textured_bind_group_layout =
            terrain_bind_group_layout(device, probe_textured_slots);
        let empty_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("forge3d-web-terrain-empty-group-layout"),
            entries: &[],
        });
        let empty_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("forge3d-web-terrain-empty-group"),
            layout: &empty_layout,
            entries: &[],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("forge3d-web-terrain-pipeline-layout"),
            bind_group_layouts: &[
                Some(&bind_group_layout),
                Some(lighting_layout),
                Some(&empty_layout),
                Some(ibl_layout),
            ],
            immediate_size: 0,
        });
        let textured_pipeline_layout =
            device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("forge3d-web-terrain-textured-pipeline-layout"),
                bind_group_layouts: &[
                    Some(&textured_bind_group_layout),
                    Some(lighting_layout),
                    Some(texture_layout),
                    Some(ibl_layout),
                ],
                immediate_size: 0,
            });
        let probe_pipeline_layout =
            device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("forge3d-web-terrain-probe-pipeline-layout"),
                bind_group_layouts: &[
                    Some(&probe_bind_group_layout),
                    Some(probe_lighting_layout),
                    Some(&empty_layout),
                    Some(ibl_layout),
                ],
                immediate_size: 0,
            });
        let probe_textured_pipeline_layout =
            device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("forge3d-web-terrain-probe-textured-pipeline-layout"),
                bind_group_layouts: &[
                    Some(&probe_textured_bind_group_layout),
                    Some(probe_lighting_layout),
                    Some(texture_layout),
                    Some(ibl_layout),
                ],
                immediate_size: 0,
            });
        let mut masked_layouts = Vec::new();
        for (group0, lights, textured) in [
            (&bind_group_layout, lighting_layout, false),
            (&textured_bind_group_layout, lighting_layout, true),
            (&probe_bind_group_layout, probe_lighting_layout, false),
            (
                &probe_textured_bind_group_layout,
                probe_lighting_layout,
                true,
            ),
        ] {
            for reflection in [false, true] {
                for aerial in [false, true] {
                    if reflection
                        && textured
                        && device.limits().max_sampled_textures_per_shader_stage < 20
                    {
                        masked_layouts.push(textured_pipeline_layout.clone());
                        continue;
                    }
                    let group2 = super::environment::reflection::masked_layout(
                        device, textured, reflection, aerial,
                    );
                    masked_layouts.push(device.create_pipeline_layout(
                        &wgpu::PipelineLayoutDescriptor {
                            label: Some("terrain-environment-pipeline-layout"),
                            bind_group_layouts: &[
                                Some(group0),
                                Some(lights),
                                Some(&group2),
                                Some(ibl_layout),
                            ],
                            immediate_size: 0,
                        },
                    ));
                }
            }
        }
        Self {
            masked_layouts,
            bind_group_layout,
            slots,
            textured_bind_group_layout,
            textured_slots,
            probe_bind_group_layout,
            probe_slots,
            probe_textured_bind_group_layout,
            probe_textured_slots,
            empty_bind_group,
            pipeline_layout,
            textured_pipeline_layout,
            probe_pipeline_layout,
            probe_textured_pipeline_layout,
            variants: std::collections::HashMap::new(),
            capture_variants: std::collections::HashMap::new(),
        }
    }

    /// Returns the capture pipeline for `features` (already carrying the
    /// terrain mode) and `pass`, compiling the capture variant on first use.
    #[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
    pub(super) fn capture_variant(
        &mut self,
        device: &wgpu::Device,
        features: ShaderFeatures,
        pass: super::offline::CapturePass,
    ) -> wgpu::RenderPipeline {
        let features = features.with_capture();
        let pipeline_layout = if features.masked_reflection() || features.aerial() {
            &self.masked_layouts[usize::from(features.probes()) * 8
                + usize::from(features.samples_scene_textures()) * 4
                + usize::from(features.masked_reflection()) * 2
                + usize::from(features.aerial())]
        } else {
            match (features.probes(), features.samples_scene_textures()) {
                (false, false) => &self.pipeline_layout,
                (false, true) => &self.textured_pipeline_layout,
                (true, false) => &self.probe_pipeline_layout,
                (true, true) => &self.probe_textured_pipeline_layout,
            }
        };
        self.capture_variants
            .entry((features.bits(), pass))
            .or_insert_with(|| {
                let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                    label: Some("forge3d-web-terrain-capture-shader"),
                    source: wgpu::ShaderSource::Wgsl(specialize(TERRAIN_SHADER, features).into()),
                });
                build_terrain_pipeline(
                    device,
                    pipeline_layout,
                    &shader,
                    pass.entry_point(),
                    &pass.color_targets_for(features.capture_blend()),
                )
            })
            .clone()
    }

    /// Group-0 layout and W08 slots of the profile `features` select.
    pub(super) fn group0_for(
        &self,
        features: ShaderFeatures,
    ) -> (&wgpu::BindGroupLayout, W08Slots) {
        match (features.probes(), features.samples_scene_textures()) {
            (false, false) => (&self.bind_group_layout, self.slots),
            (false, true) => (&self.textured_bind_group_layout, self.textured_slots),
            (true, false) => (&self.probe_bind_group_layout, self.probe_slots),
            (true, true) => (
                &self.probe_textured_bind_group_layout,
                self.probe_textured_slots,
            ),
        }
    }

    /// The textured profile's group-0 layout when it differs from the
    /// untextured one (a device that cannot fit every W08 slot next to the
    /// scene textures).
    pub(super) fn textured_group0(&self) -> Option<(&wgpu::BindGroupLayout, W08Slots)> {
        Some((&self.textured_bind_group_layout, self.textured_slots))
    }

    pub(super) fn probe_group0(&self, scene_textures: bool) -> (&wgpu::BindGroupLayout, W08Slots) {
        if scene_textures {
            (
                &self.probe_textured_bind_group_layout,
                self.probe_textured_slots,
            )
        } else {
            (&self.probe_bind_group_layout, self.probe_slots)
        }
    }

    /// Returns the pipeline for `features`, compiling it on first use.
    pub(super) fn variant(
        &mut self,
        device: &wgpu::Device,
        features: ShaderFeatures,
        surface_format: wgpu::TextureFormat,
    ) -> TerrainPipelineVariant {
        let pipeline_layout = if features.masked_reflection() || features.aerial() {
            &self.masked_layouts[usize::from(features.probes()) * 8
                + usize::from(features.samples_scene_textures()) * 4
                + usize::from(features.masked_reflection()) * 2
                + usize::from(features.aerial())]
        } else {
            match (features.probes(), features.samples_scene_textures()) {
                (false, false) => &self.pipeline_layout,
                (false, true) => &self.textured_pipeline_layout,
                (true, false) => &self.probe_pipeline_layout,
                (true, true) => &self.probe_textured_pipeline_layout,
            }
        };
        self.variants
            .entry((features.bits(), surface_format))
            .or_insert_with(|| {
                let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                    label: Some("forge3d-web-terrain-shader"),
                    source: wgpu::ShaderSource::Wgsl(specialize(TERRAIN_SHADER, features).into()),
                });
                let pipeline = create_terrain_render_pipeline(
                    device,
                    surface_format,
                    pipeline_layout,
                    &shader,
                );
                TerrainPipelineVariant { features, pipeline }
            })
            .clone()
    }
}

/// GPU buffers for the coarse proxy grid drawn by the shadow depth pass in
/// clipmap mode (E2); the dense clipmap mesh is never shadow-suitable.
pub(super) struct ShadowProxyMesh {
    #[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
    pub(super) vertex_buffer: wgpu::Buffer,
    #[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
    pub(super) index_buffer: wgpu::Buffer,
    #[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
    pub(super) index_count: u32,
    /// GPU bytes for `terrain:clipmap` ledger accounting.
    pub(super) bytes: u64,
}

/// WGSL `TerrainOverlayUniform` mirror (binding 16): 48 bytes.
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub(super) struct TerrainOverlayUniformGpu {
    /// [layer count, global opacity, 0, 0].
    pub control: [f32; 4],
    /// Blend-mode discriminant per layer lane (`array<vec4<u32>, 2>`).
    pub modes: [u32; 8],
}

impl TerrainOverlayUniformGpu {
    fn from_plan(plan: &forge3d_core::terrain_overlay::OverlayPlan) -> Self {
        let mut modes = [0u32; 8];
        for (index, layer) in plan.layers.iter().enumerate() {
            modes[index] = match layer.blend_mode {
                forge3d_core::terrain_overlay::OverlayBlendMode::Normal => 0,
                forge3d_core::terrain_overlay::OverlayBlendMode::Multiply => 1,
                forge3d_core::terrain_overlay::OverlayBlendMode::Overlay => 2,
            };
        }
        Self {
            control: [plan.layers.len() as f32, plan.global_opacity, 0.0, 0.0],
            modes,
        }
    }
}

/// W08 (E5): GPU block for the planned overlay stack — one RGBA8UnormSrgb
/// layer per planned composite at bindings 14/15/16.
pub(super) struct TerrainOverlayState {
    pub plan: forge3d_core::terrain_overlay::OverlayPlan,
    texture_view: wgpu::TextureView,
    sampler: wgpu::Sampler,
    uniform_buffer: wgpu::Buffer,
    /// Texture + uniform bytes (ledger `terrain:overlays`).
    gpu_bytes: u64,
}

impl TerrainOverlayState {
    fn new(context: &GpuContext, plan: forge3d_core::terrain_overlay::OverlayPlan) -> Self {
        let device = &context.device;
        let layers = plan.layers.len().max(1) as u32;
        let width = plan.width.max(1);
        let height = plan.height.max(1);
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("forge3d-web-terrain-overlays"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: layers,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8UnormSrgb,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        for (index, layer) in plan.layers.iter().enumerate() {
            let (data, pitch) =
                super::terrain_vt::pad_rows(&layer.rgba, width as usize * 4, height as usize);
            context.queue.write_texture(
                wgpu::TexelCopyTextureInfo {
                    texture: &texture,
                    mip_level: 0,
                    origin: wgpu::Origin3d {
                        x: 0,
                        y: 0,
                        z: index as u32,
                    },
                    aspect: wgpu::TextureAspect::All,
                },
                &data,
                wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(pitch),
                    rows_per_image: Some(height),
                },
                wgpu::Extent3d {
                    width,
                    height,
                    depth_or_array_layers: 1,
                },
            );
        }
        let texture_view = texture.create_view(&wgpu::TextureViewDescriptor {
            label: Some("forge3d-web-terrain-overlays"),
            dimension: Some(wgpu::TextureViewDimension::D2Array),
            ..Default::default()
        });
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("forge3d-web-terrain-overlay-sampler"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::MipmapFilterMode::Nearest,
            ..Default::default()
        });
        let uniform = TerrainOverlayUniformGpu::from_plan(&plan);
        let uniform_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("forge3d-web-terrain-overlay-uniform"),
            contents: bytemuck::bytes_of(&uniform),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        Self {
            gpu_bytes: Self::gpu_bytes_for(&plan),
            plan,
            texture_view,
            sampler,
            uniform_buffer,
        }
    }

    /// Texture + uniform bytes (ledger `terrain:overlays`).
    pub(super) fn gpu_bytes(&self) -> u64 {
        self.gpu_bytes
    }

    /// Ledger bytes a plan will allocate (commit pre-check).
    pub(super) fn gpu_bytes_for(plan: &forge3d_core::terrain_overlay::OverlayPlan) -> u64 {
        plan.gpu_bytes + std::mem::size_of::<TerrainOverlayUniformGpu>() as u64
    }
}

/// 1x1 transparent / zeroed fallbacks for the W08 binding slots the layout
/// exposes but this terrain does not use (grid + non-overlay/VT commits).
struct W08BindingFallbacks {
    overlay_view: Option<wgpu::TextureView>,
    overlay_sampler: Option<wgpu::Sampler>,
    overlay_uniform: Option<wgpu::Buffer>,
    vt_page_view: Option<wgpu::TextureView>,
    vt_uniform: Option<wgpu::Buffer>,
    vt_feedback: Option<wgpu::Buffer>,
    // Keeps the fallback textures alive (views hold refs but we keep the
    // handles for clarity).
    #[allow(dead_code)]
    overlay_texture: Option<wgpu::Texture>,
    #[allow(dead_code)]
    vt_page_texture: Option<wgpu::Texture>,
}

impl W08BindingFallbacks {
    fn new(device: &wgpu::Device, slots: W08Slots) -> Self {
        let (overlay_texture, overlay_view, overlay_sampler, overlay_uniform) = if slots.overlays {
            let texture = device.create_texture(&wgpu::TextureDescriptor {
                label: Some("forge3d-web-terrain-overlay-fallback"),
                size: wgpu::Extent3d {
                    width: 1,
                    height: 1,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8UnormSrgb,
                usage: wgpu::TextureUsages::TEXTURE_BINDING,
                view_formats: &[],
            });
            let view = texture.create_view(&wgpu::TextureViewDescriptor {
                dimension: Some(wgpu::TextureViewDimension::D2Array),
                ..Default::default()
            });
            let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
                label: Some("forge3d-web-terrain-overlay-fallback-sampler"),
                address_mode_u: wgpu::AddressMode::ClampToEdge,
                address_mode_v: wgpu::AddressMode::ClampToEdge,
                address_mode_w: wgpu::AddressMode::ClampToEdge,
                mag_filter: wgpu::FilterMode::Linear,
                min_filter: wgpu::FilterMode::Linear,
                ..Default::default()
            });
            let uniform = device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("forge3d-web-terrain-overlay-fallback-uniform"),
                size: std::mem::size_of::<TerrainOverlayUniformGpu>() as u64,
                usage: wgpu::BufferUsages::UNIFORM,
                mapped_at_creation: false,
            });
            (Some(texture), Some(view), Some(sampler), Some(uniform))
        } else {
            (None, None, None, None)
        };
        let (vt_page_texture, vt_page_view, vt_uniform, vt_feedback) = if slots.vt {
            let texture = device.create_texture(&wgpu::TextureDescriptor {
                label: Some("forge3d-web-terrain-vt-page-fallback"),
                size: wgpu::Extent3d {
                    width: 1,
                    height: 1,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba32Float,
                usage: wgpu::TextureUsages::TEXTURE_BINDING,
                view_formats: &[],
            });
            let view = texture.create_view(&wgpu::TextureViewDescriptor {
                dimension: Some(wgpu::TextureViewDimension::D2Array),
                ..Default::default()
            });
            let uniform = device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("forge3d-web-terrain-vt-fallback-uniform"),
                size: std::mem::size_of::<super::terrain_vt::TerrainVTUniformsGpu>() as u64,
                usage: wgpu::BufferUsages::UNIFORM,
                mapped_at_creation: false,
            });
            let feedback = device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("forge3d-web-terrain-vt-fallback-feedback"),
                size: 16,
                usage: wgpu::BufferUsages::STORAGE,
                mapped_at_creation: false,
            });
            (Some(texture), Some(view), Some(uniform), Some(feedback))
        } else {
            (None, None, None, None)
        };
        Self {
            overlay_view,
            overlay_sampler,
            overlay_uniform,
            vt_page_view,
            vt_uniform,
            vt_feedback,
            overlay_texture,
            vt_page_texture,
        }
    }
}

pub(super) struct TerrainRenderResources {
    pub(super) pipeline: wgpu::RenderPipeline,
    /// Shader features the current `pipeline` was specialized for.
    #[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
    pub(super) features: ShaderFeatures,
    pub(super) bind_group: wgpu::BindGroup,
    pub(super) vertex_buffer: wgpu::Buffer,
    pub(super) index_buffer: wgpu::Buffer,
    pub(super) index_count: u32,
    /// Vertex-buffer element count (clipmap mesh is constant-size; the
    /// layout update rewrites contents only).
    #[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
    pub(super) vertex_count: u32,
    pub(super) render_mode: u32,
    camera_buffer: wgpu::Buffer,
    #[allow(dead_code)]
    color_ramp_buffer: wgpu::Buffer,
    #[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
    pub(super) params_buffer: wgpu::Buffer,
    #[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
    pub(super) params: TerrainParamsUniform,
    pub(super) height_texture: wgpu::Texture,
    pub(super) height_width: u32,
    pub(super) height_height: u32,
    pub(super) heightfield_origin: [f32; 2],
    pub(super) ao_output: Option<TerrainAnalysisOutput>,
    pub(super) sun_output: Option<TerrainAnalysisOutput>,
    #[allow(dead_code)]
    analysis_fallback_view: wgpu::TextureView,
    #[allow(dead_code)]
    sampler: wgpu::Sampler,
    pub(super) material: super::terrain_material::TerrainMaterialResources,
    /// W08 (E2/E3): `TerrainGeometryUniform` at binding 12 — zeroed for
    /// plain grid terrain.
    geometry_buffer: wgpu::Buffer,
    /// Texture bound at binding 13 when the negotiated limit exposes it:
    /// the streaming page table, or a 1x1x1 fallback layer otherwise.
    #[allow(dead_code)]
    page_table_view: Option<wgpu::TextureView>,
    /// Keeps the fallback page-table texture alive.
    #[allow(dead_code)]
    page_table_fallback: Option<wgpu::Texture>,
    /// W08 clipmap mesh state; `RefCell` because camera updates rewrite the
    /// fixed-size vertex/index buffers through `&self`.
    pub(super) clipmap: Option<std::cell::RefCell<super::terrain_w08::ClipmapGeometryState>>,
    /// W08 streamed heightfield state (mosaic + atlas + LOD-select pass).
    pub(super) streaming: Option<super::terrain_w08::HeightStreamingState>,
    /// Coarse shadow-caster proxy used only in clipmap mode.
    pub(super) shadow_proxy: Option<ShadowProxyMesh>,
    /// W08 (E5): planned overlay composite state (bindings 14-16).
    pub(super) overlays: Option<TerrainOverlayState>,
    /// W08 (E6): material virtual texturing (bindings 8/9 atlas + 17-19).
    pub(super) vt: Option<super::terrain_vt::TerrainVtState>,
    /// Fallback resources for W08 binding slots the layout exposes but this
    /// commit does not use.
    w08_fallbacks: W08BindingFallbacks,
    /// Group 0 for textured variants when their layout drops W08 slots.
    textured_bind_group: Option<wgpu::BindGroup>,
    /// Group 0 for probe variants, whose lighting group consumes one more
    /// fragment-stage storage-buffer slot than the W08 baseline.
    probe_bind_group: wgpu::BindGroup,
    /// Group 0 for textured probe variants.
    probe_textured_bind_group: wgpu::BindGroup,
    /// Empty group 2 bound by untextured variants.
    empty_bind_group: wgpu::BindGroup,
}

impl TerrainRenderResources {
    /// Group-0 and group-2 bind groups for the active pipeline profile:
    /// textured variants bind `scene_textures` (the material-0 `TextureSet`),
    /// untextured variants an empty group 2.
    pub(super) fn profile_bind_groups<'a>(
        &'a self,
        scene_textures: &'a wgpu::BindGroup,
    ) -> (&'a wgpu::BindGroup, &'a wgpu::BindGroup) {
        match (
            self.features.probes(),
            self.features.samples_scene_textures(),
        ) {
            (false, false) => (&self.bind_group, &self.empty_bind_group),
            (false, true) => (
                self.textured_bind_group
                    .as_ref()
                    .unwrap_or(&self.bind_group),
                scene_textures,
            ),
            (true, false) => (&self.probe_bind_group, &self.empty_bind_group),
            (true, true) => (&self.probe_textured_bind_group, scene_textures),
        }
    }

    /// Refuses a material commit that would texture material 0 while this
    /// terrain uses W08 slots the textured profile cannot bind (the commit is
    /// rejected before anything changes).
    pub(super) fn check_material_textures(
        &self,
        device: &wgpu::Device,
        material0_flags: u32,
    ) -> Result<(), WebError> {
        if material0_flags & super::shader_variants::SCENE_TEXTURE_FLAGS == 0 {
            return Ok(());
        }
        if self.features.masked_reflection()
            && device.limits().max_sampled_textures_per_shader_stage < 20
        {
            return Err(WebError::new(
                Forge3DErrorCode::UnsupportedFeature,
                "textured masked-terrain reflections require 20 sampled textures",
            ));
        }
        let probes = self.features.probes();
        let slots = W08Slots::of_device(device, true, probes);
        let sampled = device.limits().max_sampled_textures_per_shader_stage;
        if self.streaming.is_some() && !slots.page_table {
            return Err(w08_limit_error(
                "terrain streaming",
                1,
                true,
                sampled,
                probes,
            ));
        }
        if self.overlays.is_some() && !slots.overlays {
            return Err(w08_limit_error(
                "terrain overlays",
                2,
                true,
                sampled,
                probes,
            ));
        }
        if self.vt.is_some() && !slots.vt {
            return Err(w08_limit_error(
                "terrain virtual texturing",
                3,
                true,
                sampled,
                probes,
            ));
        }
        Ok(())
    }

    /// Applies this terrain's mode, W08 geometry regions and material
    /// regions to `features`.
    pub(super) fn specialize(&self, features: ShaderFeatures) -> ShaderFeatures {
        features
            .with_terrain_mode(self.render_mode)
            .with_terrain_material(self.material.shader_enabled)
            .with_terrain_material_regions(self.material.regions)
            .with_terrain_w08(self.clipmap.is_some(), self.streaming.is_some())
            .with_terrain_w08_h2b(self.overlays.is_some(), self.vt.is_some())
    }

    #[allow(clippy::too_many_arguments)]
    fn new(
        context: &GpuContext,
        surface_format: wgpu::TextureFormat,
        terrain: &forge3d_core::terrain::TerrainHeightmapInput,
        color_ramp: &TerrainColorRampOptions,
        height_ao: &HeightfieldAoConfig,
        sun_visibility: &SunVisibilityConfig,
        debug_view: TerrainDebugView,
        clear_color: [f32; 4],
        camera: &forge3d_core::camera::CameraInput,
        width: u32,
        height: u32,
        pipeline_cache: &mut TerrainPipelineCache,
        features: ShaderFeatures,
        material: super::terrain_material::TerrainMaterialResources,
        overlays: Option<TerrainOverlayState>,
        vt: Option<super::terrain_vt::TerrainVtState>,
        clipmap_state: Option<super::terrain_w08::ClipmapGeometryState>,
    ) -> Result<Self, WebError> {
        // W08 (E0): commit-time capability checks against the negotiated
        // device limits; the layout only exposes the page-table binding when
        // the sampled-texture budget reached binding 13.
        let sampled_limit = context
            .device
            .limits()
            .max_sampled_textures_per_shader_stage;
        if clipmap_state.is_some() && sampled_limit < W08_SAMPLED_TEXTURES_CLIPMAP {
            return Err(WebError::new(
                Forge3DErrorCode::UnsupportedFeature,
                format!(
                    "terrain clipmap requires maxSampledTexturesPerShaderStage >= {W08_SAMPLED_TEXTURES_CLIPMAP}, device has {sampled_limit}"
                ),
            ));
        }
        let mut streaming_state = None;
        if let Some(streaming_config) = terrain.streaming.as_ref() {
            let scene_textures = features.samples_scene_textures();
            if !pipeline_cache.group0_for(features).1.page_table {
                return Err(w08_limit_error(
                    "terrain streaming",
                    1,
                    scene_textures,
                    sampled_limit,
                    features.probes(),
                ));
            }
            streaming_state = Some(super::terrain_w08::HeightStreamingState::new(
                context,
                terrain,
                streaming_config,
            )?);
        }

        let (vertex_buffer, index_buffer, index_count, vertex_count) =
            if let Some(clipmap) = &clipmap_state {
                // Fixed-size clipmap buffers; `update_layout` rewrites them
                // in place when the snapped ring centers move.
                let vertex_buffer =
                    context
                        .device
                        .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                            label: Some("forge3d-web-terrain-clipmap-vertices"),
                            contents: bytemuck::cast_slice(&clipmap.vertices),
                            usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
                        });
                let index_buffer =
                    context
                        .device
                        .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                            label: Some("forge3d-web-terrain-clipmap-indices"),
                            contents: bytemuck::cast_slice(&clipmap.indices),
                            usage: wgpu::BufferUsages::INDEX | wgpu::BufferUsages::COPY_DST,
                        });
                (
                    vertex_buffer,
                    index_buffer,
                    clipmap.indices.len() as u32,
                    clipmap.vertices.len() as u32,
                )
            } else {
                let (vb, ib, ic) = create_terrain_mesh_buffers(context, terrain)?;
                (vb, ib, ic, terrain.width.saturating_mul(terrain.height))
            };
        let (height_texture, height_view) = create_height_texture(context, terrain);
        let camera_uniform = create_camera_uniform(camera, width, height)?;
        let color_ramp_uniform = ColorRampUniform::from_options(color_ramp, clear_color);
        let params_uniform = TerrainParamsUniform::from_input(terrain, debug_view, surface_format);
        let camera_buffer = context
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("forge3d-web-terrain-camera-uniform"),
                contents: bytemuck::bytes_of(&camera_uniform),
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            });
        let color_ramp_buffer =
            context
                .device
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("forge3d-web-terrain-color-ramp-uniform"),
                    contents: bytemuck::bytes_of(&color_ramp_uniform),
                    usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                });
        let params_buffer = context
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("forge3d-web-terrain-params-uniform"),
                contents: bytemuck::bytes_of(&params_uniform),
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            });
        // W08 (E2/E3): binding 12 is unconditional — a zeroed uniform for
        // plain grid terrain so one layout serves every variant.
        let geometry_uniform = match &clipmap_state {
            Some(clipmap) => super::terrain_w08::TerrainGeometryUniform::for_input(
                terrain,
                clipmap,
                streaming_state.as_ref(),
            ),
            None => super::terrain_w08::TerrainGeometryUniform::grid(),
        };
        let geometry_buffer =
            context
                .device
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("forge3d-web-terrain-geometry-uniform"),
                    contents: bytemuck::bytes_of(&geometry_uniform),
                    usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                });
        // Binding 13 exists only when the negotiated limit exposes it; a
        // 1x1x1 u32 layer is bound when the layout has the slot but this
        // terrain is not streaming.
        let (page_table_view, page_table_fallback) = if pipeline_cache.slots.page_table {
            match &streaming_state {
                Some(stream) => (Some(stream.page_table_view.clone()), None),
                None => {
                    let texture = context.device.create_texture(&wgpu::TextureDescriptor {
                        label: Some("forge3d-web-terrain-page-table-fallback"),
                        size: wgpu::Extent3d {
                            width: 1,
                            height: 1,
                            depth_or_array_layers: 1,
                        },
                        mip_level_count: 1,
                        sample_count: 1,
                        dimension: wgpu::TextureDimension::D2,
                        format: wgpu::TextureFormat::R32Uint,
                        usage: wgpu::TextureUsages::TEXTURE_BINDING,
                        view_formats: &[],
                    });
                    let view = texture.create_view(&wgpu::TextureViewDescriptor {
                        dimension: Some(wgpu::TextureViewDimension::D2Array),
                        ..Default::default()
                    });
                    (Some(view), Some(texture))
                }
            }
        } else {
            (None, None)
        };
        // Clipmap shadows draw a coarse proxy grid (E2); the dense clipmap
        // mesh layout is not what `vs_terrain_depth` consumes.
        let shadow_proxy = clipmap_state.as_ref().map(|_| {
            let (vertices, indices) = super::terrain_w08::shadow_proxy_mesh(terrain);
            let vertex_buffer =
                context
                    .device
                    .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                        label: Some("forge3d-web-terrain-shadow-proxy-vertices"),
                        contents: bytemuck::cast_slice(&vertices),
                        usage: wgpu::BufferUsages::VERTEX,
                    });
            let index_buffer =
                context
                    .device
                    .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                        label: Some("forge3d-web-terrain-shadow-proxy-indices"),
                        contents: bytemuck::cast_slice(&indices),
                        usage: wgpu::BufferUsages::INDEX,
                    });
            ShadowProxyMesh {
                vertex_buffer,
                index_buffer,
                index_count: indices.len() as u32,
                bytes: (vertices.len() * std::mem::size_of::<TerrainVertex>()
                    + indices.len() * std::mem::size_of::<u32>()) as u64,
            }
        });
        let sampler = context.device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("forge3d-web-terrain-nearest-sampler"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Nearest,
            min_filter: wgpu::FilterMode::Nearest,
            mipmap_filter: wgpu::MipmapFilterMode::Nearest,
            ..wgpu::SamplerDescriptor::default()
        });
        let fallback = create_analysis_fallback_texture(context);
        let analysis_fallback_view = fallback.create_view(&wgpu::TextureViewDescriptor::default());
        let ao_output = if height_ao.enabled {
            Some(super::analysis::run_height_ao_pass(
                context,
                &height_view,
                terrain,
                height_ao,
            )?)
        } else {
            None
        };
        let sun_output = if sun_visibility.enabled {
            Some(super::analysis::run_sun_visibility_pass(
                context,
                &height_view,
                terrain,
                sun_visibility,
            )?)
        } else {
            None
        };
        let bind_group_layout = pipeline_cache.bind_group_layout.clone();
        let ao_view = ao_output
            .as_ref()
            .map(|output| &output.view)
            .unwrap_or(&analysis_fallback_view);
        let sun_view = sun_output
            .as_ref()
            .map(|output| &output.view)
            .unwrap_or(&analysis_fallback_view);
        let slots = pipeline_cache.slots;
        let has_overlay_bindings = slots.overlays;
        let has_vt_bindings = slots.vt;
        let w08_fallbacks = W08BindingFallbacks::new(&context.device, slots);
        // W08 (E6): under VT, bindings 8/9 are the atlas + VT sampler.
        let vt_binding = vt.as_ref().map(|vt| (&vt.atlas_view, &vt.atlas_sampler));
        let [m7, m8, m9, m10, m11] = material.bind_group_entries(vt_binding);
        // Binding 0 is the mosaic atlas under streaming (the committed dense
        // heights already live in its pinned coarsest slots); the dense
        // `height_texture` stays the analysis/AO input either way.
        let bound_height_view = streaming_state
            .as_ref()
            .map(|stream| &stream.atlas_view)
            .unwrap_or(&height_view);
        let mut terrain_entries = vec![
            m7,
            m8,
            m9,
            m10,
            m11,
            wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::TextureView(bound_height_view),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: wgpu::BindingResource::Sampler(&sampler),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: camera_buffer.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 3,
                resource: color_ramp_buffer.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 4,
                resource: params_buffer.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 5,
                resource: wgpu::BindingResource::TextureView(ao_view),
            },
            wgpu::BindGroupEntry {
                binding: 6,
                resource: wgpu::BindingResource::TextureView(sun_view),
            },
            wgpu::BindGroupEntry {
                binding: 12,
                resource: geometry_buffer.as_entire_binding(),
            },
        ];
        if let Some(view) = &page_table_view {
            terrain_entries.push(wgpu::BindGroupEntry {
                binding: 13,
                resource: wgpu::BindingResource::TextureView(view),
            });
        }
        // W08 (E5): overlay slots — the planned composite or the 1x1
        // transparent fallback (uniform layer count = 0).
        if has_overlay_bindings {
            let (view, sampler, uniform) = overlays
                .as_ref()
                .map(|state| (&state.texture_view, &state.sampler, &state.uniform_buffer))
                .or(
                    match (
                        &w08_fallbacks.overlay_view,
                        &w08_fallbacks.overlay_sampler,
                        &w08_fallbacks.overlay_uniform,
                    ) {
                        (Some(v), Some(s), Some(b)) => Some((v, s, b)),
                        _ => None,
                    },
                )
                .expect("overlay bindings exist in the layout");
            terrain_entries.extend([
                wgpu::BindGroupEntry {
                    binding: 14,
                    resource: wgpu::BindingResource::TextureView(view),
                },
                wgpu::BindGroupEntry {
                    binding: 15,
                    resource: wgpu::BindingResource::Sampler(sampler),
                },
                wgpu::BindGroupEntry {
                    binding: 16,
                    resource: uniform.as_entire_binding(),
                },
            ]);
        }
        // W08 (E6): VT slots — the committed VT block or the zeroed
        // fallback (config0.x = 0 disables the path).
        if has_vt_bindings {
            let (page_view, uniform, feedback) = vt
                .as_ref()
                .map(|state| {
                    (
                        &state.page_table_view,
                        &state.uniform_buffer,
                        &state.feedback_buffer,
                    )
                })
                .or(
                    match (
                        &w08_fallbacks.vt_page_view,
                        &w08_fallbacks.vt_uniform,
                        &w08_fallbacks.vt_feedback,
                    ) {
                        (Some(v), Some(u), Some(f)) => Some((v, u, f)),
                        _ => None,
                    },
                )
                .expect("vt bindings exist in the layout");
            terrain_entries.extend([
                wgpu::BindGroupEntry {
                    binding: 17,
                    resource: wgpu::BindingResource::TextureView(page_view),
                },
                wgpu::BindGroupEntry {
                    binding: 18,
                    resource: uniform.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 19,
                    resource: feedback.as_entire_binding(),
                },
            ]);
        }
        let create_profile_group =
            |label: &'static str, layout: &wgpu::BindGroupLayout, profile: W08Slots| {
                let entries = terrain_entries
                    .iter()
                    .filter(|entry| profile.keeps(entry.binding))
                    .cloned()
                    .collect::<Vec<_>>();
                context
                    .device
                    .create_bind_group(&wgpu::BindGroupDescriptor {
                        label: Some(label),
                        layout,
                        entries: &entries,
                    })
            };
        let bind_group =
            create_profile_group("forge3d-web-terrain-bind-group", &bind_group_layout, slots);
        // Each profile owns a group 0 whose W08 bindings match the storage
        // and sampled-texture budget of its pipeline layout.
        let textured_bind_group = pipeline_cache.textured_group0().map(|(layout, profile)| {
            create_profile_group("forge3d-web-terrain-textured-bind-group", layout, profile)
        });
        let (probe_layout, probe_profile) = pipeline_cache.probe_group0(false);
        let probe_bind_group = create_profile_group(
            "forge3d-web-terrain-probe-bind-group",
            probe_layout,
            probe_profile,
        );
        let (probe_textured_layout, probe_textured_profile) = pipeline_cache.probe_group0(true);
        let probe_textured_bind_group = create_profile_group(
            "forge3d-web-terrain-probe-textured-bind-group",
            probe_textured_layout,
            probe_textured_profile,
        );
        let variant = pipeline_cache.variant(
            &context.device,
            features
                .with_terrain_mode(match terrain.render_mode {
                    forge3d_core::terrain::TerrainRenderMode::Perspective => 0,
                    forge3d_core::terrain::TerrainRenderMode::Screen => 1,
                })
                .with_terrain_material(material.shader_enabled)
                .with_terrain_material_regions(material.regions)
                .with_terrain_w08(clipmap_state.is_some(), streaming_state.is_some())
                .with_terrain_w08_h2b(overlays.is_some(), vt.is_some()),
            surface_format,
        );

        Ok(Self {
            pipeline: variant.pipeline,
            features: variant.features,
            bind_group,
            vertex_buffer,
            index_buffer,
            index_count,
            vertex_count,
            render_mode: match terrain.render_mode {
                forge3d_core::terrain::TerrainRenderMode::Perspective => 0,
                forge3d_core::terrain::TerrainRenderMode::Screen => 1,
            },
            camera_buffer,
            color_ramp_buffer,
            params_buffer,
            params: params_uniform,
            height_texture,
            height_width: terrain.width,
            height_height: terrain.height,
            heightfield_origin: terrain.heightfield_origin(),
            ao_output,
            sun_output,
            analysis_fallback_view,
            sampler,
            material,
            geometry_buffer,
            page_table_view,
            page_table_fallback,
            clipmap: clipmap_state.map(std::cell::RefCell::new),
            streaming: streaming_state,
            shadow_proxy,
            overlays,
            vt,
            w08_fallbacks,
            textured_bind_group,
            probe_bind_group,
            probe_textured_bind_group,
            empty_bind_group: pipeline_cache.empty_bind_group.clone(),
        })
    }

    fn update_camera(
        &self,
        context: &GpuContext,
        camera: &forge3d_core::camera::CameraInput,
        width: u32,
        height: u32,
    ) -> Result<(), WebError> {
        let uniform = create_camera_uniform(camera, width, height)?;
        context
            .queue
            .write_buffer(&self.camera_buffer, 0, bytemuck::bytes_of(&uniform));
        // W08 (E2): snap clipmap ring centers to the camera; the fixed-size
        // vertex/index buffers are rewritten in place on change.
        if let Some(clipmap) = &self.clipmap {
            let camera_xz = [camera.position[0], camera.position[2]];
            if let Some((vertices, indices)) = clipmap.borrow_mut().update_layout(camera_xz) {
                context
                    .queue
                    .write_buffer(&self.vertex_buffer, 0, bytemuck::cast_slice(vertices));
                context
                    .queue
                    .write_buffer(&self.index_buffer, 0, bytemuck::cast_slice(indices));
            }
        }
        // W08 (E4): LOD-select params follow the display camera.
        if let Some(streaming) = &self.streaming {
            if let Some(lod_select) = &streaming.lod_select {
                let aspect = width.max(1) as f32 / height.max(1) as f32;
                let max_lod = streaming.pyramid.lod_count() - 1;
                lod_select.update_params(context, camera, height.max(1) as f32, max_lod, aspect)?;
            }
        }
        Ok(())
    }

    /// Group-0 bind group identical to `bind_group` except for the camera
    /// uniform, which is the offline capture camera (`CaptureCameraUniform`).
    #[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
    pub(super) fn capture_bind_group(
        &self,
        device: &wgpu::Device,
        (layout, profile): (&wgpu::BindGroupLayout, W08Slots),
        camera_buffer: &wgpu::Buffer,
    ) -> wgpu::BindGroup {
        // Streaming terrain binds the mosaic atlas, matching `bind_group`.
        let fallback_height_view;
        let height_view = if let Some(streaming) = &self.streaming {
            &streaming.atlas_view
        } else {
            fallback_height_view = self
                .height_texture
                .create_view(&wgpu::TextureViewDescriptor::default());
            &fallback_height_view
        };
        let ao_view = self
            .ao_output
            .as_ref()
            .map(|output| &output.view)
            .unwrap_or(&self.analysis_fallback_view);
        let sun_view = self
            .sun_output
            .as_ref()
            .map(|output| &output.view)
            .unwrap_or(&self.analysis_fallback_view);
        let vt_binding = self
            .vt
            .as_ref()
            .map(|vt| (&vt.atlas_view, &vt.atlas_sampler));
        let [m7, m8, m9, m10, m11] = self.material.bind_group_entries(vt_binding);
        let mut entries = vec![
            m7,
            m8,
            m9,
            m10,
            m11,
            wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::TextureView(height_view),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: wgpu::BindingResource::Sampler(&self.sampler),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: camera_buffer.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 3,
                resource: self.color_ramp_buffer.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 4,
                resource: self.params_buffer.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 5,
                resource: wgpu::BindingResource::TextureView(ao_view),
            },
            wgpu::BindGroupEntry {
                binding: 6,
                resource: wgpu::BindingResource::TextureView(sun_view),
            },
            wgpu::BindGroupEntry {
                binding: 12,
                resource: self.geometry_buffer.as_entire_binding(),
            },
        ];
        if let Some(view) = &self.page_table_view {
            entries.push(wgpu::BindGroupEntry {
                binding: 13,
                resource: wgpu::BindingResource::TextureView(view),
            });
        }
        if profile.overlays {
            let (view, sampler, uniform) = self
                .overlays
                .as_ref()
                .map(|state| (&state.texture_view, &state.sampler, &state.uniform_buffer))
                .or(
                    match (
                        &self.w08_fallbacks.overlay_view,
                        &self.w08_fallbacks.overlay_sampler,
                        &self.w08_fallbacks.overlay_uniform,
                    ) {
                        (Some(v), Some(s), Some(b)) => Some((v, s, b)),
                        _ => None,
                    },
                )
                .expect("overlay bindings exist in the layout");
            entries.extend([
                wgpu::BindGroupEntry {
                    binding: 14,
                    resource: wgpu::BindingResource::TextureView(view),
                },
                wgpu::BindGroupEntry {
                    binding: 15,
                    resource: wgpu::BindingResource::Sampler(sampler),
                },
                wgpu::BindGroupEntry {
                    binding: 16,
                    resource: uniform.as_entire_binding(),
                },
            ]);
        }
        if profile.vt {
            let (page_view, uniform, feedback) = self
                .vt
                .as_ref()
                .map(|state| {
                    (
                        &state.page_table_view,
                        &state.uniform_buffer,
                        &state.feedback_buffer,
                    )
                })
                .or(
                    match (
                        &self.w08_fallbacks.vt_page_view,
                        &self.w08_fallbacks.vt_uniform,
                        &self.w08_fallbacks.vt_feedback,
                    ) {
                        (Some(v), Some(u), Some(f)) => Some((v, u, f)),
                        _ => None,
                    },
                )
                .expect("vt bindings exist in the layout");
            entries.extend([
                wgpu::BindGroupEntry {
                    binding: 17,
                    resource: wgpu::BindingResource::TextureView(page_view),
                },
                wgpu::BindGroupEntry {
                    binding: 18,
                    resource: uniform.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 19,
                    resource: feedback.as_entire_binding(),
                },
            ]);
        }
        entries.retain(|entry| profile.keeps(entry.binding));
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("forge3d-web-terrain-capture-bind-group"),
            layout,
            entries: &entries,
        })
    }

    /// Points `pipeline` at the cached variant for `features` and `surface_format`.
    #[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
    pub(super) fn use_variant(
        &mut self,
        context: &GpuContext,
        cache: &mut TerrainPipelineCache,
        features: ShaderFeatures,
        surface_format: wgpu::TextureFormat,
    ) {
        let variant = cache.variant(&context.device, self.specialize(features), surface_format);
        self.pipeline = variant.pipeline;
        self.features = variant.features;
    }

    // -------------------------------------------------------------------
    // W08 (E7): geometry report, streaming wasm API, frame hooks, ledger.
    // -------------------------------------------------------------------

    /// `getTerrainGeometryReport` (E2/E7). Grid inputs report their dense
    /// dims with `triangleBudget == triangleCount`; clipmap inputs report
    /// the A1/A7 fields (ring config, snapped centers, budget, reduction).
    pub(super) fn geometry_report(&self) -> JsValue {
        use super::device_health::set_js_property;
        let report = js_sys::Object::new();
        let render_mode = if self.render_mode == 1 {
            "screen"
        } else {
            "perspective"
        };
        set_js_property(&report, "renderMode", &JsValue::from_str(render_mode));
        if let Some(clipmap) = &self.clipmap {
            let clipmap = clipmap.borrow();
            set_js_property(&report, "mode", &JsValue::from_str("clipmap"));
            set_js_property(
                &report,
                "ringCount",
                &JsValue::from_f64(clipmap.config.ring_count as f64),
            );
            set_js_property(
                &report,
                "ringResolution",
                &JsValue::from_f64(clipmap.config.ring_resolution as f64),
            );
            set_js_property(
                &report,
                "centerResolution",
                &JsValue::from_f64(clipmap.config.center_resolution as f64),
            );
            set_js_property(
                &report,
                "skirtDepth",
                &JsValue::from_f64(clipmap.config.skirt_depth as f64),
            );
            set_js_property(
                &report,
                "morphRange",
                &JsValue::from_f64(clipmap.config.morph_range as f64),
            );
            set_js_property(
                &report,
                "baseCellSize",
                &serde_wasm_bindgen::to_value(&clipmap.s0).unwrap_or(JsValue::NULL),
            );
            set_js_property(
                &report,
                "vertexCount",
                &JsValue::from_f64(clipmap.vertices.len() as f64),
            );
            set_js_property(
                &report,
                "indexCount",
                &JsValue::from_f64(clipmap.indices.len() as f64),
            );
            set_js_property(
                &report,
                "triangleCount",
                &JsValue::from_f64(clipmap.indices.len() as f64 / 3.0),
            );
            set_js_property(
                &report,
                "triangleBudget",
                &JsValue::from_f64(clipmap.triangle_budget as f64),
            );
            set_js_property(
                &report,
                "fullResolutionTriangles",
                &JsValue::from_f64(clipmap.full_resolution_triangles as f64),
            );
            set_js_property(
                &report,
                "triangleReductionPercent",
                &JsValue::from_f64(f64::from(
                    forge3d_core::terrain_clipmap::calculate_triangle_reduction(
                        clipmap.full_resolution_triangles,
                        clipmap.triangle_budget,
                    ),
                )),
            );
            set_js_property(
                &report,
                "centers",
                &serde_wasm_bindgen::to_value(&clipmap.centers_world()).unwrap_or(JsValue::NULL),
            );
            set_js_property(
                &report,
                "shadowCasterResolution",
                &serde_wasm_bindgen::to_value(&clipmap.shadow_caster).unwrap_or(JsValue::NULL),
            );
        } else {
            set_js_property(&report, "mode", &JsValue::from_str("grid"));
            let triangles = u64::from(self.index_count) / 3;
            set_js_property(
                &report,
                "vertexCount",
                &JsValue::from_f64(f64::from(self.vertex_count)),
            );
            set_js_property(
                &report,
                "indexCount",
                &JsValue::from_f64(f64::from(self.index_count)),
            );
            set_js_property(
                &report,
                "triangleCount",
                &JsValue::from_f64(triangles as f64),
            );
            set_js_property(
                &report,
                "triangleBudget",
                &JsValue::from_f64(triangles as f64),
            );
            set_js_property(
                &report,
                "fullResolutionTriangles",
                &JsValue::from_f64(triangles as f64),
            );
            set_js_property(&report, "triangleReductionPercent", &JsValue::from_f64(0.0));
            set_js_property(
                &report,
                "shadowCasterResolution",
                &serde_wasm_bindgen::to_value(&[self.height_width, self.height_height])
                    .unwrap_or(JsValue::NULL),
            );
        }
        report.into()
    }

    /// `planHeightTiles` (E3): plans clipmap-driven requests and returns
    /// `{requests: [{lod,x,y,priority,prefetch}], cancelled: [{lod,x,y}]}`.
    /// Requires clipmap + streaming; the shared native error is returned
    /// otherwise.
    pub(super) fn plan_height_tiles(&mut self, max_requests: u32) -> Result<JsValue, WebError> {
        use super::device_health::set_js_property;
        let (Some(clipmap), Some(streaming)) = (&self.clipmap, &mut self.streaming) else {
            return Err(height_streaming_not_enabled());
        };
        let (layout, config) = {
            let clipmap = clipmap.borrow();
            (clipmap.layout.clone(), clipmap.config.clone())
        };
        let (requests, cancelled) = streaming.plan(&layout, &config, max_requests);
        let requests_js = js_sys::Array::new();
        for tile in &requests {
            let entry = js_sys::Object::new();
            set_js_property(&entry, "lod", &JsValue::from_f64(tile.id.lod as f64));
            set_js_property(&entry, "x", &JsValue::from_f64(tile.id.x as f64));
            set_js_property(&entry, "y", &JsValue::from_f64(tile.id.y as f64));
            set_js_property(&entry, "prefetch", &JsValue::from_bool(tile.prefetch));
            set_js_property(&entry, "priority", &JsValue::from_f64(tile.priority as f64));
            requests_js.push(&entry);
        }
        let cancelled_js = js_sys::Array::new();
        for id in &cancelled {
            let entry = js_sys::Object::new();
            set_js_property(&entry, "lod", &JsValue::from_f64(id.lod as f64));
            set_js_property(&entry, "x", &JsValue::from_f64(id.x as f64));
            set_js_property(&entry, "y", &JsValue::from_f64(id.y as f64));
            cancelled_js.push(&entry);
        }
        let out = js_sys::Object::new();
        set_js_property(&out, "requests", &requests_js);
        set_js_property(&out, "cancelled", &cancelled_js);
        Ok(out.into())
    }

    /// `completeHeightTile` (E3): uploads `heights` (packed row-major tile
    /// data matching `tile_rect`) into the mosaic; returns
    /// `{accepted, evicted: {lod,x,y}|null}`.
    pub(super) fn complete_height_tile(
        &mut self,
        context: &GpuContext,
        tile: forge3d_core::terrain_stream::TileId,
        heights: &[f32],
    ) -> Result<JsValue, WebError> {
        use super::device_health::set_js_property;
        let Some(streaming) = &mut self.streaming else {
            return Err(height_streaming_not_enabled());
        };
        let outcome = streaming.complete(context, tile, heights)?;
        let out = js_sys::Object::new();
        set_js_property(&out, "accepted", &JsValue::from_bool(outcome.is_some()));
        let evicted = outcome
            .and_then(|outcome| outcome.evicted)
            .map(|id| {
                let entry = js_sys::Object::new();
                set_js_property(&entry, "lod", &JsValue::from_f64(id.lod as f64));
                set_js_property(&entry, "x", &JsValue::from_f64(id.x as f64));
                set_js_property(&entry, "y", &JsValue::from_f64(id.y as f64));
                entry.into()
            })
            .unwrap_or(JsValue::NULL);
        set_js_property(&out, "evicted", &evicted);
        Ok(out.into())
    }

    /// `failHeightTile` (E3): releases the in-flight slot and counts it.
    pub(super) fn fail_height_tile(
        &mut self,
        tile: forge3d_core::terrain_stream::TileId,
    ) -> Result<(), WebError> {
        let Some(streaming) = &mut self.streaming else {
            return Err(height_streaming_not_enabled());
        };
        streaming.fail(tile);
        Ok(())
    }

    /// `getHeightStreamingStats` (E3): the spec's stats object —
    /// `{enabled, center, lodCount, tileSize, residentTiles,
    /// residentFineTiles, residentHeightBytes, maxResidentBytes,
    /// coarsePrefilled, tilesRequested, tilesUploaded, pending, cancelled,
    /// droppedByPolicy, backpressure, deduplicated, failed, evictions,
    /// plannedTiles, plannedResident, converged, lodSelection}`.
    pub(super) fn height_streaming_stats(&self) -> Result<JsValue, WebError> {
        use super::device_health::set_js_property;
        let Some(streaming) = &self.streaming else {
            return Err(height_streaming_not_enabled());
        };
        let counters = streaming.queue.counters();
        let mosaic = streaming.mosaic.stats();
        let planned_resident = streaming
            .last_plan
            .iter()
            .filter(|tile| streaming.mosaic.lookup(tile.id).is_some())
            .count();
        let out = js_sys::Object::new();
        let set = |name: &str, value: f64| set_js_property(&out, name, &JsValue::from_f64(value));
        set_js_property(&out, "enabled", &JsValue::from_bool(true));
        let center = self
            .clipmap
            .as_ref()
            .and_then(|clipmap| clipmap.borrow().centers_world().into_iter().next())
            .unwrap_or([0.0, 0.0]);
        set_js_property(
            &out,
            "center",
            &serde_wasm_bindgen::to_value(&center).unwrap_or(JsValue::NULL),
        );
        set("lodCount", streaming.pyramid.lod_count() as f64);
        set("tileSize", streaming.pyramid.tile_size() as f64);
        set("residentTiles", streaming.mosaic.resident_count() as f64);
        set("residentFineTiles", streaming.resident_fine_tiles() as f64);
        set(
            "residentHeightBytes",
            streaming.mosaic.resident_bytes() as f64,
        );
        set("maxResidentBytes", streaming.max_resident_bytes as f64);
        set_js_property(
            &out,
            "coarsePrefilled",
            &JsValue::from_bool(streaming.coarse_prefilled),
        );
        set("tilesRequested", counters.requests as f64);
        set("tilesUploaded", streaming.tiles_uploaded as f64);
        set("pending", streaming.queue.pending().len() as f64);
        set("cancelled", counters.canceled as f64);
        set("droppedByPolicy", counters.dropped_by_policy as f64);
        set("backpressure", counters.backpressure as f64);
        set("deduplicated", counters.deduplicated as f64);
        set("failed", streaming.tiles_failed as f64);
        set("evictions", mosaic.evictions as f64);
        set("plannedTiles", streaming.last_plan.len() as f64);
        set("plannedResident", planned_resident as f64);
        set_js_property(
            &out,
            "converged",
            &JsValue::from_bool(streaming.converged()),
        );
        // Per-ring data LODs, identical to the ring_data_lod uniform table.
        let ring_lods = self
            .clipmap
            .as_ref()
            .map(|cell| {
                let clipmap = cell.borrow();
                let last = streaming.pyramid.lod_count() - 1;
                (0..clipmap.config.ring_count)
                    .map(|ring| {
                        (ring as i64 + streaming.plan.lod_bias as i64).clamp(0, last as i64) as u32
                    })
                    .collect::<Vec<u32>>()
            })
            .unwrap_or_default();
        set_js_property(
            &out,
            "ringDataLods",
            &serde_wasm_bindgen::to_value(&ring_lods).unwrap_or(JsValue::NULL),
        );
        let lod_selection = js_sys::Object::new();
        if let Some(lod_select) = &streaming.lod_select {
            let (visible, triangles) = lod_select
                .latest
                .as_ref()
                .map(|latest| (latest.visible_count, latest.total_triangles))
                .unwrap_or((0, 0));
            set_js_property(
                &lod_selection,
                "visibleTiles",
                &JsValue::from_f64(visible as f64),
            );
            set_js_property(
                &lod_selection,
                "totalTriangles",
                &JsValue::from_f64(triangles as f64),
            );
            set_js_property(
                &lod_selection,
                "frame",
                &JsValue::from_f64(lod_select.frame as f64),
            );
        }
        set_js_property(&out, "lodSelection", &lod_selection);
        Ok(out.into())
    }

    /// `getLodSelection` (E4): latest harvested GPU LOD selection — `null`
    /// before the first readback lands (native `try_read` semantics).
    pub(super) fn lod_selection(&self) -> Result<JsValue, WebError> {
        use super::device_health::set_js_property;
        let Some(streaming) = &self.streaming else {
            return Err(height_streaming_not_enabled());
        };
        let Some(lod_select) = &streaming.lod_select else {
            return Ok(JsValue::NULL);
        };
        let Some(latest) = &lod_select.latest else {
            return Ok(JsValue::NULL);
        };
        let out = js_sys::Object::new();
        let tiles = js_sys::Array::new();
        for tile in &latest.tiles {
            let (lod, x, y) = forge3d_core::terrain_clipmap::unpack_tile_id(tile.tile_id);
            let entry = js_sys::Object::new();
            set_js_property(&entry, "tileId", &JsValue::from_f64(tile.tile_id as f64));
            set_js_property(&entry, "lod", &JsValue::from_f64(lod as f64));
            set_js_property(&entry, "x", &JsValue::from_f64(x as f64));
            set_js_property(&entry, "y", &JsValue::from_f64(y as f64));
            set_js_property(&entry, "distance", &JsValue::from_f64(tile.distance as f64));
            set_js_property(
                &entry,
                "selectedLod",
                &JsValue::from_f64(tile.selected_lod as f64),
            );
            tiles.push(&entry);
        }
        set_js_property(&out, "frame", &JsValue::from_f64(latest.frame as f64));
        set_js_property(
            &out,
            "visibleCount",
            &JsValue::from_f64(latest.visible_count as f64),
        );
        set_js_property(
            &out,
            "totalTriangles",
            &JsValue::from_f64(latest.total_triangles as f64),
        );
        set_js_property(&out, "tiles", &tiles);
        Ok(out.into())
    }

    /// Per-frame W08 maintenance before the frame encoder is built
    /// (`render_runtime`, `begin_offline`/`accumulate`): harvests the
    /// pending LOD readback, uploads dirty page-table layers, rolls the
    /// mosaic's LRU frame counter, and runs the VT residency pass (feedback
    /// harvest + request collection + tile uploads).
    pub(super) fn prepare_w08_frame(
        &mut self,
        context: &GpuContext,
        camera: &forge3d_core::camera::CameraInput,
        width: u32,
        height: u32,
    ) {
        if let Some(streaming) = &mut self.streaming {
            if let Some(lod_select) = &mut streaming.lod_select {
                lod_select.harvest(context);
                if let Some(latest) = &lod_select.latest {
                    streaming.lod_visibility = Some(latest.visible_ids.clone());
                }
            }
            streaming.mosaic.begin_frame();
            streaming.flush_page_table(context);
        }
        if let Some(vt) = &mut self.vt {
            let span = (self.height_width.saturating_sub(1) as f32 * self.params.spacing[0])
                .max(self.height_height.saturating_sub(1) as f32 * self.params.spacing[1])
                .max(1.0);
            vt.frame(
                context,
                camera,
                width.max(1),
                height.max(1),
                self.render_mode == 1,
                span,
            );
        }
    }

    /// Encodes the per-frame buffer clears that must land before the terrain
    /// pass (VT feedback ring).
    pub(super) fn encode_w08_frame_start(&self, encoder: &mut wgpu::CommandEncoder) {
        if let Some(vt) = &self.vt {
            vt.encode_frame_start(encoder);
        }
    }

    /// Encodes the LOD-selection dispatch + staging copy (skipped while a
    /// readback is in flight — the render never stalls on the map).
    pub(super) fn encode_w08_compute(&mut self, encoder: &mut wgpu::CommandEncoder) {
        if let Some(streaming) = &mut self.streaming {
            if let Some(lod_select) = &mut streaming.lod_select {
                lod_select.encode_frame(encoder);
            }
        }
    }

    /// Encodes the post-pass copies that must land after the terrain pass
    /// (VT feedback ring -> MAP_READ staging).
    pub(super) fn encode_w08_frame_end(&self, encoder: &mut wgpu::CommandEncoder) {
        if let Some(vt) = &self.vt {
            vt.encode_frame_end(encoder);
        }
    }

    /// Starts the non-blocking staging maps after the frame's submission.
    pub(super) fn begin_w08_map(&mut self, context: &GpuContext) {
        if let Some(streaming) = &mut self.streaming {
            if let Some(lod_select) = &mut streaming.lod_select {
                lod_select.begin_map(context);
            }
        }
        if let Some(vt) = &mut self.vt {
            vt.begin_feedback_map();
        }
    }

    /// `terrain:clipmap` ledger bytes: clipmap vertex/index + geometry
    /// uniform + shadow-proxy buffers (0 for grid terrain).
    pub(super) fn clipmap_gpu_bytes(&self) -> u64 {
        let Some(clipmap) = &self.clipmap else {
            return 0;
        };
        let bytes = clipmap.borrow().gpu_bytes();
        debug_assert_eq!(
            bytes,
            (clipmap.borrow().vertices.len() * std::mem::size_of::<TerrainVertex>()
                + clipmap.borrow().indices.len() * std::mem::size_of::<u32>()) as u64
                + std::mem::size_of::<super::terrain_w08::TerrainGeometryUniform>() as u64
                + self.shadow_proxy.as_ref().map_or(0, |proxy| proxy.bytes)
        );
        bytes
    }

    /// `terrain:height-stream` ledger bytes: atlas + page table (0 without
    /// streaming).
    pub(super) fn streaming_gpu_bytes(&self) -> u64 {
        self.streaming
            .as_ref()
            .map_or(0, |stream| stream.gpu_bytes())
    }

    /// `terrain:lod-select` ledger bytes (0 without streaming).
    pub(super) fn lod_select_gpu_bytes(&self) -> u64 {
        self.streaming.as_ref().map_or(0, |stream| {
            stream.lod_select.as_ref().map_or(0, |lod| lod.gpu_bytes())
        })
    }

    /// `terrain:overlays` ledger bytes (0 without overlays).
    pub(super) fn overlay_gpu_bytes(&self) -> u64 {
        self.overlays
            .as_ref()
            .map_or(0, TerrainOverlayState::gpu_bytes)
    }

    /// `terrain:vt` ledger bytes (0 without material VT).
    pub(super) fn vt_gpu_bytes(&self) -> u64 {
        self.vt
            .as_ref()
            .map_or(0, super::terrain_vt::TerrainVtState::gpu_bytes)
    }

    /// W08 (E5): `getTerrainOverlayReport` body — `enabled:false` zeros
    /// when the committed terrain has no visible overlay plan.
    #[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
    pub(super) fn overlay_report(&self) -> JsValue {
        use super::device_health::set_js_property;
        let out = js_sys::Object::new();
        let value = JsValue::from(out.clone());
        match &self.overlays {
            Some(state) => {
                let plan = &state.plan;
                set_js_property(&value, "enabled", &JsValue::from_bool(true));
                set_js_property(
                    &value,
                    "layerCount",
                    &JsValue::from_f64(plan.layers.len() as f64),
                );
                set_js_property(&value, "width", &JsValue::from_f64(plan.width as f64));
                set_js_property(&value, "height", &JsValue::from_f64(plan.height as f64));
                set_js_property(
                    &value,
                    "requestedWidth",
                    &JsValue::from_f64(plan.requested_width as f64),
                );
                set_js_property(
                    &value,
                    "requestedHeight",
                    &JsValue::from_f64(plan.requested_height as f64),
                );
                set_js_property(&value, "downscaled", &JsValue::from_bool(plan.downscaled));
                set_js_property(
                    &value,
                    "gpuBytes",
                    &JsValue::from_f64(plan.gpu_bytes as f64),
                );
                set_js_property(
                    &value,
                    "globalOpacity",
                    &JsValue::from_f64(f64::from(plan.global_opacity)),
                );
                let layers = js_sys::Array::new();
                for layer in &plan.layers {
                    let entry = js_sys::Object::new();
                    let entry_value = JsValue::from(entry.clone());
                    set_js_property(&entry_value, "name", &JsValue::from_str(&layer.name));
                    set_js_property(
                        &entry_value,
                        "blendMode",
                        &JsValue::from_str(layer.blend_mode.as_str()),
                    );
                    set_js_property(
                        &entry_value,
                        "zOrder",
                        &JsValue::from_f64(f64::from(layer.z_order)),
                    );
                    layers.push(&entry);
                }
                set_js_property(&value, "layers", &layers);
            }
            None => {
                set_js_property(&value, "enabled", &JsValue::from_bool(false));
                set_js_property(&value, "layerCount", &JsValue::from_f64(0.0));
                set_js_property(&value, "width", &JsValue::from_f64(0.0));
                set_js_property(&value, "height", &JsValue::from_f64(0.0));
                set_js_property(&value, "requestedWidth", &JsValue::from_f64(0.0));
                set_js_property(&value, "requestedHeight", &JsValue::from_f64(0.0));
                set_js_property(&value, "downscaled", &JsValue::from_bool(false));
                set_js_property(&value, "gpuBytes", &JsValue::from_f64(0.0));
                set_js_property(&value, "globalOpacity", &JsValue::from_f64(1.0));
                set_js_property(&value, "layers", &js_sys::Array::new());
            }
        }
        value
    }

    /// W08 (E6): `getMaterialVtStats` body — camelCase core `VtStats`,
    /// all zeros when VT is disabled.
    #[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
    pub(super) fn vt_stats_report(&self) -> JsValue {
        let stats = self.vt.as_ref().map(|vt| vt.stats()).unwrap_or_default();
        vt_stats_js(self.vt.is_some(), &stats)
    }
}

/// W08 (E6): shared `getMaterialVtStats` object shape — same keys the
/// committed-terrain path reports, so a disabled/failed commit still
/// yields a zeroed stats object instead of `null`.
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub(super) fn vt_stats_js(enabled: bool, stats: &forge3d_core::terrain_vt::VtStats) -> JsValue {
    use super::device_health::set_js_property;
    let out = js_sys::Object::new();
    let value = JsValue::from(out.clone());
    set_js_property(&value, "enabled", &JsValue::from_bool(enabled));
    set_js_property(
        &value,
        "residentPages",
        &JsValue::from_f64(stats.resident_pages as f64),
    );
    set_js_property(
        &value,
        "totalPages",
        &JsValue::from_f64(stats.total_pages as f64),
    );
    set_js_property(
        &value,
        "cacheBudgetPages",
        &JsValue::from_f64(stats.cache_budget_pages as f64),
    );
    set_js_property(
        &value,
        "cacheBudgetMb",
        &JsValue::from_f64(f64::from(stats.cache_budget_mb)),
    );
    set_js_property(
        &value,
        "cacheHits",
        &JsValue::from_f64(stats.cache_hits as f64),
    );
    set_js_property(
        &value,
        "cacheMisses",
        &JsValue::from_f64(stats.cache_misses as f64),
    );
    set_js_property(
        &value,
        "missRate",
        &JsValue::from_f64(f64::from(stats.miss_rate)),
    );
    set_js_property(
        &value,
        "tilesStreamed",
        &JsValue::from_f64(stats.tiles_streamed as f64),
    );
    set_js_property(
        &value,
        "evictions",
        &JsValue::from_f64(stats.evictions as f64),
    );
    set_js_property(
        &value,
        "avgUploadMs",
        &JsValue::from_f64(f64::from(stats.avg_upload_ms)),
    );
    set_js_property(
        &value,
        "lastUploadMs",
        &JsValue::from_f64(f64::from(stats.last_upload_ms)),
    );
    set_js_property(
        &value,
        "residentMegabytes",
        &JsValue::from_f64(f64::from(stats.resident_megabytes)),
    );
    set_js_property(
        &value,
        "sourceCount",
        &JsValue::from_f64(stats.source_count as f64),
    );
    set_js_property(
        &value,
        "feedbackRequests",
        &JsValue::from_f64(stats.feedback_requests as f64),
    );
    value
}

/// Shared E3 error for every streaming entry point when the committed
/// terrain has no `streaming` declaration.
pub(super) fn height_streaming_not_enabled() -> WebError {
    WebError::new(
        Forge3DErrorCode::InvalidInput,
        "height streaming not enabled",
    )
}

/// JSON mirror of core `VtSupportReport` re-exported for the commit error
/// details; the implementation lives next to the `virtualTexture` parser.
fn vt_support_report_json(report: &forge3d_core::terrain_vt::VtSupportReport) -> serde_json::Value {
    crate::terrain_material_input::vt_support_report_json(report)
}

#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub(super) fn create_terrain_render_pipeline(
    device: &wgpu::Device,
    surface_format: wgpu::TextureFormat,
    pipeline_layout: &wgpu::PipelineLayout,
    shader: &wgpu::ShaderModule,
) -> wgpu::RenderPipeline {
    let targets = [Some(wgpu::ColorTargetState {
        format: surface_format,
        blend: None,
        write_mask: wgpu::ColorWrites::ALL,
    })];
    build_terrain_pipeline(device, pipeline_layout, shader, "fs_main", &targets)
}

fn build_terrain_pipeline(
    device: &wgpu::Device,
    pipeline_layout: &wgpu::PipelineLayout,
    shader: &wgpu::ShaderModule,
    fragment_entry: &str,
    targets: &[Option<wgpu::ColorTargetState>],
) -> wgpu::RenderPipeline {
    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("forge3d-web-terrain-pipeline"),
        layout: Some(pipeline_layout),
        vertex: wgpu::VertexState {
            module: shader,
            entry_point: Some("vs_main"),
            compilation_options: wgpu::PipelineCompilationOptions::default(),
            buffers: &[wgpu::VertexBufferLayout {
                array_stride: std::mem::size_of::<TerrainVertex>() as wgpu::BufferAddress,
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
        fragment: Some(wgpu::FragmentState {
            module: shader,
            entry_point: Some(fragment_entry),
            compilation_options: wgpu::PipelineCompilationOptions::default(),
            targets,
        }),
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
            format: DEPTH_FORMAT,
            depth_write_enabled: Some(true),
            depth_compare: Some(wgpu::CompareFunction::LessEqual),
            stencil: wgpu::StencilState::default(),
            bias: wgpu::DepthBiasState::default(),
        }),
        multisample: wgpu::MultisampleState::default(),
        multiview_mask: None,
        cache: None,
    })
}

fn create_terrain_mesh_buffers(
    context: &GpuContext,
    terrain: &forge3d_core::terrain::TerrainHeightmapInput,
) -> Result<(wgpu::Buffer, wgpu::Buffer, u32), WebError> {
    let mesh = terrain.mesh_descriptor().map_err(map_core_error)?;
    let mut vertices = mesh
        .vertices
        .iter()
        .map(|vertex| TerrainVertex {
            position: vertex.position,
            uv: vertex.uv,
        })
        .collect::<Vec<_>>();
    let mut indices = mesh.indices;
    append_terrain_edge_skirts(&mut vertices, &mut indices, terrain.width, terrain.height)?;

    let vertex_buffer = context
        .device
        .create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("forge3d-web-terrain-vertices"),
            contents: bytemuck::cast_slice(&vertices),
            usage: wgpu::BufferUsages::VERTEX,
        });
    let index_buffer = context
        .device
        .create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("forge3d-web-terrain-indices"),
            contents: bytemuck::cast_slice(&indices),
            usage: wgpu::BufferUsages::INDEX,
        });

    Ok((vertex_buffer, index_buffer, indices.len() as u32))
}

pub(super) fn append_terrain_edge_skirts(
    vertices: &mut Vec<TerrainVertex>,
    indices: &mut Vec<u32>,
    width: u32,
    height: u32,
) -> Result<(), WebError> {
    if width < 2 || height < 2 {
        return Ok(());
    }

    let width_usize = width as usize;
    let height_usize = height as usize;
    append_horizontal_skirt(vertices, indices, 0, width_usize, false)?;
    append_horizontal_skirt(vertices, indices, height_usize - 1, width_usize, true)?;
    append_vertical_skirt(vertices, indices, 0, width_usize, height_usize, true)?;
    append_vertical_skirt(
        vertices,
        indices,
        width_usize - 1,
        width_usize,
        height_usize,
        false,
    )?;
    Ok(())
}

fn append_horizontal_skirt(
    vertices: &mut Vec<TerrainVertex>,
    indices: &mut Vec<u32>,
    row: usize,
    width: usize,
    reverse: bool,
) -> Result<(), WebError> {
    let skirt_indices = (0..width)
        .map(|column| push_skirt_vertex(vertices, row * width + column))
        .collect::<Result<Vec<_>, _>>()?;
    for column in 0..(width - 1) {
        let a = (row * width + column) as u32;
        let b = (row * width + column + 1) as u32;
        let a_skirt = skirt_indices[column];
        let b_skirt = skirt_indices[column + 1];
        if reverse {
            indices.extend_from_slice(&[a, b, a_skirt, b, b_skirt, a_skirt]);
        } else {
            indices.extend_from_slice(&[a, a_skirt, b, b, a_skirt, b_skirt]);
        }
    }
    Ok(())
}

fn append_vertical_skirt(
    vertices: &mut Vec<TerrainVertex>,
    indices: &mut Vec<u32>,
    column: usize,
    width: usize,
    height: usize,
    reverse: bool,
) -> Result<(), WebError> {
    let skirt_indices = (0..height)
        .map(|row| push_skirt_vertex(vertices, row * width + column))
        .collect::<Result<Vec<_>, _>>()?;
    for row in 0..(height - 1) {
        let a = (row * width + column) as u32;
        let b = ((row + 1) * width + column) as u32;
        let a_skirt = skirt_indices[row];
        let b_skirt = skirt_indices[row + 1];
        if reverse {
            indices.extend_from_slice(&[a, b, a_skirt, b, b_skirt, a_skirt]);
        } else {
            indices.extend_from_slice(&[a, a_skirt, b, b, a_skirt, b_skirt]);
        }
    }
    Ok(())
}

fn push_skirt_vertex(
    vertices: &mut Vec<TerrainVertex>,
    source_index: usize,
) -> Result<u32, WebError> {
    let mut vertex = *vertices.get(source_index).ok_or_else(|| {
        WebError::new(
            Forge3DErrorCode::InvalidInput,
            "terrain skirt source vertex is out of range",
        )
    })?;
    vertex.position[1] -= TERRAIN_SKIRT_DEPTH;
    let index = u32::try_from(vertices.len()).map_err(|_| {
        WebError::new(
            Forge3DErrorCode::InvalidInput,
            "terrain skirt mesh is too large for u32 indices",
        )
    })?;
    vertices.push(vertex);
    Ok(index)
}

fn create_height_texture(
    context: &GpuContext,
    terrain: &forge3d_core::terrain::TerrainHeightmapInput,
) -> (wgpu::Texture, wgpu::TextureView) {
    let texture = context.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("forge3d-web-terrain-height-r32float"),
        size: wgpu::Extent3d {
            width: terrain.width,
            height: terrain.height,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::R32Float,
        usage: wgpu::TextureUsages::TEXTURE_BINDING
            | wgpu::TextureUsages::COPY_DST
            | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });

    upload_r32float_texture(context, &texture, terrain);
    let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
    (texture, view)
}

fn create_analysis_fallback_texture(context: &GpuContext) -> wgpu::Texture {
    let texture = context.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("forge3d-web-terrain-analysis-fallback"),
        size: wgpu::Extent3d {
            width: 1,
            height: 1,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::R32Float,
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
        bytemuck::bytes_of(&1.0f32),
        wgpu::TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT),
            rows_per_image: Some(1),
        },
        wgpu::Extent3d {
            width: 1,
            height: 1,
            depth_or_array_layers: 1,
        },
    );
    texture
}

pub(super) fn create_camera_uniform(
    camera: &forge3d_core::camera::CameraInput,
    width: u32,
    height: u32,
) -> Result<CameraUniform, WebError> {
    if height == 0 {
        return Err(WebError::new(
            Forge3DErrorCode::InvalidInput,
            "camera aspect ratio height must be greater than zero",
        ));
    }
    let aspect_ratio = width as f32 / height as f32;
    let forward = {
        let direction = [
            camera.target[0] - camera.position[0],
            camera.target[1] - camera.position[1],
            camera.target[2] - camera.position[2],
        ];
        let length = (direction[0] * direction[0]
            + direction[1] * direction[1]
            + direction[2] * direction[2])
            .sqrt();
        if length.is_finite() && length > 0.0 {
            [
                direction[0] / length,
                direction[1] / length,
                direction[2] / length,
            ]
        } else {
            [0.0, 0.0, -1.0]
        }
    };
    Ok(CameraUniform {
        view_projection: camera
            .view_projection_matrix(aspect_ratio)
            .map_err(map_core_error)?,
        camera_position: [
            camera.position[0],
            camera.position[1],
            camera.position[2],
            1.0,
        ],
        camera_forward: [
            forward[0],
            forward[1],
            forward[2],
            if camera.is_orthographic() { 1.0 } else { 0.0 },
        ],
    })
}

/// Camera uniform of the offline capture variants: the display camera block
/// (jittered view-projection) followed by the unjittered current/previous
/// matrices for motion vectors, `[near, far, width, height]` and the object ID
/// the draw writes (`capture_ids.x`).
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub(super) struct CaptureCameraUniform {
    pub(super) base: CameraUniform,
    pub(super) motion_current: [[f32; 4]; 4],
    pub(super) motion_previous: [[f32; 4]; 4],
    pub(super) capture_params: [f32; 4],
    pub(super) capture_ids: [u32; 4],
}

#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub(super) fn create_capture_camera_uniform(
    camera: &forge3d_core::camera::CameraInput,
    previous: &forge3d_core::camera::CameraInput,
    width: u32,
    height: u32,
    jitter: [f32; 2],
    object_id: u32,
) -> Result<CaptureCameraUniform, WebError> {
    let mut base = create_camera_uniform(camera, width, height)?;
    let current = base.view_projection;
    let previous = create_camera_uniform(previous, width, height)?.view_projection;
    base.view_projection = forge3d_core::offline::jitter::jitter_clip_matrix(
        glam::Mat4::from_cols_array_2d(&current),
        jitter,
        width,
        height,
    )
    .to_cols_array_2d();
    Ok(CaptureCameraUniform {
        base,
        motion_current: current,
        motion_previous: previous,
        capture_params: [camera.near, camera.far, width as f32, height as f32],
        capture_ids: [object_id, 0, 0, 0],
    })
}

pub(super) enum R32FloatUploadPlan {
    Tight { bytes_per_row: u32 },
    RowWise { row_bytes: u32 },
}

pub(super) fn r32float_upload_plan(width: u32) -> R32FloatUploadPlan {
    let row_bytes = width * std::mem::size_of::<f32>() as u32;
    if row_bytes % wgpu::COPY_BYTES_PER_ROW_ALIGNMENT == 0 {
        R32FloatUploadPlan::Tight {
            bytes_per_row: row_bytes,
        }
    } else {
        R32FloatUploadPlan::RowWise { row_bytes }
    }
}

pub(super) fn upload_r32float_texture(
    context: &GpuContext,
    texture: &wgpu::Texture,
    terrain: &forge3d_core::terrain::TerrainHeightmapInput,
) {
    let source = bytemuck::cast_slice::<f32, u8>(&terrain.heights);
    match r32float_upload_plan(terrain.width) {
        R32FloatUploadPlan::Tight { bytes_per_row } => {
            context.queue.write_texture(
                wgpu::TexelCopyTextureInfo {
                    texture,
                    mip_level: 0,
                    origin: wgpu::Origin3d::ZERO,
                    aspect: wgpu::TextureAspect::All,
                },
                source,
                wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(bytes_per_row),
                    rows_per_image: Some(terrain.height),
                },
                wgpu::Extent3d {
                    width: terrain.width,
                    height: terrain.height,
                    depth_or_array_layers: 1,
                },
            );
        }
        R32FloatUploadPlan::RowWise { row_bytes } => {
            for y in 0..terrain.height {
                let start = (y * row_bytes) as usize;
                let row = &source[start..start + row_bytes as usize];
                context.queue.write_texture(
                    wgpu::TexelCopyTextureInfo {
                        texture,
                        mip_level: 0,
                        origin: wgpu::Origin3d { x: 0, y, z: 0 },
                        aspect: wgpu::TextureAspect::All,
                    },
                    row,
                    wgpu::TexelCopyBufferLayout {
                        offset: 0,
                        bytes_per_row: None,
                        rows_per_image: None,
                    },
                    wgpu::Extent3d {
                        width: terrain.width,
                        height: 1,
                        depth_or_array_layers: 1,
                    },
                );
            }
        }
    }
}

pub(super) fn align_copy_bytes_per_row(value: u32) -> u32 {
    let alignment = wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
    value.div_ceil(alignment) * alignment
}

use super::shader_variants::{specialize, ShaderFeatures};

/// Terrain WGSL template; compile variants through [`TerrainPipelineCache`].
pub(super) const TERRAIN_SHADER: &str = concat!(
    include_str!("brdf.wgsl"),
    include_str!("ibl_lighting.wgsl"),
    include_str!("shadow_lighting.wgsl"),
    include_str!("lighting.wgsl"),
    include_str!("terrain_probes.wgsl"),
    include_str!("environment/sky.wgsl"),
    include_str!("terrain_atmosphere.wgsl"),
    include_str!("terrain_water.wgsl"),
    include_str!("terrain_material.wgsl"),
    include_str!("terrain_w08.wgsl"),
    r#"
struct VertexInput {
    @builtin(vertex_index) vertex_index: u32,
    @location(0) position: vec3<f32>,
    @location(1) uv: vec2<f32>,
};

struct CameraUniform {
    view_projection: mat4x4<f32>,
    camera_position: vec4<f32>,
    camera_forward: vec4<f32>,
    // #if capture
    motion_current: mat4x4<f32>,
    motion_previous: mat4x4<f32>,
    capture_params: vec4<f32>,
    capture_ids: vec4<u32>,
    // #endif
};

struct ColorRampUniform {
    stops: array<vec4<f32>, 8>,
    stop_count: u32,
    clear_color: vec4<f32>,
};

struct TerrainParamsUniform {
    spacing: vec2<f32>,
    exaggeration: f32,
    domain_min: f32,
    inv_domain_span: f32,
    nodata_value: f32,
    has_nodata: f32,
    debug_view: u32,
    render_mode: u32,
    output_srgb: u32,
    _params_pad: vec2<u32>,
};

struct VertexOutput {
    // #if capture
    @builtin(position) @invariant position: vec4<f32>,
    // #else
    @builtin(position) position: vec4<f32>,
    // #endif
    @location(0) height: f32,
    @location(1) uv: vec2<f32>,
    @location(2) world_position: vec3<f32>,
};

struct TerrainSample {
    radiance: vec3<f32>,
    albedo: vec3<f32>,
    normal: vec3<f32>,
    covered: bool,
};

@group(0) @binding(0) var heightmap: texture_2d<f32>;
@group(0) @binding(1) var nearest_sampler: sampler;
@group(0) @binding(2) var<uniform> camera: CameraUniform;
@group(0) @binding(3) var<uniform> color_ramp: ColorRampUniform;
@group(0) @binding(4) var<uniform> params: TerrainParamsUniform;
@group(0) @binding(5) var ao_texture: texture_2d<f32>;
@group(0) @binding(6) var sun_texture: texture_2d<f32>;

// #if terrain_clipmap || terrain_streaming
// W08 (E2/E3): clipmap + streamed heightfield parameters (group 0, binding
// 12). One clipmap grid unit equals `base_cell_size` world units; `anchor` is
// world XZ of grid unit (0,0). `hf_*` describe the finest level: the
// committed dense heightfield when not streaming, the virtual dims when
// `heightmap` is the slot atlas.
struct TerrainGeometryUniform {
    s0: vec2<f32>,
    anchor: vec2<f32>,
    skirt_depth: f32,
    ring_count: u32,
    mode_flags: u32,
    lod_count: u32,
    hf_origin: vec2<f32>,
    hf_spacing: vec2<f32>,
    hf_dims: vec2<u32>,
    tile_size: u32,
    slots_per_row: u32,
    base_dims: vec2<u32>,
    morph_range: f32,
    _pad0: f32,
    ring_data_lod: array<vec4<u32>, 4>,
}
@group(0) @binding(12) var<uniform> terrain_geometry: TerrainGeometryUniform;
// #endif
// #if terrain_streaming
// W08 (E3): mosaic page table — one u32 layer per lod, texel = tile,
// value = atlas slot + 1 (0 = absent).
@group(0) @binding(13) var height_page_table: texture_2d_array<u32>;
// #endif

fn is_nan_height(value: f32) -> bool {
    let bits = bitcast<u32>(value);
    return (bits & 0x7f800000u) == 0x7f800000u && (bits & 0x007fffffu) != 0u;
}

fn is_valid_height(value: f32) -> bool {
    if (is_nan_height(value)) {
        return false;
    }
    if (params.has_nodata > 0.5 && value == params.nodata_value) {
        return false;
    }
    return true;
}

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    // #if terrain_screen
    if (params.render_mode == 1u) {
        // Screen mode: fullscreen triangle with fixed NDC coverage; the camera
        // uniform stays bound for shading-only view/specular terms.
        let uv = vec2<f32>(
            f32((input.vertex_index << 1u) & 2u),
            f32(input.vertex_index & 2u),
        );
        let uv_clamped = clamp(uv, vec2<f32>(0.0), vec2<f32>(1.0));
        let raw_height = screen_height_sample(uv_clamped);
        let height = select(params.domain_min, raw_height, is_valid_height(raw_height));
        let t = clamp(
            (height - params.domain_min) * params.inv_domain_span,
            0.0,
            1.0,
        );
        var height_display = params.domain_min + t / params.inv_domain_span;
        // #if terrain_material
        height_display = tm_height_geom(raw_height);
        // #endif
        output.height = raw_height;
        output.uv = uv_clamped;
        output.position = vec4<f32>(uv.x * 2.0 - 1.0, uv.y * 2.0 - 1.0, 0.0, 1.0);
        // Native screen frame: XY is the unit tile plane, Z is display height.
        output.world_position = vec3<f32>(
            uv.x - 0.5,
            uv.y - 0.5,
            height_display * params.exaggeration,
        );
        return output;
    }
    // #endif
    // #if terrain_clipmap
    // W08 (E2): clipmap vertex path — exact port of core
    // `clipmap_vertex_position` (DESIGN A5). `position = [grid_x, morph,
    // grid_z]` holds absolute integer grid units relative to
    // `terrain_geometry.anchor` (one unit = `s0` world units per axis);
    // `uv = [ring, flags]` with CLIPMAP_FLAG_SKIRT = 1,
    // CLIPMAP_FLAG_COARSE_BOUNDARY = 2, CLIPMAP_FLAG_INNER_BOUNDARY = 4.
    // Runs before the dense-grid path whenever the committed geometry is
    // clipmap (`mode_flags` bit 0); the grid block remains for
    // `mode_flags == 0`.
    if ((terrain_geometry.mode_flags & 1u) != 0u) {
        let ring = u32(input.uv.x);
        let flags = u32(input.uv.y);
        let grid = vec2<i32>(
            i32(round(input.position.x)),
            i32(round(input.position.z)),
        );
        // A5: k = max(morph, 0); skirt vertices carry morph = -1 -> k = 0.
        let k = max(input.position.y, 0.0);
        // A5: step = 1 << (ring + 1); coarse = grid - rem_euclid(grid, step)
        // on integer coords (WGSL % keeps the dividend's sign, so wrap).
        let step = 1i << (ring + 1u);
        let rem = ((grid % vec2<i32>(step)) + vec2<i32>(step)) % vec2<i32>(step);
        let coarse = grid - rem;
        // A5 endpoint-exact selects — never `mix` at k == 0 or k == 1.
        var p = vec2<f32>(grid);
        if (k >= 1.0) {
            p = vec2<f32>(coarse);
        } else if (k > 0.0) {
            p = vec2<f32>(grid) * (1.0 - k) + vec2<f32>(coarse) * k;
        }
        // A5: lod_f = data_lod(ring); lod_c = data_lod of the coarser RING
        // index `min(ring + 1, ring_count - 1)` (not `lod_f + 1`).
        let last_ring = terrain_geometry.ring_count - 1u;
        let lod_f = terrain_ring_data_lod(ring);
        let lod_c = terrain_ring_data_lod(min(ring + 1u, last_ring));
        // A5: kh = 1 on COARSE_BOUNDARY vertices, else k.
        var kh = k;
        if ((flags & 2u) != 0u) {
            kh = 1.0;
        }
        // A5: world = anchor + p * s0 — grid units map through `s0`.
        let world_xz = terrain_geometry.anchor + p * terrain_geometry.s0;
        // A5 endpoint-exact selects on kh.
        var raw_height = terrain_height_world(world_xz, lod_f);
        if (kh >= 1.0) {
            raw_height = terrain_height_world(world_xz, lod_c);
        } else if (kh > 0.0) {
            raw_height = raw_height * (1.0 - kh)
                + terrain_height_world(world_xz, lod_c) * kh;
        }
        // Finest-level heightmap uv from the world XZ; fragments outside
        // [0, 1] take the uncovered (clear-color) path in the fragment.
        let uv_fine = (world_xz - terrain_geometry.hf_origin)
            / (vec2<f32>(terrain_geometry.hf_dims - vec2<u32>(1u, 1u))
                * terrain_geometry.hf_spacing);
        var height = select(params.domain_min, raw_height, is_valid_height(raw_height));
        // #if terrain_material
        height = tm_height_geom(raw_height);
        // #endif
        // A5: `if flags & SKIRT { h -= skirt_depth_world }` — skirt_depth is
        // a world-unit offset applied after exaggeration; `output.height`
        // keeps the sampled height so shading is unchanged.
        var world_y = (height - params.domain_min) * params.exaggeration;
        if ((flags & 1u) != 0u) {
            world_y = world_y - terrain_geometry.skirt_depth;
        }
        output.height = raw_height;
        output.uv = uv_fine;
        let world_position = vec3<f32>(world_xz.x, world_y, world_xz.y);
        output.position = camera.view_projection * vec4<f32>(world_position, 1.0);
        output.world_position = world_position;
        return output;
    }
    // #endif
    // #if terrain_perspective
    let raw_height = terrain_height_nearest(input.uv);
    var height = select(params.domain_min, raw_height, is_valid_height(raw_height));
    // #if terrain_material
    height = tm_height_geom(raw_height);
    // #endif
    output.height = raw_height;
    output.uv = input.uv;
    let world_position = vec3<f32>(
        input.position.x,
        input.position.y + (height - params.domain_min) * params.exaggeration,
        input.position.z,
    );
    output.position = camera.view_projection * vec4<f32>(world_position, 1.0);
    output.world_position = world_position;
    // #endif
    return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
    if ((camera.camera_position.w == -1.0 || camera.camera_position.w == -3.0) && input.world_position.y < camera.camera_forward.w) { discard; }
    if ((camera.camera_position.w == -2.0 || camera.camera_position.w == -4.0) && input.world_position.z < camera.camera_forward.w) { discard; }
    if (params.debug_view == 1u) {
        return vec4<f32>(vec3<f32>(analysis_gray(input.uv, 1u)), 1.0);
    }
    if (params.debug_view == 2u) {
        return vec4<f32>(vec3<f32>(analysis_gray(input.uv, 2u)), 1.0);
    }
    // #if terrain_screen
    if (params.render_mode == 1u) {
        return terrain_screen_shade(input);
    }
    // #endif
    // #if terrain_perspective
    // #if terrain_material
    return tm_display(terrain_perspective_sample(input));
    // #else
    return vec4<f32>(terrain_perspective_sample(input).radiance, 1.0);
    // #endif
    // #else
    return vec4<f32>(color_ramp.clear_color.xyz, 1.0);
    // #endif
}

// #if terrain_perspective
fn terrain_perspective_sample(input: VertexOutput) -> TerrainSample {
    // #if terrain_material
    return tm_perspective_sample(input);
    // #else
    var valid_height = is_valid_height(input.height);
    // #if terrain_clipmap
    // W08 (E2): clipmap fragments outside the finest-level heightfield
    // footprint (uv outside [0, 1]) take the uncovered path — identical to
    // nodata. Grid-terrain uvs are always in range; clipmap ring/skirt
    // fragments may fall outside when the layout overhangs the edge.
    valid_height = valid_height
        && all(input.uv >= vec2<f32>(0.0))
        && all(input.uv <= vec2<f32>(1.0));
    // #endif
    let t = clamp((input.height - params.domain_min) * params.inv_domain_span, 0.0, 1.0);
    var base_color = sample_color_ramp(t);
    // #if terrain_overlay
    // W08 (E5): the same overlay stack applied to the ramp albedo before
    // lighting (mirrors the `tm_shade` apply site).
    base_color = terrain_apply_overlays(base_color, input.uv);
    // #endif
    let normal = terrain_normal(input.uv);
    // camera_forward.w flags an orthographic camera: parallel view rays.
    var view_vector = camera.camera_position.xyz - input.world_position;
    if (camera.camera_forward.w > 0.5) {
        view_vector = -camera.camera_forward.xyz;
    }
    let view_direction = forge3d_safe_direction(view_vector);
    var tangent_xyz = vec3<f32>(1.0, 0.0, 0.0)
        - normal * dot(normal, vec3<f32>(1.0, 0.0, 0.0));
    if (dot(tangent_xyz, tangent_xyz) < 1e-8) {
        tangent_xyz = vec3<f32>(0.0, 0.0, 1.0)
            - normal * dot(normal, vec3<f32>(0.0, 0.0, 1.0));
    }
    let tangent = vec4<f32>(forge3d_safe_direction(tangent_xyz), 1.0);
    let view_depth = dot(
        camera.camera_forward.xyz,
        input.world_position - camera.camera_position.xyz,
    );
    var shaded = forge3d_evaluate_lighting(
        base_color,
        input.world_position,
        normal,
        view_direction,
        0u,
        input.uv,
        tangent,
        view_depth,
    );
    shaded = shaded * analysis_shade(input.uv, 1u) * analysis_shade(input.uv, 2u);
    let edge_fade = terrain_edge_fade(input.uv);
    let lit = mix(color_ramp.clear_color.xyz, shaded, edge_fade);
    var result: TerrainSample;
    result.radiance = select(lit, color_ramp.clear_color.xyz, !valid_height);
    result.albedo = base_color;
    result.normal = normal;
    result.covered = valid_height;
    return result;
    // #endif
}
// #endif

fn analysis_shade(uv: vec2<f32>, channel: u32) -> f32 {
    let raw = analysis_sample(uv, channel);
    return select(1.0, raw, raw == raw);
}

fn analysis_gray(uv: vec2<f32>, channel: u32) -> f32 {
    let raw = analysis_sample(uv, channel);
    return clamp(select(0.0, raw, raw == raw), 0.0, 1.0);
}

fn analysis_sample(uv: vec2<f32>, channel: u32) -> f32 {
    if (channel == 1u) {
        let dims = textureDimensions(ao_texture);
        let texel = clamp(
            vec2<i32>(uv * vec2<f32>(dims)),
            vec2<i32>(0, 0),
            vec2<i32>(dims) - vec2<i32>(1, 1),
        );
        return textureLoad(ao_texture, texel, 0).r;
    }
    let dims = textureDimensions(sun_texture);
    let texel = clamp(
        vec2<i32>(uv * vec2<f32>(dims)),
        vec2<i32>(0, 0),
        vec2<i32>(dims) - vec2<i32>(1, 1),
    );
    return textureLoad(sun_texture, texel, 0).r;
}

fn sample_color_ramp(t: f32) -> vec3<f32> {
    var previous = color_ramp.stops[0];
    for (var i: u32 = 1u; i < 8u; i = i + 1u) {
        if (i >= color_ramp.stop_count) {
            return previous.xyz;
        }
        let next = color_ramp.stops[i];
        if (t <= next.w) {
            let span = max(next.w - previous.w, 0.0001);
            let local_t = clamp((t - previous.w) / span, 0.0, 1.0);
            return mix(previous.xyz, next.xyz, local_t);
        }
        previous = next;
    }
    return previous.xyz;
}

/// Native screen-mode colormap: `Colormap1D` bakes a 256-entry Rgba8Unorm
/// LUT (byte-rounded lerp at `i / 255`) sampled with linear filtering.
fn screen_color_ramp_entry(index: i32) -> vec3<f32> {
    let t = f32(clamp(index, 0, 255)) / 255.0;
    return round(sample_color_ramp(t) * 255.0) / 255.0;
}

fn screen_color_ramp(t: f32) -> vec3<f32> {
    let x = clamp(t, 0.0, 1.0) * 256.0 - 0.5;
    let base = floor(x);
    let f = x - base;
    let i0 = i32(base);
    return mix(screen_color_ramp_entry(i0), screen_color_ramp_entry(i0 + 1), f);
}

// Height lookup helpers (W08/E3). Without `terrain_streaming` these expand
// to exactly the previous `textureDimensions`/`textureLoad`/
// `textureSampleLevel` calls on the dense `heightmap`; under streaming
// `heightmap` is the slot atlas and lod-0 dims/uv span come from
// `terrain_geometry` instead.
fn terrain_height_dims() -> vec2<u32> {
    // #if terrain_streaming
    return terrain_geometry.hf_dims;
    // #else
    return textureDimensions(heightmap);
    // #endif
}

fn terrain_height_load(texel: vec2<i32>) -> f32 {
    // #if terrain_streaming
    return terrain_height_load_lod(texel, 0u);
    // #else
    let dims = vec2<i32>(terrain_height_dims());
    let max_texel = dims - vec2<i32>(1, 1);
    return textureLoad(heightmap, clamp(texel, vec2<i32>(0, 0), max_texel), 0).r;
    // #endif
}

// #if terrain_streaming
// Atlas fetch through the page table: `l` steps coarser from `lod` until a
// resident tile answers (the coarsest level is always resident).
fn terrain_height_load_lod(texel: vec2<i32>, lod: u32) -> f32 {
    for (var lp = lod; lp < terrain_geometry.lod_count; lp = lp + 1u) {
        let shift = lp - lod;
        let t = texel >> vec2<u32>(shift, shift);
        let dims_l = vec2<i32>(
            (terrain_geometry.hf_dims - vec2<u32>(1u, 1u)) >> vec2<u32>(lp, lp)
        ) + vec2<i32>(1, 1);
        let tc = clamp(t, vec2<i32>(0, 0), dims_l - vec2<i32>(1, 1));
        let tile = vec2<u32>(tc) / vec2<u32>(
            terrain_geometry.tile_size, terrain_geometry.tile_size);
        let entry = textureLoad(height_page_table, vec2<i32>(tile), i32(lp), 0).r;
        if (entry != 0u) {
            let slot = entry - 1u;
            let slot_origin = vec2<u32>(
                slot % terrain_geometry.slots_per_row,
                slot / terrain_geometry.slots_per_row,
            ) * terrain_geometry.tile_size;
            let local = vec2<u32>(tc) % vec2<u32>(
                terrain_geometry.tile_size, terrain_geometry.tile_size);
            return textureLoad(heightmap, vec2<i32>(slot_origin + local), 0).r;
        }
    }
    return 0.0;
}

// Bilinear level-`lod` height at heightmap uv (texel centers at
// `(i + 0.5) / dims`, clamp-to-edge) through the page table: the
// streaming counterpart of every fragment-stage `heightmap` sample.
fn terrain_height_bilinear_lod(uv: vec2<f32>, lod: u32) -> f32 {
    let dims_l = vec2<i32>(
        (terrain_geometry.hf_dims - vec2<u32>(1u, 1u)) >> vec2<u32>(lod, lod)
    ) + vec2<i32>(1, 1);
    let g = uv * vec2<f32>(dims_l) - vec2<f32>(0.5, 0.5);
    let base = vec2<i32>(floor(g));
    let frac = g - vec2<f32>(base);
    let max_texel = dims_l - vec2<i32>(1, 1);
    let b0 = clamp(base, vec2<i32>(0, 0), max_texel);
    let b1 = clamp(base + vec2<i32>(1, 1), vec2<i32>(0, 0), max_texel);
    let h00 = terrain_height_load_lod(vec2<i32>(b0.x, b0.y), lod);
    let h10 = terrain_height_load_lod(vec2<i32>(b1.x, b0.y), lod);
    let h01 = terrain_height_load_lod(vec2<i32>(b0.x, b1.y), lod);
    let h11 = terrain_height_load_lod(vec2<i32>(b1.x, b1.y), lod);
    return mix(mix(h00, h10, frac.x), mix(h01, h11, frac.x), frac.y);
}
// #else
fn terrain_height_load_lod(texel: vec2<i32>, lod: u32) -> f32 {
    return terrain_height_load(texel);
}
// #endif

// Nearest = `floor(uv * dims)` (E3); identical to the previous level-0
// nearest-sample call on the dense texture when not streaming.
fn terrain_height_nearest(uv: vec2<f32>) -> f32 {
    // #if terrain_streaming
    let dims = vec2<i32>(terrain_height_dims());
    let texel = clamp(
        vec2<i32>(floor(uv * vec2<f32>(dims))),
        vec2<i32>(0, 0),
        dims - vec2<i32>(1, 1),
    );
    return terrain_height_load(texel);
    // #else
    return textureSampleLevel(heightmap, nearest_sampler, uv, 0.0).r;
    // #endif
}

// #if terrain_clipmap
// World-space bilinear height over the level-`lod` heightfield (E3). Without
// streaming only lod 0 exists (`terrain_height_load_lod` ignores `lod`);
// under streaming the ring's `data_lod` row of the page table is walked.
fn terrain_height_world(world_xz: vec2<f32>, lod: u32) -> f32 {
    let g = (world_xz - terrain_geometry.hf_origin) / terrain_geometry.hf_spacing;
    let scale = f32(1u << lod);
    let gl = g / scale;
    let lod_dims = vec2<i32>(
        (terrain_geometry.hf_dims - vec2<u32>(1u, 1u)) >> vec2<u32>(lod, lod)
    ) + vec2<i32>(1, 1);
    let base = vec2<i32>(floor(gl));
    let frac = gl - vec2<f32>(base);
    let b0 = clamp(base, vec2<i32>(0, 0), lod_dims - vec2<i32>(1, 1));
    let b1 = clamp(base + vec2<i32>(1, 1), vec2<i32>(0, 0), lod_dims - vec2<i32>(1, 1));
    let h00 = terrain_height_load_lod(vec2<i32>(b0.x, b0.y), lod);
    let h10 = terrain_height_load_lod(vec2<i32>(b1.x, b0.y), lod);
    let h01 = terrain_height_load_lod(vec2<i32>(b0.x, b1.y), lod);
    let h11 = terrain_height_load_lod(vec2<i32>(b1.x, b1.y), lod);
    return mix(mix(h00, h10, frac.x), mix(h01, h11, frac.x), frac.y);
}

// Per-ring data lod the vertex stage walks: `clamp(ring + lod_bias)` under
// streaming, always 0 on the dense heightfield.
fn terrain_ring_data_lod(ring: u32) -> u32 {
    // #if terrain_streaming
    return terrain_geometry.ring_data_lod[ring / 4u][ring % 4u];
    // #else
    return 0u;
    // #endif
}
// #endif

fn terrain_normal(uv: vec2<f32>) -> vec3<f32> {
    let dimensions = terrain_height_dims();
    let max_texel = vec2<i32>(i32(dimensions.x) - 1, i32(dimensions.y) - 1);
    let scaled_uv = uv * vec2<f32>(f32(dimensions.x - 1u), f32(dimensions.y - 1u));
    let center = vec2<i32>(i32(round(scaled_uv.x)), i32(round(scaled_uv.y)));
    let center_height = height_at(center, max_texel);
    let left = height_or_center(center + vec2<i32>(-1, 0), max_texel, center_height);
    let right = height_or_center(center + vec2<i32>(1, 0), max_texel, center_height);
    let up = height_or_center(center + vec2<i32>(0, -1), max_texel, center_height);
    let down = height_or_center(center + vec2<i32>(0, 1), max_texel, center_height);
    let tangent_x = vec3<f32>(2.0 * params.spacing.x, (right - left) * params.exaggeration, 0.0);
    let tangent_z = vec3<f32>(0.0, (down - up) * params.exaggeration, 2.0 * params.spacing.y);
    return normalize(cross(tangent_z, tangent_x));
}

fn height_at(texel: vec2<i32>, max_texel: vec2<i32>) -> f32 {
    return terrain_height_load(clamp(texel, vec2<i32>(0, 0), max_texel));
}

fn height_or_center(texel: vec2<i32>, max_texel: vec2<i32>, center_height: f32) -> f32 {
    let value = height_at(texel, max_texel);
    return select(center_height, value, is_valid_height(value));
}

fn terrain_edge_fade(uv: vec2<f32>) -> f32 {
    let edge_distance = min(min(uv.x, uv.y), min(1.0 - uv.x, 1.0 - uv.y));
    return smoothstep(0.0, 0.35, edge_distance);
}

// Terrain screen render mode: ports the historical terrain_pbr_pom screen
// path (fullscreen coverage, stylized hillshade composition, filmic tonemap).

fn screen_height_sample(uv_in: vec2<f32>) -> f32 {
    // The historical screen path binds the R32Float heightmap without float
    // filtering, so every height fetch resolves to the nearest texel
    // (clamp-to-edge); normals are piecewise constant per texel. Fetching
    // through the nearest sampler (not `floor(uv * dims)`) keeps the
    // hardware's sub-texel coordinate rounding, exactly like native.
    let uv = clamp(uv_in, vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 1.0));
    // #if terrain_streaming
    // Under streaming `heightmap` is the slot atlas: the material path's
    // height reads (tm_shade, POM, coverage) go through the page table.
    return terrain_height_bilinear_lod(uv, 0u);
    // #else
    return textureSampleLevel(heightmap, nearest_sampler, uv, 0.0).r;
    // #endif
}

fn screen_hue_variation(
    albedo: vec3<f32>,
    slope_factor: f32,
    height_norm: f32,
    hue_shift_strength: f32,
) -> vec3<f32> {
    if (hue_shift_strength <= 0.0) {
        return albedo;
    }
    let max_c = max(max(albedo.r, albedo.g), albedo.b);
    let min_c = min(min(albedo.r, albedo.g), albedo.b);
    let delta = max_c - min_c;
    if (delta < 0.001) {
        return albedo;
    }
    var hue: f32;
    if (max_c == albedo.r) {
        hue = ((albedo.g - albedo.b) / delta) / 6.0;
        if (hue < 0.0) {
            hue = hue + 1.0;
        }
    } else if (max_c == albedo.g) {
        hue = (2.0 + (albedo.b - albedo.r) / delta) / 6.0;
    } else {
        hue = (4.0 + (albedo.r - albedo.g) / delta) / 6.0;
    }
    let saturation = delta / max_c;
    let value = max_c;
    let slope_shift = (slope_factor - 0.5) * hue_shift_strength;
    let elev_shift = (height_norm - 0.5) * hue_shift_strength * 0.4;
    let noise_shift = (saturation - 0.5) * hue_shift_strength * 0.5;
    let new_hue = fract(hue + slope_shift + elev_shift + noise_shift);
    let c = saturation * value;
    let x = c * (1.0 - abs(fract(new_hue * 6.0) * 2.0 - 1.0));
    let m = value - c;
    var rgb: vec3<f32>;
    let h6 = new_hue * 6.0;
    if (h6 < 1.0) {
        rgb = vec3<f32>(c, x, 0.0);
    } else if (h6 < 2.0) {
        rgb = vec3<f32>(x, c, 0.0);
    } else if (h6 < 3.0) {
        rgb = vec3<f32>(0.0, c, x);
    } else if (h6 < 4.0) {
        rgb = vec3<f32>(0.0, x, c);
    } else if (h6 < 5.0) {
        rgb = vec3<f32>(x, 0.0, c);
    } else {
        rgb = vec3<f32>(c, 0.0, x);
    }
    return rgb + vec3<f32>(m, m, m);
}

fn tonemap_filmic_terrain(color: vec3<f32>) -> vec3<f32> {
    let a = 0.22;
    let b = 0.30;
    let c = 0.10;
    let d = 0.20;
    let e = 0.01;
    let f = 0.30;
    let w = 11.2;
    let x = max(color, vec3<f32>(0.0));
    let curve = ((x * (a * x + vec3<f32>(c * b)) + vec3<f32>(d * e))
        / (x * (a * x + vec3<f32>(b)) + vec3<f32>(d * f)))
        - vec3<f32>(e / f);
    let white = ((w * (a * w + c * b) + d * e) / (w * (a * w + b) + d * f))
        - e / f;
    return clamp(curve / white, vec3<f32>(0.0), vec3<f32>(1.0));
}

fn srgb_eotf_decode(c: vec3<f32>) -> vec3<f32> {
    let lo = c / 12.92;
    let hi = pow((c + vec3<f32>(0.055)) / 1.055, vec3<f32>(2.4));
    return select(hi, lo, c <= vec3<f32>(0.04045));
}

// Historical screen-mode comparison sampling: the native shadow sampler was a
// linear comparison sampler, so each requested uv blends four binary
// depth-test results on cascade layer 0.
fn screen_shadow_compare_linear(shadow_uv: vec2<f32>, depth: f32) -> f32 {
    let size = max(forge3d_shadows.params0.x, 1.0);
    let dims = vec2<i32>(i32(size), i32(size));
    let p = shadow_uv * size - vec2<f32>(0.5, 0.5);
    let base = vec2<i32>(floor(p));
    let f = p - floor(p);
    var total = 0.0;
    for (var oy = 0; oy < 2; oy = oy + 1) {
        for (var ox = 0; ox < 2; ox = ox + 1) {
            let texel = clamp(
                base + vec2<i32>(ox, oy),
                vec2<i32>(0, 0),
                dims - vec2<i32>(1, 1),
            );
            let stored = textureLoad(forge3d_shadow_depth, texel, 0, 0);
            let lit = select(0.0, 1.0, depth <= stored);
            let weight = select(1.0 - f.x, f.x, ox == 1)
                * select(1.0 - f.y, f.y, oy == 1);
            total = total + lit * weight;
        }
    }
    return total;
}

fn terrain_screen_shadow(
    uv: vec2<f32>,
    height_norm: f32,
    normal: vec3<f32>,
    light_dir: vec3<f32>,
) -> f32 {
    if (!forge3d_shadow_enabled() || forge3d_shadows.control.z == 0u) {
        return 1.0;
    }
    // Historical screen-mode receiver: native Z-up position on the unit tile.
    let receiver = vec3<f32>(
        uv.x - 0.5,
        uv.y - 0.5,
        height_norm * params.exaggeration,
    );
    let clip = forge3d_shadows.matrices[0] * vec4<f32>(receiver, 1.0);
    let ndc = clip.xyz / clip.w;
    let shadow_uv = vec2<f32>(ndc.x * 0.5 + 0.5, ndc.y * -0.5 + 0.5);
    if (shadow_uv.x < 0.0 || shadow_uv.x > 1.0
        || shadow_uv.y < 0.0 || shadow_uv.y > 1.0
        || ndc.z < 0.0 || ndc.z > 1.0)
    {
        return 1.0;
    }
    let n_dot_l = max(dot(normal, light_dir), 0.0);
    let slope = clamp(1.0 - n_dot_l, 0.0, 1.0);
    let bias = forge3d_shadows.params0.z
        + forge3d_shadows.params1.x * slope
        + forge3d_shadows.params0.w;
    let compare_depth = ndc.z - bias;
    let filter_scale = max(forge3d_shadows.params2.x, 1.0);
    let texel_uv = (1.0 / max(forge3d_shadows.params0.x, 1.0)) * filter_scale;
    var sum = 0.0;
    for (var y = -2; y <= 2; y = y + 1) {
        for (var x = -2; x <= 2; x = x + 1) {
            sum = sum + screen_shadow_compare_linear(
                shadow_uv + vec2<f32>(f32(x), f32(y)) * texel_uv,
                compare_depth,
            );
        }
    }
    return sum / 25.0;
}

fn terrain_screen_shade(input: VertexOutput) -> vec4<f32> {
    // Screen mode always runs the native terrain material path (the
    // default material when none is set); the runtime never selects a
    // screen variant without the `terrain_material` region.
    // #if terrain_material
    return tm_display(terrain_screen_sample(input));
    // #else
    return vec4<f32>(color_ramp.clear_color.xyz, 1.0);
    // #endif
}

/// Pre-tonemap screen-mode radiance with its albedo and shading normal.
fn terrain_screen_sample(input: VertexOutput) -> TerrainSample {
    // #if terrain_material
    return tm_screen_sample(input);
    // #else
    var empty: TerrainSample;
    empty.radiance = color_ramp.clear_color.xyz;
    empty.albedo = vec3<f32>(0.0);
    empty.normal = vec3<f32>(0.0, 0.0, 1.0);
    empty.covered = false;
    return empty;
    // #endif
}

// #if capture
// Offline/AOV capture: primary targets (HDR color, normalized linear depth,
// object ID, pixel motion) and surface targets (albedo, shading normal).
struct CapturePrimaryOutput {
    @location(0) color: vec4<f32>,
    @location(1) depth: f32,
    @location(2) id: u32,
    @location(3) motion: vec2<f32>,
};

struct CaptureSurfaceOutput {
    @location(0) albedo: vec4<f32>,
    @location(1) normal: vec4<f32>,
};

fn terrain_capture_sample(input: VertexOutput) -> TerrainSample {
    var result: TerrainSample;
    result.radiance = color_ramp.clear_color.xyz;
    result.albedo = vec3<f32>(0.0);
    result.normal = vec3<f32>(0.0);
    result.covered = false;
    // #if terrain_screen
    if (params.render_mode == 1u) {
        result = terrain_screen_sample(input);
    }
    // #endif
    // #if terrain_perspective
    if (params.render_mode != 1u) {
        result = terrain_perspective_sample(input);
    }
    // #endif
    if (params.debug_view == 1u || params.debug_view == 2u) {
        result.radiance = vec3<f32>(analysis_gray(input.uv, params.debug_view));
    }
    return result;
}

fn capture_linear_depth(world_position: vec3<f32>) -> f32 {
    let view_depth = dot(
        camera.camera_forward.xyz,
        world_position - camera.camera_position.xyz,
    );
    let near = camera.capture_params.x;
    let far = camera.capture_params.y;
    return clamp((view_depth - near) / max(far - near, 1e-5), 0.0, 1.0);
}

fn capture_motion(world_position: vec3<f32>) -> vec2<f32> {
    let current = camera.motion_current * vec4<f32>(world_position, 1.0);
    let previous = camera.motion_previous * vec4<f32>(world_position, 1.0);
    if (abs(current.w) < 1e-12 || abs(previous.w) < 1e-12) {
        return vec2<f32>(0.0);
    }
    let delta = current.xy / current.w - previous.xy / previous.w;
    return delta * vec2<f32>(0.5 * camera.capture_params.z, -0.5 * camera.capture_params.w);
}

@fragment
fn fs_capture_primary(input: VertexOutput) -> CapturePrimaryOutput {
    let shaded = terrain_capture_sample(input);
    var output: CapturePrimaryOutput;
    output.color = vec4<f32>(shaded.radiance, 1.0);
    output.depth = select(1.0, capture_linear_depth(input.world_position), shaded.covered);
    output.id = select(0u, camera.capture_ids.x, shaded.covered);
    // Screen mode covers fixed NDC; only perspective terrain moves on screen.
    output.motion = select(
        vec2<f32>(0.0),
        capture_motion(input.world_position),
        shaded.covered && params.render_mode != 1u,
    );
    return output;
}

@fragment
fn fs_capture_surface(input: VertexOutput) -> CaptureSurfaceOutput {
    let shaded = terrain_capture_sample(input);
    var output: CaptureSurfaceOutput;
    output.albedo = select(vec4<f32>(0.0), vec4<f32>(shaded.albedo, forge3d_material(0u).surface.x), shaded.covered);
    output.normal = select(vec4<f32>(0.0), vec4<f32>(shaded.normal, forge3d_material(0u).surface.y), shaded.covered);
    return output;
}
// #endif

"#,
);

#[cfg(test)]
mod w08_slot_tests {
    use super::*;
    #[test]
    fn vt_storage_limits_count_actual_probe_and_base_layouts() {
        let storage = |entries: &[wgpu::BindGroupLayoutEntry]| {
            entries
                .iter()
                .filter(|entry| {
                    entry.visibility.contains(wgpu::ShaderStages::FRAGMENT)
                        && matches!(
                            entry.ty,
                            wgpu::BindingType::Buffer {
                                ty: wgpu::BufferBindingType::Storage { .. },
                                ..
                            }
                        )
                })
                .count() as u32
        };
        let all = W08Slots {
            page_table: true,
            overlays: true,
            vt: true,
        };
        let terrain = storage(&terrain_layout_entries(all));
        assert_eq!(
            terrain + storage(&super::super::lighting::lighting_layout_entries()),
            W08_STORAGE_BUFFERS_VT
        );
        assert_eq!(
            terrain + storage(&super::super::lighting::lighting_layout_entries_with_probes()),
            W09_STORAGE_BUFFERS_VT_PROBES
        );
        assert!(W08Slots::for_limits_with_probes(24, 3, false, false).vt);
        assert!(!W08Slots::for_limits_with_probes(24, 3, false, true).vt);
        assert!(W08Slots::for_limits_with_probes(24, 4, false, true).vt);
    }

    fn fragment_textures(entries: &[wgpu::BindGroupLayoutEntry]) -> u32 {
        entries
            .iter()
            .filter(|entry| {
                entry.visibility.contains(wgpu::ShaderStages::FRAGMENT)
                    && matches!(entry.ty, wgpu::BindingType::Texture { .. })
            })
            .count() as u32
    }

    /// Fragment sampled textures of a terrain pipeline profile, counted from
    /// the real layout entries of groups 0-3.
    fn pipeline_textures(slots: W08Slots, scene_textures: bool) -> u32 {
        let mut count = fragment_textures(&terrain_layout_entries(slots))
            + fragment_textures(&super::super::lighting::lighting_layout_entries())
            + fragment_textures(&super::super::ibl::ibl_layout_entries())
            + fragment_textures(&super::super::shadows::shadow_layout_entries());
        if scene_textures {
            count += fragment_textures(&super::super::textures::texture_layout_entries());
        }
        count
    }

    #[test]
    fn w10_optional_bindings_fit_their_real_profiles() {
        let uniform_count = |entries: &[wgpu::BindGroupLayoutEntry]| {
            entries
                .iter()
                .filter(|e| {
                    e.visibility.contains(wgpu::ShaderStages::FRAGMENT)
                        && matches!(
                            e.ty,
                            wgpu::BindingType::Buffer {
                                ty: wgpu::BufferBindingType::Uniform,
                                ..
                            }
                        )
                })
                .count()
        };
        for textured in [false, true] {
            for probes in [false, true] {
                for reflection in [false, true] {
                    for aerial in [false, true] {
                        let cap = if textured && reflection { 20 } else { 16 };
                        let slots = W08Slots::for_limits_with_probes(cap, 8, textured, probes);
                        let group0 = terrain_layout_entries(slots);
                        let group1 = if probes {
                            super::super::lighting::lighting_layout_entries_with_probes()
                        } else {
                            super::super::lighting::lighting_layout_entries()
                        };
                        let group2 = super::super::environment::reflection::masked_layout_entries(
                            textured, reflection, aerial,
                        );
                        let group3 = super::super::ibl::ibl_layout_entries()
                            .into_iter()
                            .chain(super::super::shadows::shadow_layout_entries())
                            .collect::<Vec<_>>();
                        assert!(
                            fragment_textures(&group0)
                                + fragment_textures(&group1)
                                + fragment_textures(&group2)
                                + fragment_textures(&group3)
                                <= cap
                        );
                        assert!(
                            uniform_count(&group0)
                                + uniform_count(&group1)
                                + uniform_count(&group2)
                                + uniform_count(&group3)
                                <= 12
                        );
                        assert_eq!(uniform_count(&group2), usize::from(reflection || aerial));
                    }
                }
            }
        }
    }
    const NONE: W08Slots = W08Slots {
        page_table: false,
        overlays: false,
        vt: false,
    };

    #[test]
    fn base_constants_match_the_real_layouts() {
        assert_eq!(
            pipeline_textures(NONE, false),
            TERRAIN_BASE_SAMPLED_TEXTURES
        );
        assert_eq!(
            pipeline_textures(NONE, true),
            TERRAIN_BASE_SAMPLED_TEXTURES + TERRAIN_SCENE_TEXTURE_SLOTS
        );
        let stacked = [
            W08Slots {
                page_table: true,
                ..NONE
            },
            W08Slots {
                page_table: true,
                overlays: true,
                vt: false,
            },
            W08Slots {
                page_table: true,
                overlays: true,
                vt: true,
            },
        ];
        for (stack, slots) in (1u32..).zip(stacked) {
            for scene_textures in [false, true] {
                assert_eq!(
                    pipeline_textures(slots, scene_textures),
                    W08Slots::required(scene_textures, stack),
                    "stack {stack} textured {scene_textures}"
                );
            }
        }
    }

    #[test]
    fn untextured_terrain_fits_every_w08_slot_in_the_webgpu_default() {
        let slots = W08Slots::for_limits(16, 8, false);
        assert_eq!(
            slots,
            W08Slots {
                page_table: true,
                overlays: true,
                vt: true
            }
        );
        assert!(pipeline_textures(slots, false) <= 16);
        // A textured material 0 leaves no W08 headroom at the default.
        assert_eq!(W08Slots::for_limits(16, 8, true), NONE);
    }

    #[test]
    fn profiles_never_exceed_the_negotiated_limit() {
        for sampled in 16..=24 {
            for scene_textures in [false, true] {
                let slots = W08Slots::for_limits(sampled, 8, scene_textures);
                assert!(
                    pipeline_textures(slots, scene_textures) <= sampled,
                    "sampled {sampled} textured {scene_textures}"
                );
            }
        }
        // Textured thresholds: 17 page table, 18 overlays, 19 VT.
        assert!(W08Slots::for_limits(17, 8, true).page_table);
        assert!(!W08Slots::for_limits(17, 8, true).overlays);
        assert!(W08Slots::for_limits(18, 8, true).overlays);
        assert!(!W08Slots::for_limits(18, 8, true).vt);
        assert!(W08Slots::for_limits(19, 8, true).vt);
        // VT also needs the storage-buffer headroom.
        assert!(!W08Slots::for_limits(24, W08_STORAGE_BUFFERS_VT - 1, false).vt);
    }

    #[test]
    fn keeps_drops_only_the_missing_w08_bindings() {
        let slots = W08Slots {
            page_table: true,
            overlays: false,
            vt: false,
        };
        for binding in [0, 5, 8, 12, 13] {
            assert!(slots.keeps(binding), "binding {binding}");
        }
        for binding in 14..=19 {
            assert!(!slots.keeps(binding), "binding {binding}");
        }
    }
}

pub(super) fn reflection_pipeline(
    device: &wgpu::Device,
    runtime: &super::Forge3DRuntime,
    features: ShaderFeatures,
    format: wgpu::TextureFormat,
) -> wgpu::RenderPipeline {
    let textures = runtime.textures.as_ref().unwrap();
    let ibl = runtime.ibl.as_ref().unwrap();
    let lighting = runtime.lighting.as_ref().unwrap();
    let mut cache = TerrainPipelineCache::new(
        device,
        &lighting.bind_group_layout,
        &lighting.probe_bind_group_layout,
        &textures.bind_group_layout,
        &ibl.bind_group_layout,
    );
    cache.variant(device, features, format).pipeline
}
