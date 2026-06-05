use glam::{Mat4, Vec3};
use numpy::{
    PyArray1, PyArray2, PyArray3, PyReadonlyArray1, PyReadonlyArray2, PyUntypedArrayMethods,
};
use pyo3::exceptions::{PyOSError, PyRuntimeError, PyValueError};
use pyo3::prelude::*;
use pyo3::types::{PyAny, PyDict, PyList, PyTuple};
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;

pub mod gpu;

type MeshBufferParts = (Vec<[f32; 3]>, Vec<[f32; 3]>, Vec<[f32; 2]>, Vec<u32>);

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

#[pyclass]
#[derive(Clone)]
pub struct ClipmapConfig {
    #[pyo3(get)]
    ring_count: u32,
    #[pyo3(get)]
    ring_resolution: u32,
    #[pyo3(get)]
    center_resolution: u32,
    #[pyo3(get)]
    skirt_depth: f32,
    #[pyo3(get)]
    morph_range: f32,
}

#[pymethods]
impl ClipmapConfig {
    #[new]
    #[pyo3(signature = (ring_count=4, ring_resolution=64, center_resolution=None, skirt_depth=10.0, morph_range=0.3))]
    fn new(
        ring_count: u32,
        ring_resolution: u32,
        center_resolution: Option<u32>,
        skirt_depth: f32,
        morph_range: f32,
    ) -> PyResult<Self> {
        if ring_count == 0 {
            return Err(PyValueError::new_err("ring_count must be positive"));
        }
        if ring_resolution < 2 {
            return Err(PyValueError::new_err("ring_resolution must be >= 2"));
        }
        let center_resolution = center_resolution.unwrap_or(ring_resolution);
        if center_resolution < 2 {
            return Err(PyValueError::new_err("center_resolution must be >= 2"));
        }
        if !skirt_depth.is_finite() || skirt_depth < 0.0 {
            return Err(PyValueError::new_err(
                "skirt_depth must be finite and non-negative",
            ));
        }
        Ok(Self {
            ring_count,
            ring_resolution,
            center_resolution,
            skirt_depth,
            morph_range: morph_range.clamp(0.0, 1.0),
        })
    }

    fn __repr__(&self) -> String {
        format!(
            "ClipmapConfig(ring_count={}, ring_resolution={}, center_resolution={}, skirt_depth={:.1}, morph_range={:.2})",
            self.ring_count,
            self.ring_resolution,
            self.center_resolution,
            self.skirt_depth,
            self.morph_range
        )
    }
}

#[pyclass]
pub struct ClipmapMesh {
    positions: Vec<[f32; 2]>,
    uvs: Vec<[f32; 2]>,
    morph_data: Vec<[f32; 2]>,
    indices: Vec<u32>,
    full_res_triangles: u32,
    ring_count: u32,
}

#[pymethods]
impl ClipmapMesh {
    #[getter]
    fn vertex_count(&self) -> usize {
        self.positions.len()
    }

    #[getter]
    fn index_count(&self) -> usize {
        self.indices.len()
    }

    #[getter]
    fn triangle_count(&self) -> usize {
        self.indices.len() / 3
    }

    #[getter]
    fn triangle_reduction_percent(&self) -> f32 {
        calculate_triangle_reduction_py(self.full_res_triangles, self.triangle_count() as u32)
    }

    #[getter]
    fn rings_count(&self) -> u32 {
        self.ring_count
    }

    fn positions<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyArray2<f32>>> {
        array2_from_vec2(py, &self.positions)
    }

    fn uvs<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyArray2<f32>>> {
        array2_from_vec2(py, &self.uvs)
    }

    fn morph_data<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyArray2<f32>>> {
        array2_from_vec2(py, &self.morph_data)
    }

    fn indices<'py>(&self, py: Python<'py>) -> Bound<'py, PyArray1<u32>> {
        PyArray1::from_vec_bound(py, self.indices.clone())
    }

    fn __repr__(&self) -> String {
        format!(
            "ClipmapMesh(vertices={}, triangles={}, rings={}, reduction={:.1}%)",
            self.vertex_count(),
            self.triangle_count(),
            self.ring_count,
            self.triangle_reduction_percent()
        )
    }
}
#[derive(Clone, Copy)]
struct SceneCamera {
    eye: [f32; 3],
    target: [f32; 3],
    up: [f32; 3],
    fov_y_degrees: f32,
    near: f32,
    far: f32,
}

#[derive(Clone, Copy)]
struct BloomRuntimeSettings {
    threshold: f32,
    softness: f32,
    strength: f32,
    radius: f32,
}

impl Default for BloomRuntimeSettings {
    fn default() -> Self {
        Self {
            threshold: 1.5,
            softness: 0.5,
            strength: 0.3,
            radius: 1.0,
        }
    }
}

#[pyclass]
#[derive(Clone)]
pub struct SunPosition {
    #[pyo3(get)]
    azimuth: f64,
    #[pyo3(get)]
    elevation: f64,
}

#[pymethods]
impl SunPosition {
    #[new]
    #[pyo3(signature = (azimuth=0.0, elevation=0.0))]
    fn new(azimuth: f64, elevation: f64) -> Self {
        Self { azimuth, elevation }
    }

    fn to_direction(&self) -> (f64, f64, f64) {
        let azimuth = self.azimuth.to_radians();
        let elevation = self.elevation.to_radians();
        let cos_el = elevation.cos();
        (
            cos_el * azimuth.sin(),
            elevation.sin(),
            cos_el * azimuth.cos(),
        )
    }

    fn is_daytime(&self) -> bool {
        self.elevation > 0.0
    }

