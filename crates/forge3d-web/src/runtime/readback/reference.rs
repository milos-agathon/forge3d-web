//! The same unjittered W06 depth reference, without a discarded beauty sample,
//! accumulation, tonemapping or unrelated AOV readbacks.
use crate::error::{map_core_error, Forge3DErrorCode, WebError};
use crate::runtime::{
    offline::{
        self,
        gpu::{read_texture, CaptureTargets},
    },
    postfx::capture::CaptureFrame,
    terrain::CaptureCameraUniform,
    Forge3DRuntime,
};
use forge3d_core::{
    gpu::GpuContext,
    memory::MemoryCategory,
    readback::{decode_float_rows, ReadbackFormat},
};

const KEY: &str = "readback:map-reference";

pub(super) async fn read_depth(runtime: &mut Forge3DRuntime) -> Result<Vec<f32>, WebError> {
    offline::ensure_no_offline(runtime)?;
    super::super::environment::refresh(runtime)?;
    super::super::shader_variants::sync_pipelines(runtime)?;
    let context = runtime.context.clone().ok_or_else(|| {
        WebError::new(
            Forge3DErrorCode::RuntimeDisposed,
            "Runtime GPU context is not available",
        )
    })?;
    let layout = ReadbackFormat::R32Float
        .layout(runtime.width, runtime.height)
        .map_err(map_core_error)?;
    if layout.buffer_size > runtime.max_buffer_size {
        return Err(WebError::new(
            Forge3DErrorCode::ResourceLimitExceeded,
            "Map depth reference exceeds maxBufferSize",
        ));
    }
    let blend =
        super::super::shader_variants::runtime_terrain_lighting_features(runtime)?.capture_blend();
    let pixels = u64::from(runtime.width) * u64::from(runtime.height);
    let targets = CaptureTargets::planned_bytes(runtime.width, runtime.height, false, false)
        - if blend { pixels * 8 } else { 0 };
    let environment = if runtime.environment.is_some() {
        pixels * if blend { 8 } else { 16 }
    } else {
        0
    };
    let bytes = targets
        + environment
        + layout.buffer_size
        + std::mem::size_of::<CaptureCameraUniform>() as u64;
    runtime
        .memory
        .replace(KEY, MemoryCategory::Readback, bytes)?;
    let result = capture(runtime, &context).await;
    runtime.memory.release(KEY);
    result
}

async fn capture(runtime: &mut Forge3DRuntime, context: &GpuContext) -> Result<Vec<f32>, WebError> {
    let scope = context
        .device
        .push_error_scope(wgpu::ErrorFilter::Validation);
    let result = (|| {
        let camera = runtime.camera;
        let uniform = super::super::terrain::create_capture_camera_uniform(
            &camera,
            &camera,
            runtime.width,
            runtime.height,
            [0.; 2],
            offline::AOV_ID_TERRAIN,
        )?;
        let frame = CaptureFrame::reference(runtime, context)?;
        frame.update(runtime, context, &camera, [0.; 2])?;
        super::super::shadows::refresh_shadow_state(runtime)?;
        let mut encoder = context
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("forge3d-web-map-depth-reference"),
            });
        // This unjittered reference reads geometric depth only. Its terrain
        // entry point omits lighting, so the canonical frame's shadow maps do
        // not need to be redrawn for this discarded color target.
        frame.encode_reference(runtime, &mut encoder, uniform.base.view_projection);
        context.queue.submit(std::iter::once(encoder.finish()));
        Ok::<_, WebError>(frame)
    })();
    if let Some(error) = scope.pop().await {
        return Err(WebError::new(
            Forge3DErrorCode::InternalError,
            format!("Map depth reference: {error}"),
        ));
    }
    let frame = result?;
    let (bytes, layout) = read_texture(
        context,
        &frame.targets.depth.texture,
        ReadbackFormat::R32Float,
        runtime.width,
        runtime.height,
    )
    .await?;
    decode_float_rows(&bytes, layout, ReadbackFormat::R32Float).map_err(map_core_error)
}
