use super::gpu::Target;
use crate::{
    error::{map_core_error, WebError},
    runtime::Forge3DRuntime,
};
use forge3d_core::{environment::Environment, gpu::GpuContext};
struct Layer {
    index: usize,
    view: wgpu::TextureView,
    camera: wgpu::Buffer,
}
pub(crate) struct ReflectionTargets {
    _texture: wgpu::Texture,
    pub array_view: wgpu::TextureView,
    depth: Target,
    layers: Vec<Layer>,
}
impl ReflectionTargets {
    pub fn new(
        context: &GpuContext,
        s: &Environment,
        w: u32,
        h: u32,
        format: wgpu::TextureFormat,
    ) -> Self {
        let planar = s.water.iter().any(|w| w.reflection == "planar");
        let (w, h) = if planar { (w, h) } else { (1, 1) };
        let texture = context.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("environment-planar-reflections"),
            size: wgpu::Extent3d {
                width: w,
                height: h,
                depth_or_array_layers: s.water.len().max(1) as u32,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        let array_view = texture.create_view(&wgpu::TextureViewDescriptor {
            dimension: Some(wgpu::TextureViewDimension::D2Array),
            ..Default::default()
        });
        let depth = Target::new(&context.device, w, h, super::super::terrain::DEPTH_FORMAT);
        let layers = s
            .water
            .iter()
            .enumerate()
            .filter(|(_, l)| l.reflection == "planar")
            .map(|(index, _)| Layer {
                index,
                view: texture.create_view(&wgpu::TextureViewDescriptor {
                    dimension: Some(wgpu::TextureViewDimension::D2),
                    base_array_layer: index as u32,
                    array_layer_count: Some(1),
                    ..Default::default()
                }),
                camera: context.device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some("environment-reflected-camera"),
                    size: 96,
                    usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                    mapped_at_creation: false,
                }),
            })
            .collect();
        Self {
            _texture: texture,
            array_view,
            depth,
            layers,
        }
    }
    pub fn update(&self, runtime: &Forge3DRuntime) -> Result<(), WebError> {
        let e = runtime.environment.as_ref().expect("environment");
        let context = runtime.context.as_ref().expect("context");
        let vp = glam::Mat4::from_cols_array_2d(
            &runtime
                .camera
                .view_projection_matrix(runtime.width as f32 / runtime.height as f32)
                .map_err(map_core_error)?,
        );
        for layer in &self.layers {
            let height = e.snapshot.water[layer.index].height;
            let reflect = glam::Mat4::from_cols(
                glam::Vec4::X,
                -glam::Vec4::Y,
                glam::Vec4::Z,
                glam::vec4(0., 2. * height, 0., 1.),
            );
            let position = reflect.transform_point3(runtime.camera.position.into());
            let fwd = reflect
                .transform_vector3(
                    glam::Vec3::from(runtime.camera.target)
                        - glam::Vec3::from(runtime.camera.position),
                )
                .normalize();
            let mut data = Vec::from((vp * reflect).to_cols_array());
            data.extend_from_slice(&[position.x, position.y, position.z, -1.]);
            data.extend_from_slice(&[fwd.x, fwd.y, fwd.z, height]);
            context
                .queue
                .write_buffer(&layer.camera, 0, bytemuck::cast_slice(&data));
        }
        Ok(())
    }
    pub fn encode(&self, runtime: &Forge3DRuntime, encoder: &mut wgpu::CommandEncoder) {
        let (Some(context), Some(textures), Some(ibl), Some(lighting)) = (
            runtime.context.as_ref(),
            runtime.textures.as_ref(),
            runtime.ibl.as_ref(),
            runtime.lighting.as_ref(),
        ) else {
            return;
        };
        for layer in &self.layers {
            let terrain_group = runtime.terrain.as_ref().and_then(|t| {
                runtime.terrain_pipeline_cache.as_ref().map(|cache| {
                    t.capture_bind_group(
                        &context.device,
                        cache.group0_for(t.features),
                        &layer.camera,
                    )
                })
            });
            let scene_group = runtime
                .scene
                .as_ref()
                .map(|s| s.capture_camera_bind_group(&context.device, &layer.camera));
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("forge3d-planar-reflection-pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &layer.view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                    view: &self.depth.view,
                    depth_ops: Some(wgpu::Operations {
                        load: wgpu::LoadOp::Clear(1.),
                        store: wgpu::StoreOp::Discard,
                    }),
                    stencil_ops: None,
                }),
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            if let (Some(t), Some(group)) = (runtime.terrain.as_ref(), terrain_group.as_ref()) {
                let (_, group2) = t.profile_bind_groups(textures.bind_group_for(0));
                pass.set_pipeline(&t.pipeline);
                pass.set_bind_group(0, group, &[]);
                pass.set_bind_group(1, &lighting.bind_group, &[]);
                pass.set_bind_group(2, group2, &[]);
                pass.set_bind_group(3, &ibl.bind_group, &[]);
                pass.set_vertex_buffer(0, t.vertex_buffer.slice(..));
                pass.set_index_buffer(t.index_buffer.slice(..), wgpu::IndexFormat::Uint32);
                if t.render_mode == 1 {
                    pass.draw(0..3, 0..1);
                } else {
                    pass.draw_indexed(0..t.index_count, 0, 0..1);
                }
            }
            if let (Some(scene), Some(group)) = (runtime.scene.as_ref(), scene_group.as_ref()) {
                scene.draw_reflection(&mut pass, group, textures, ibl);
            }
            if let Some(scatter) = runtime.scatter.as_ref() {
                scatter.draw_reflection(&mut pass, runtime, &layer.camera);
            }
        }
    }
}
