use super::*;

pub(crate) fn build(
    runtime: &Forge3DRuntime,
    inputs: Vec<ScatterBatch>,
    memory: &mut crate::runtime::memory::MemoryLedger,
) -> Result<Option<ScatterResources>, WebError> {
    if inputs.is_empty() {
        memory.release(KEY);
        memory.release(TEXTURES_KEY);
        return Ok(None);
    }
    let context = runtime
        .context
        .as_ref()
        .ok_or_else(|| invalid("scatter requires an active runtime"))?;
    let lighting = runtime
        .lighting
        .as_ref()
        .ok_or_else(|| invalid("scatter requires lighting resources"))?;
    let textures = runtime
        .textures
        .as_ref()
        .ok_or_else(|| invalid("scatter requires texture resources"))?;
    let ibl = runtime
        .ibl
        .as_ref()
        .ok_or_else(|| invalid("scatter requires IBL resources"))?;
    let mut report = MemoryReport {
        batch_count: inputs.len(),
        uniform_buffer_bytes: 256,
        texture_bytes: 8,
        ..Default::default()
    };
    for batch in &inputs {
        batch.validate().map_err(invalid)?;
        report.level_count += batch.levels.len();
        report.total_instances += batch.transforms.len() / 16;
        report.hlod_cluster_count += batch.clusters.len();
        for l in &batch.levels {
            report.vertex_buffer_bytes += (l.mesh.positions.len() / 3 * 72) as u64;
            report.index_buffer_bytes += (l.mesh.indices.len() * 4) as u64;
            report.instance_buffer_bytes += (batch.transforms.len() / 16 * 80) as u64;
            report.uniform_buffer_bytes += 128;
        }
        for c in &batch.clusters {
            report.hlod_buffer_bytes +=
                (c.mesh.positions.len() / 3 * 72 + c.mesh.indices.len() * 4 + 80) as u64;
            report.uniform_buffer_bytes += 128;
        }
    }
    report.total_buffer_bytes = report
        .vertex_buffer_bytes
        .checked_add(report.index_buffer_bytes)
        .and_then(|n| n.checked_add(report.instance_buffer_bytes))
        .and_then(|n| n.checked_add(report.hlod_buffer_bytes))
        .and_then(|n| n.checked_add(report.uniform_buffer_bytes))
        .ok_or_else(|| invalid("scatter byte accounting overflow"))?;
    report.gpu_bytes = report.total_buffer_bytes + report.texture_bytes;
    if inputs.iter().any(|b| {
        (b.transforms.len() / 16 * 80) as u64 > runtime.max_buffer_size
            || b.levels.iter().any(|l| {
                (l.mesh.positions.len() / 3 * 72) as u64 > runtime.max_buffer_size
                    || (l.mesh.indices.len() * 4) as u64 > runtime.max_buffer_size
            })
            || b.clusters.iter().any(|c| {
                (c.mesh.positions.len() / 3 * 72) as u64 > runtime.max_buffer_size
                    || (c.mesh.indices.len() * 4) as u64 > runtime.max_buffer_size
            })
    }) {
        return Err(WebError::new(
            Forge3DErrorCode::ResourceLimitExceeded,
            "scatter exceeds maxBufferSize",
        ));
    }
    memory.replace_all(&[
        (KEY, MemoryCategory::Buffers, report.total_buffer_bytes),
        (TEXTURES_KEY, MemoryCategory::Textures, 8),
    ])?;
    let device = &context.device;
    let layout = pipeline::camera_layout(device);
    let camera = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("scatter-camera"),
        size: 256,
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let fallback_height = fallback(
        device,
        wgpu::TextureFormat::R32Float,
        wgpu::TextureViewDimension::D2,
    );
    let fallback_pages = fallback(
        device,
        wgpu::TextureFormat::R32Uint,
        wgpu::TextureViewDimension::D2Array,
    );
    let format = runtime
        .surface_state
        .as_ref()
        .ok_or_else(|| invalid("scatter requires a surface"))?
        .config
        .format;
    let features = crate::runtime::shader_variants::runtime_lighting_features(runtime)?;
    let layouts = [
        &layout,
        &lighting.bind_group_layout,
        &textures.bind_group_layout,
        &ibl.bind_group_layout,
    ];
    let (display, primary, surface) = pipelines(device, layouts, features, format);
    let mut id_start = 0x100000;
    let batches = inputs
        .into_iter()
        .map(|input| {
            let levels = input
                .levels
                .iter()
                .map(|l| {
                    draw(
                        context,
                        &layout,
                        &camera,
                        &fallback_height,
                        &fallback_pages,
                        &l.mesh,
                        input.color,
                        input.transforms.len() / 16,
                    )
                })
                .collect();
            let clusters = input
                .clusters
                .iter()
                .map(|c| {
                    draw(
                        context,
                        &layout,
                        &camera,
                        &fallback_height,
                        &fallback_pages,
                        &c.mesh,
                        input.color,
                        1,
                    )
                })
                .collect();
            let start = id_start;
            id_start += input.transforms.len() as u32 / 16;
            Batch {
                input,
                levels,
                clusters,
                id_start: start,
            }
        })
        .collect();
    Ok(Some(ScatterResources {
        batches,
        camera,
        layout,
        fallback_height,
        fallback_pages,
        features,
        format,
        pipeline: display,
        primary,
        surface,
        stats: Default::default(),
        memory: report,
    }))
}
