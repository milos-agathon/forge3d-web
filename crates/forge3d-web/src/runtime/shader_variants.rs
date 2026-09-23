//! Feature-specialized WGSL for the shared lighting stack.
//!
//! The terrain and world shaders carry every BRDF model, light kind, texture
//! channel, shadow filter and IBL path, each selected at runtime by a uniform or
//! a per-material lane. Compiling all of them for every pipeline is the dominant
//! runtime-creation cost on GPUs without a warm shader cache. The WGSL sources
//! mark optional regions with `// #if <feature>` / `// #else` / `// #endif`, and
//! each pipeline is compiled from a variant that keeps only the regions its
//! current scene state can reach. A region is gated only where the same runtime
//! condition already skips it, so every variant renders identically to the full
//! template for the state it was generated from.

use forge3d_core::lighting::{Light, LightingState};
use forge3d_core::materials::MaterialState;

use crate::error::{Forge3DErrorCode, WebError};

/// Bit set of reachable shader regions.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) struct ShaderFeatures(u64);

const BRDF_MODEL_COUNT: u32 = 13;
const SHADOW_FILTER_COUNT: u32 = 6;

const LIGHT_DIRECTIONAL: u64 = 1 << 13;
const LIGHT_POINT_SPOT: u64 = 1 << 14;
const LIGHT_RECT: u64 = 1 << 15;
const TEX_BASE: u64 = 1 << 16;
const TEX_NORMAL: u64 = 1 << 17;
const TEX_METALLIC_ROUGHNESS: u64 = 1 << 18;
const TEX_OCCLUSION: u64 = 1 << 19;
const TEX_EMISSIVE: u64 = 1 << 20;
const LIGHT_DEBUG_BOUNDS: u64 = 1 << 21;
const IBL: u64 = 1 << 22;
const SHADOWS: u64 = 1 << 23;
const SHADOW_FILTER_BASE: u32 = 24;
const SHADOW_DEBUG_CASCADES: u64 = 1 << 30;
const SHADOW_DEBUG_FACTOR: u64 = 1 << 31;
const TERRAIN_SCREEN: u64 = 1 << 32;
const TERRAIN_PERSPECTIVE: u64 = 1 << 33;
#[cfg(test)]
const ALL_BITS: u64 = (1 << 34) - 1;

impl ShaderFeatures {
    /// Every region: the unspecialized template.
    #[cfg(test)]
    pub(crate) const ALL: Self = Self(ALL_BITS);

    pub(crate) fn bits(self) -> u64 {
        self.0
    }

    #[cfg(test)]
    pub(crate) fn from_bits(bits: u64) -> Self {
        Self(bits & ALL_BITS)
    }

    fn with(self, bit: u64, enabled: bool) -> Self {
        if enabled {
            Self(self.0 | bit)
        } else {
            self
        }
    }

    /// Regions reachable by the shared lighting code for this runtime state.
    ///
    /// `shadow_control` is the `control` lane of the shadow uniform the GPU
    /// reads: `[enabled, filter lane, cascade count, debug mode]`.
    pub(crate) fn for_lighting(
        lighting: &LightingState,
        materials: &MaterialState,
        ibl_enabled: bool,
        shadow_control: [u32; 4],
    ) -> Self {
        let mut bits = 0u64;
        let mut texture_flags = 0u32;
        for material in materials.pack_materials() {
            if material.effective_brdf < BRDF_MODEL_COUNT {
                bits |= 1 << material.effective_brdf;
            }
            texture_flags |= material.flags;
        }
        for light in &lighting.lights {
            bits |= match light {
                Light::Directional(_) => LIGHT_DIRECTIONAL,
                Light::Point(_) | Light::Spot(_) => LIGHT_POINT_SPOT,
                Light::Rect(_) => LIGHT_RECT,
            };
        }
        let shadows_on = shadow_control[0] != 0;
        let mut features = Self(bits)
            .with(TEX_BASE, texture_flags & 1 != 0)
            .with(TEX_NORMAL, texture_flags & 2 != 0)
            .with(TEX_METALLIC_ROUGHNESS, texture_flags & 4 != 0)
            .with(TEX_OCCLUSION, texture_flags & 8 != 0)
            .with(TEX_EMISSIVE, texture_flags & 16 != 0)
            .with(LIGHT_DEBUG_BOUNDS, lighting.debug_bounds)
            .with(IBL, ibl_enabled)
            .with(SHADOWS, shadows_on)
            .with(SHADOW_DEBUG_CASCADES, shadow_control[3] == 1)
            .with(SHADOW_DEBUG_FACTOR, shadow_control[3] == 2);
        if shadows_on {
            // Lanes past the last filter fall through to the switch default (MSM).
            let lane = shadow_control[1].min(SHADOW_FILTER_COUNT - 1);
            features = features.with(1 << (SHADOW_FILTER_BASE + lane), true);
        }
        features
    }

    /// Adds the terrain render-mode region (`0` perspective, `1` screen).
    pub(crate) fn with_terrain_mode(self, render_mode: u32) -> Self {
        let cleared = Self(self.0 & !(TERRAIN_SCREEN | TERRAIN_PERSPECTIVE));
        if render_mode == 1 {
            cleared.with(TERRAIN_SCREEN, true)
        } else {
            cleared.with(TERRAIN_PERSPECTIVE, true)
        }
    }

