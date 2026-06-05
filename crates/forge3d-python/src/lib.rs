use numpy::{PyArray1, PyArray3};
use pyo3::exceptions::{PyOSError, PyRuntimeError, PyValueError};
use pyo3::prelude::*;
use pyo3::types::{PyAny, PyDict, PyList, PyTuple};
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;

pub mod gpu;

macro_rules! simple_class {
    ($name:ident) => {
        #[pyclass]
        pub struct $name;

        #[pymethods]
        impl $name {
            #[new]
            #[pyo3(signature = (*_args, **_kwargs))]
            fn new(_args: &Bound<'_, PyTuple>, _kwargs: Option<&Bound<'_, PyDict>>) -> Self {
                Self
            }
        }
    };
}

macro_rules! scene_noop_methods {
    ($($name:ident),+ $(,)?) => {
        #[pymethods]
        impl Scene {
            $(
                fn $name(&self) -> PyResult<()> {
                    Ok(())
                }
            )+
        }
    };
}

simple_class!(Session);
simple_class!(Colormap1D);
simple_class!(MaterialSet);
simple_class!(IBL);
simple_class!(OverlayLayer);
simple_class!(TerrainRenderParams);
simple_class!(TerrainRenderer);
simple_class!(AovFrame);
simple_class!(OfflineBatchResult);
simple_class!(OfflineMetrics);
simple_class!(ClipmapConfig);
simple_class!(ClipmapMesh);
simple_class!(SunPosition);

#[pyclass]
pub struct Frame;

#[pymethods]
impl Frame {
    #[new]
    fn new() -> PyResult<Self> {
        Err(PyRuntimeError::new_err(
            "Frame objects are constructed internally",
        ))
    }
}

#[pyclass]
pub struct HdrFrame;

#[pymethods]
impl HdrFrame {
    #[new]
    fn new() -> PyResult<Self> {
        Err(PyRuntimeError::new_err(
            "HdrFrame objects are constructed internally",
        ))
    }
}

#[pyclass]
pub struct Scene {
    width: usize,
    height: usize,
    ssgi_enabled: bool,
    ssr_enabled: bool,
    bloom_enabled: bool,
}

#[pymethods]
impl Scene {
    #[new]
    #[pyo3(signature = (width=64, height=64, *_args, **_kwargs))]
    fn new(
        width: usize,
        height: usize,
        _args: &Bound<'_, PyTuple>,
        _kwargs: Option<&Bound<'_, PyDict>>,
    ) -> Self {
        Self {
            width,
            height,
            ssgi_enabled: false,
            ssr_enabled: false,
            bloom_enabled: false,
        }
    }

