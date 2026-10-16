use wasm_bindgen::prelude::*;

use super::device_health::set_js_property;
#[cfg(target_arch = "wasm32")]
use super::render::{reconfigure_surface, recreate_surface};
use super::Forge3DRuntime;
use crate::error::{Forge3DErrorCode, WebError};

#[derive(Debug, Clone, Default)]
pub(super) struct AdapterDiagnostics {
    pub(super) name: String,
    pub(super) vendor: String,
    pub(super) device: String,
    pub(super) architecture: String,
    pub(super) description: String,
    pub(super) backend: String,
    pub(super) device_type: String,
    pub(super) is_fallback: bool,
    pub(super) features: Vec<String>,
    pub(super) limits: Vec<(String, u64)>,
    pub(super) surface_formats: Vec<String>,
    pub(super) timestamp_query: bool,
}

#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub(super) fn kebab_name(debug_name: &str) -> String {
    let characters: Vec<char> = debug_name.chars().collect();
    let mut out = String::with_capacity(debug_name.len() + 4);
    for (index, character) in characters.iter().enumerate() {
        if character.is_ascii_uppercase() {
            let boundary = index > 0
                && (characters[index - 1].is_ascii_lowercase()
                    || (characters[index - 1].is_ascii_digit()
                        && index > 1
                        && characters[index - 2].is_ascii_digit()));
            if boundary {
                out.push('-');
            }
            out.push(character.to_ascii_lowercase());
        } else {
            out.push(character.to_ascii_lowercase());
        }
    }
    out
}

#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub(super) fn numeric_limits(limits: &wgpu::Limits) -> Vec<(&'static str, u64)> {
    vec![
        (
            "maxTextureDimension1D",
            u64::from(limits.max_texture_dimension_1d),
        ),
        (
            "maxTextureDimension2D",
            u64::from(limits.max_texture_dimension_2d),
        ),
        (
            "maxTextureDimension3D",
            u64::from(limits.max_texture_dimension_3d),
        ),
        (
            "maxTextureArrayLayers",
            u64::from(limits.max_texture_array_layers),
        ),
        ("maxBindGroups", u64::from(limits.max_bind_groups)),
        (
            "maxBindingsPerBindGroup",
            u64::from(limits.max_bindings_per_bind_group),
        ),
        (
            "maxDynamicUniformBuffersPerPipelineLayout",
            u64::from(limits.max_dynamic_uniform_buffers_per_pipeline_layout),
        ),
        (
            "maxDynamicStorageBuffersPerPipelineLayout",
            u64::from(limits.max_dynamic_storage_buffers_per_pipeline_layout),
        ),
        (
            "maxSampledTexturesPerShaderStage",
            u64::from(limits.max_sampled_textures_per_shader_stage),
        ),
        (
            "maxSamplersPerShaderStage",
            u64::from(limits.max_samplers_per_shader_stage),
        ),
        (
            "maxStorageBuffersPerShaderStage",
            u64::from(limits.max_storage_buffers_per_shader_stage),
        ),
        (
            "maxStorageTexturesPerShaderStage",
            u64::from(limits.max_storage_textures_per_shader_stage),
        ),
        (
            "maxUniformBuffersPerShaderStage",
            u64::from(limits.max_uniform_buffers_per_shader_stage),
        ),
        (
            "maxBindingArrayElementsPerShaderStage",
            u64::from(limits.max_binding_array_elements_per_shader_stage),
        ),
        (
            "maxBindingArrayAccelerationStructureElementsPerShaderStage",
            u64::from(limits.max_binding_array_acceleration_structure_elements_per_shader_stage),
        ),
        (
            "maxBindingArraySamplerElementsPerShaderStage",
            u64::from(limits.max_binding_array_sampler_elements_per_shader_stage),
        ),
        (
            "maxUniformBufferBindingSize",
            limits.max_uniform_buffer_binding_size,
        ),
        (
            "maxStorageBufferBindingSize",
            limits.max_storage_buffer_binding_size,
        ),
        ("maxVertexBuffers", u64::from(limits.max_vertex_buffers)),
        ("maxBufferSize", limits.max_buffer_size),
        (
            "maxVertexAttributes",
            u64::from(limits.max_vertex_attributes),
        ),
        (
            "maxVertexBufferArrayStride",
            u64::from(limits.max_vertex_buffer_array_stride),
        ),
        (
            "maxInterStageShaderVariables",
            u64::from(limits.max_inter_stage_shader_variables),
        ),
        (
            "minUniformBufferOffsetAlignment",
            u64::from(limits.min_uniform_buffer_offset_alignment),
        ),
        (
            "minStorageBufferOffsetAlignment",
            u64::from(limits.min_storage_buffer_offset_alignment),
        ),
        (
            "maxColorAttachments",
            u64::from(limits.max_color_attachments),
        ),
        (
            "maxColorAttachmentBytesPerSample",
            u64::from(limits.max_color_attachment_bytes_per_sample),
        ),
        (
            "maxComputeWorkgroupStorageSize",
            u64::from(limits.max_compute_workgroup_storage_size),
        ),
        (
            "maxComputeInvocationsPerWorkgroup",
            u64::from(limits.max_compute_invocations_per_workgroup),
        ),
        (
            "maxComputeWorkgroupSizeX",
            u64::from(limits.max_compute_workgroup_size_x),
        ),
        (
            "maxComputeWorkgroupSizeY",
            u64::from(limits.max_compute_workgroup_size_y),
        ),
        (
            "maxComputeWorkgroupSizeZ",
            u64::from(limits.max_compute_workgroup_size_z),
        ),
        (
            "maxComputeWorkgroupsPerDimension",
            u64::from(limits.max_compute_workgroups_per_dimension),
        ),
        ("maxImmediateSize", u64::from(limits.max_immediate_size)),
        (
            "maxNonSamplerBindings",
            u64::from(limits.max_non_sampler_bindings),
        ),
        (
            "maxMultiviewViewCount",
            u64::from(limits.max_multiview_view_count),
        ),
    ]
}

