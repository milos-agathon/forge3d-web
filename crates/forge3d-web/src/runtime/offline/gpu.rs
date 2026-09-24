//! GPU resources of the offline capture path: capture targets, compute
//! pipelines with explicit layouts, and buffer/readback helpers.

use forge3d_core::gpu::GpuContext;
use wgpu::util::DeviceExt;

use super::{
    CAPTURE_COLOR_FORMAT, CAPTURE_DEPTH_FORMAT, CAPTURE_ID_FORMAT, CAPTURE_MOTION_FORMAT,
    CAPTURE_OVERLAY_FORMAT, CAPTURE_SURFACE_FORMAT,
};
use crate::error::{Forge3DErrorCode, WebError};
use crate::runtime::terrain::DEPTH_FORMAT;

pub(crate) const ACCUMULATE_SHADER: &str = include_str!("../offline_accumulate.wgsl");
pub(crate) const LUMINANCE_SHADER: &str = include_str!("../offline_luminance.wgsl");
pub(crate) const RESOLVE_SHADER: &str = include_str!("../offline_resolve.wgsl");
pub(crate) const TONEMAP_SHADER: &str = include_str!("../offline_tonemap.wgsl");
pub(crate) const DENOISE_SHADER: &str = include_str!("../offline_denoise.wgsl");

pub(crate) const WORKGROUP: u32 = 8;

pub(crate) struct Target {
    pub texture: wgpu::Texture,
    pub view: wgpu::TextureView,
}

impl Target {
    fn new(
        device: &wgpu::Device,
        label: &str,
        format: wgpu::TextureFormat,
        width: u32,
        height: u32,
    ) -> Self {
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some(label),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                | wgpu::TextureUsages::TEXTURE_BINDING
                | wgpu::TextureUsages::COPY_SRC
                | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        Self { texture, view }
    }
}

/// Render targets of one capture session. Surface and overlay layers are
/// 1x1 placeholders when the session does not capture them.
pub(crate) struct CaptureTargets {
    pub color: Target,
    pub depth: Target,
    pub id: Target,
    pub motion: Target,
    pub albedo: Target,
    pub normal: Target,
    pub overlay: Target,
    pub depth_stencil: Target,
    pub depth_ref: Target,
    pub id_ref: Target,
    pub motion_ref: Target,
}

impl CaptureTargets {
    pub(crate) fn new(
        device: &wgpu::Device,
        width: u32,
        height: u32,
        surface: bool,
        overlay: bool,
    ) -> Self {
        let (sw, sh) = if surface { (width, height) } else { (1, 1) };
        let (ow, oh) = if overlay { (width, height) } else { (1, 1) };
        let target = |label: &str, format, w, h| Target::new(device, label, format, w, h);
        Self {
            color: target(
                "forge3d-web-capture-color",
                CAPTURE_COLOR_FORMAT,
                width,
                height,
            ),
            depth: target(
                "forge3d-web-capture-depth",
                CAPTURE_DEPTH_FORMAT,
                width,
                height,
            ),
            id: target("forge3d-web-capture-id", CAPTURE_ID_FORMAT, width, height),
            motion: target(
                "forge3d-web-capture-motion",
                CAPTURE_MOTION_FORMAT,
                width,
                height,
            ),
            albedo: target("forge3d-web-capture-albedo", CAPTURE_SURFACE_FORMAT, sw, sh),
            normal: target("forge3d-web-capture-normal", CAPTURE_SURFACE_FORMAT, sw, sh),
            overlay: target(
                "forge3d-web-capture-overlay",
                CAPTURE_OVERLAY_FORMAT,
                ow,
                oh,
            ),
            depth_stencil: target(
                "forge3d-web-capture-depth-stencil",
                DEPTH_FORMAT,
                width,
                height,
            ),
            depth_ref: target(
                "forge3d-web-capture-depth-ref",
                CAPTURE_DEPTH_FORMAT,
                width,
                height,
            ),
            id_ref: target(
                "forge3d-web-capture-id-ref",
                CAPTURE_ID_FORMAT,
                width,
                height,
            ),
            motion_ref: target(
                "forge3d-web-capture-motion-ref",
                CAPTURE_MOTION_FORMAT,
                width,
                height,
            ),
        }
    }

    /// Planned bytes before allocation (mirrors `new`).
    pub(crate) fn planned_bytes(width: u32, height: u32, surface: bool, overlay: bool) -> u64 {
        let pixels = u64::from(width) * u64::from(height);
        let mut per_pixel = 16 + 4 + 4 + 8 + 4 + 4 + 4 + 8;
        let mut fixed = 0;
        if surface {
            per_pixel += 32;
        } else {
            fixed += 32;
        }
        if overlay {
            per_pixel += 8;
        } else {
            fixed += 8;
        }
        pixels.saturating_mul(per_pixel).saturating_add(fixed)
    }
}