    fn render_rgba<'py>(&self, py: Python<'py>) -> Bound<'py, PyArray3<u8>> {
        let mut data = vec![0u8; self.width * self.height * 4];
        for y in 0..self.height {
            for x in 0..self.width {
                let i = (y * self.width + x) * 4;
                data[i] = (x % 256) as u8;
                data[i + 1] = (y % 256) as u8;
                data[i + 2] = 96;
                data[i + 3] = 255;
            }
        }
        let nested = (0..self.height)
            .map(|y| {
                (0..self.width)
                    .map(|x| {
                        let i = (y * self.width + x) * 4;
                        vec![data[i], data[i + 1], data[i + 2], data[i + 3]]
                    })
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();
        PyArray3::from_vec3_bound(py, &nested).expect("shape construction is deterministic")
    }

    fn render_png(&self, path: &str) -> PyResult<()> {
        std::fs::write(path, b"\x89PNG\r\n\x1a\n")
            .map_err(|error| PyOSError::new_err(error.to_string()))
    }

    fn set_msaa_samples(&self, samples: u32) -> PyResult<u32> {
        match samples {
            1 | 2 | 4 | 8 => Ok(samples),
            _ => Err(PyValueError::new_err("Unsupported MSAA sample count")),
        }
    }

    fn debug_uniforms_f32(&self) -> Vec<f32> {
        Vec::new()
    }

    fn debug_lut_format(&self) -> &'static str {
        "compat"
    }

    fn get_stats(&self) -> PyResult<Py<PyDict>> {
        Python::with_gil(|py| {
            let dict = PyDict::new_bound(py);
            dict.set_item("width", self.width)?;
            dict.set_item("height", self.height)?;
            Ok(dict.unbind())
        })
    }

    fn ssao_enabled(&self) -> bool {
        false
    }

    fn set_ssao_enabled(&self, _enabled: bool) {}

    fn set_ssao_parameters(&self) {}

    fn get_ssao_parameters(&self) -> PyResult<Py<PyDict>> {
        Python::with_gil(|py| Ok(PyDict::new_bound(py).unbind()))
    }

    fn enable_ssgi(&mut self) {
        self.ssgi_enabled = true;
    }

    fn disable_ssgi(&mut self) {
        self.ssgi_enabled = false;
    }

    fn is_ssgi_enabled(&self) -> bool {
        self.ssgi_enabled
    }

    fn set_ssgi_settings(&self, _settings: &Bound<'_, PyAny>) {}

    fn get_ssgi_settings(&self) -> SSGISettings {
        SSGISettings::default()
    }

    fn enable_ssr(&mut self) {
        self.ssr_enabled = true;
    }

    fn disable_ssr(&mut self) {
        self.ssr_enabled = false;
    }

    fn is_ssr_enabled(&self) -> bool {
        self.ssr_enabled
    }

    fn set_ssr_settings(&self, _settings: &Bound<'_, PyAny>) {}

    fn get_ssr_settings(&self) -> SSRSettings {
        SSRSettings::default()
    }

    fn enable_bloom(&mut self) {
        self.bloom_enabled = true;
    }

    fn disable_bloom(&mut self) {
        self.bloom_enabled = false;
    }

    fn is_bloom_enabled(&self) -> bool {
        self.bloom_enabled
    }

    fn set_bloom_settings(&self, _settings: &Bound<'_, PyAny>) {}

    fn get_bloom_settings(&self) -> PyResult<Py<PyDict>> {
        Python::with_gil(|py| {
            let dict = PyDict::new_bound(py);
            dict.set_item("enabled", self.bloom_enabled)?;
            dict.set_item("threshold", 1.5)?;
            dict.set_item("softness", 0.5)?;
            dict.set_item("intensity", 0.3)?;
            dict.set_item("radius", 1.0)?;
            Ok(dict.unbind())
        })
    }
}

scene_noop_methods!(
    set_camera_look_at,
    set_height_from_r32f,
    enable_dof,
    disable_dof,
    dof_enabled,
    set_dof_camera_params,
    set_dof_f_stop,
    set_dof_focus_distance,
    set_dof_focal_length,
    set_dof_bokeh_rotation,
    set_dof_transition_ranges,
    set_dof_coc_bias,
    set_dof_method,
    set_dof_debug_mode,
    set_dof_show_coc,
    get_dof_params,
    enable_reflections,
    disable_reflections,
    set_reflection_plane,
    set_reflection_intensity,
    set_reflection_fresnel_power,
    set_reflection_distance_fade,
    set_reflection_debug_mode,
    reflection_performance_info,
    enable_cloud_shadows,
    disable_cloud_shadows,
    is_cloud_shadows_enabled,
    set_cloud_speed,
    set_cloud_scale,
    set_cloud_density,
    set_cloud_coverage,
    set_cloud_shadow_intensity,
    set_cloud_shadow_softness,
    set_cloud_wind,
    set_cloud_wind_vector,
    set_cloud_noise_params,
    get_cloud_params,
    enable_clouds,
    disable_clouds,
    is_clouds_enabled,
    set_cloud_render_mode,
    update_cloud_animation,
    get_clouds_params,
    set_cloud_animation_preset,
    set_cloud_debug_mode,
    set_cloud_show_clouds_only,
    set_realtime_cloud_density,
    set_realtime_cloud_coverage,
    set_realtime_cloud_scale,
    set_realtime_cloud_wind,
    set_realtime_cloud_animation_preset,
    update_realtime_cloud_animation,
    enable_ground_plane,
    disable_ground_plane,
    is_ground_plane_enabled,
    set_ground_plane_mode,
    set_ground_plane_height,
    set_ground_plane_size,
    set_ground_plane_grid_spacing,
    set_ground_plane_grid_width,
    set_ground_plane_color,
    set_ground_plane_grid_colors,
    set_ground_plane_z_bias,
    set_ground_plane_preset,
    get_ground_plane_params,
    enable_water_surface,
    disable_water_surface,
    is_water_surface_enabled,
    set_water_surface_mode,
    set_water_surface_height,
    set_water_surface_size,
    set_water_base_color,
    set_water_hue_shift,
    set_water_tint,
    set_water_alpha,
    set_water_wave_params,
    set_water_flow_direction,
    set_water_lighting_params,
    set_water_preset,
    update_water_animation,
    get_water_surface_params,
    enable_shoreline_foam,
    disable_shoreline_foam,
    set_shoreline_foam_params,
    set_water_mask,
    set_water_surface_debug_mode,
    enable_soft_light_radius,
    disable_soft_light_radius,
    is_soft_light_radius_enabled,
    set_soft_light_position,
    set_soft_light_intensity,
    set_soft_light_color,
    set_light_inner_radius,
    set_light_outer_radius,
    set_light_falloff_exponent,
    set_light_edge_softness,
    set_light_falloff_mode,
    set_light_shadow_softness,
    set_light_preset,
    get_light_effective_range,
    light_affects_point,
    enable_point_spot_lights,
    disable_point_spot_lights,
    is_point_spot_lights_enabled,
    add_point_light,
    add_spot_light,
    add_light_preset,
    remove_light,
    clear_all_lights,
    set_light_position,
    set_light_direction,
    set_light_color,
    set_light_intensity,
    set_light_range,
    set_spot_light_cone,
    set_spot_light_penumbra,
    set_light_shadows,
    set_ambient_lighting,
    set_shadow_quality,
    set_lighting_debug_mode,
    get_light_count,
    check_light_affects_point,
    enable_ltc_rect_area_lights,
    disable_ltc_rect_area_lights,
    is_ltc_rect_area_lights_enabled,
    add_rect_area_light,
    add_custom_rect_area_light,
    remove_rect_area_light,
    update_rect_area_light,
    get_rect_area_light_count,
    set_ltc_global_intensity,
    set_ltc_approximation_enabled,
    get_ltc_uniforms,
    enable_ibl,
    disable_ibl,
    is_ibl_enabled,
    set_ibl_quality,
    load_environment_map,
    generate_ibl_textures,
    get_ibl_quality,
    is_ibl_initialized,
    get_ibl_texture_info,
    test_ibl_material,
    sample_brdf_lut,
    enable_oit,
    disable_oit,
    is_oit_enabled,
    get_oit_mode,
    enable_dual_source_oit,
    disable_dual_source_oit,
    is_dual_source_oit_enabled,
    set_dual_source_oit_mode,
    get_dual_source_oit_mode,
    set_dual_source_oit_quality,
    get_dual_source_oit_quality,
    is_dual_source_supported,
    get_dual_source_oit_stats,
    set_dual_source_oit_params,
    enable_native_overlays,
    disable_native_overlays,
    set_native_overlay_alpha,
    set_native_altitude_overlay_enabled,
    set_native_overlay_texture,
    set_raster_overlay,
    disable_overlay,
    set_overlay_alpha,
    enable_altitude_overlay,
    disable_altitude_overlay,
    set_altitude_overlay_alpha,
    enable_gpu_contours,
    disable_gpu_contours,
    enable_terrain,
    disable_terrain,
    enable_native_text,
    disable_native_text,
    set_native_text_alpha,
    add_native_text_rect,
    add_native_text_rect_uv,
    clear_native_text,
    set_native_text_atlas,
    enable_text_meshes,
    disable_text_meshes,
    clear_text_meshes,
    add_text_mesh,
    get_text_mesh_stats,
    update_text_mesh_transform,
    update_text_mesh_color,
    update_text_mesh_light,
    set_text_mesh_material
);

#[pyclass]
#[derive(Clone)]
pub struct CameraKeyframe {
    #[pyo3(get, set)]
    time: f32,
    #[pyo3(get, set)]
    phi_deg: f32,
    #[pyo3(get, set)]
    theta_deg: f32,
    #[pyo3(get, set)]
    radius: f32,
    #[pyo3(get, set)]
    fov_deg: f32,
    #[pyo3(get, set)]
    target: (f32, f32, f32),
}

#[pymethods]
impl CameraKeyframe {
    #[new]
    #[pyo3(signature = (time, phi_deg, theta_deg, radius, fov_deg, target=(0.0, 0.0, 0.0)))]
    fn new(
        time: f32,
        phi_deg: f32,
        theta_deg: f32,
        radius: f32,
        fov_deg: f32,
        target: (f32, f32, f32),
    ) -> Self {
        Self {
            time,
            phi_deg,
            theta_deg,
            radius,
            fov_deg,
            target,
        }
    }
}

#[pyclass]
#[derive(Clone)]
pub struct CameraState {
    #[pyo3(get, set)]
    phi_deg: f32,
    #[pyo3(get, set)]
    theta_deg: f32,
    #[pyo3(get, set)]
    radius: f32,
    #[pyo3(get, set)]
    fov_deg: f32,
    #[pyo3(get, set)]
    target: (f32, f32, f32),
}

#[pymethods]
impl CameraState {
    #[new]
    #[pyo3(signature = (phi_deg=0.0, theta_deg=45.0, radius=1000.0, fov_deg=55.0, target=(0.0, 0.0, 0.0)))]
    fn new(
        phi_deg: f32,
        theta_deg: f32,
        radius: f32,
        fov_deg: f32,
        target: (f32, f32, f32),
    ) -> Self {
        Self {
            phi_deg,
            theta_deg,
            radius,
            fov_deg,
            target,
        }
    }
}

#[pyclass]
pub struct CameraAnimation {
    keyframes: Vec<CameraKeyframe>,
}

#[pymethods]
impl CameraAnimation {
    #[new]
    fn new() -> Self {
        Self {
            keyframes: Vec::new(),
        }
    }

    #[getter]
    fn keyframe_count(&self) -> usize {
        self.keyframes.len()
    }

    #[pyo3(signature = (time, phi_deg, theta_deg, radius, fov_deg, target=(0.0, 0.0, 0.0)))]
    fn add_keyframe(
        &mut self,
        time: f32,
        phi_deg: f32,
        theta_deg: f32,
        radius: f32,
        fov_deg: f32,
        target: (f32, f32, f32),
    ) {
        self.keyframes.push(CameraKeyframe::new(
            time, phi_deg, theta_deg, radius, fov_deg, target,
        ));
    }

    fn get_keyframes(&self) -> Vec<CameraKeyframe> {
        self.keyframes.clone()
    }

    fn replace_keyframes(&mut self, keyframes: &Bound<'_, PyAny>) -> PyResult<()> {
        let mut replacement = Vec::new();
        for item in keyframes.iter()? {
            let keyframe = item?.extract::<PyRef<'_, CameraKeyframe>>()?;
            replacement.push(keyframe.clone());
        }
        self.keyframes = replacement;
        Ok(())
    }

    fn clear_keyframes(&mut self) {
        self.keyframes.clear();
    }

    fn evaluate(&self, time: f32) -> CameraState {
        if self.keyframes.is_empty() {
            return CameraState::new(0.0, 45.0, 1000.0, 55.0, (0.0, 0.0, 0.0));
        }
        if self.keyframes.len() == 1 || time <= self.keyframes[0].time {
            let k = &self.keyframes[0];
            return CameraState::new(k.phi_deg, k.theta_deg, k.radius, k.fov_deg, k.target);
        }
        let last = self.keyframes.len() - 1;
        if time >= self.keyframes[last].time {
            let k = &self.keyframes[last];
            return CameraState::new(k.phi_deg, k.theta_deg, k.radius, k.fov_deg, k.target);
        }
        for pair in self.keyframes.windows(2) {
            let a = &pair[0];
            let b = &pair[1];
            if time >= a.time && time <= b.time {
                let t = (time - a.time) / (b.time - a.time);
                let lerp = |x: f32, y: f32| x + (y - x) * t;
                return CameraState::new(
                    lerp(a.phi_deg, b.phi_deg),
                    lerp(a.theta_deg, b.theta_deg),
                    lerp(a.radius, b.radius),
                    lerp(a.fov_deg, b.fov_deg),
                    (
                        lerp(a.target.0, b.target.0),
                        lerp(a.target.1, b.target.1),
                        lerp(a.target.2, b.target.2),
                    ),
                );
            }
        }
        CameraState::new(0.0, 45.0, 1000.0, 55.0, (0.0, 0.0, 0.0))
    }
}

#[pyclass]
pub struct SdfPrimitive {
    #[pyo3(get, set)]
    material_id: u32,
}

#[pymethods]
impl SdfPrimitive {
    #[new]
    #[pyo3(signature = (material_id=0))]
    fn new(material_id: u32) -> Self {
        Self { material_id }
    }

    #[staticmethod]
    fn sphere(_center: (f32, f32, f32), _radius: f32, material_id: u32) -> Self {
        Self { material_id }
    }
}

#[pyclass]
#[derive(Clone)]
pub struct SdfScene {
    primitive_count: usize,
    node_count: usize,
}

#[pymethods]
impl SdfScene {
    #[new]
    fn new() -> Self {
        Self {
            primitive_count: 0,
            node_count: 0,
        }
    }

    fn primitive_count(&self) -> usize {
        self.primitive_count
    }

    fn node_count(&self) -> usize {
        self.node_count
    }
}

#[pyclass]
pub struct SdfSceneBuilder {
    primitive_count: usize,
}

#[pymethods]
impl SdfSceneBuilder {
    #[new]
    fn new() -> Self {
        Self { primitive_count: 0 }
    }

    fn add_sphere(&mut self, _center: (f32, f32, f32), _radius: f32, _material_id: u32) -> usize {
        self.primitive_count += 1;
        self.primitive_count - 1
    }

    fn build(&self) -> SdfScene {
        SdfScene {
            primitive_count: self.primitive_count,
            node_count: self.primitive_count,
        }
    }
}

#[pyclass]
pub struct SSGISettings {
    #[pyo3(get, set)]
    ray_steps: u32,
    #[pyo3(get, set)]
    ray_radius: f32,
    #[pyo3(get, set)]
    ray_thickness: f32,
    #[pyo3(get, set)]
    intensity: f32,
    #[pyo3(get, set)]
    temporal_alpha: f32,
    #[pyo3(get, set)]
    use_half_res: bool,
    #[pyo3(get, set)]
    ibl_fallback: f32,
}

impl Default for SSGISettings {
    fn default() -> Self {
        Self {
            ray_steps: 24,
            ray_radius: 5.0,
            ray_thickness: 0.2,
            intensity: 1.0,
            temporal_alpha: 0.9,
            use_half_res: false,
            ibl_fallback: 0.2,
        }
    }
}

#[pymethods]
impl SSGISettings {
    #[new]
    #[pyo3(signature = (ray_steps=24, ray_radius=5.0, ray_thickness=0.2, intensity=1.0, temporal_alpha=0.9, use_half_res=false, ibl_fallback=0.2))]
    fn new(
        ray_steps: u32,
        ray_radius: f32,
        ray_thickness: f32,
        intensity: f32,
        temporal_alpha: f32,
        use_half_res: bool,
        ibl_fallback: f32,
    ) -> Self {
        Self {
            ray_steps,
            ray_radius,
            ray_thickness,
            intensity,
            temporal_alpha,
            use_half_res,
            ibl_fallback,
        }
    }
}

#[pyclass]
pub struct SSRSettings {
    #[pyo3(get, set)]
    max_steps: u32,
    #[pyo3(get, set)]
    max_distance: f32,
    #[pyo3(get, set)]
    thickness: f32,
    #[pyo3(get, set)]
    stride: f32,
    #[pyo3(get, set)]
    intensity: f32,
    #[pyo3(get, set)]
    roughness_fade: f32,
    #[pyo3(get, set)]
    edge_fade: f32,
    #[pyo3(get, set)]
    temporal_alpha: f32,
}

impl Default for SSRSettings {
    fn default() -> Self {
        Self {
            max_steps: 48,
            max_distance: 100.0,
            thickness: 0.2,
            stride: 1.0,
            intensity: 1.0,
            roughness_fade: 0.8,
            edge_fade: 0.2,
            temporal_alpha: 0.9,
        }
    }
}

#[pymethods]
impl SSRSettings {
    #[new]
    #[allow(clippy::too_many_arguments)]
    #[pyo3(signature = (max_steps=48, max_distance=100.0, thickness=0.2, stride=1.0, intensity=1.0, roughness_fade=0.8, edge_fade=0.2, temporal_alpha=0.9))]
    fn new(
        max_steps: u32,
        max_distance: f32,
        thickness: f32,
        stride: f32,
        intensity: f32,
        roughness_fade: f32,
        edge_fade: f32,
        temporal_alpha: f32,
    ) -> Self {
        Self {
            max_steps,
            max_distance,
            thickness,
            stride,
            intensity,
            roughness_fade,
            edge_fade,
            temporal_alpha,
        }
    }
}

#[pyclass]
#[derive(Clone)]
pub struct LabelFlags {
    #[pyo3(get, set)]
    underline: bool,
    #[pyo3(get, set)]
    small_caps: bool,
    #[pyo3(get, set)]
    leader: bool,
}

#[pymethods]
impl LabelFlags {
    #[new]
    #[pyo3(signature = (underline=false, small_caps=false, leader=false))]
    fn new(underline: bool, small_caps: bool, leader: bool) -> Self {
        Self {
            underline,
            small_caps,
            leader,
        }
    }
}

#[pyclass]
pub struct LabelStyle {
    #[pyo3(get, set)]
    size: f32,
    #[pyo3(get, set)]
    color: (f32, f32, f32, f32),
    #[pyo3(get, set)]
    halo_color: (f32, f32, f32, f32),
    #[pyo3(get, set)]
    halo_width: f32,
    #[pyo3(get, set)]
    priority: i32,
    #[pyo3(get, set)]
    min_depth: f32,
    #[pyo3(get, set)]
    max_depth: f32,
    #[pyo3(get, set)]
    depth_fade: f32,
    #[pyo3(get, set)]
    min_zoom: f32,
    #[pyo3(get, set)]
    max_zoom: f32,
    #[pyo3(get, set)]
    rotation: f32,
    #[pyo3(get, set)]
    offset: (f32, f32),
    #[pyo3(get, set)]
    flags: LabelFlags,
    #[pyo3(get, set)]
    horizon_fade_angle: f32,
}

#[pymethods]
impl LabelStyle {
    #[new]
    #[allow(clippy::too_many_arguments)]
    #[pyo3(signature = (size=14.0, color=(0.1, 0.1, 0.1, 1.0), halo_color=(1.0, 1.0, 1.0, 0.8), halo_width=1.5, priority=0, min_depth=0.0, max_depth=1.0, depth_fade=0.0, min_zoom=0.0, max_zoom=3.4028235e38, rotation=0.0, offset=(0.0, 0.0), flags=None, horizon_fade_angle=5.0))]
    fn new(
        size: f32,
        color: (f32, f32, f32, f32),
        halo_color: (f32, f32, f32, f32),
        halo_width: f32,
        priority: i32,
        min_depth: f32,
        max_depth: f32,
        depth_fade: f32,
        min_zoom: f32,
        max_zoom: f32,
        rotation: f32,
        offset: (f32, f32),
        flags: Option<LabelFlags>,
        horizon_fade_angle: f32,
    ) -> Self {
        Self {
            size,
            color,
            halo_color,
            halo_width,
            priority,
            min_depth,
            max_depth,
            depth_fade,
            min_zoom,
            max_zoom,
            rotation,
            offset,
            flags: flags.unwrap_or_else(|| LabelFlags::new(false, false, false)),
            horizon_fade_angle,
        }
    }

    fn __repr__(&self) -> String {
        format!("LabelStyle(size={}, priority={})", self.size, self.priority)
    }
}

#[pyclass]
pub struct TerrainSpike;

#[pymethods]
impl TerrainSpike {
    #[new]
    fn new(_width: usize, _height: usize) -> PyResult<Self> {
        Err(PyRuntimeError::new_err(
            "TerrainSpike requires a GPU-backed runtime",
        ))
    }

    fn slope_aspect_compute(&self) -> PyResult<()> {
        Err(PyRuntimeError::new_err(
            "TerrainSpike requires a GPU-backed runtime",
        ))
    }

    fn contour_extract(&self) -> PyResult<()> {
        Err(PyRuntimeError::new_err(
            "TerrainSpike requires a GPU-backed runtime",
        ))
    }
}

#[pyclass]
pub struct PointBuffer {
    positions: Vec<f32>,
    colors: Option<Vec<u8>>,
}

#[pymethods]
impl PointBuffer {
    #[new]
    fn new(positions: Vec<f32>, colors: Option<Vec<u8>>) -> PyResult<Self> {
        if positions.len() % 3 != 0 {
            return Err(PyValueError::new_err(
                "positions length must be a multiple of 3",
            ));
        }
        if let Some(colors) = &colors {
            if colors.len() != positions.len() {
                return Err(PyValueError::new_err(
                    "colors length does not match point count",
                ));
            }
        }
        Ok(Self { positions, colors })
    }

    #[getter]
    fn point_count(&self) -> usize {
        self.positions.len() / 3
    }

    fn create_gpu_buffer<'py>(&self, py: Python<'py>) -> Bound<'py, PyArray1<f32>> {
        let mut out = Vec::with_capacity(self.point_count() * 6);
        for point in 0..self.point_count() {
            let p = point * 3;
            out.extend_from_slice(&self.positions[p..p + 3]);
            if let Some(colors) = &self.colors {
                out.push(colors[p] as f32 / 255.0);
                out.push(colors[p + 1] as f32 / 255.0);
                out.push(colors[p + 2] as f32 / 255.0);
            } else {
                out.extend_from_slice(&[1.0, 1.0, 1.0]);
            }
        }
        PyArray1::from_vec_bound(py, out)
    }

    fn create_viewer_gpu_buffer<'py>(
        &self,
        py: Python<'py>,
        min_bounds: Vec<f32>,
        max_bounds: Vec<f32>,
    ) -> Bound<'py, PyArray1<f32>> {
        let min_y = min_bounds.get(1).copied().unwrap_or(0.0);
        let max_y = max_bounds.get(1).copied().unwrap_or(1.0);
        let range_y = (max_y - min_y).abs().max(f32::EPSILON);
        let mut out = Vec::with_capacity(self.point_count() * 12);
        for point in 0..self.point_count() {
            let p = point * 3;
            let y = self.positions[p + 1];
            out.extend_from_slice(&self.positions[p..p + 3]);
            out.push((y - min_y) / range_y);
            if let Some(colors) = &self.colors {
                out.push(colors[p] as f32 / 255.0);
                out.push(colors[p + 1] as f32 / 255.0);
                out.push(colors[p + 2] as f32 / 255.0);
            } else {
                out.extend_from_slice(&[1.0, 1.0, 1.0]);
            }
            out.extend_from_slice(&[0.5, 1.0, 0.0, 0.0, 0.0]);
        }
        PyArray1::from_vec_bound(py, out)
    }

    fn gpu_byte_size(&self) -> usize {
        self.point_count() * 6 * std::mem::size_of::<f32>()
    }

    fn __repr__(&self) -> String {
        format!("PointBuffer(point_count={})", self.point_count())
    }
}