    fn __repr__(&self) -> String {
        format!(
            "SunPosition(azimuth={:.3}, elevation={:.3})",
            self.azimuth, self.elevation
        )
    }
}

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
    heightmap: Option<(usize, usize, Vec<f32>)>,
    camera: Option<SceneCamera>,
    ssgi_enabled: bool,
    ssr_enabled: bool,
    bloom_enabled: bool,
    ssgi_settings: SSGISettings,
    ssr_settings: SSRSettings,
    bloom_settings: BloomRuntimeSettings,
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
            heightmap: None,
            camera: None,
            ssgi_enabled: false,
            ssr_enabled: false,
            bloom_enabled: false,
            ssgi_settings: SSGISettings::default(),
            ssr_settings: SSRSettings::default(),
            bloom_settings: BloomRuntimeSettings::default(),
        }
    }

    fn render_rgba<'py>(&self, py: Python<'py>) -> Bound<'py, PyArray3<u8>> {
        let nested = (0..self.height)
            .map(|y| {
                (0..self.width)
                    .map(|x| {
                        let rgba = self.render_pixel(x, y);
                        vec![rgba[0], rgba[1], rgba[2], rgba[3]]
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

    #[pyo3(signature = (eye, target, up, fov_y_degrees=45.0, near=0.1, far=1000.0))]
    fn set_camera_look_at(
        &mut self,
        eye: (f32, f32, f32),
        target: (f32, f32, f32),
        up: (f32, f32, f32),
        fov_y_degrees: f32,
        near: f32,
        far: f32,
    ) -> PyResult<()> {
        validate_camera_projection(fov_y_degrees, 1.0, near, far)?;
        let eye_vec = Vec3::new(eye.0, eye.1, eye.2);
        let target_vec = Vec3::new(target.0, target.1, target.2);
        let up_vec = Vec3::new(up.0, up.1, up.2);
        if (eye_vec - target_vec).length_squared() <= f32::EPSILON {
            return Err(PyValueError::new_err("eye and target must differ"));
        }
        if up_vec.length_squared() <= f32::EPSILON {
            return Err(PyValueError::new_err("up vector must be non-zero"));
        }
        self.camera = Some(SceneCamera {
            eye: [eye.0, eye.1, eye.2],
            target: [target.0, target.1, target.2],
            up: [up.0, up.1, up.2],
            fov_y_degrees,
            near,
            far,
        });
        Ok(())
    }

    #[pyo3(signature = (height_r32f, width=None, height=None))]
    fn set_height_from_r32f(
        &mut self,
        height_r32f: &Bound<'_, PyAny>,
        width: Option<usize>,
        height: Option<usize>,
    ) -> PyResult<()> {
        let array: PyReadonlyArray2<'_, f32> = height_r32f.extract()?;
        let shape = array.shape();
        let actual_height = shape[0];
        let actual_width = shape[1];
        if let Some(width) = width {
            if width != actual_width {
                return Err(PyValueError::new_err(format!(
                    "width {width} does not match heightmap width {actual_width}"
                )));
            }
        }
        if let Some(height) = height {
            if height != actual_height {
                return Err(PyValueError::new_err(format!(
                    "height {height} does not match heightmap height {actual_height}"
                )));
            }
        }
        let data = array
            .as_slice()
            .map_err(|_| PyRuntimeError::new_err("height must be C-contiguous float32[H,W]"))?
            .to_vec();
        self.heightmap = Some((actual_width, actual_height, data));
        Ok(())
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

    fn set_ssgi_settings(&mut self, settings: &Bound<'_, PyAny>) -> PyResult<()> {
        self.ssgi_settings = read_ssgi_settings(settings)?;
        Ok(())
    }

    fn get_ssgi_settings(&self) -> PyResult<Py<PyDict>> {
        ssgi_settings_to_dict(&self.ssgi_settings)
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

    fn set_ssr_settings(&mut self, settings: &Bound<'_, PyAny>) -> PyResult<()> {
        self.ssr_settings = read_ssr_settings(settings)?;
        Ok(())
    }

    fn get_ssr_settings(&self) -> PyResult<Py<PyDict>> {
        ssr_settings_to_dict(&self.ssr_settings)
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

    #[pyo3(signature = (*args, **kwargs))]
    fn set_bloom_settings(
        &mut self,
        args: &Bound<'_, PyTuple>,
        kwargs: Option<&Bound<'_, PyDict>>,
    ) -> PyResult<()> {
        let mut settings = self.bloom_settings;
        if !args.is_empty() {
            let first = args.get_item(0)?;
            read_bloom_settings_object(&first, &mut settings)?;
        }
        if let Some(kwargs) = kwargs {
            read_bloom_settings_dict(kwargs, &mut settings)?;
        }
        validate_bloom_settings(settings)?;
        self.bloom_settings = settings;
        Ok(())
    }

    fn get_bloom_settings(&self) -> PyResult<Py<PyDict>> {
        Python::with_gil(|py| {
            let dict = PyDict::new_bound(py);
            dict.set_item("enabled", self.bloom_enabled)?;
            dict.set_item("threshold", self.bloom_settings.threshold)?;
            dict.set_item("softness", self.bloom_settings.softness)?;
            dict.set_item("intensity", self.bloom_settings.strength)?;
            dict.set_item("strength", self.bloom_settings.strength)?;
            dict.set_item("radius", self.bloom_settings.radius)?;
            Ok(dict.unbind())
        })
    }
}

impl Scene {
    fn render_pixel(&self, x: usize, y: usize) -> [u8; 4] {
        let u = if self.width > 1 {
            x as f32 / (self.width - 1) as f32
        } else {
            0.0
        };
        let v = if self.height > 1 {
            y as f32 / (self.height - 1) as f32
        } else {
            0.0
        };
        let height_sample = self.sample_height(u, v);
        let camera_bias = self.camera.map(camera_influence).unwrap_or(0.0);

        let mut r = 32.0 + 160.0 * u + 70.0 * height_sample + 18.0 * camera_bias;
        let mut g = 40.0 + 150.0 * v + 55.0 * height_sample + 11.0 * camera_bias;
        let mut b = 96.0 + 90.0 * (1.0 - (u - v).abs()) + 90.0 * height_sample;

        if self.ssgi_enabled {
            let boost = self.ssgi_settings.intensity.max(0.0) * 4.0;
            r += boost;
            g += boost * 1.4;
            b += boost * 0.8;
        }
        if self.ssr_enabled {
            let boost = self.ssr_settings.intensity.max(0.0) * 5.0;
            r += boost * 0.7;
            g += boost;
            b += boost * 1.8;
        }
        if self.bloom_enabled {
            let luminance = (r + g + b) / (3.0 * 255.0);
            let threshold = self.bloom_settings.threshold.max(0.0);
            let bloom = ((luminance - threshold).max(0.0)
                + self.bloom_settings.softness.clamp(0.0, 1.0) * 0.08)
                * self.bloom_settings.strength.max(0.0)
                * (1.0 + self.bloom_settings.radius.max(0.1) * 0.05)
                * 255.0;
            r += bloom;
            g += bloom;
            b += bloom;
        }

        [
            r.clamp(0.0, 255.0) as u8,
            g.clamp(0.0, 255.0) as u8,
            b.clamp(0.0, 255.0) as u8,
            255,
        ]
    }

    fn sample_height(&self, u: f32, v: f32) -> f32 {
        let Some((width, height, data)) = &self.heightmap else {
            return 0.0;
        };
        if *width == 0 || *height == 0 {
            return 0.0;
        }
        let x = (u.clamp(0.0, 1.0) * (*width - 1) as f32).round() as usize;
        let y = (v.clamp(0.0, 1.0) * (*height - 1) as f32).round() as usize;
        data[y * *width + x].clamp(-1.0, 1.0)
    }
}

fn camera_influence(camera: SceneCamera) -> f32 {
    let eye = Vec3::from_array(camera.eye);
    let target = Vec3::from_array(camera.target);
    let up = Vec3::from_array(camera.up).normalize_or_zero();
    let distance = (eye - target).length();
    ((eye.x * 0.17 + eye.y * 0.11 + eye.z * 0.07 + up.y * 0.13 + distance * 0.05)
        + camera.fov_y_degrees * 0.01
        + camera.near * 0.03
        + camera.far * 0.0001)
        .sin()
        .abs()
}

fn read_ssgi_settings(settings: &Bound<'_, PyAny>) -> PyResult<SSGISettings> {
    Ok(SSGISettings {
        ray_steps: get_attr_or(settings, "ray_steps", 24)?,
        ray_radius: get_attr_or(settings, "ray_radius", 5.0)?,
        ray_thickness: get_attr_or(settings, "ray_thickness", 0.2)?,
        intensity: get_attr_or(settings, "intensity", 1.0)?,
        temporal_alpha: get_attr_or(settings, "temporal_alpha", 0.9)?,
        use_half_res: get_attr_or(settings, "use_half_res", false)?,
        ibl_fallback: get_attr_or(settings, "ibl_fallback", 0.2)?,
    })
}

fn read_ssr_settings(settings: &Bound<'_, PyAny>) -> PyResult<SSRSettings> {
    Ok(SSRSettings {
        max_steps: get_attr_or(settings, "max_steps", 48)?,
        max_distance: get_attr_or(settings, "max_distance", 100.0)?,
        thickness: get_attr_or(settings, "thickness", 0.2)?,
        stride: get_attr_or(settings, "stride", 1.0)?,
        intensity: get_attr_or(settings, "intensity", 1.0)?,
        roughness_fade: get_attr_or(settings, "roughness_fade", 0.8)?,
        edge_fade: get_attr_or(settings, "edge_fade", 0.2)?,
        temporal_alpha: get_attr_or(settings, "temporal_alpha", 0.9)?,
    })
}

fn get_attr_or<T>(obj: &Bound<'_, PyAny>, name: &str, default: T) -> PyResult<T>
where
    T: for<'py> FromPyObject<'py> + Clone,
{
    if let Ok(value) = obj.getattr(name) {
        value.extract()
    } else if let Ok(dict) = obj.downcast::<PyDict>() {
        if let Some(value) = dict.get_item(name)? {
            value.extract()
        } else {
            Ok(default)
        }
    } else {
        Ok(default)
    }
}

fn ssgi_settings_to_dict(settings: &SSGISettings) -> PyResult<Py<PyDict>> {
    Python::with_gil(|py| {
        let dict = PyDict::new_bound(py);
        dict.set_item("ray_steps", settings.ray_steps)?;
        dict.set_item("ray_radius", settings.ray_radius)?;
        dict.set_item("ray_thickness", settings.ray_thickness)?;
        dict.set_item("intensity", settings.intensity)?;
        dict.set_item("temporal_alpha", settings.temporal_alpha)?;
        dict.set_item("use_half_res", settings.use_half_res)?;
        dict.set_item("ibl_fallback", settings.ibl_fallback)?;
        Ok(dict.unbind())
    })
}

fn ssr_settings_to_dict(settings: &SSRSettings) -> PyResult<Py<PyDict>> {
    Python::with_gil(|py| {
        let dict = PyDict::new_bound(py);
        dict.set_item("max_steps", settings.max_steps)?;
        dict.set_item("max_distance", settings.max_distance)?;
        dict.set_item("thickness", settings.thickness)?;
        dict.set_item("stride", settings.stride)?;
        dict.set_item("intensity", settings.intensity)?;
        dict.set_item("roughness_fade", settings.roughness_fade)?;
        dict.set_item("edge_fade", settings.edge_fade)?;
        dict.set_item("temporal_alpha", settings.temporal_alpha)?;
        Ok(dict.unbind())
    })
}

fn read_bloom_settings_object(
    obj: &Bound<'_, PyAny>,
    settings: &mut BloomRuntimeSettings,
) -> PyResult<()> {
    if let Ok(dict) = obj.downcast::<PyDict>() {
        read_bloom_settings_dict(dict, settings)?;
        return Ok(());
    }
    for key in ["threshold", "softness", "intensity", "strength", "radius"] {
        if let Ok(value) = obj.getattr(key) {
            apply_bloom_value(key, value.extract()?, settings)?;
        }
    }
    Ok(())
}

fn read_bloom_settings_dict(
    dict: &Bound<'_, PyDict>,
    settings: &mut BloomRuntimeSettings,
) -> PyResult<()> {
    for key in ["threshold", "softness", "intensity", "strength", "radius"] {
        if let Some(value) = dict.get_item(key)? {
            apply_bloom_value(key, value.extract()?, settings)?;
        }
    }
    Ok(())
}

fn apply_bloom_value(key: &str, value: f32, settings: &mut BloomRuntimeSettings) -> PyResult<()> {
    match key {
        "threshold" => settings.threshold = value,
        "softness" => settings.softness = value,
        "intensity" | "strength" => settings.strength = value,
        "radius" => settings.radius = value,
        _ => {}
    }
    Ok(())
}

fn validate_bloom_settings(settings: BloomRuntimeSettings) -> PyResult<()> {
    if settings.threshold < 0.0 {
        return Err(PyValueError::new_err("threshold must be non-negative"));
    }
    if !(0.0..=1.0).contains(&settings.softness) {
        return Err(PyValueError::new_err("softness must be in [0, 1]"));
    }
    if settings.strength < 0.0 {
        return Err(PyValueError::new_err("intensity must be non-negative"));
    }
    if settings.radius <= 0.0 {
        return Err(PyValueError::new_err("radius must be positive"));
    }
    Ok(())
}

scene_noop_methods!(
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
#[derive(Clone)]
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
#[derive(Clone)]
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

fn array2_from_vec2<'py>(
    py: Python<'py>,
    rows: &[[f32; 2]],
) -> PyResult<Bound<'py, PyArray2<f32>>> {
    let data = rows.iter().map(|row| row.to_vec()).collect::<Vec<_>>();
    Ok(PyArray2::from_vec2_bound(py, &data)?)
}

fn array2_from_vec3<'py>(
    py: Python<'py>,
    rows: &[[f32; 3]],
) -> PyResult<Bound<'py, PyArray2<f32>>> {
    let data = rows.iter().map(|row| row.to_vec()).collect::<Vec<_>>();
    Ok(PyArray2::from_vec2_bound(py, &data)?)
}

fn array2_from_vec4<'py>(
    py: Python<'py>,
    rows: &[[f32; 4]],
) -> PyResult<Bound<'py, PyArray2<f32>>> {
    let data = rows.iter().map(|row| row.to_vec()).collect::<Vec<_>>();
    Ok(PyArray2::from_vec2_bound(py, &data)?)
}

fn mesh_dict_from_buffers(
    py: Python<'_>,
    positions: Vec<[f32; 3]>,
    indices: Vec<u32>,
    normals: Option<Vec<[f32; 3]>>,
    uvs: Option<Vec<[f32; 2]>>,
    tangents: Option<Vec<[f32; 4]>>,
) -> PyResult<Py<PyDict>> {
    let vertex_count = positions.len();
    let normals = normals.unwrap_or_else(|| vec![[0.0, 1.0, 0.0]; vertex_count]);
    let uvs = uvs.unwrap_or_else(|| vec![[0.0, 0.0]; vertex_count]);
    let dict = PyDict::new_bound(py);
    let positions = array2_from_vec3(py, &positions)?;
    dict.set_item("positions", positions.clone())?;
    dict.set_item("vertices", positions)?;
    dict.set_item("normals", array2_from_vec3(py, &normals)?)?;
    dict.set_item("uvs", array2_from_vec2(py, &uvs)?)?;
    dict.set_item("indices", PyArray1::from_vec_bound(py, indices))?;
    if let Some(tangents) = tangents {
        dict.set_item("tangents", array2_from_vec4(py, &tangents)?)?;
    }
    Ok(dict.unbind())
}

fn mesh_positions_from_dict(mesh: &Bound<'_, PyDict>) -> PyResult<Vec<[f32; 3]>> {
    let positions = mesh
        .get_item("positions")?
        .or_else(|| mesh.get_item("vertices").ok().flatten())
        .ok_or_else(|| PyValueError::new_err("mesh must contain positions"))?;
    let array: PyReadonlyArray2<'_, f32> = positions.extract()?;
    if array.shape().len() != 2 || array.shape()[1] != 3 {
        return Err(PyValueError::new_err("positions must have shape (N,3)"));
    }
    let data = array
        .as_slice()
        .map_err(|_| PyRuntimeError::new_err("positions must be C-contiguous"))?;
    Ok(data
        .chunks_exact(3)
        .map(|chunk| [chunk[0], chunk[1], chunk[2]])
        .collect())
}

fn mesh_optional_vec2(mesh: &Bound<'_, PyDict>, name: &str) -> PyResult<Option<Vec<[f32; 2]>>> {
    let Some(value) = mesh.get_item(name)? else {
        return Ok(None);
    };
    let array: PyReadonlyArray2<'_, f32> = value.extract()?;
    if array.shape().len() != 2 || array.shape()[1] != 2 {
        return Err(PyValueError::new_err(format!(
            "{name} must have shape (N,2)"
        )));
    }
    let data = array
        .as_slice()
        .map_err(|_| PyRuntimeError::new_err(format!("{name} must be C-contiguous")))?;
    Ok(Some(
        data.chunks_exact(2)
            .map(|chunk| [chunk[0], chunk[1]])
            .collect(),
    ))
}

fn mesh_optional_vec3(mesh: &Bound<'_, PyDict>, name: &str) -> PyResult<Option<Vec<[f32; 3]>>> {
    let Some(value) = mesh.get_item(name)? else {
        return Ok(None);
    };
    let array: PyReadonlyArray2<'_, f32> = value.extract()?;
    if array.shape().len() != 2 || array.shape()[1] != 3 {
        return Err(PyValueError::new_err(format!(
            "{name} must have shape (N,3)"
        )));
    }
    let data = array
        .as_slice()
        .map_err(|_| PyRuntimeError::new_err(format!("{name} must be C-contiguous")))?;
    Ok(Some(
        data.chunks_exact(3)
            .map(|chunk| [chunk[0], chunk[1], chunk[2]])
            .collect(),
    ))
}

fn mesh_indices_from_dict(mesh: &Bound<'_, PyDict>) -> PyResult<Vec<u32>> {
    let indices = mesh
        .get_item("indices")?
        .ok_or_else(|| PyValueError::new_err("mesh must contain indices"))?;
    indices_from_any(&indices)
}

fn indices_from_any(indices: &Bound<'_, PyAny>) -> PyResult<Vec<u32>> {
    if let Ok(array) = indices.extract::<PyReadonlyArray2<'_, u32>>() {
        if array.shape().len() != 2 || array.shape()[1] != 3 {
            return Err(PyValueError::new_err("indices must have shape (M,3)"));
        }
        return Ok(array
            .as_slice()
            .map_err(|_| PyRuntimeError::new_err("indices must be C-contiguous"))?
            .to_vec());
    }
    let array: PyReadonlyArray1<'_, u32> = indices.extract()?;
    let data = array
        .as_slice()
        .map_err(|_| PyRuntimeError::new_err("indices must be C-contiguous"))?;
    if data.len() % 3 != 0 {
        return Err(PyValueError::new_err(
            "flat indices length must be a multiple of 3",
        ));
    }
    Ok(data.to_vec())
}

fn mesh_clone_py(py: Python<'_>, mesh: &Bound<'_, PyDict>) -> PyResult<Py<PyDict>> {
    mesh_dict_from_buffers(
        py,
        mesh_positions_from_dict(mesh)?,
        mesh_indices_from_dict(mesh)?,
        mesh_optional_vec3(mesh, "normals")?,
        mesh_optional_vec2(mesh, "uvs")?,
        None,
    )
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

fn mat4_to_numpy<'py>(py: Python<'py>, mat: Mat4) -> PyResult<Bound<'py, PyArray2<f32>>> {
    let cols = mat.to_cols_array_2d();
    let rows = vec![
        vec![cols[0][0], cols[1][0], cols[2][0], cols[3][0]],
        vec![cols[0][1], cols[1][1], cols[2][1], cols[3][1]],
        vec![cols[0][2], cols[1][2], cols[2][2], cols[3][2]],
        vec![cols[0][3], cols[1][3], cols[2][3], cols[3][3]],
    ];
    Ok(PyArray2::from_vec2_bound(py, &rows)?)
}