#[derive(Clone, Copy)]
pub(crate) enum Slot {
    Texture(wgpu::TextureSampleType),
    StorageRead,
    StorageRw,
    Uniform,
}

pub(crate) struct ComputeStage {
    pub layout: wgpu::BindGroupLayout,
    pub pipeline: wgpu::ComputePipeline,
}

impl ComputeStage {
    fn new(device: &wgpu::Device, label: &str, source: &str, slots: &[Slot]) -> Self {
        let entries: Vec<wgpu::BindGroupLayoutEntry> = slots
            .iter()
            .enumerate()
            .map(|(binding, slot)| wgpu::BindGroupLayoutEntry {
                binding: binding as u32,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: match slot {
                    Slot::Texture(sample_type) => wgpu::BindingType::Texture {
                        sample_type: *sample_type,
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    Slot::StorageRead => wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: true },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    Slot::StorageRw => wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: false },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    Slot::Uniform => wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                },
                count: None,
            })
            .collect();
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some(label),
            entries: &entries,
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some(label),
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some(label),
            source: wgpu::ShaderSource::Wgsl(source.into()),
        });
        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some(label),
            layout: Some(&pipeline_layout),
            module: &module,
            entry_point: Some("main"),
            compilation_options: wgpu::PipelineCompilationOptions::default(),
            cache: None,
        });
        Self { layout, pipeline }
    }

    pub(crate) fn bind_group(
        &self,
        device: &wgpu::Device,
        label: &str,
        resources: &[wgpu::BindingResource<'_>],
    ) -> wgpu::BindGroup {
        let entries: Vec<wgpu::BindGroupEntry<'_>> = resources
            .iter()
            .enumerate()
            .map(|(binding, resource)| wgpu::BindGroupEntry {
                binding: binding as u32,
                resource: resource.clone(),
            })
            .collect();
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some(label),
            layout: &self.layout,
            entries: &entries,
        })
    }

    pub(crate) fn dispatch(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        label: &str,
        bind_group: &wgpu::BindGroup,
        width: u32,
        height: u32,
    ) {
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
            label: Some(label),
            timestamp_writes: None,
        });
        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, bind_group, &[]);
        pass.dispatch_workgroups(width.div_ceil(WORKGROUP), height.div_ceil(WORKGROUP), 1);
    }
}

/// Compute pipelines shared by every offline session of a runtime.
pub(crate) struct OfflinePipelines {
    pub accumulate: ComputeStage,
    pub luminance: ComputeStage,
    pub resolve: ComputeStage,
    pub tonemap: ComputeStage,
    pub denoise: ComputeStage,
}

impl OfflinePipelines {
    pub(crate) fn new(device: &wgpu::Device) -> Self {
        let float = wgpu::TextureSampleType::Float { filterable: false };
        Self {
            accumulate: ComputeStage::new(
                device,
                "forge3d-web-offline-accumulate",
                ACCUMULATE_SHADER,
                &[
                    Slot::Texture(float),
                    Slot::Texture(float),
                    Slot::Texture(float),
                    Slot::Texture(float),
                    Slot::StorageRw,
                    Slot::StorageRw,
                    Slot::StorageRw,
                    Slot::Uniform,
                ],
            ),
            luminance: ComputeStage::new(
                device,
                "forge3d-web-offline-luminance",
                LUMINANCE_SHADER,
                &[Slot::StorageRead, Slot::StorageRw, Slot::Uniform],
            ),
            resolve: ComputeStage::new(
                device,
                "forge3d-web-offline-resolve",
                RESOLVE_SHADER,
                &[
                    Slot::StorageRead,
                    Slot::StorageRead,
                    Slot::StorageRead,
                    Slot::StorageRw,
                    Slot::StorageRw,
                    Slot::StorageRw,
                    Slot::Texture(float),
                    Slot::StorageRw,
                    Slot::Uniform,
                ],
            ),
            tonemap: ComputeStage::new(
                device,
                "forge3d-web-offline-tonemap",
                TONEMAP_SHADER,
                &[
                    Slot::StorageRead,
                    Slot::Texture(wgpu::TextureSampleType::Uint),
                    Slot::StorageRw,
                    Slot::Uniform,
                ],
            ),
            denoise: ComputeStage::new(
                device,
                "forge3d-web-offline-denoise",
                DENOISE_SHADER,
                &[
                    Slot::StorageRead,
                    Slot::StorageRw,
                    Slot::StorageRead,
                    Slot::StorageRead,
                    Slot::StorageRead,
                    Slot::Uniform,
                ],
            ),
        }
    }
}

pub(crate) fn storage_buffer(device: &wgpu::Device, label: &str, size: u64) -> wgpu::Buffer {
    device.create_buffer(&wgpu::BufferDescriptor {
        label: Some(label),
        size: size.max(16),
        usage: wgpu::BufferUsages::STORAGE
            | wgpu::BufferUsages::COPY_SRC
            | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    })
}

