use wasm_bindgen::prelude::*;

use super::Forge3DRuntime;
use crate::error::{map_core_error, to_js_error, Forge3DErrorCode, WebError};

pub fn ensure_not_disposed(runtime: &Forge3DRuntime) -> Result<(), JsValue> {
    ensure_not_disposed_error(runtime).map_err(to_js_error)
}

pub fn ensure_not_disposed_error(runtime: &Forge3DRuntime) -> Result<(), WebError> {
    if runtime.disposed {
        return Err(WebError::new(
            Forge3DErrorCode::RuntimeDisposed,
            "Runtime has been disposed",
        ));
    }
    Ok(())
}

pub(super) fn ensure_device_healthy_error(runtime: &mut Forge3DRuntime) -> Result<(), WebError> {
    runtime
        .context
        .as_ref()
        .ok_or_else(|| {
            WebError::new(
                Forge3DErrorCode::RuntimeDisposed,
                "Runtime GPU context is not available",
            )
        })?
        .health
        .check()
        .map_err(map_core_error)
}

pub(super) fn set_js_property(target: &JsValue, name: &str, value: &JsValue) {
    let _ = js_sys::Reflect::set(target, &JsValue::from_str(name), value);
}
