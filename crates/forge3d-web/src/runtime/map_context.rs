//! Explicit, scoped ownership of a map group's device. Every frame still gets
//! independent surfaces, buffers, scene state and a complete native draw.
use super::{Forge3DRuntime, RuntimeCanvas};
use crate::error::{map_core_error, to_js_error, Forge3DErrorCode, WebError};
use forge3d_core::gpu::{GpuContext, GpuRuntime};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct MapRuntimeContext {
    context: Option<(GpuRuntime, GpuContext)>,
}

impl MapRuntimeContext {
    pub(super) fn from_runtime(runtime: &Forge3DRuntime) -> Result<Self, JsValue> {
        super::ensure_not_disposed_error(runtime).map_err(to_js_error)?;
        if let Some(context) = &runtime.context {
            context
                .health
                .check()
                .map_err(map_core_error)
                .map_err(to_js_error)?;
        }
        Ok(Self {
            context: runtime.gpu_runtime.clone().zip(runtime.context.clone()),
        })
    }

    fn create_runtime(&self, canvas: RuntimeCanvas, options: JsValue) -> js_sys::Promise {
        let context = self.context.clone();
        // Own the clones in the future; no WASM borrow survives this call.
        wasm_bindgen_futures::future_to_promise(async move {
            let context = context.ok_or_else(|| {
                to_js_error(WebError::new(
                    Forge3DErrorCode::RuntimeDisposed,
                    "Map render context is closed",
                ))
            })?;
            #[cfg(target_arch = "wasm32")]
            let runtime =
                super::init::create_runtime_with_context(canvas, options, false, Some(context))
                    .await;
            #[cfg(not(target_arch = "wasm32"))]
            let runtime = {
                let _ = context;
                super::init::create_runtime(canvas, options, false).await
            };
            runtime.map(JsValue::from).map_err(to_js_error)
        })
    }
}

#[wasm_bindgen]
impl MapRuntimeContext {
    #[wasm_bindgen(js_name = create)]
    pub fn create(&self, canvas: web_sys::HtmlCanvasElement, options: JsValue) -> js_sys::Promise {
        self.create_runtime(RuntimeCanvas::Html(canvas), options)
    }

    #[wasm_bindgen(js_name = createOffscreen)]
    pub fn create_offscreen(
        &self,
        canvas: web_sys::OffscreenCanvas,
        options: JsValue,
    ) -> js_sys::Promise {
        self.create_runtime(RuntimeCanvas::Offscreen(canvas), options)
    }

    pub fn dispose(&mut self) {
        self.context = None;
    }
}