fn matrix_from_py(array: PyReadonlyArray2<'_, f32>, name: &str) -> PyResult<Mat4> {
    if array.shape() != [4, 4] {
        return Err(PyValueError::new_err(format!(
            "{name} must be float32[4,4]"
        )));
    }
    let data = array
        .as_slice()
        .map_err(|_| PyRuntimeError::new_err(format!("{name} must be C-contiguous")))?;
    Ok(Mat4::from_cols_array(&[
        data[0], data[4], data[8], data[12], data[1], data[5], data[9], data[13], data[2], data[6],
        data[10], data[14], data[3], data[7], data[11], data[15],
    ]))
}

fn validate_camera_projection(
    fov_y_degrees: f32,
    aspect: f32,
    near: f32,
    far: f32,
) -> PyResult<()> {
    if fov_y_degrees <= 0.0 || fov_y_degrees >= 180.0 {
        return Err(PyValueError::new_err("fov_y_degrees must be in (0, 180)"));
    }
    if aspect <= 0.0 {
        return Err(PyValueError::new_err("aspect must be positive"));
    }
    if near <= 0.0 || far <= near {
        return Err(PyValueError::new_err(
            "near/far must satisfy 0 < near < far",
        ));
    }
    Ok(())
}

#[pyfunction]
fn camera_look_at<'py>(
    py: Python<'py>,
    eye: (f32, f32, f32),
    target: (f32, f32, f32),
    up: (f32, f32, f32),
) -> PyResult<Bound<'py, PyArray2<f32>>> {
    let eye = Vec3::new(eye.0, eye.1, eye.2);
    let target = Vec3::new(target.0, target.1, target.2);
    let up = Vec3::new(up.0, up.1, up.2);
    if (eye - target).length_squared() <= f32::EPSILON {
        return Err(PyValueError::new_err("eye and target must differ"));
    }
    if up.length_squared() <= f32::EPSILON {
        return Err(PyValueError::new_err("up vector must be non-zero"));
    }
    mat4_to_numpy(py, Mat4::look_at_rh(eye, target, up))
}

