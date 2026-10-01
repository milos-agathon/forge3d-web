#![cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
mod froxel;
mod gpu;
mod reflection;
#[cfg(test)]
mod tests;
use crate::{
    error::{Forge3DErrorCode, WebError},
    runtime::Forge3DRuntime,
};
use forge3d_core::{environment::Environment, memory::MemoryCategory};
pub(super) use gpu::EnvironmentResources;
pub(super) const KEY: &str = "environment:resources";
pub(super) fn invalid(s: impl Into<String>) -> WebError {
    WebError::new(Forge3DErrorCode::InvalidInput, s)
}
pub(super) fn parse(value: wasm_bindgen::JsValue) -> Result<Option<Environment>, WebError> {
    if value.is_null() || value.is_undefined() {
        return Ok(None);
    }
    let s: Environment =
        serde_wasm_bindgen::from_value(value).map_err(|e| invalid(format!("environment: {e}")))?;
    s.validate().map_err(invalid)?;
    Ok(Some(s))
}
pub(super) fn prepare(
    runtime: &Forge3DRuntime,
    s: Option<&Environment>,
    planned: &mut super::memory::MemoryLedger,
) -> Result<Option<EnvironmentResources>, WebError> {
    let Some(s) = s else {
        planned.release(KEY);
        return Ok(None);
    };
    s.validate().map_err(invalid)?;
    let context = runtime
        .context
        .as_ref()
        .ok_or_else(|| invalid("GPU context unavailable"))?;
    let mut selected = s.clone();
    let bytes = |s: &Environment| s.gpu_bytes(runtime.width, runtime.height);
    if !planned.fits_after_release(&[KEY], bytes(&selected))
        && matches!(
            runtime.overflow_policy,
            forge3d_core::memory::OverflowPolicy::Downscale
        )
        && selected.resolution_scale == 1.0
    {
        selected.resolution_scale = 0.5;
        selected.steps = (selected.steps / 2).max(8);
    }
    planned.replace(KEY, MemoryCategory::Textures, bytes(&selected))?;
    let format = runtime
        .surface_state
        .as_ref()
        .ok_or_else(|| invalid("surface unavailable"))?
        .config
        .format;
    let limits = context.device.limits();
    if selected.volumetric_mode == "froxel"
        && (runtime.width.div_ceil(8) > limits.max_texture_dimension_3d
            || runtime.height.div_ceil(8) > limits.max_texture_dimension_3d
            || selected.steps > limits.max_texture_dimension_3d)
    {
        return Err(WebError::new(
            Forge3DErrorCode::ResourceLimitExceeded,
            "froxel grid exceeds 3D texture limit",
        ));
    }
    let limit = limits.max_storage_buffer_binding_size as u64;
    if selected.payload_floats() as u64 * 4 > limit {
        return Err(WebError::new(
            Forge3DErrorCode::ResourceLimitExceeded,
            "environment payload exceeds storage binding limit",
        ));
    }
    Ok(Some(EnvironmentResources::new(
        context,
        selected,
        runtime.width,
        runtime.height,
        format,
    )))
}
pub(super) fn set(
    runtime: &mut Forge3DRuntime,
    value: wasm_bindgen::JsValue,
) -> Result<(), WebError> {
    let s = parse(value)?;
    let mut planned = runtime.memory.clone();
    let mut env = prepare(runtime, s.as_ref(), &mut planned)?;
    let original = runtime
        .environment
        .as_ref()
        .and_then(|e| e.original_lighting.clone())
        .or_else(|| {
            runtime
                .lighting
                .as_ref()
                .map(|l| (l.state.clone(), l.light_ids.clone()))
        });
    if let Some(e) = &mut env {
        e.original_lighting = original;
    } else if let (Some((state, ids)), Some(lighting), Some(context)) =
        (original, &mut runtime.lighting, &runtime.context)
    {
        lighting.commit_state(context, &state, ids);
    }
    runtime.environment = env;
    runtime.memory = planned;
    Ok(())
}
pub(super) fn refresh(runtime: &mut Forge3DRuntime) -> Result<(), WebError> {
    if let (Some(e), Some(lighting), Some(context)) = (
        &runtime.environment,
        &mut runtime.lighting,
        &runtime.context,
    ) {
        let d = e.snapshot.sun_at(runtime.time_seconds);
        let mut state = lighting.state.clone();
        if let Some(forge3d_core::lighting::Light::Directional(sun)) = state
            .lights
            .iter_mut()
            .find(|l| matches!(l, forge3d_core::lighting::Light::Directional(_)))
        {
            sun.direction = d.map(|x| -x);
            sun.color = e.snapshot.sun_color;
            sun.intensity = if d[1] > 0.0 {
                e.snapshot.sun_intensity
            } else {
                0.0
            };
            lighting.commit_state(context, &state, lighting.light_ids.clone());
        }
    }
    if let Some(e) = &runtime.environment {
        e.update(runtime)?;
    }
    Ok(())
}
pub(super) fn prepare_resize(
    runtime: &Forge3DRuntime,
    width: u32,
    height: u32,
    planned: &mut super::memory::MemoryLedger,
) -> Result<Option<EnvironmentResources>, WebError> {
    let Some(old) = runtime.environment.as_ref() else {
        return Ok(None);
    };
    let context = runtime
        .context
        .as_ref()
        .ok_or_else(|| invalid("context unavailable"))?;
    let s = old.snapshot.clone();
    let limit = context.device.limits().max_texture_dimension_3d;
    if s.volumetric_mode == "froxel"
        && (width.div_ceil(8) > limit || height.div_ceil(8) > limit || s.steps > limit)
    {
        return Err(WebError::new(
            Forge3DErrorCode::ResourceLimitExceeded,
            "resized froxel grid exceeds 3D texture limit",
        ));
    }
    planned.replace(KEY, MemoryCategory::Textures, s.gpu_bytes(width, height))?;
    let format = runtime
        .surface_state
        .as_ref()
        .ok_or_else(|| invalid("surface unavailable"))?
        .config
        .format;
    let mut environment = EnvironmentResources::new(context, s, width, height, format);
    environment.original_lighting = old.original_lighting.clone();
    Ok(Some(environment))
}
pub(super) fn resize(
    runtime: &mut Forge3DRuntime,
    width: u32,
    height: u32,
) -> Result<(), WebError> {
    let mut planned = runtime.memory.clone();
    let environment = prepare_resize(runtime, width, height, &mut planned)?;
    runtime.environment = environment;
    runtime.memory = planned;
    Ok(())
}
