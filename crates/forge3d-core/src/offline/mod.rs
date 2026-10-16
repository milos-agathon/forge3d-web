//! Offline quality: deterministic sample jitter, accumulation convergence
//! metrics, HDR resolve operators, the AOV-guided A-trous denoiser and image
//! comparison metrics (native TV12 `render_offline` and M5 denoise surfaces).
//!
//! Everything here is CPU/WASM-safe; the WebGPU accumulation, resolve and
//! denoise passes in `forge3d-web` evaluate the same arithmetic.

pub mod denoise;
pub mod image_metrics;
pub mod jitter;
pub mod metrics;
pub mod tonemap;

#[cfg(test)]
mod tests;