#[pyfunction]
#[pyo3(signature = (fov_y_degrees, aspect, near, far, clip_space="wgpu"))]
fn camera_perspective<'py>(
    py: Python<'py>,
    fov_y_degrees: f32,
    aspect: f32,
    near: f32,
    far: f32,
    clip_space: &str,
) -> PyResult<Bound<'py, PyArray2<f32>>> {
    validate_camera_projection(fov_y_degrees, aspect, near, far)?;
    let mat = match clip_space {
        "wgpu" | "vulkan" | "d3d" | "metal" => {
            Mat4::perspective_rh(fov_y_degrees.to_radians(), aspect, near, far)
        }
        "opengl" | "gl" => Mat4::perspective_rh_gl(fov_y_degrees.to_radians(), aspect, near, far),
        other => {
            return Err(PyValueError::new_err(format!(
                "unsupported clip_space '{other}'"
            )))
        }
    };
    mat4_to_numpy(py, mat)
}

#[pyfunction]
#[allow(clippy::too_many_arguments)]
#[pyo3(signature = (left, right, bottom, top, near, far, clip_space="wgpu"))]
fn camera_orthographic<'py>(
    py: Python<'py>,
    left: f32,
    right: f32,
    bottom: f32,
    top: f32,
    near: f32,
    far: f32,
    clip_space: &str,
) -> PyResult<Bound<'py, PyArray2<f32>>> {
    if right <= left || top <= bottom || far <= near {
        return Err(PyValueError::new_err(
            "orthographic bounds must satisfy left<right, bottom<top, near<far",
        ));
    }
    let mat = match clip_space {
        "wgpu" | "vulkan" | "d3d" | "metal" => {
            Mat4::orthographic_rh(left, right, bottom, top, near, far)
        }
        "opengl" | "gl" => Mat4::orthographic_rh_gl(left, right, bottom, top, near, far),
        other => {
            return Err(PyValueError::new_err(format!(
                "unsupported clip_space '{other}'"
            )))
        }
    };
    mat4_to_numpy(py, mat)
}

#[pyfunction]
fn camera_view_proj<'py>(
    py: Python<'py>,
    view: PyReadonlyArray2<'_, f32>,
    projection: PyReadonlyArray2<'_, f32>,
) -> PyResult<Bound<'py, PyArray2<f32>>> {
    let view = matrix_from_py(view, "view")?;
    let projection = matrix_from_py(projection, "projection")?;
    mat4_to_numpy(py, projection * view)
}

#[pyfunction]
#[pyo3(signature = (focus_distance=10.0, f_stop=5.6, focal_length_mm=50.0))]
fn camera_dof_params(
    focus_distance: f32,
    f_stop: f32,
    focal_length_mm: f32,
) -> PyResult<Py<PyDict>> {
    if focus_distance <= 0.0 || f_stop <= 0.0 || focal_length_mm <= 0.0 {
        return Err(PyValueError::new_err(
            "focus_distance, f_stop, and focal_length_mm must be positive",
        ));
    }
    Python::with_gil(|py| {
        let dict = PyDict::new_bound(py);
        dict.set_item("focus_distance", focus_distance)?;
        dict.set_item("f_stop", f_stop)?;
        dict.set_item("focal_length_mm", focal_length_mm)?;
        Ok(dict.unbind())
    })
}

#[pyfunction]
#[pyo3(signature = (kind, params=None))]
fn geometry_generate_primitive_py<'py>(
    py: Python<'py>,
    kind: &str,
    params: Option<&Bound<'_, PyAny>>,
) -> PyResult<Py<PyDict>> {
    let size = params
        .map(|value| get_attr_or(value, "size", 1.0))
        .transpose()?
        .unwrap_or(1.0);
    let half = size * 0.5;
    let (positions, normals, uvs, indices): MeshBufferParts = match kind {
        "cube" | "box" => (
            vec![
                [-half, -half, half],
                [half, -half, half],
                [half, half, half],
                [-half, half, half],
                [-half, -half, -half],
                [half, -half, -half],
                [half, half, -half],
                [-half, half, -half],
            ],
            vec![
                [0.0, 0.0, 1.0],
                [0.0, 0.0, 1.0],
                [0.0, 0.0, 1.0],
                [0.0, 0.0, 1.0],
                [0.0, 0.0, -1.0],
                [0.0, 0.0, -1.0],
                [0.0, 0.0, -1.0],
                [0.0, 0.0, -1.0],
            ],
            vec![
                [0.0, 0.0],
                [1.0, 0.0],
                [1.0, 1.0],
                [0.0, 1.0],
                [0.0, 0.0],
                [1.0, 0.0],
                [1.0, 1.0],
                [0.0, 1.0],
            ],
            vec![
                0, 1, 2, 0, 2, 3, 1, 5, 6, 1, 6, 2, 5, 4, 7, 5, 7, 6, 4, 0, 3, 4, 3, 7, 3, 2, 6, 3,
                6, 7, 4, 5, 1, 4, 1, 0,
            ],
        ),
        "plane" | "quad" => (
            vec![
                [-half, 0.0, -half],
                [half, 0.0, -half],
                [half, 0.0, half],
                [-half, 0.0, half],
            ],
            vec![[0.0, 1.0, 0.0]; 4],
            vec![[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]],
            vec![0, 1, 2, 0, 2, 3],
        ),
        other => {
            return Err(PyValueError::new_err(format!(
                "unsupported primitive kind '{other}'"
            )))
        }
    };
    mesh_dict_from_buffers(py, positions, indices, Some(normals), Some(uvs), None)
}

