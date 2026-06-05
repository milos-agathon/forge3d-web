use forge3d_core::gpu::{GpuContext, GpuRuntime, GpuRuntimeOptions};

pub fn request_context_blocking(
    options: &GpuRuntimeOptions,
) -> forge3d_core::error::Result<GpuContext> {
    let runtime = GpuRuntime::new(wgpu::Instance::default());
    pollster::block_on(runtime.request_context(None, options))
}