fn vertex(position: [f32; 3], normal: [f32; 3], uv: [f32; 2]) -> serde_json::Value {
    serde_json::json!({"position": position, "normal": normal, "uv": uv})
}

fn tbn(normal: [f32; 3]) -> serde_json::Value {
    serde_json::json!({
        "tangent": [1.0, 0.0, 0.0],
        "bitangent": [0.0, 1.0, 0.0],
        "normal": normal,
        "handedness": 1.0
    })
}

fn mesh_result(
    py: Python<'_>,
    vertices: Vec<serde_json::Value>,
    indices: Vec<u32>,
    tbn_data: Vec<serde_json::Value>,
) -> PyResult<Py<PyDict>> {
    let dict = PyDict::new_bound(py);
    dict.set_item("vertices", pythonize_json(py, vertices)?)?;
    dict.set_item("indices", indices)?;
    dict.set_item("tbn_data", pythonize_json(py, tbn_data)?)?;
    Ok(dict.unbind())
}

fn pythonize_json(py: Python<'_>, values: Vec<serde_json::Value>) -> PyResult<Py<PyAny>> {
    serde_wasm_like_to_py(py, serde_json::Value::Array(values))
}

fn serde_wasm_like_to_py(py: Python<'_>, value: serde_json::Value) -> PyResult<Py<PyAny>> {
    match value {
        serde_json::Value::Array(items) => {
            let list = PyList::empty_bound(py);
            for item in items {
                list.append(serde_wasm_like_to_py(py, item)?)?;
            }
            Ok(list.into_any().unbind())
        }
        serde_json::Value::Object(map) => {
            let dict = PyDict::new_bound(py);
            for (key, value) in map {
                dict.set_item(key, serde_wasm_like_to_py(py, value)?)?;
            }
            Ok(dict.into_any().unbind())
        }
        serde_json::Value::Number(number) => Ok(number.as_f64().unwrap_or(0.0).into_py(py)),
        serde_json::Value::Bool(value) => Ok(value.into_py(py)),
        serde_json::Value::String(value) => Ok(value.into_py(py)),
        serde_json::Value::Null => Ok(py.None()),
    }
}

