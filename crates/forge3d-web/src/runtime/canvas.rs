#[derive(Clone)]
pub(super) enum RuntimeCanvas {
    Html(web_sys::HtmlCanvasElement),
    Offscreen(web_sys::OffscreenCanvas),
}

impl RuntimeCanvas {
    #[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
    pub(super) fn width(&self) -> u32 {
        match self {
            Self::Html(canvas) => canvas.width(),
            Self::Offscreen(canvas) => canvas.width(),
        }
    }

    #[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
    pub(super) fn height(&self) -> u32 {
        match self {
            Self::Html(canvas) => canvas.height(),
            Self::Offscreen(canvas) => canvas.height(),
        }
    }

    pub(super) fn set_width(&self, width: u32) {
        match self {
            Self::Html(canvas) => canvas.set_width(width),
            Self::Offscreen(canvas) => canvas.set_width(width),
        }
    }

    pub(super) fn set_height(&self, height: u32) {
        match self {
            Self::Html(canvas) => canvas.set_height(height),
            Self::Offscreen(canvas) => canvas.set_height(height),
        }
    }

    #[cfg(target_arch = "wasm32")]
    pub(super) fn surface_target(&self) -> wgpu::SurfaceTarget<'static> {
        match self {
            Self::Html(canvas) => wgpu::SurfaceTarget::Canvas(canvas.clone()),
            Self::Offscreen(canvas) => wgpu::SurfaceTarget::OffscreenCanvas(canvas.clone()),
        }
    }
}
