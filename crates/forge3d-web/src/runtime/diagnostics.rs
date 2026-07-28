use wasm_bindgen::prelude::*;

#[cfg(target_arch = "wasm32")]
use super::device_health::set_js_property;
#[cfg(target_arch = "wasm32")]
use super::render::{reconfigure_surface, recreate_surface};
use super::Forge3DRuntime;
use crate::error::{Forge3DErrorCode, WebError};

#[cfg(target_arch = "wasm32")]
pub(super) fn simulate_surface_failure(
    runtime: &mut Forge3DRuntime,
    failure: &str,
    force_format_change: bool,
) -> Result<JsValue, WebError> {
    let result = js_sys::Object::new();
    match failure {
        "outdated" => {
            if force_format_change {
                return Err(WebError::new(
                    Forge3DErrorCode::InvalidInput,
                    "Outdated recovery cannot force a surface-format change",
                ));
            }
            reconfigure_surface(runtime)?;
            set_js_property(result.as_ref(), "action", &JsValue::from_str("reconfigure"));
            set_js_property(
                result.as_ref(),
                "surfaceFormat",
                &JsValue::from_str(&runtime.surface_format),
            );
            set_js_property(result.as_ref(), "pipelineRebuilt", &JsValue::FALSE);
        }
        "lost" => {
            let report = recreate_surface(runtime, force_format_change)?;
            set_js_property(result.as_ref(), "action", &JsValue::from_str("recreate"));
            set_js_property(
                result.as_ref(),
                "oldSurfaceFormat",
                &JsValue::from_str(&format!("{:?}", report.old_format)),
            );
            set_js_property(
                result.as_ref(),
                "surfaceFormat",
                &JsValue::from_str(&format!("{:?}", report.new_format)),
            );
            set_js_property(
                result.as_ref(),
                "pipelineRebuilt",
                &JsValue::from_bool(report.pipeline_rebuilt),
            );
        }
        _ => {
            return Err(WebError::new(
                Forge3DErrorCode::InvalidInput,
                "Diagnostic surface failure must be 'outdated' or 'lost'",
            ));
        }
    }
    Ok(result.into())
}

#[cfg(not(target_arch = "wasm32"))]
pub(super) fn simulate_surface_failure(
    _runtime: &mut Forge3DRuntime,
    _failure: &str,
    _force_format_change: bool,
) -> Result<JsValue, WebError> {
    Err(WebError::new(
        Forge3DErrorCode::UnsupportedFeature,
        "Surface-failure simulation is only available in wasm32 browser builds",
    ))
}

#[cfg(target_arch = "wasm32")]
pub(super) async fn simulate_shader_compilation_failure(
    runtime: &Forge3DRuntime,
) -> Result<(), WebError> {
    let context = runtime.context.as_ref().ok_or_else(|| {
        WebError::new(
            Forge3DErrorCode::RuntimeDisposed,
            "Runtime GPU context is not available",
        )
    })?;
    let scope = context
        .device
        .push_error_scope(wgpu::ErrorFilter::Validation);
    let _shader = context
        .device
        .create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("forge3d-web-diagnostic-invalid-shader"),
            source: wgpu::ShaderSource::Wgsl(
                "@vertex fn broken( -> @builtin(position) vec4f {".into(),
            ),
        });
    if let Some(error) = scope.pop().await {
        return Err(WebError::new(
            Forge3DErrorCode::ShaderCompilationFailed,
            format!("diagnostic shader compilation failed: {error}"),
        ));
    }
    Err(WebError::new(
        Forge3DErrorCode::InternalError,
        "Diagnostic invalid shader unexpectedly compiled",
    ))
}

#[cfg(not(target_arch = "wasm32"))]
pub(super) async fn simulate_shader_compilation_failure(
    _runtime: &Forge3DRuntime,
) -> Result<(), WebError> {
    Err(WebError::new(
        Forge3DErrorCode::UnsupportedFeature,
        "Shader-failure simulation is only available in wasm32 browser builds",
    ))
}