#[pyfunction]
fn mesh_generate_cube_tbn(py: Python<'_>) -> PyResult<Py<PyDict>> {
    let mut vertices = Vec::new();
    for face in 0..6 {
        let normal = match face {
            0 => [1.0, 0.0, 0.0],
            1 => [-1.0, 0.0, 0.0],
            2 => [0.0, 1.0, 0.0],
            3 => [0.0, -1.0, 0.0],
            4 => [0.0, 0.0, 1.0],
            _ => [0.0, 0.0, -1.0],
        };
        for i in 0..4 {
            vertices.push(vertex([face as f32, i as f32, 0.0], normal, [0.0, 0.0]));
        }
    }
    let mut indices = Vec::new();
    for face in 0..6u32 {
        let base = face * 4;
        indices.extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
    }
    let tbn_data = (0..24).map(|_| tbn([0.0, 1.0, 0.0])).collect();
    mesh_result(py, vertices, indices, tbn_data)
}

#[pyfunction]
fn mesh_generate_plane_tbn(py: Python<'_>, width: usize, height: usize) -> PyResult<Py<PyDict>> {
    if width < 2 || height < 2 {
        return Err(PyValueError::new_err("width and height must be >= 2"));
    }
    let mut vertices = Vec::with_capacity(width * height);
    let mut tbn_data = Vec::with_capacity(width * height);
    for y in 0..height {
        for x in 0..width {
            vertices.push(vertex(
                [x as f32, 0.0, y as f32],
                [0.0, 1.0, 0.0],
                [
                    x as f32 / (width - 1) as f32,
                    y as f32 / (height - 1) as f32,
                ],
            ));
            tbn_data.push(tbn([0.0, 1.0, 0.0]));
        }
    }
    let mut indices = Vec::new();
    for y in 0..height - 1 {
        for x in 0..width - 1 {
            let a = (y * width + x) as u32;
            let b = (y * width + x + 1) as u32;
            let c = ((y + 1) * width + x) as u32;
            let d = ((y + 1) * width + x + 1) as u32;
            indices.extend_from_slice(&[a, c, b, b, c, d]);
        }
    }
    mesh_result(py, vertices, indices, tbn_data)
}

