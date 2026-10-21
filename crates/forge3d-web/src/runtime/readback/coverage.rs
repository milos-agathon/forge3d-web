//! Read opaque coverage from the display depth without an offline HDR capture.
use crate::error::WebError;
use forge3d_core::gpu::GpuContext;

const SHADER: &str = r#"
@group(0) @binding(0) var depth: texture_depth_2d;
@group(0) @binding(1) var<storage, read_write> coverage: array<u32>;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let size = textureDimensions(depth);
    if (id.x >= size.x || id.y >= size.y) { return; }
    coverage[id.y * size.x + id.x] = select(0u, 1u, textureLoad(depth, vec2<i32>(id.xy), 0) < 1.0);
}
"#;

pub(super) struct CoverageReadback {
    pipeline: wgpu::ComputePipeline,
    bindings: wgpu::BindGroup,
    storage: wgpu::Buffer,
    readback: wgpu::Buffer,
    bytes: u64,
}

impl CoverageReadback {
    pub(super) fn new(
        device: &wgpu::Device,
        depth: &wgpu::TextureView,
        width: u32,
        height: u32,
    ) -> Self {
        let bytes = u64::from(width) * u64::from(height) * 4;
        let storage = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("forge3d-web-map-coverage"),
            size: bytes,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        let readback = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("forge3d-web-map-coverage-readback"),
            size: bytes,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("forge3d-web-map-coverage"),
            source: wgpu::ShaderSource::Wgsl(SHADER.into()),
        });
        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("forge3d-web-map-coverage"),
            layout: None,
            module: &module,
            entry_point: Some("main"),
            compilation_options: Default::default(),
            cache: None,
        });
        let bindings = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("forge3d-web-map-coverage"),
            layout: &pipeline.get_bind_group_layout(0),
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(depth),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: storage.as_entire_binding(),
                },
            ],
        });
        Self {
            pipeline,
            bindings,
            storage,
            readback,
            bytes,
        }
    }

    pub(super) fn encode(&self, encoder: &mut wgpu::CommandEncoder, width: u32, height: u32) {
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("forge3d-web-map-coverage"),
                timestamp_writes: None,
            });
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &self.bindings, &[]);
            pass.dispatch_workgroups(width.div_ceil(8), height.div_ceil(8), 1);
        }
        encoder.copy_buffer_to_buffer(&self.storage, 0, &self.readback, 0, self.bytes);
    }

    pub(super) async fn read(self, context: &GpuContext) -> Result<Vec<u8>, WebError> {
        let data = super::map_readback_buffer(context, &self.readback, self.bytes).await?;
        Ok(data
            .chunks_exact(4)
            .map(|bytes| u32::from_le_bytes(bytes.try_into().unwrap()) as u8)
            .collect())
    }
}