    fn enabled(self, name: &str) -> bool {
        let bit = match name {
            "light_directional" => LIGHT_DIRECTIONAL,
            "light_point_spot" => LIGHT_POINT_SPOT,
            "light_rect" => LIGHT_RECT,
            "tex_base" => TEX_BASE,
            "tex_normal" => TEX_NORMAL,
            "tex_metallic_roughness" => TEX_METALLIC_ROUGHNESS,
            "tex_occlusion" => TEX_OCCLUSION,
            "tex_emissive" => TEX_EMISSIVE,
            "light_debug_bounds" => LIGHT_DEBUG_BOUNDS,
            "ibl" => IBL,
            "shadows" => SHADOWS,
            "shadow_debug_cascades" => SHADOW_DEBUG_CASCADES,
            "shadow_debug_factor" => SHADOW_DEBUG_FACTOR,
            "terrain_screen" => TERRAIN_SCREEN,
            "terrain_perspective" => TERRAIN_PERSPECTIVE,
            other => {
                if let Some(model) = other.strip_prefix("brdf_") {
                    let model: u32 = model.parse().expect("brdf feature index");
                    assert!(model < BRDF_MODEL_COUNT, "unknown brdf feature {other}");
                    1 << model
                } else if let Some(lane) = other.strip_prefix("shadow_filter_") {
                    let lane: u32 = lane.parse().expect("shadow filter feature index");
                    assert!(lane < SHADOW_FILTER_COUNT, "unknown shadow filter {other}");
                    1 << (SHADOW_FILTER_BASE + lane)
                } else {
                    panic!("unknown shader feature {other}");
                }
            }
        };
        self.0 & bit != 0
    }

    /// Evaluates `name`, `!name`, or `a || b || ...`.
    fn condition(self, expression: &str) -> bool {
        expression.split("||").any(|term| {
            let term = term.trim();
            match term.strip_prefix('!') {
                Some(name) => !self.enabled(name.trim()),
                None => self.enabled(term),
            }
        })
    }
}

/// Expands `// #if` / `// #else` / `// #endif` markers for `features`.
///
/// Marker lines are dropped; nesting is supported. Panics on malformed
/// markers, which are compile-time constants covered by unit tests.
pub(crate) fn specialize(template: &str, features: ShaderFeatures) -> String {
    // (branch taken for this level, parent active)
    let mut stack: Vec<(bool, bool)> = Vec::new();
    let mut output = String::with_capacity(template.len());
    for line in template.lines() {
        let trimmed = line.trim();
        let active = stack
            .last()
            .map(|&(taken, parent)| taken && parent)
            .unwrap_or(true);
        if let Some(expression) = trimmed.strip_prefix("// #if ") {
            stack.push((features.condition(expression), active));
            continue;
        }
        if trimmed == "// #else" {
            let (taken, parent) = stack.pop().expect("#else without #if");
            stack.push((!taken, parent));
            continue;
        }
        if trimmed == "// #endif" {
            stack.pop().expect("#endif without #if");
            continue;
        }
        if active {
            output.push_str(line);
            output.push('\n');
        }
    }
    assert!(stack.is_empty(), "unterminated #if in shader template");
    output
}

/// Shared-lighting features for the given resources.
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub(super) fn lighting_features(
    lighting: &super::lighting::LightingResources,
    ibl: &super::ibl::IblResources,
    shadows: &super::shadows::ShadowResources,
) -> ShaderFeatures {
    ShaderFeatures::for_lighting(
        &lighting.state,
        &lighting.material_state,
        ibl.enabled,
        shadows.control,
    )
}

/// Shared-lighting features for the runtime's committed state.
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub(super) fn runtime_lighting_features(
    runtime: &super::Forge3DRuntime,
) -> Result<ShaderFeatures, WebError> {
    match (
        runtime.lighting.as_ref(),
        runtime.ibl.as_ref(),
        runtime.shadows.as_ref(),
    ) {
        (Some(lighting), Some(ibl), Some(shadows)) => Ok(lighting_features(lighting, ibl, shadows)),
        _ => Err(WebError::new(
            Forge3DErrorCode::RuntimeDisposed,
            "Runtime lighting resources are not available",
        )),
    }
}

/// Points the terrain and world pipelines at the variants for the current
/// state. Called before every frame and readback; a no-op when nothing that
/// selects a shader region changed since the last call.
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub(super) fn sync_pipelines(runtime: &mut super::Forge3DRuntime) -> Result<(), WebError> {
    if runtime.lighting.is_none() {
        return Ok(());
    }
    let features = runtime_lighting_features(runtime)?;
    let (Some(context), Some(surface)) = (runtime.context.clone(), runtime.surface_state.as_ref())
    else {
        return Ok(());
    };
    let format = surface.config.format;
    if let (Some(terrain), Some(cache)) = (
        runtime.terrain.as_mut(),
        runtime.terrain_pipeline_cache.as_mut(),
    ) {
        if terrain.features != features.with_terrain_mode(terrain.render_mode) {
            terrain.use_variant(&context, cache, features, format);
        }
    }
    if let (Some(scene), Some(textures), Some(ibl)) = (
        runtime.scene.as_mut(),
        runtime.textures.as_ref(),
        runtime.ibl.as_ref(),
    ) {
        scene.use_world_variant(&context, features, textures, ibl);
    }
    Ok(())
}

#[cfg(test)]
mod tests;