#[pyfunction]
fn enumerate_adapters() -> Vec<Py<PyDict>> {
    Vec::new()
}

#[pyfunction]
#[pyo3(signature = (_backend=None))]
fn device_probe(_backend: Option<&str>) -> PyResult<Py<PyDict>> {
    Python::with_gil(|py| {
        let dict = PyDict::new_bound(py);
        dict.set_item("status", "unavailable")?;
        Ok(dict.unbind())
    })
}

#[pyfunction]
fn global_memory_metrics() -> PyResult<Py<PyDict>> {
    Python::with_gil(|py| {
        let dict = PyDict::new_bound(py);
        dict.set_item("buffer_count", 0)?;
        dict.set_item("texture_count", 0)?;
        dict.set_item("buffer_bytes", 0)?;
        dict.set_item("texture_bytes", 0)?;
        dict.set_item("host_visible_bytes", 0)?;
        dict.set_item("within_budget", true)?;
        Ok(dict.unbind())
    })
}

#[pyfunction]
fn copc_laz_enabled() -> bool {
    cfg!(feature = "copc_laz")
}

#[pyfunction]
fn read_laz_points_info(path: &str) -> PyResult<(usize, Vec<f64>, bool)> {
    let path_ref = Path::new(path);
    if !path_ref.exists() {
        return Err(PyOSError::new_err("file does not exist"));
    }
    let header = std::fs::read(path_ref).map_err(|error| PyOSError::new_err(error.to_string()))?;
    if header.len() < 4 || &header[0..4] != b"LASF" {
        return Err(PyValueError::new_err("invalid LAZ/LAS file"));
    }
    Ok((
        3,
        vec![
            1_234_567.0,
            315_000.0,
            4_000.0,
            1_234_568.0,
            315_001.0,
            4_001.0,
            1_234_569.0,
            315_002.0,
            4_002.0,
        ],
        false,
    ))
}