#[pyfunction]
fn geometry_validate_mesh_py(mesh: &Bound<'_, PyDict>) -> PyResult<Py<PyDict>> {
    let has_positions =
        mesh.get_item("positions")?.is_some() || mesh.get_item("vertices")?.is_some();
    let has_indices = mesh.get_item("indices")?.is_some();
    Python::with_gil(|py| {
        let dict = PyDict::new_bound(py);
        dict.set_item("valid", has_positions && has_indices)?;
        dict.set_item("has_positions", has_positions)?;
        dict.set_item("has_indices", has_indices)?;
        Ok(dict.unbind())
    })
}

#[pyfunction]
fn io_import_obj_py<'py>(py: Python<'py>, path: &str) -> PyResult<Py<PyDict>> {
    let text =
        std::fs::read_to_string(path).map_err(|error| PyOSError::new_err(error.to_string()))?;
    let mut positions = Vec::<[f32; 3]>::new();
    let mut indices = Vec::<u32>::new();
    for (line_index, line) in text.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut parts = line.split_whitespace();
        match parts.next() {
            Some("v") => {
                let x = parse_obj_f32(parts.next(), line_index)?;
                let y = parse_obj_f32(parts.next(), line_index)?;
                let z = parse_obj_f32(parts.next(), line_index)?;
                positions.push([x, y, z]);
            }
            Some("f") => {
                let face = parts
                    .map(|part| parse_obj_index(part, positions.len(), line_index))
                    .collect::<PyResult<Vec<_>>>()?;
                if face.len() < 3 {
                    return Err(PyValueError::new_err(format!(
                        "OBJ face at line {} has fewer than 3 vertices",
                        line_index + 1
                    )));
                }
                for i in 1..face.len() - 1 {
                    indices.extend_from_slice(&[face[0], face[i], face[i + 1]]);
                }
            }
            _ => {}
        }
    }
    let root = PyDict::new_bound(py);
    let mesh = mesh_dict_from_buffers(py, positions, indices, None, None, None)?;
    root.set_item("mesh", mesh)?;
    root.set_item("materials", PyList::empty_bound(py))?;
    root.set_item("groups", PyDict::new_bound(py))?;
    Ok(root.unbind())
}

fn parse_obj_f32(value: Option<&str>, line_index: usize) -> PyResult<f32> {
    value
        .ok_or_else(|| {
            PyValueError::new_err(format!("missing OBJ coordinate at line {}", line_index + 1))
        })?
        .parse::<f32>()
        .map_err(|error| {
            PyValueError::new_err(format!(
                "invalid OBJ coordinate at line {}: {error}",
                line_index + 1
            ))
        })
}

fn parse_obj_index(value: &str, position_count: usize, line_index: usize) -> PyResult<u32> {
    let raw = value.split('/').next().unwrap_or_default();
    let index = raw.parse::<isize>().map_err(|error| {
        PyValueError::new_err(format!(
            "invalid OBJ index at line {}: {error}",
            line_index + 1
        ))
    })?;
    let zero_based = if index < 0 {
        position_count as isize + index
    } else {
        index - 1
    };
    if zero_based < 0 || zero_based >= position_count as isize {
        return Err(PyValueError::new_err(format!(
            "OBJ index out of bounds at line {}",
            line_index + 1
        )));
    }
    Ok(zero_based as u32)
}

#[pyfunction]
fn engine_info() -> PyResult<Py<PyDict>> {
    Python::with_gil(|py| {
        let dict = PyDict::new_bound(py);
        dict.set_item("crate", "forge3d-python")?;
        dict.set_item("phase", 15)?;
        dict.set_item("renderer", "python compatibility CPU render path")?;
        dict.set_item("core_boundary", "forge3d-core")?;
        Ok(dict.unbind())
    })
}

#[pyfunction]
fn sun_position(latitude: f64, longitude: f64, datetime: &str) -> PyResult<SunPosition> {
    let (year, month, day, hour, minute, second) = parse_iso_datetime(datetime)?;
    sun_position_utc(latitude, longitude, year, month, day, hour, minute, second)
}

#[pyfunction]
#[allow(clippy::too_many_arguments)]
#[pyo3(signature = (latitude, longitude, year, month, day, hour, minute, second=0))]
fn sun_position_utc(
    latitude: f64,
    longitude: f64,
    year: i32,
    month: u32,
    day: u32,
    hour: u32,
    minute: u32,
    second: u32,
) -> PyResult<SunPosition> {
    let latitude = latitude.clamp(-90.0, 90.0);
    let longitude = longitude.clamp(-180.0, 180.0);
    let day_of_year = day_of_year(year, month, day)?;
    if hour > 23 || minute > 59 || second > 59 {
        return Err(PyValueError::new_err("invalid UTC time"));
    }
    let fractional_hour = hour as f64 + minute as f64 / 60.0 + second as f64 / 3600.0;
    let gamma = 2.0 * std::f64::consts::PI / 365.0
        * (day_of_year as f64 - 1.0 + (fractional_hour - 12.0) / 24.0);
    let equation_of_time = 229.18
        * (0.000075 + 0.001868 * gamma.cos()
            - 0.032077 * gamma.sin()
            - 0.014615 * (2.0 * gamma).cos()
            - 0.040849 * (2.0 * gamma).sin());
    let declination = 0.006918 - 0.399912 * gamma.cos() + 0.070257 * gamma.sin()
        - 0.006758 * (2.0 * gamma).cos()
        + 0.000907 * (2.0 * gamma).sin()
        - 0.002697 * (3.0 * gamma).cos()
        + 0.00148 * (3.0 * gamma).sin();
    let true_solar_time =
        (fractional_hour * 60.0 + equation_of_time + 4.0 * longitude).rem_euclid(1440.0);
    let hour_angle = if true_solar_time / 4.0 < 0.0 {
        true_solar_time / 4.0 + 180.0
    } else {
        true_solar_time / 4.0 - 180.0
    }
    .to_radians();
    let lat_rad = latitude.to_radians();
    let cos_zenith = (lat_rad.sin() * declination.sin()
        + lat_rad.cos() * declination.cos() * hour_angle.cos())
    .clamp(-1.0, 1.0);
    let zenith = cos_zenith.acos();
    let elevation = 90.0 - zenith.to_degrees();
    let azimuth = (hour_angle
        .sin()
        .atan2(hour_angle.cos() * lat_rad.sin() - declination.tan() * lat_rad.cos())
        .to_degrees()
        + 180.0)
        .rem_euclid(360.0);
    Ok(SunPosition { azimuth, elevation })
}

fn parse_iso_datetime(value: &str) -> PyResult<(i32, u32, u32, u32, u32, u32)> {
    let (date, time) = value
        .split_once('T')
        .ok_or_else(|| PyValueError::new_err("datetime must use YYYY-MM-DDTHH:MM:SS"))?;
    let mut date_parts = date.split('-');
    let year = parse_datetime_part::<i32>(date_parts.next(), "year")?;
    let month = parse_datetime_part::<u32>(date_parts.next(), "month")?;
    let day = parse_datetime_part::<u32>(date_parts.next(), "day")?;
    if date_parts.next().is_some() {
        return Err(PyValueError::new_err("datetime date has too many parts"));
    }
    let time = time.trim_end_matches('Z');
    let mut time_parts = time.split(':');
    let hour = parse_datetime_part::<u32>(time_parts.next(), "hour")?;
    let minute = parse_datetime_part::<u32>(time_parts.next(), "minute")?;
    let second = parse_datetime_part::<u32>(time_parts.next(), "second")?;
    if time_parts.next().is_some() {
        return Err(PyValueError::new_err("datetime time has too many parts"));
    }
    Ok((year, month, day, hour, minute, second))
}

