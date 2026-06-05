use std::sync::Arc;

use crate::error::{Forge3dError, Result};

#[derive(Debug, Clone)]
pub struct GpuRuntimeOptions {
    pub power_preference: wgpu::PowerPreference,
    pub required_features: wgpu::Features,
    pub required_limits: wgpu::Limits,
    pub label: Option<String>,
}

impl Default for GpuRuntimeOptions {
    fn default() -> Self {
        Self {
            power_preference: wgpu::PowerPreference::HighPerformance,
            required_features: wgpu::Features::empty(),
            required_limits: wgpu::Limits::downlevel_webgl2_defaults(),
            label: None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct GpuRuntime {
    pub instance: Arc<wgpu::Instance>,
}

impl GpuRuntime {
    pub fn new(instance: wgpu::Instance) -> Self {
        Self {
            instance: Arc::new(instance),
        }
    }

    pub async fn request_context(
        &self,
        compatible_surface: Option<&wgpu::Surface<'_>>,
        options: &GpuRuntimeOptions,
    ) -> Result<GpuContext> {
        let adapter = self
            .instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: options.power_preference,
                compatible_surface,
                force_fallback_adapter: false,
            })
            .await
            .ok_or(Forge3dError::AdapterUnavailable)?;

        let (device, queue) = adapter
            .request_device(
                &wgpu::DeviceDescriptor {
                    label: options.label.as_deref(),
                    required_features: options.required_features,
                    required_limits: options.required_limits.clone(),
                },
                None,
            )
            .await
            .map_err(|error| Forge3dError::DeviceRequest {
                message: error.to_string(),
            })?;

        Ok(GpuContext {
            adapter: Arc::new(adapter),
            device: Arc::new(device),
            queue: Arc::new(queue),
        })
    }
}

#[derive(Debug, Clone)]
pub struct GpuContext {
    pub adapter: Arc<wgpu::Adapter>,
    pub device: Arc<wgpu::Device>,
    pub queue: Arc<wgpu::Queue>,
}

#[cfg(test)]
mod tests {
    use super::GpuRuntimeOptions;

    #[test]
    fn gpu_runtime_options_default_to_browser_compatible_limits() {
        let options = GpuRuntimeOptions::default();

        assert_eq!(
            options.power_preference,
            wgpu::PowerPreference::HighPerformance
        );
        assert!(options.required_features.is_empty());
        assert_eq!(
            options.required_limits.max_texture_dimension_2d,
            wgpu::Limits::downlevel_webgl2_defaults().max_texture_dimension_2d
        );
        assert!(options.label.is_none());
    }
}