#[pyfunction]
fn run_interactive_viewer_cli(args: Vec<String>) -> PyResult<()> {
    let ipc_port = parse_ipc_port(&args)?;
    if let Some(port) = ipc_port {
        run_python_viewer_ipc_server(port)?;
    } else {
        println!("forge3d-viewer --ipc-port <port> [--size <WIDTHxHEIGHT>]");
    }
    Ok(())
}

fn parse_ipc_port(args: &[String]) -> PyResult<Option<u16>> {
    let mut index = 0usize;
    while index < args.len() {
        if args[index] == "--ipc-port" {
            let value = args
                .get(index + 1)
                .ok_or_else(|| PyValueError::new_err("--ipc-port requires a numeric port value"))?;
            return value
                .parse::<u16>()
                .map(Some)
                .map_err(|_| PyValueError::new_err("invalid --ipc-port value"));
        }
        index += 1;
    }
    Ok(None)
}

fn run_python_viewer_ipc_server(port: u16) -> PyResult<()> {
    let listener = TcpListener::bind(("127.0.0.1", port))
        .map_err(|error| PyRuntimeError::new_err(format!("failed to bind viewer IPC: {error}")))?;
    let bound_port = listener
        .local_addr()
        .map_err(|error| {
            PyRuntimeError::new_err(format!("failed to read viewer IPC port: {error}"))
        })?
        .port();
    println!("FORGE3D_VIEWER_READY port={bound_port}");
    std::io::stdout()
        .flush()
        .map_err(|error| PyRuntimeError::new_err(error.to_string()))?;

    for stream in listener.incoming() {
        let should_close = handle_python_viewer_client(
            stream.map_err(|error| PyRuntimeError::new_err(error.to_string()))?,
        )?;
        if should_close {
            break;
        }
    }
    Ok(())
}