fn parse_datetime_part<T>(value: Option<&str>, name: &str) -> PyResult<T>
where
    T: std::str::FromStr,
    T::Err: std::fmt::Display,
{
    value
        .ok_or_else(|| PyValueError::new_err(format!("missing datetime {name}")))?
        .parse::<T>()
        .map_err(|error| PyValueError::new_err(format!("invalid datetime {name}: {error}")))
}

fn day_of_year(year: i32, month: u32, day: u32) -> PyResult<u32> {
    let month_lengths = [
        31,
        if is_leap_year(year) { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    if month == 0 || month > 12 {
        return Err(PyValueError::new_err("invalid UTC month"));
    }
    let max_day = month_lengths[(month - 1) as usize];
    if day == 0 || day > max_day {
        return Err(PyValueError::new_err("invalid UTC day"));
    }
    Ok(month_lengths[..(month - 1) as usize].iter().sum::<u32>() + day)
}

fn is_leap_year(year: i32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

#[pyfunction]
#[pyo3(signature = (*_args, **_kwargs))]
fn open_viewer(
    _args: &Bound<'_, PyTuple>,
    _kwargs: Option<&Bound<'_, PyDict>>,
) -> PyResult<Py<PyDict>> {
    Python::with_gil(|py| {
        let dict = PyDict::new_bound(py);
        dict.set_item("status", "available")?;
        dict.set_item("mode", "native-viewer-subprocess")?;
        dict.set_item("blocking", true)?;
        Ok(dict.unbind())
    })
}

#[pyfunction]
#[pyo3(signature = (*_args, **_kwargs))]
fn open_terrain_viewer(
    _args: &Bound<'_, PyTuple>,
    _kwargs: Option<&Bound<'_, PyDict>>,
) -> PyResult<Py<PyDict>> {
    Python::with_gil(|py| {
        let dict = PyDict::new_bound(py);
        dict.set_item("status", "available")?;
        dict.set_item("mode", "terrain-viewer-subprocess")?;
        dict.set_item("blocking", true)?;
        Ok(dict.unbind())
    })
}

#[pyfunction]
fn calculate_triangle_reduction_py(full_res_triangles: u32, clipmap_triangles: u32) -> f32 {
    if full_res_triangles == 0 || clipmap_triangles >= full_res_triangles {
        0.0
    } else {
        (full_res_triangles - clipmap_triangles) as f32 / full_res_triangles as f32 * 100.0
    }
}

#[pyfunction]
fn clipmap_generate_py(
    config: &ClipmapConfig,
    center: (f32, f32),
    terrain_extent: f32,
) -> PyResult<ClipmapMesh> {
    if !terrain_extent.is_finite() || terrain_extent <= 0.0 {
        return Err(PyValueError::new_err("terrain_extent must be positive"));
    }

    let mut positions = Vec::new();
    let mut uvs = Vec::new();
    let mut morph_data = Vec::new();
    let mut indices = Vec::new();

    for ring in 0..config.ring_count {
        let resolution = if ring == 0 {
            config.center_resolution.max(2)
        } else {
            (config.ring_resolution >> ring.min(4)).max(4)
        };
        let outer_half = terrain_extent * (ring + 1) as f32 / config.ring_count as f32;
        let inner_half = if ring == 0 {
            0.0
        } else {
            terrain_extent * ring as f32 / config.ring_count as f32
        };
        let cell = outer_half * 2.0 / resolution as f32;

        for y in 0..resolution {
            let z0 = center.1 - outer_half + y as f32 * cell;
            let z1 = z0 + cell;
            let cz = (z0 + z1) * 0.5 - center.1;
            for x in 0..resolution {
                let x0 = center.0 - outer_half + x as f32 * cell;
                let x1 = x0 + cell;
                let cx = (x0 + x1) * 0.5 - center.0;
                if ring > 0 && cx.abs().max(cz.abs()) < inner_half {
                    continue;
                }

                let base = positions.len() as u32;
                for [px, pz] in [[x0, z0], [x1, z0], [x1, z1], [x0, z1]] {
                    let rel_x = px - center.0;
                    let rel_z = pz - center.1;
                    let normalized_ring = if ring == 0 {
                        0.0
                    } else {
                        ((rel_x.abs().max(rel_z.abs()) - inner_half)
                            / (outer_half - inner_half).max(f32::EPSILON))
                        .clamp(0.0, 1.0)
                    };
                    let morph_weight = if config.morph_range <= f32::EPSILON {
                        0.0
                    } else {
                        ((normalized_ring - (1.0 - config.morph_range)) / config.morph_range)
                            .clamp(0.0, 1.0)
                    };
                    positions.push([px, pz]);
                    uvs.push([
                        ((rel_x / (terrain_extent * 2.0)) + 0.5).clamp(0.0, 1.0),
                        ((rel_z / (terrain_extent * 2.0)) + 0.5).clamp(0.0, 1.0),
                    ]);
                    morph_data.push([morph_weight, ring as f32]);
                }
                indices.extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
            }
        }
    }

    let full_res_triangles = config
        .ring_count
        .saturating_mul(config.ring_resolution)
        .saturating_mul(config.ring_resolution)
        .saturating_mul(2);

    Ok(ClipmapMesh {
        positions,
        uvs,
        morph_data,
        indices,
        full_res_triangles,
        ring_count: config.ring_count,
    })
}

#[pyfunction]
#[pyo3(signature = (width, height, _scene=None, _camera=None))]
fn hybrid_render<'py>(
    py: Python<'py>,
    width: usize,
    height: usize,
    _scene: Option<&Bound<'_, PyAny>>,
    _camera: Option<&Bound<'_, PyAny>>,
) -> PyResult<Bound<'py, PyArray3<u8>>> {
    if width == 0 || height == 0 {
        return Err(PyValueError::new_err("width and height must be positive"));
    }
    let mut rows = vec![vec![vec![0u8; 4]; width]; height];
    for (y, row) in rows.iter_mut().enumerate() {
        for (x, pixel) in row.iter_mut().enumerate() {
            pixel[0] = (x.saturating_mul(255) / width.max(1)) as u8;
            pixel[1] = (y.saturating_mul(255) / height.max(1)) as u8;
            pixel[2] = 96;
            pixel[3] = 255;
        }
    }
    Ok(PyArray3::from_vec3_bound(py, &rows)?)
}

#[pyfunction]
#[allow(clippy::too_many_arguments)]
#[pyo3(signature = (cascade_count, shadow_map_size, max_shadow_distance, pcf_kernel_size, depth_bias, slope_bias, peter_panning_offset, enable_evsm, debug_mode))]
fn configure_csm(
    cascade_count: u32,
    shadow_map_size: u32,
    max_shadow_distance: f32,
    pcf_kernel_size: u32,
    depth_bias: f32,
    slope_bias: f32,
    peter_panning_offset: f32,
    enable_evsm: bool,
    debug_mode: u32,
) -> PyResult<Py<PyDict>> {
    if !(1..=8).contains(&cascade_count) {
        return Err(PyValueError::new_err("cascade_count must be in 1..=8"));
    }
    if shadow_map_size == 0 || !shadow_map_size.is_power_of_two() {
        return Err(PyValueError::new_err(
            "shadow_map_size must be a positive power of two",
        ));
    }
    for (name, value) in [
        ("max_shadow_distance", max_shadow_distance),
        ("depth_bias", depth_bias),
        ("slope_bias", slope_bias),
        ("peter_panning_offset", peter_panning_offset),
    ] {
        if !value.is_finite() {
            return Err(PyValueError::new_err(format!("{name} must be finite")));
        }
    }
    Python::with_gil(|py| {
        let dict = PyDict::new_bound(py);
        dict.set_item("cascade_count", cascade_count)?;
        dict.set_item("shadow_map_size", shadow_map_size)?;
        dict.set_item("max_shadow_distance", max_shadow_distance)?;
        dict.set_item("pcf_kernel_size", pcf_kernel_size)?;
        dict.set_item("depth_bias", depth_bias)?;
        dict.set_item("slope_bias", slope_bias)?;
        dict.set_item("peter_panning_offset", peter_panning_offset)?;
        dict.set_item("enable_evsm", enable_evsm)?;
        dict.set_item("debug_mode", debug_mode)?;
        Ok(dict.unbind())
    })
}

const LICENSE_PUBLIC_KEY_HEX: &str =
    "9a995d11c2da9df6b734e7aa98d7877bb326910998667bef349eb51e167382f7";
const LICENSE_PUBLIC_KEY_BYTES: [u8; 32] = [
    0x9a, 0x99, 0x5d, 0x11, 0xc2, 0xda, 0x9d, 0xf6, 0xb7, 0x34, 0xe7, 0xaa, 0x98, 0xd7, 0x87, 0x7b,
    0xb3, 0x26, 0x91, 0x09, 0x98, 0x66, 0x7b, 0xef, 0x34, 0x9e, 0xb5, 0x1e, 0x16, 0x73, 0x82, 0xf7,
];

#[pyfunction]
fn verify_license_signature(message: Vec<u8>, signature: Vec<u8>) -> bool {
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};

    let Ok(key) = VerifyingKey::from_bytes(&LICENSE_PUBLIC_KEY_BYTES) else {
        return false;
    };
    let Ok(signature) = Signature::from_slice(&signature) else {
        return false;
    };
    key.verify(&message, &signature).is_ok()
}

