//! Bounded texture transfers: admission, regions, staging, decoding and cleanup.
mod coverage;
mod frame;
mod map;
mod mapping;
mod plan;
mod reference;
#[cfg(test)]
pub(super) use frame::normalize_readback_to_rgba;
pub(super) use frame::read_rgba_runtime;
pub(super) use map::read_map_frame_runtime;
pub(super) use mapping::map_readback_buffer;
#[cfg(test)]
mod tests;
use super::memory::MemoryLedger;
use crate::error::{map_core_error, WebError};
use forge3d_core::{
    gpu::GpuContext,
    memory::MemoryCategory,
    readback::{decode_float_rows, decode_u32_rows, unpad_rows, ReadbackFormat, ReadbackLayout},
};
pub(super) use plan::{Plan, Region};

pub(super) struct Request<'a> {
    pub texture: &'a wgpu::Texture,
    pub region: Region,
}
pub(super) struct Data {
    pub bytes: Vec<u8>,
    pub layout: ReadbackLayout,
    pub format: ReadbackFormat,
    layers: u32,
}
impl Data {
    pub fn tight(&self) -> Result<Vec<u8>, WebError> {
        let mut result = Vec::new();
        for bytes in self
            .bytes
            .chunks_exact(self.layout.buffer_size as usize)
            .take(self.layers as usize)
        {
            result.extend(unpad_rows(bytes, self.layout).map_err(map_core_error)?);
        }
        Ok(result)
    }
    pub fn floats(&self) -> Result<Vec<f32>, WebError> {
        let mut result = Vec::new();
        for bytes in self
            .bytes
            .chunks_exact(self.layout.buffer_size as usize)
            .take(self.layers as usize)
        {
            result.extend(
                decode_float_rows(bytes, self.layout, self.format).map_err(map_core_error)?,
            );
        }
        Ok(result)
    }
    pub fn uints(&self) -> Result<Vec<u32>, WebError> {
        decode_u32_rows(&self.bytes, self.layout).map_err(map_core_error)
    }
}

// The guard also releases admission when a future is dropped while mapping.
struct Admission<'a> {
    memory: &'a mut MemoryLedger,
    key: &'static str,
}
impl Drop for Admission<'_> {
    fn drop(&mut self) {
        self.memory.release(self.key);
    }
}
pub(super) async fn admitted<T>(
    memory: &mut MemoryLedger,
    key: &'static str,
    bytes: u64,
    work: impl std::future::Future<Output = Result<T, WebError>>,
) -> Result<T, WebError> {
    memory.replace(key, MemoryCategory::Readback, bytes)?;
    let _admission = Admission { memory, key };
    work.await
}

pub(super) struct Job {
    buffer: Option<wgpu::Buffer>,
    plans: Vec<Plan>,
    bytes: u64,
}
impl Drop for Job {
    fn drop(&mut self) {
        if let Some(buffer) = &self.buffer {
            buffer.unmap();
        }
    }
}
impl Job {
    pub fn plans(requests: &[Request<'_>], max_buffer: u64) -> Result<Vec<Plan>, WebError> {
        let mut offset = 0;
        requests
            .iter()
            .map(|r| {
                use wgpu::TextureFormat as F;
                let format = match r.texture.format() {
                    F::Rgba8Unorm | F::Rgba8UnormSrgb => ReadbackFormat::Rgba8Unorm,
                    F::Bgra8Unorm | F::Bgra8UnormSrgb => ReadbackFormat::Bgra8Unorm,
                    F::Rgba16Float => ReadbackFormat::Rgba16Float,
                    F::Rgba32Float => ReadbackFormat::Rgba32Float,
                    F::Rg32Float => ReadbackFormat::Rg32Float,
                    F::R32Float => ReadbackFormat::R32Float,
                    F::R32Uint => ReadbackFormat::R32Uint,
                    _ => {
                        return Err(crate::error::WebError::new(
                            crate::error::Forge3DErrorCode::UnsupportedFeature,
                            "unsupported texture readback format",
                        ))
                    }
                };
                if format != r.region.format
                    || !r.texture.usage().contains(wgpu::TextureUsages::COPY_SRC)
                    || r.texture.sample_count() != 1
                {
                    return Err(crate::error::WebError::new(
                        crate::error::Forge3DErrorCode::InvalidInput,
                        "incompatible texture readback source",
                    ));
                }
                let plan = Plan::new(
                    r.texture.size(),
                    r.texture.mip_level_count(),
                    r.region,
                    offset,
                    max_buffer,
                )?;
                offset = plan.end();
                Ok(plan)
            })
            .collect()
    }
    pub fn encode(
        context: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        requests: &[Request<'_>],
    ) -> Result<Self, WebError> {
        let plans = Self::plans(requests, context.device.limits().max_buffer_size)?;
        let bytes = plans.last().map_or(0, Plan::end);
        let buffer = (bytes > 0).then(|| {
            context.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("texture:bounded-readback"),
                size: bytes,
                usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            })
        });
        if let Some(buffer) = &buffer {
            for (r, p) in requests
                .iter()
                .zip(&plans)
                .filter(|(_, p)| p.layout.is_some())
            {
                let layout = p.layout.unwrap();
                encoder.copy_texture_to_buffer(
                    wgpu::TexelCopyTextureInfo {
                        texture: r.texture,
                        mip_level: r.region.mip,
                        origin: r.region.origin,
                        aspect: wgpu::TextureAspect::All,
                    },
                    wgpu::TexelCopyBufferInfo {
                        buffer,
                        layout: wgpu::TexelCopyBufferLayout {
                            offset: p.offset,
                            bytes_per_row: Some(layout.padded_bytes_per_row),
                            rows_per_image: Some(layout.height),
                        },
                    },
                    r.region.extent,
                );
            }
        }
        Ok(Self {
            buffer,
            plans,
            bytes,
        })
    }
    pub async fn read(&self, context: &GpuContext) -> Result<Vec<Data>, WebError> {
        let bytes = if let Some(buffer) = &self.buffer {
            map_readback_buffer(context, buffer, self.bytes).await?
        } else {
            Vec::new()
        };
        self.plans
            .iter()
            .filter_map(|p| {
                p.layout.map(|layout| Data {
                    bytes: bytes[p.offset as usize..p.end() as usize].to_vec(),
                    layout,
                    format: p.region.format,
                    layers: p.region.extent.depth_or_array_layers,
                })
            })
            .map(Ok)
            .collect()
    }
    pub async fn tight(&self, context: &GpuContext) -> Result<Vec<u8>, WebError> {
        let mut result = Vec::new();
        for data in self.read(context).await? {
            result.extend(data.tight()?);
        }
        Ok(result)
    }
}
pub(super) async fn read(
    context: &GpuContext,
    memory: &mut MemoryLedger,
    key: &'static str,
    requests: &[Request<'_>],
) -> Result<Vec<Data>, WebError> {
    let plans = Job::plans(requests, context.device.limits().max_buffer_size)?;
    let bytes = plans.last().map_or(0, Plan::end);
    admitted(memory, key, bytes, async {
        let mut encoder = context
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("texture:bounded-readback"),
            });
        let job = Job::encode(context, &mut encoder, requests)?;
        context.queue.submit(Some(encoder.finish()));
        job.read(context).await
    })
    .await
}
