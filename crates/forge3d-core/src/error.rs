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