impl AdapterDiagnostics {
    #[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
    pub(super) fn capture(
        context: &forge3d_core::gpu::GpuContext,
        surface_formats: Vec<wgpu::TextureFormat>,
    ) -> Self {
        let info = context.adapter.get_info();
        let mut features: Vec<String> = context
            .device
            .features()
            .iter()
            .filter_map(|feature| feature.as_str())
            .map(|name| name.to_string())
            .collect();
        features.sort();
        let mut formats: Vec<String> = surface_formats
            .iter()
            .map(|format| kebab_name(&format!("{format:?}")))
            .collect();
        formats.sort();
        formats.dedup();
        let timestamp_query = context
            .device
            .features()
            .contains(wgpu::Features::TIMESTAMP_QUERY);
        Self {
            name: info.name,
            vendor: format!("0x{:08x}", info.vendor),
            device: format!("0x{:08x}", info.device),
            architecture: String::new(),
            description: info.driver_info,
            backend: kebab_name(&format!("{:?}", info.backend)),
            device_type: kebab_name(&format!("{:?}", info.device_type)),
            is_fallback: info.device_type == wgpu::DeviceType::Cpu,
            features,
            limits: numeric_limits(&context.device.limits())
                .into_iter()
                .map(|(name, value)| (name.to_string(), value))
                .collect(),
            surface_formats: formats,
            timestamp_query,
        }
    }

    pub(super) fn populate_capabilities(&self, capabilities: &JsValue) {
        let adapter_info = js_sys::Object::new();
        set_js_property(
            adapter_info.as_ref(),
            "name",
            &JsValue::from_str(&self.name),
        );
        set_js_property(
            adapter_info.as_ref(),
            "vendor",
            &JsValue::from_str(&self.vendor),
        );
        set_js_property(
            adapter_info.as_ref(),
            "device",
            &JsValue::from_str(&self.device),
        );
        set_js_property(
            adapter_info.as_ref(),
            "architecture",
            &JsValue::from_str(&self.architecture),
        );
        set_js_property(
            adapter_info.as_ref(),
            "description",
            &JsValue::from_str(&self.description),
        );
        set_js_property(
            adapter_info.as_ref(),
            "backend",
            &JsValue::from_str(&self.backend),
        );
        set_js_property(
            adapter_info.as_ref(),
            "deviceType",
            &JsValue::from_str(&self.device_type),
        );
        set_js_property(capabilities, "adapterInfo", adapter_info.as_ref());
        set_js_property(
            capabilities,
            "isFallbackAdapter",
            &JsValue::from_bool(self.is_fallback),
        );
        let features = js_sys::Array::new();
        for feature in &self.features {
            features.push(&JsValue::from_str(feature));
        }
        set_js_property(capabilities, "features", features.as_ref());
        let limits = js_sys::Object::new();
        for (name, value) in &self.limits {
            set_js_property(limits.as_ref(), name, &JsValue::from_f64(*value as f64));
        }
        set_js_property(capabilities, "limits", limits.as_ref());
        let formats = js_sys::Array::new();
        for format in &self.surface_formats {
            formats.push(&JsValue::from_str(format));
        }
        set_js_property(capabilities, "surfaceFormats", formats.as_ref());
        set_js_property(
            capabilities,
            "timestampQuery",
            &JsValue::from_bool(self.timestamp_query),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::{kebab_name, numeric_limits};

    #[test]
    fn kebab_name_normalizes_debug_names() {
        assert_eq!(kebab_name("BrowserWebGpu"), "browser-web-gpu");
        assert_eq!(kebab_name("IntegratedGpu"), "integrated-gpu");
        assert_eq!(kebab_name("Cpu"), "cpu");
        assert_eq!(kebab_name("Bgra8UnormSrgb"), "bgra8unorm-srgb");
        assert_eq!(kebab_name("Rgba16Float"), "rgba16-float");
    }

    #[test]
    fn numeric_limits_cover_required_diagnostic_fields() {
        let names: Vec<&str> = numeric_limits(&wgpu::Limits::default())
            .into_iter()
            .map(|(name, _)| name)
            .collect();
        for required in [
            "maxTextureDimension2D",
            "maxBufferSize",
            "maxBindGroups",
            "maxBindingsPerBindGroup",
            "maxUniformBuffersPerShaderStage",
            "maxStorageBuffersPerShaderStage",
            "maxSampledTexturesPerShaderStage",
            "maxSamplersPerShaderStage",
            "maxComputeWorkgroupStorageSize",
            "maxComputeInvocationsPerWorkgroup",
            "maxComputeWorkgroupsPerDimension",
        ] {
            assert!(names.contains(&required), "missing limit {required}");
        }
    }
}

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
            format!("forge3d-web-diagnostic-invalid-shader/pipeline compilation failed: {error}"),
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