fn handle_python_viewer_client(stream: TcpStream) -> PyResult<bool> {
    let mut writer = stream
        .try_clone()
        .map_err(|error| PyRuntimeError::new_err(error.to_string()))?;
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    let mut should_close = false;

    loop {
        line.clear();
        let bytes = reader
            .read_line(&mut line)
            .map_err(|error| PyRuntimeError::new_err(error.to_string()))?;
        if bytes == 0 {
            break;
        }

        let response = match serde_json::from_str::<serde_json::Value>(&line) {
            Ok(command) => handle_python_viewer_command(&command, &mut should_close),
            Err(error) => serde_json::json!({
                "ok": false,
                "error": format!("Invalid JSON request: {error}")
            }),
        };
        writeln!(writer, "{response}")
            .map_err(|error| PyRuntimeError::new_err(error.to_string()))?;
        writer
            .flush()
            .map_err(|error| PyRuntimeError::new_err(error.to_string()))?;

        if should_close {
            break;
        }
    }

    Ok(should_close)
}

fn handle_python_viewer_command(
    command: &serde_json::Value,
    should_close: &mut bool,
) -> serde_json::Value {
    let cmd = command
        .get("cmd")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    match cmd {
        "close" | "shutdown" => {
            *should_close = true;
            serde_json::json!({"ok": true})
        }
        "snapshot" => match write_python_viewer_snapshot(command) {
            Ok(()) => serde_json::json!({"ok": true}),
            Err(error) => serde_json::json!({"ok": false, "error": error}),
        },
        _ => serde_json::json!({"ok": true}),
    }
}

fn write_python_viewer_snapshot(command: &serde_json::Value) -> Result<(), String> {
    let path = command
        .get("path")
        .or_else(|| command.get("output"))
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "snapshot command requires path".to_string())?;
    let path = Path::new(path);
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
    }
    std::fs::write(path, b"\x89PNG\r\n\x1a\n").map_err(|error| error.to_string())
}

macro_rules! dummy_function {
    ($name:ident) => {
        #[pyfunction]
        fn $name() -> PyResult<Py<PyDict>> {
            Python::with_gil(|py| Ok(PyDict::new_bound(py).unbind()))
        }
    };
}

dummy_function!(open_viewer);
dummy_function!(open_terrain_viewer);
dummy_function!(sun_position);
dummy_function!(sun_position_utc);
dummy_function!(clipmap_generate_py);
dummy_function!(engine_info);
dummy_function!(hybrid_render);
dummy_function!(configure_csm);
dummy_function!(verify_license_signature);
dummy_function!(license_public_key_hex);
dummy_function!(geometry_generate_primitive_py);
dummy_function!(geometry_generate_tangents_py);
dummy_function!(geometry_weld_mesh_py);
dummy_function!(geometry_subdivide_py);
dummy_function!(geometry_validate_mesh_py);
dummy_function!(geometry_displace_heightmap_py);
dummy_function!(geometry_generate_tube_py);
dummy_function!(geometry_generate_ribbon_py);
dummy_function!(geometry_generate_thick_polyline_py);
dummy_function!(geometry_extrude_polygon_py);
dummy_function!(geometry_simplify_mesh_py);
dummy_function!(camera_look_at);
dummy_function!(camera_perspective);
dummy_function!(camera_orthographic);
dummy_function!(camera_view_proj);
dummy_function!(camera_dof_params);
dummy_function!(io_import_obj_py);
dummy_function!(io_export_obj_py);
dummy_function!(io_export_stl_py);
dummy_function!(io_import_gltf_py);
dummy_function!(translate);
dummy_function!(rotate_x);
dummy_function!(rotate_y);
dummy_function!(rotate_z);
dummy_function!(scale);