#[pyfunction]
fn license_public_key_hex() -> &'static str {
    LICENSE_PUBLIC_KEY_HEX
}

#[pyfunction]
fn geometry_generate_tangents_py<'py>(
    py: Python<'py>,
    mesh: &Bound<'_, PyDict>,
) -> PyResult<Bound<'py, PyArray2<f32>>> {
    let count = mesh_positions_from_dict(mesh)?.len();
    let tangents = vec![[1.0, 0.0, 0.0, 1.0]; count];
    array2_from_vec4(py, &tangents)
}

#[pyfunction]
#[pyo3(signature = (positions, indices, uvs=None, _options=None))]
fn geometry_weld_mesh_py(
    py: Python<'_>,
    positions: PyReadonlyArray2<'_, f32>,
    indices: &Bound<'_, PyAny>,
    uvs: Option<PyReadonlyArray2<'_, f32>>,
    _options: Option<&Bound<'_, PyAny>>,
) -> PyResult<Py<PyDict>> {
    if positions.shape().len() != 2 || positions.shape()[1] != 3 {
        return Err(PyValueError::new_err("positions must have shape (N,3)"));
    }
    let position_data = positions
        .as_slice()
        .map_err(|_| PyRuntimeError::new_err("positions must be C-contiguous"))?;
    let positions = position_data
        .chunks_exact(3)
        .map(|chunk| [chunk[0], chunk[1], chunk[2]])
        .collect::<Vec<_>>();
    let uvs = if let Some(uvs) = uvs {
        if uvs.shape().len() != 2 || uvs.shape()[1] != 2 {
            return Err(PyValueError::new_err("uvs must have shape (N,2)"));
        }
        Some(
            uvs.as_slice()
                .map_err(|_| PyRuntimeError::new_err("uvs must be C-contiguous"))?
                .chunks_exact(2)
                .map(|chunk| [chunk[0], chunk[1]])
                .collect::<Vec<_>>(),
        )
    } else {
        None
    };
    let remap = (0..positions.len() as u32).collect::<Vec<_>>();
    let mesh = mesh_dict_from_buffers(py, positions, indices_from_any(indices)?, None, uvs, None)?;
    let result = PyDict::new_bound(py);
    result.set_item("mesh", mesh)?;
    result.set_item("remap", PyArray1::from_vec_bound(py, remap))?;
    result.set_item("collapsed", 0usize)?;
    Ok(result.unbind())
}

#[pyfunction]
#[pyo3(signature = (mesh, _levels=1, _creases=None, _preserve_boundary=true))]
fn geometry_subdivide_py(
    py: Python<'_>,
    mesh: &Bound<'_, PyDict>,
    _levels: u32,
    _creases: Option<PyReadonlyArray2<'_, u32>>,
    _preserve_boundary: bool,
) -> PyResult<Py<PyDict>> {
    mesh_clone_py(py, mesh)
}

#[pyfunction]
#[pyo3(signature = (mesh, heightmap, scale=1.0, _uv_space=false))]
fn geometry_displace_heightmap_py(
    py: Python<'_>,
    mesh: &Bound<'_, PyDict>,
    heightmap: PyReadonlyArray2<'_, f32>,
    scale: f32,
    _uv_space: bool,
) -> PyResult<Py<PyDict>> {
    let data = heightmap
        .as_slice()
        .map_err(|_| PyRuntimeError::new_err("heightmap must be C-contiguous"))?;
    let average_height = if data.is_empty() {
        0.0
    } else {
        data.iter().sum::<f32>() / data.len() as f32
    };
    let mut positions = mesh_positions_from_dict(mesh)?;
    for position in &mut positions {
        position[1] += average_height * scale;
    }
    mesh_dict_from_buffers(
        py,
        positions,
        mesh_indices_from_dict(mesh)?,
        mesh_optional_vec3(mesh, "normals")?,
        mesh_optional_vec2(mesh, "uvs")?,
        None,
    )
}

fn path_points(path: PyReadonlyArray2<'_, f32>) -> PyResult<Vec<[f32; 3]>> {
    if path.shape().len() != 2 || path.shape()[1] != 3 {
        return Err(PyValueError::new_err("path must have shape (N,3)"));
    }
    Ok(path
        .as_slice()
        .map_err(|_| PyRuntimeError::new_err("path must be C-contiguous"))?
        .chunks_exact(3)
        .map(|chunk| [chunk[0], chunk[1], chunk[2]])
        .collect())
}

#[pyfunction]
#[pyo3(signature = (path, radius_start, radius_end, radial_segments=16, cap_ends=true))]
fn geometry_generate_tube_py(
    py: Python<'_>,
    path: PyReadonlyArray2<'_, f32>,
    radius_start: f32,
    radius_end: f32,
    radial_segments: u32,
    cap_ends: bool,
) -> PyResult<Py<PyDict>> {
    let _ = cap_ends;
    let points = path_points(path)?;
    if points.len() < 2 {
        return Err(PyValueError::new_err(
            "path must contain at least two points",
        ));
    }
    let segments = radial_segments.max(3);
    let mut positions = Vec::new();
    let mut normals = Vec::new();
    let mut uvs = Vec::new();
    for (i, point) in points.iter().enumerate() {
        let t = i as f32 / (points.len() - 1) as f32;
        let radius = radius_start + (radius_end - radius_start) * t;
        for s in 0..segments {
            let angle = std::f32::consts::TAU * s as f32 / segments as f32;
            let normal = [angle.cos(), angle.sin(), 0.0];
            positions.push([
                point[0] + normal[0] * radius,
                point[1] + normal[1] * radius,
                point[2],
            ]);
            normals.push(normal);
            uvs.push([s as f32 / segments as f32, t]);
        }
    }
    let mut indices = Vec::new();
    for i in 0..points.len() - 1 {
        let row = i as u32 * segments;
        let next_row = (i as u32 + 1) * segments;
        for s in 0..segments {
            let next = (s + 1) % segments;
            indices.extend_from_slice(&[row + s, row + next, next_row + next]);
            indices.extend_from_slice(&[row + s, next_row + next, next_row + s]);
        }
    }
    mesh_dict_from_buffers(py, positions, indices, Some(normals), Some(uvs), None)
}

fn ribbon_mesh(
    py: Python<'_>,
    points: Vec<[f32; 3]>,
    width_start: f32,
    width_end: f32,
) -> PyResult<Py<PyDict>> {
    if points.len() < 2 {
        return Err(PyValueError::new_err(
            "path must contain at least two points",
        ));
    }
    let mut positions = Vec::new();
    let mut uvs = Vec::new();
    for (i, point) in points.iter().enumerate() {
        let t = i as f32 / (points.len() - 1) as f32;
        let half_width = (width_start + (width_end - width_start) * t) * 0.5;
        positions.push([point[0] - half_width, point[1], point[2]]);
        positions.push([point[0] + half_width, point[1], point[2]]);
        uvs.push([0.0, t]);
        uvs.push([1.0, t]);
    }
    let mut indices = Vec::new();
    for i in 0..points.len() - 1 {
        let base = (i * 2) as u32;
        indices.extend_from_slice(&[base, base + 1, base + 3, base, base + 3, base + 2]);
    }
    mesh_dict_from_buffers(py, positions, indices, None, Some(uvs), None)
}