pub(crate) fn storage_buffer_init(
    device: &wgpu::Device,
    label: &str,
    bytes: &[u8],
) -> wgpu::Buffer {
    if bytes.is_empty() {
        return storage_buffer(device, label, 16);
    }
    device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some(label),
        contents: bytes,
        usage: wgpu::BufferUsages::STORAGE
            | wgpu::BufferUsages::COPY_SRC
            | wgpu::BufferUsages::COPY_DST,
    })
}

pub(crate) fn uniform_buffer(device: &wgpu::Device, label: &str, bytes: &[u8]) -> wgpu::Buffer {
    device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some(label),
        contents: bytes,
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
    })
}

pub(crate) fn staging_buffer(device: &wgpu::Device, label: &str, size: u64) -> wgpu::Buffer {
    device.create_buffer(&wgpu::BufferDescriptor {
        label: Some(label),
        size: size.max(4),
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    })
}

/// Rejects storage bindings larger than the device allows.
pub(crate) fn check_storage_binding(
    context: &GpuContext,
    bytes: u64,
    what: &str,
) -> Result<(), WebError> {
    let limit = u64::from(context.device.limits().max_storage_buffer_binding_size);
    if bytes > limit {
        return Err(WebError::new(
            Forge3DErrorCode::ResourceLimitExceeded,
            format!(
                "{what} requires a {bytes}-byte storage binding but maxStorageBufferBindingSize is {limit}"
            ),
        ));
    }
    Ok(())
}

/// Resolves once the queue has finished all submitted work.
pub(crate) async fn wait_for_queue(context: &GpuContext) -> Result<(), WebError> {
    let promise = js_sys::Promise::new(&mut |resolve, _reject| {
        context.queue.on_submitted_work_done(move || {
            let _ = resolve.call0(&wasm_bindgen::JsValue::NULL);
        });
    });
    let _ = context.device.poll(wgpu::PollType::Poll);
    wasm_bindgen_futures::JsFuture::from(promise)
        .await
        .map(|_| ())
        .map_err(|error| {
            WebError::with_details(
                Forge3DErrorCode::InternalError,
                "Waiting for submitted GPU work failed",
                error,
            )
        })
}

/// Copies a storage buffer to a mappable buffer and reads it back.
pub(crate) async fn read_buffer(
    context: &GpuContext,
    source: &wgpu::Buffer,
    size: u64,
) -> Result<Vec<u8>, WebError> {
    let staging = staging_buffer(&context.device, "forge3d-web-offline-readback", size);
    let mut encoder = context
        .device
        .create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("forge3d-web-offline-readback-encoder"),
        });
    encoder.copy_buffer_to_buffer(source, 0, &staging, 0, size);
    context.queue.submit(std::iter::once(encoder.finish()));
    let mut bytes =
        crate::runtime::readback::map_readback_buffer(context, &staging, size.max(4)).await?;
    bytes.truncate(size as usize);
    Ok(bytes)
}

/// Copies a texture through a padded-row buffer and returns the padded bytes
/// plus the layout used (typed decode happens in `forge3d_core::readback`).
pub(crate) async fn read_texture(
    context: &GpuContext,
    texture: &wgpu::Texture,
    format: forge3d_core::readback::ReadbackFormat,
    width: u32,
    height: u32,
) -> Result<(Vec<u8>, forge3d_core::readback::ReadbackLayout), WebError> {
    let layout = format
        .layout(width, height)
        .map_err(crate::error::map_core_error)?;
    let staging = staging_buffer(
        &context.device,
        "forge3d-web-offline-texture-readback",
        layout.buffer_size,
    );
    let mut encoder = context
        .device
        .create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("forge3d-web-offline-texture-readback-encoder"),
        });
    encoder.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo {
            texture,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        wgpu::TexelCopyBufferInfo {
            buffer: &staging,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(layout.padded_bytes_per_row),
                rows_per_image: Some(height),
            },
        },
        wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
    );
    context.queue.submit(std::iter::once(encoder.finish()));
    let bytes =
        crate::runtime::readback::map_readback_buffer(context, &staging, layout.buffer_size)
            .await?;
    Ok((bytes, layout))
}

pub(crate) fn copy_texture(
    encoder: &mut wgpu::CommandEncoder,
    source: &wgpu::Texture,
    destination: &wgpu::Texture,
    width: u32,
    height: u32,
) {
    encoder.copy_texture_to_texture(
        wgpu::TexelCopyTextureInfo {
            texture: source,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        wgpu::TexelCopyTextureInfo {
            texture: destination,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
    );
}

pub(crate) fn f32_bytes(values: &[f32]) -> &[u8] {
    bytemuck::cast_slice(values)
}

pub(crate) fn bytes_to_f32(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect()
}
