use wasm_bindgen::prelude::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Forge3DErrorCode {
    WebGpuUnavailable,
    WebGpuAdapterUnavailable,
    DeviceRequestFailed,
    SurfaceCreateFailed,
    SurfaceLost,
    SurfaceOutdated,
    OutOfMemory,
    UnsupportedFeature,
    InvalidInput,
    IoError,
    RequestCancelled,
    ShaderCompilationFailed,
    RuntimeDisposed,
}

impl Forge3DErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::WebGpuUnavailable => "WEBGPU_UNAVAILABLE",
            Self::WebGpuAdapterUnavailable => "WEBGPU_ADAPTER_UNAVAILABLE",
            Self::DeviceRequestFailed => "DEVICE_REQUEST_FAILED",
            Self::SurfaceCreateFailed => "SURFACE_CREATE_FAILED",
            Self::SurfaceLost => "SURFACE_LOST",
            Self::SurfaceOutdated => "SURFACE_OUTDATED",
            Self::OutOfMemory => "OUT_OF_MEMORY",
            Self::UnsupportedFeature => "UNSUPPORTED_FEATURE",
            Self::InvalidInput => "INVALID_INPUT",
            Self::IoError => "IO_ERROR",
            Self::RequestCancelled => "REQUEST_CANCELLED",
            Self::ShaderCompilationFailed => "SHADER_COMPILATION_FAILED",
            Self::RuntimeDisposed => "RUNTIME_DISPOSED",
        }
    }
}

#[derive(Clone)]
pub struct WebError {
    code: Forge3DErrorCode,
    message: String,
    details: JsValue,
}

impl std::fmt::Debug for WebError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("WebError")
            .field("code", &self.code)
            .field("message", &self.message)
            .finish_non_exhaustive()
    }
}

impl WebError {
    pub fn new(code: Forge3DErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            details: JsValue::UNDEFINED,
        }
    }

    pub fn with_details(
        code: Forge3DErrorCode,
        message: impl Into<String>,
        details: JsValue,
    ) -> Self {
        Self {
            code,
            message: message.into(),
            details,
        }
    }

    pub fn code(&self) -> Forge3DErrorCode {
        self.code
    }

    pub fn message(&self) -> &str {
        &self.message
    }

    pub fn details(&self) -> &JsValue {
        &self.details
    }
}

#[wasm_bindgen]
pub struct Forge3DError {
    code: String,
    message: String,
    details: JsValue,
}

#[wasm_bindgen]
impl Forge3DError {
    #[wasm_bindgen(constructor)]
    pub fn new(code: String, message: String, details: JsValue) -> Self {
        Self {
            code,
            message,
            details,
        }
    }

    #[wasm_bindgen(getter)]
    pub fn code(&self) -> String {
        self.code.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn message(&self) -> String {
        self.message.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn details(&self) -> JsValue {
        self.details.clone()
    }
}

pub fn js_error(code: Forge3DErrorCode, message: impl Into<String>) -> JsValue {
    to_js_error(WebError::new(code, message))
}

pub fn to_js_error(error: WebError) -> JsValue {
    let js_error = js_sys::Error::new(error.message());
    let value = JsValue::from(js_error);

    set_property(&value, "name", &JsValue::from_str("Forge3DError"));
    set_property(&value, "code", &JsValue::from_str(error.code().as_str()));
    if !error.details().is_undefined() {
        set_property(&value, "details", error.details());
    }

    value
}

pub fn map_core_error(error: forge3d_core::error::Forge3dError) -> WebError {
    use forge3d_core::error::Forge3dError;

    match error {
        Forge3dError::AdapterUnavailable => WebError::new(
            Forge3DErrorCode::WebGpuAdapterUnavailable,
            "No compatible WebGPU adapter is available",
        ),
        Forge3dError::DeviceRequest { message } => {
            WebError::new(Forge3DErrorCode::DeviceRequestFailed, message)
        }
        Forge3dError::UnsupportedFeature { feature } => WebError::new(
            Forge3DErrorCode::UnsupportedFeature,
            format!("Unsupported feature: {feature}"),
        ),
        Forge3dError::InvalidInput { field, message } => WebError::new(
            Forge3DErrorCode::InvalidInput,
            format!("Invalid input {field}: {message}"),
        ),
        Forge3dError::ShaderCompilation { label, message } => WebError::new(
            Forge3DErrorCode::ShaderCompilationFailed,
            format!("Shader compilation failed in {label}: {message}"),
        ),
        Forge3dError::SurfaceLost => WebError::new(Forge3DErrorCode::SurfaceLost, "Surface lost"),
        Forge3dError::SurfaceOutdated => {
            WebError::new(Forge3DErrorCode::SurfaceOutdated, "Surface outdated")
        }
        Forge3dError::OutOfMemory => {
            WebError::new(Forge3DErrorCode::OutOfMemory, "Out of GPU memory")
        }
        Forge3dError::Io { message } => WebError::new(Forge3DErrorCode::IoError, message),
        Forge3dError::Cancelled => {
            WebError::new(Forge3DErrorCode::RequestCancelled, "Request cancelled")
        }
        Forge3dError::RuntimeDisposed => WebError::new(
            Forge3DErrorCode::RuntimeDisposed,
            "Runtime has been disposed",
        ),
    }
}

fn set_property(target: &JsValue, name: &str, value: &JsValue) {
    let _ = js_sys::Reflect::set(target, &JsValue::from_str(name), value);
}

#[cfg(test)]
mod tests {
    use super::{map_core_error, Forge3DErrorCode};

    #[test]
    fn maps_core_errors_to_stable_browser_codes() {
        let error = map_core_error(forge3d_core::error::Forge3dError::AdapterUnavailable);
        assert_eq!(error.code().as_str(), "WEBGPU_ADAPTER_UNAVAILABLE");

        let error = map_core_error(forge3d_core::error::Forge3dError::RuntimeDisposed);
        assert_eq!(error.code(), Forge3DErrorCode::RuntimeDisposed);
    }
}