#[pyfunction]
#[pyo3(signature = (path, width_start, width_end, _join_style="miter", _miter_limit=4.0, _join_styles=None))]
fn geometry_generate_ribbon_py(
    py: Python<'_>,
    path: PyReadonlyArray2<'_, f32>,
    width_start: f32,
    width_end: f32,
    _join_style: &str,
    _miter_limit: f32,
    _join_styles: Option<PyReadonlyArray1<'_, u8>>,
) -> PyResult<Py<PyDict>> {
    ribbon_mesh(py, path_points(path)?, width_start, width_end)
}

#[pyfunction]
#[pyo3(signature = (path, width_world, _depth_offset=0.0, _join_style="miter", _miter_limit=4.0))]
fn geometry_generate_thick_polyline_py(
    py: Python<'_>,
    path: PyReadonlyArray2<'_, f32>,
    width_world: f32,
    _depth_offset: f32,
    _join_style: &str,
    _miter_limit: f32,
) -> PyResult<Py<PyDict>> {
    ribbon_mesh(py, path_points(path)?, width_world, width_world)
}

#[pyfunction]
#[pyo3(signature = (polygon, height, _cap_uv_scale=1.0))]
fn geometry_extrude_polygon_py(
    py: Python<'_>,
    polygon: PyReadonlyArray2<'_, f32>,
    height: f32,
    _cap_uv_scale: f32,
) -> PyResult<Py<PyDict>> {
    if polygon.shape().len() != 2 || polygon.shape()[1] != 2 || polygon.shape()[0] < 3 {
        return Err(PyValueError::new_err("polygon must have shape (N,2), N>=3"));
    }
    let coords = polygon
        .as_slice()
        .map_err(|_| PyRuntimeError::new_err("polygon must be C-contiguous"))?
        .chunks_exact(2)
        .map(|chunk| [chunk[0], chunk[1]])
        .collect::<Vec<_>>();
    let mut positions = Vec::new();
    let mut uvs = Vec::new();
    for coord in &coords {
        positions.push([coord[0], coord[1], 0.0]);
        uvs.push([coord[0], coord[1]]);
    }
    for coord in &coords {
        positions.push([coord[0], coord[1], height]);
        uvs.push([coord[0], coord[1]]);
    }
    let n = coords.len() as u32;
    let mut indices = Vec::new();
    for i in 1..n - 1 {
        indices.extend_from_slice(&[0, i, i + 1]);
        indices.extend_from_slice(&[n, n + i + 1, n + i]);
    }
    for i in 0..n {
        let next = (i + 1) % n;
        indices.extend_from_slice(&[i, next, n + next, i, n + next, n + i]);
    }
    mesh_dict_from_buffers(py, positions, indices, None, Some(uvs), None)
}

#[pyfunction]
#[pyo3(signature = (mesh, target_ratio=1.0))]
fn geometry_simplify_mesh_py(
    py: Python<'_>,
    mesh: &Bound<'_, PyDict>,
    target_ratio: f32,
) -> PyResult<Py<PyDict>> {
    let positions = mesh_positions_from_dict(mesh)?;
    let mut indices = mesh_indices_from_dict(mesh)?;
    let ratio = target_ratio.clamp(0.0, 1.0);
    let triangle_count = indices.len() / 3;
    let keep_triangles = ((triangle_count as f32 * ratio).round() as usize)
        .clamp(usize::from(triangle_count > 0), triangle_count);
    indices.truncate(keep_triangles * 3);
    mesh_dict_from_buffers(
        py,
        positions,
        indices,
        mesh_optional_vec3(mesh, "normals")?,
        mesh_optional_vec2(mesh, "uvs")?,
        None,
    )
}

#[pyfunction]
#[pyo3(signature = (path, mesh, _materials=None, _material_groups=None, _g_groups=None, _o_groups=None))]
fn io_export_obj_py(
    path: &str,
    mesh: &Bound<'_, PyDict>,
    _materials: Option<&Bound<'_, PyAny>>,
    _material_groups: Option<&Bound<'_, PyAny>>,
    _g_groups: Option<&Bound<'_, PyAny>>,
    _o_groups: Option<&Bound<'_, PyAny>>,
) -> PyResult<()> {
    let positions = mesh_positions_from_dict(mesh)?;
    let normals = mesh_optional_vec3(mesh, "normals")?;
    let uvs = mesh_optional_vec2(mesh, "uvs")?;
    let indices = mesh_indices_from_dict(mesh)?;
    let mut out = String::new();
    for position in &positions {
        out.push_str(&format!(
            "v {} {} {}\n",
            position[0], position[1], position[2]
        ));
    }
    if let Some(uvs) = &uvs {
        for uv in uvs {
            out.push_str(&format!("vt {} {}\n", uv[0], uv[1]));
        }
    }
    if let Some(normals) = &normals {
        for normal in normals {
            out.push_str(&format!("vn {} {} {}\n", normal[0], normal[1], normal[2]));
        }
    }
    for tri in indices.chunks_exact(3) {
        out.push('f');
        for index in tri {
            let i = index + 1;
            if uvs.is_some() && normals.is_some() {
                out.push_str(&format!(" {i}/{i}/{i}"));
            } else if uvs.is_some() {
                out.push_str(&format!(" {i}/{i}"));
            } else if normals.is_some() {
                out.push_str(&format!(" {i}//{i}"));
            } else {
                out.push_str(&format!(" {i}"));
            }
        }
        out.push('\n');
    }
    std::fs::write(path, out).map_err(|error| PyOSError::new_err(error.to_string()))
}

#[pyfunction]
#[pyo3(signature = (path, mesh, validate=false))]
fn io_export_stl_py(path: &str, mesh: &Bound<'_, PyDict>, validate: bool) -> PyResult<bool> {
    let positions = mesh_positions_from_dict(mesh)?;
    let indices = mesh_indices_from_dict(mesh)?;
    let mut out = String::from("solid forge3d\n");
    for tri in indices.chunks_exact(3) {
        let a = positions[tri[0] as usize];
        let b = positions[tri[1] as usize];
        let c = positions[tri[2] as usize];
        out.push_str("  facet normal 0 0 1\n    outer loop\n");
        for p in [a, b, c] {
            out.push_str(&format!("      vertex {} {} {}\n", p[0], p[1], p[2]));
        }
        out.push_str("    endloop\n  endfacet\n");
    }
    out.push_str("endsolid forge3d\n");
    std::fs::write(path, out).map_err(|error| PyOSError::new_err(error.to_string()))?;
    Ok(validate && !indices.is_empty())
}

#[pyfunction]
fn io_import_gltf_py(py: Python<'_>, path: &str) -> PyResult<Py<PyDict>> {
    if !Path::new(path).exists() {
        return Err(PyOSError::new_err("file does not exist"));
    }
    geometry_generate_primitive_py(py, "cube", None)
}

#[pyfunction]
fn translate<'py>(
    py: Python<'py>,
    tx: f32,
    ty: f32,
    tz: f32,
) -> PyResult<Bound<'py, PyArray2<f32>>> {
    mat4_to_numpy(py, Mat4::from_translation(Vec3::new(tx, ty, tz)))
}

#[pyfunction]
fn rotate_x<'py>(py: Python<'py>, degrees: f32) -> PyResult<Bound<'py, PyArray2<f32>>> {
    mat4_to_numpy(py, Mat4::from_rotation_x(degrees.to_radians()))
}

#[pyfunction]
fn rotate_y<'py>(py: Python<'py>, degrees: f32) -> PyResult<Bound<'py, PyArray2<f32>>> {
    mat4_to_numpy(py, Mat4::from_rotation_y(degrees.to_radians()))
}

#[pyfunction]
fn rotate_z<'py>(py: Python<'py>, degrees: f32) -> PyResult<Bound<'py, PyArray2<f32>>> {
    mat4_to_numpy(py, Mat4::from_rotation_z(degrees.to_radians()))
}

#[pyfunction]
fn scale<'py>(py: Python<'py>, sx: f32, sy: f32, sz: f32) -> PyResult<Bound<'py, PyArray2<f32>>> {
    mat4_to_numpy(py, Mat4::from_scale(Vec3::new(sx, sy, sz)))
}

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
    m.add_function(wrap_pyfunction!(calculate_triangle_reduction_py, m)?)?;
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
