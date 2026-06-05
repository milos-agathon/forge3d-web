#[derive(Debug, thiserror::Error)]
pub enum Forge3dError {
    #[error("WebGPU adapter unavailable")]
    AdapterUnavailable,
    #[error("Device request failed: {message}")]
    DeviceRequest { message: String },
    #[error("Unsupported feature: {feature}")]
    UnsupportedFeature { feature: String },
    #[error("Invalid input {field}: {message}")]
    InvalidInput { field: String, message: String },
    #[error("Shader compilation failed in {label}: {message}")]
    ShaderCompilation { label: String, message: String },
    #[error("Surface lost")]
    SurfaceLost,
    #[error("Surface outdated")]
    SurfaceOutdated,
    #[error("Out of GPU memory")]
    OutOfMemory,
    #[error("IO failed: {message}")]
    Io { message: String },
    #[error("Request cancelled")]
    Cancelled,
    #[error("Runtime has been disposed")]
    RuntimeDisposed,
}

pub type Result<T> = std::result::Result<T, Forge3dError>;

#[cfg(feature = "gpu")]
impl From<wgpu::SurfaceError> for Forge3dError {
    fn from(error: wgpu::SurfaceError) -> Self {
        match error {
            wgpu::SurfaceError::Lost => Self::SurfaceLost,
            wgpu::SurfaceError::Outdated => Self::SurfaceOutdated,
            wgpu::SurfaceError::OutOfMemory => Self::OutOfMemory,
            wgpu::SurfaceError::Timeout => Self::Cancelled,
        }
    }
}
