// Legacy GPU test helpers retained for staged native/offline code.
// Runtime-owned GPU state now lives in crate::gpu.
use std::sync::Arc;

pub struct GpuContext {
    pub instance: Arc<wgpu::Instance>,
    pub device: Arc<wgpu::Device>,
    pub queue: Arc<wgpu::Queue>,
    pub adapter: Arc<wgpu::Adapter>,
}

pub fn legacy_context_removed() -> ! {
    panic!("legacy global GPU context was removed; use forge3d_core::gpu::GpuRuntime instead")
}

/// Align to WebGPU's required bytes-per-row for copies.
#[inline]
pub fn align_copy_bpr(unpadded: u32) -> u32 {
    let a = wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
    ((unpadded + a - 1) / a) * a
}

/// Create a small wgpu device for unit tests.
///
/// Returns `None` when no GPU adapter is available (e.g. headless CI runners),
/// allowing tests to skip gracefully instead of panicking.
pub fn create_device_for_test() -> Option<wgpu::Device> {
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
        backends: wgpu::Backends::all(),
        ..Default::default()
    });
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::LowPower,
        compatible_surface: None,
        force_fallback_adapter: false,
    }))?;
    // Keep native limits to allow larger render targets in tests as well.
    let mut limits = adapter.limits();
    let desired_storage_buffers = 8;
    limits.max_storage_buffers_per_shader_stage = limits
        .max_storage_buffers_per_shader_stage
        .max(desired_storage_buffers);

    let (device, _queue) = pollster::block_on(adapter.request_device(
        &wgpu::DeviceDescriptor {
            required_features: wgpu::Features::empty(),
            required_limits: limits,
            label: Some("forge3d-test-device"),
        },
        None,
    ))
    .ok()?;
    Some(device)
}

/// Create device and queue for unit tests (P3-08).
///
/// Returns `None` when no GPU adapter is available (e.g. headless CI runners).
pub fn create_device_and_queue_for_test() -> Option<(wgpu::Device, wgpu::Queue)> {
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
        backends: wgpu::Backends::all(),
        ..Default::default()
    });
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::LowPower,
        compatible_surface: None,
        force_fallback_adapter: false,
    }))?;
    let mut limits = adapter.limits();
    let desired_storage_buffers = 8;
    limits.max_storage_buffers_per_shader_stage = limits
        .max_storage_buffers_per_shader_stage
        .max(desired_storage_buffers);

    let (device, queue) = pollster::block_on(adapter.request_device(
        &wgpu::DeviceDescriptor {
            required_features: wgpu::Features::empty(),
            required_limits: limits,
            label: Some("forge3d-test-device"),
        },
        None,
    ))
    .ok()?;
    Some((device, queue))
}