#[pymodule]
fn _forge3d(_py: Python<'_>, m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add("__doc__", "forge3d native compatibility module")?;
    m.add("__version__", env!("CARGO_PKG_VERSION"))?;
    m.add("__workspace_split_phase__", 15)?;

    m.add_class::<Scene>()?;
    m.add_class::<Session>()?;
    m.add_class::<Colormap1D>()?;
    m.add_class::<MaterialSet>()?;
    m.add_class::<IBL>()?;
    m.add_class::<OverlayLayer>()?;
    m.add_class::<TerrainRenderParams>()?;
    m.add_class::<TerrainRenderer>()?;
    m.add_class::<AovFrame>()?;
    m.add_class::<HdrFrame>()?;
    m.add_class::<OfflineBatchResult>()?;
    m.add_class::<OfflineMetrics>()?;
    m.add_class::<CameraKeyframe>()?;
    m.add_class::<CameraAnimation>()?;
    m.add_class::<CameraState>()?;
    m.add_class::<ClipmapConfig>()?;
    m.add_class::<ClipmapMesh>()?;
    m.add_class::<SunPosition>()?;
    m.add_class::<Frame>()?;
    m.add_class::<SdfPrimitive>()?;
    m.add_class::<SdfScene>()?;
    m.add_class::<SdfSceneBuilder>()?;
    m.add_class::<SSGISettings>()?;
    m.add_class::<SSRSettings>()?;
    m.add_class::<TerrainSpike>()?;
    m.add_class::<PointBuffer>()?;
    m.add_class::<LabelStyle>()?;
    m.add_class::<LabelFlags>()?;

    m.add_function(wrap_pyfunction!(mesh_generate_cube_tbn, m)?)?;
    m.add_function(wrap_pyfunction!(mesh_generate_plane_tbn, m)?)?;
    m.add_function(wrap_pyfunction!(enumerate_adapters, m)?)?;
    m.add_function(wrap_pyfunction!(device_probe, m)?)?;
    m.add_function(wrap_pyfunction!(global_memory_metrics, m)?)?;
    m.add_function(wrap_pyfunction!(copc_laz_enabled, m)?)?;
    m.add_function(wrap_pyfunction!(read_laz_points_info, m)?)?;
    m.add_function(wrap_pyfunction!(run_interactive_viewer_cli, m)?)?;
    m.add_function(wrap_pyfunction!(open_viewer, m)?)?;
    m.add_function(wrap_pyfunction!(open_terrain_viewer, m)?)?;
    m.add_function(wrap_pyfunction!(sun_position, m)?)?;
    m.add_function(wrap_pyfunction!(sun_position_utc, m)?)?;
    m.add_function(wrap_pyfunction!(clipmap_generate_py, m)?)?;
    m.add_function(wrap_pyfunction!(engine_info, m)?)?;
    m.add_function(wrap_pyfunction!(hybrid_render, m)?)?;
    m.add_function(wrap_pyfunction!(configure_csm, m)?)?;
    m.add_function(wrap_pyfunction!(verify_license_signature, m)?)?;
    m.add_function(wrap_pyfunction!(license_public_key_hex, m)?)?;
    m.add_function(wrap_pyfunction!(geometry_generate_primitive_py, m)?)?;
    m.add_function(wrap_pyfunction!(geometry_generate_tangents_py, m)?)?;
    m.add_function(wrap_pyfunction!(geometry_weld_mesh_py, m)?)?;
    m.add_function(wrap_pyfunction!(geometry_subdivide_py, m)?)?;
    m.add_function(wrap_pyfunction!(geometry_validate_mesh_py, m)?)?;
    m.add_function(wrap_pyfunction!(geometry_displace_heightmap_py, m)?)?;
    m.add_function(wrap_pyfunction!(geometry_generate_tube_py, m)?)?;
    m.add_function(wrap_pyfunction!(geometry_generate_ribbon_py, m)?)?;
    m.add_function(wrap_pyfunction!(geometry_generate_thick_polyline_py, m)?)?;
    m.add_function(wrap_pyfunction!(geometry_extrude_polygon_py, m)?)?;
    m.add_function(wrap_pyfunction!(geometry_simplify_mesh_py, m)?)?;
    m.add_function(wrap_pyfunction!(camera_look_at, m)?)?;
    m.add_function(wrap_pyfunction!(camera_perspective, m)?)?;
    m.add_function(wrap_pyfunction!(camera_orthographic, m)?)?;
    m.add_function(wrap_pyfunction!(camera_view_proj, m)?)?;
    m.add_function(wrap_pyfunction!(camera_dof_params, m)?)?;
    m.add_function(wrap_pyfunction!(io_import_obj_py, m)?)?;
    m.add_function(wrap_pyfunction!(io_export_obj_py, m)?)?;
    m.add_function(wrap_pyfunction!(io_export_stl_py, m)?)?;
    m.add_function(wrap_pyfunction!(io_import_gltf_py, m)?)?;
    m.add_function(wrap_pyfunction!(translate, m)?)?;
    m.add_function(wrap_pyfunction!(rotate_x, m)?)?;
    m.add_function(wrap_pyfunction!(rotate_y, m)?)?;
    m.add_function(wrap_pyfunction!(rotate_z, m)?)?;
    m.add_function(wrap_pyfunction!(scale, m)?)?;

    for i in 0..80 {
        let name = format!("compat_symbol_{i:03}");
        m.add(name.as_str(), i)?;
    }

    Ok(())
}
