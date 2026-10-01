use super::*;
impl EnvironmentResources {
    pub fn update(&self, runtime: &Forge3DRuntime) -> Result<(), WebError> {
        let context = runtime
            .context
            .as_ref()
            .ok_or_else(|| crate::runtime::environment::invalid("context unavailable"))?;
        let vp = runtime
            .camera
            .view_projection_matrix(self.width as f32 / self.height as f32)
            .map_err(map_core_error)?;
        let matrix = glam::Mat4::from_cols_array_2d(&vp);
        if self.last_time.get() != runtime.time_seconds {
            self.history_valid.set(false);
        }
        let s = &self.snapshot;
        let mut p = [[0.; 4]; 19];
        p[5][3] = 1.;
        p[16][2] = 1.;
        p[16][3] = 32.;
        p[0] = [
            runtime.camera.position[0],
            runtime.camera.position[1],
            runtime.camera.position[2],
            runtime.time_seconds,
        ];
        let sun = s.sun_at(runtime.time_seconds);
        p[1] = [
            sun[0],
            sun[1],
            sun[2],
            if sun[1] > 0. { s.sun_intensity } else { 0. },
        ];
        p[2] = [
            s.sun_color[0],
            s.sun_color[1],
            s.sun_color[2],
            s.temporal_weight,
        ];
        if let Some(sky) = &s.sky {
            p[3] = [sky.turbidity, sky.ground_albedo, sky.sun_size, sky.exposure];
            p[9][2] = if sky.model == "hosek-wilkie" { 1. } else { 0. };
            p[9][3] = 1.;
            p[18] = [
                u32::from(sky.aerial_perspective) as f32,
                sky.aerial_density,
                sky.sun_intensity,
                u32::from(runtime.terrain.as_ref().is_some_and(|t| t.render_mode == 1)) as f32,
            ];
        } else {
            p[3] = [2., 0.2, 0.00465, 1.];
        }
        if let Some(f) = &s.fog {
            p[4] = [f.density, f.height, f.falloff, f.anisotropy];
            p[5] = [
                f.color[0],
                f.color[1],
                f.color[2],
                u32::from(f.god_rays) as f32,
            ];
            p[12][2] = 1.;
            p[16][2] = f.shaft_intensity;
            p[16][3] = f.shaft_samples as f32;
            p[14][1] = match f.mode.as_str() {
                "uniform" => 0.,
                "height" => 1.,
                _ => 2.,
            };
            p[14][2] = f.scattering;
            p[14][3] = f.absorption;
        }
        if let Some(c) = &s.clouds {
            p[6] = [c.density, c.coverage, c.scale, c.height];
            p[7] = [c.thickness, c.wind[0], c.wind[1], c.animation_speed];
            p[8] = [c.shadow_strength, c.absorption, c.anisotropy, c.ambient];
            p[9][0] = c.fade_distance;
            p[9][1] = match c.mode.as_str() {
                "billboard" => 0.,
                "volumetric" => 1.,
                _ => 2.,
            };
            p[12][3] = 1.;
            p[17] = [c.color[0], c.color[1], c.color[2], c.scatter_strength];
        }
        let (ew, eh) = s.effect_size(self.width, self.height);
        p[10] = [self.width as f32, self.height as f32, ew as f32, eh as f32];
        p[16][0] = runtime.camera.near;
        p[16][1] = runtime.camera.far;
        p[11] = [
            s.max_distance,
            s.steps as f32,
            s.volumes.len() as f32,
            s.water.len() as f32,
        ];
        p[12][0] = match s.debug.as_str() {
            "transmittance" => 1.,
            "clouds" => 2.,
            "water-mask" => 3.,
            "foam" => 4.,
            "reflection" => 5.,
            _ => 0.,
        };
        p[12][1] = u32::from(self.history_valid.get()) as f32;
        p[13] = runtime.clear_color;
        let fwd = (glam::Vec3::from(runtime.camera.target)
            - glam::Vec3::from(runtime.camera.position))
        .normalize();
        p[15] = [fwd.x, fwd.y, fwd.z, 0.];
        p[14][0] = if s.volumetric_mode == "froxel" {
            1.
        } else {
            0.
        };
        context.queue.write_buffer(
            &self.uniform,
            0,
            bytemuck::bytes_of(&Uniform {
                inverse: matrix.inverse().to_cols_array_2d(),
                vp,
                previous: self.previous_vp.get(),
                p,
                bits: [
                    s.clouds.as_ref().map_or(0, |c| c.seed),
                    u32::from(s.fog.as_ref().is_none_or(|f| f.use_shadows)),
                    u32::from(s.clouds.as_ref().is_some_and(|c| c.render_path == "native")),
                    0,
                ],
            }),
        );
        self.reflection.update(runtime)?;
        Ok(())
    }
    pub fn update_capture(
        &self,
        context: &GpuContext,
        camera: &crate::runtime::terrain::CaptureCameraUniform,
        terrain: Option<&crate::runtime::terrain::TerrainRenderResources>,
    ) {
        self.history_valid.set(false);
        context.queue.write_buffer(
            &self.uniform,
            192 + 12 * 16 + 4,
            bytemuck::bytes_of(&0.0f32),
        );
        let matrix = glam::Mat4::from_cols_array_2d(&camera.base.view_projection);
        if let Some(terrain) = terrain {
            // Screen-terrain aerial perspective samples the same jittered sky ray
            // as the offline pass; keep its appended matrix synchronized.
            context.queue.write_buffer(
                &terrain.material.uniform_buffer,
                std::mem::size_of::<forge3d_core::terrain_material::TerrainMaterialUniform>()
                    as u64
                    + 64,
                bytemuck::cast_slice(&matrix.inverse().to_cols_array()),
            );
        }
        context.queue.write_buffer(
            &self.uniform,
            0,
            bytemuck::cast_slice(&matrix.inverse().to_cols_array()),
        );
        context.queue.write_buffer(
            &self.uniform,
            64,
            bytemuck::bytes_of(&camera.motion_current),
        );
        context.queue.write_buffer(
            &self.uniform,
            128,
            bytemuck::bytes_of(&camera.motion_previous),
        );
        context.queue.write_buffer(
            &self.uniform,
            192,
            bytemuck::cast_slice(&camera.base.camera_position[..3]),
        );
        context.queue.write_buffer(
            &self.uniform,
            192 + 15 * 16,
            bytemuck::bytes_of(&camera.base.camera_forward),
        );
        context.queue.write_buffer(
            &self.uniform,
            192 + 16 * 16,
            bytemuck::cast_slice(&camera.capture_params[..2]),
        );
    }
}
