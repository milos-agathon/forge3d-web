//! Persistent realtime G-buffer using the W06 capture variants.
use super::super::{offline, Forge3DRuntime};
use crate::error::WebError;
use forge3d_core::{camera::CameraInput, gpu::GpuContext};
use offline::{
    gpu::{uniform_buffer, CaptureTargets, Target},
    CapturePass, CaptureView, TerrainCapture,
};

pub(in crate::runtime) struct CaptureFrame {
    pub targets: CaptureTargets,
    pub camera_buffer: wgpu::Buffer,
    terrain: Option<TerrainCapture>,
    scene_camera: Option<wgpu::BindGroup>,
    environment_source: Option<Target>,
    width: u32,
    height: u32,
    surface: bool,
}
impl CaptureFrame {
    pub fn new(runtime: &mut Forge3DRuntime, context: &GpuContext) -> Result<Self, WebError> {
        Self::create(runtime, context, true)
    }

    pub fn reference(runtime: &mut Forge3DRuntime, context: &GpuContext) -> Result<Self, WebError> {
        Self::create(runtime, context, false)
    }

    fn create(
        runtime: &mut Forge3DRuntime,
        context: &GpuContext,
        surface: bool,
    ) -> Result<Self, WebError> {
        let (width, height) = (runtime.width, runtime.height);
        let device = &context.device;
        let initial = super::super::terrain::create_capture_camera_uniform(
            &runtime.camera,
            &runtime.camera,
            width,
            height,
            [0.; 2],
            offline::AOV_ID_TERRAIN,
        )?;
        let camera_buffer = uniform_buffer(
            device,
            "postfx:capture-camera",
            bytemuck::bytes_of(&initial),
        );
        let features = super::super::shader_variants::runtime_terrain_lighting_features(runtime)?;
        let terrain = match (
            runtime.terrain.as_ref(),
            runtime.terrain_pipeline_cache.as_mut(),
        ) {
            (Some(t), Some(cache)) => {
                let f = t.specialize(features);
                Some(TerrainCapture {
                    primary: cache.capture_variant(device, f, CapturePass::Primary),
                    surface: surface
                        .then(|| cache.capture_variant(device, f, CapturePass::Surface)),
                    bind_group: t.capture_bind_group(device, cache.group0_for(f), &camera_buffer),
                })
            }
            _ => None,
        };
        let scene_camera = runtime.scene.as_mut().map(|s| {
            s.prepare_capture(context, surface);
            s.capture_camera_bind_group(device, &camera_buffer)
        });
        let targets = CaptureTargets::new(
            device,
            width,
            height,
            surface,
            surface,
            features.capture_blend(),
        );
        let environment_source = runtime.environment.as_ref().map(|_| {
            Target::new(
                device,
                "postfx:environment-source",
                targets.color.texture.format(),
                width,
                height,
            )
        });
        Ok(Self {
            targets,
            camera_buffer,
            terrain,
            scene_camera,
            environment_source,
            width,
            height,
            surface,
        })
    }
    pub fn update(
        &self,
        runtime: &mut Forge3DRuntime,
        context: &GpuContext,
        previous: &CameraInput,
        jitter: [f32; 2],
    ) -> Result<(), WebError> {
        let uniform = super::super::terrain::create_capture_camera_uniform(
            &runtime.camera,
            previous,
            self.width,
            self.height,
            jitter,
            offline::AOV_ID_TERRAIN,
        )?;
        context
            .queue
            .write_buffer(&self.camera_buffer, 0, bytemuck::bytes_of(&uniform));
        super::super::scatter::prepare(runtime, Some(&uniform))?;
        if let Some(e) = &runtime.environment {
            e.update_capture(context, &uniform, runtime.terrain.as_ref());
        }
        Ok(())
    }
    pub fn encode(&self, runtime: &Forge3DRuntime, encoder: &mut wgpu::CommandEncoder) {
        self.encode_view(runtime, encoder, true, None);
    }

    pub fn encode_reference(
        &self,
        runtime: &Forge3DRuntime,
        encoder: &mut wgpu::CommandEncoder,
        view_projection: [[f32; 4]; 4],
    ) {
        self.encode_view(runtime, encoder, false, Some(view_projection));
    }

    fn encode_view(
        &self,
        runtime: &Forge3DRuntime,
        encoder: &mut wgpu::CommandEncoder,
        realtime: bool,
        vector_view_projection: Option<[[f32; 4]; 4]>,
    ) {
        offline::encode_capture_view(
            runtime,
            &CaptureView {
                width: self.width,
                height: self.height,
                targets: &self.targets,
                terrain: self.terrain.as_ref(),
                scene_camera: self.scene_camera.as_ref(),
                environment_source: self.environment_source.as_ref(),
                surface: self.surface,
                overlay: false,
                realtime,
                vector_view_projection,
            },
            encoder,
            self.surface,
        );
    }
}
