use super::bindings::view_entry;
use super::*;
impl EnvironmentResources {
    pub fn encode_water_aovs(
        &self,
        runtime: &Forge3DRuntime,
        encoder: &mut wgpu::CommandEncoder,
        color: &wgpu::TextureView,
        targets: &crate::runtime::offline::gpu::CaptureTargets,
        surface: bool,
    ) {
        if self.snapshot.water.is_empty() {
            return;
        }
        let device = &runtime.context.as_ref().unwrap().device;
        let shadows = runtime.shadows.as_ref().unwrap();
        let shadow = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("environment-water-shadow-group"),
            layout: &self.shadow_layout,
            entries: &[
                view_entry(0, &shadows.depth_array_view),
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: shadows.uniform_buffer.as_entire_binding(),
                },
            ],
        });
        let group = self.group(
            device,
            color,
            &targets.depth_stencil.view,
            &self.effect.view,
        );
        water_draw(
            encoder,
            &[&targets.depth.view, &targets.id.view, &targets.motion.view],
            &self.water_primary,
            &group,
            &shadow,
        );
        if surface {
            water_draw(
                encoder,
                &[&targets.albedo.view, &targets.normal.view],
                &self.water_surface,
                &group,
                &shadow,
            );
        }
    }
}
pub(super) fn water_pipeline(
    device: &wgpu::Device,
    layout: &wgpu::BindGroupLayout,
    shadow: &wgpu::BindGroupLayout,
    shader: &wgpu::ShaderModule,
    entry: &str,
    formats: &[wgpu::TextureFormat],
) -> wgpu::RenderPipeline {
    let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("environment-water-aov-layout"),
        bind_group_layouts: &[Some(layout), Some(shadow)],
        immediate_size: 0,
    });
    let targets: Vec<_> = formats
        .iter()
        .map(|&format| {
            Some(wgpu::ColorTargetState {
                format,
                blend: None,
                write_mask: wgpu::ColorWrites::ALL,
            })
        })
        .collect();
    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("environment-water-aov-pipeline"),
        layout: Some(&layout),
        vertex: wgpu::VertexState {
            module: shader,
            entry_point: Some("vs_env"),
            buffers: &[],
            compilation_options: Default::default(),
        },
        fragment: Some(wgpu::FragmentState {
            module: shader,
            entry_point: Some(entry),
            targets: &targets,
            compilation_options: Default::default(),
        }),
        primitive: Default::default(),
        depth_stencil: None,
        multisample: Default::default(),
        multiview_mask: None,
        cache: None,
    })
}
fn water_draw(
    encoder: &mut wgpu::CommandEncoder,
    views: &[&wgpu::TextureView],
    pipeline: &wgpu::RenderPipeline,
    group: &wgpu::BindGroup,
    shadow: &wgpu::BindGroup,
) {
    let attachments: Vec<_> = views
        .iter()
        .map(|view| {
            Some(wgpu::RenderPassColorAttachment {
                view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Load,
                    store: wgpu::StoreOp::Store,
                },
            })
        })
        .collect();
    let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
        label: Some("environment-water-aov-pass"),
        color_attachments: &attachments,
        depth_stencil_attachment: None,
        timestamp_writes: None,
        occlusion_query_set: None,
        multiview_mask: None,
    });
    pass.set_pipeline(pipeline);
    pass.set_bind_group(0, group, &[]);
    pass.set_bind_group(1, shadow, &[]);
    pass.draw(0..3, 0..1);
}
