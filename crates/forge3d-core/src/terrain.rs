use crate::error::{Forge3dError, Result};

const TWO_PI: f32 = std::f32::consts::TAU;

#[derive(Debug, Clone, PartialEq)]
pub struct TerrainHeightmapInput {
    pub width: u32,
    pub height: u32,
    pub heights: Vec<f32>,
    pub min_height: f32,
    pub max_height: f32,
    pub spacing: [f32; 2],
    pub exaggeration: f32,
    pub domain: [f32; 2],
    pub nodata: Option<f32>,
    pub crs: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct TerrainGridOptions {
    pub spacing: Option<[f32; 2]>,
    pub exaggeration: Option<f32>,
    pub domain: Option<[f32; 2]>,
    pub nodata: Option<f32>,
    pub crs: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TerrainMeshVertex {
    pub position: [f32; 3],
    pub uv: [f32; 2],
}

#[derive(Debug, Clone, PartialEq)]
pub struct TerrainMeshDescriptor {
    pub vertices: Vec<TerrainMeshVertex>,
    pub indices: Vec<u32>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TerrainSlopeAspect {
    pub width: u32,
    pub height: u32,
    pub slope_radians: Vec<f32>,
    pub aspect_radians: Vec<f32>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TerrainContourPolyline {
    pub level: f32,
    pub points: Vec<f32>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct TerrainContours {
    pub polylines: Vec<TerrainContourPolyline>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TerrainQuerySample {
    pub elevation: f32,
    pub slope_radians: f32,
    pub aspect_radians: f32,
    pub world_position: [f32; 3],
    pub normal: [f32; 3],
    pub grid_position: [f32; 2],
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HeightfieldAoConfig {
    pub enabled: bool,
    pub resolution_scale: f32,
    pub directions: u32,
    pub steps: u32,
    pub max_distance: f32,
    pub strength: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SunVisibilityMode {
    Hard,
    Soft,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SunVisibilityConfig {
    pub enabled: bool,
    pub mode: SunVisibilityMode,
    pub resolution_scale: f32,
    pub samples: u32,
    pub steps: u32,
    pub max_distance: f32,
    pub softness: f32,
    pub bias: f32,
    pub direction: [f32; 3],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerrainDebugView {
    None,
    HeightAo,
    SunVisibility,
}

impl HeightfieldAoConfig {
    pub fn validate(self) -> Result<Self> {
        if !self.resolution_scale.is_finite()
            || self.resolution_scale < 0.1
            || self.resolution_scale > 1.0
        {
            return Err(Forge3dError::InvalidInput {
                field: "heightAo.resolutionScale".to_string(),
                message: "heightAo resolutionScale must be between 0.1 and 1".to_string(),
            });
        }
        if self.directions == 0 || self.directions > 16 {
            return Err(Forge3dError::InvalidInput {
                field: "heightAo.directions".to_string(),
                message: "heightAo directions must be between 1 and 16".to_string(),
            });
        }
        if self.steps == 0 || self.steps > 64 {
            return Err(Forge3dError::InvalidInput {
                field: "heightAo.steps".to_string(),
                message: "heightAo steps must be between 1 and 64".to_string(),
            });
        }
        if !self.max_distance.is_finite() || self.max_distance <= 0.0 {
            return Err(Forge3dError::InvalidInput {
                field: "heightAo.maxDistance".to_string(),
                message: "heightAo maxDistance must be a finite value greater than zero"
                    .to_string(),
            });
        }
        if !self.strength.is_finite() || self.strength < 0.0 || self.strength > 2.0 {
            return Err(Forge3dError::InvalidInput {
                field: "heightAo.strength".to_string(),
                message: "heightAo strength must be between 0 and 2".to_string(),
            });
        }
        Ok(self)
    }

    pub fn output_dimensions(&self, width: u32, height: u32) -> (u32, u32) {
        (
            (width as f32 * self.resolution_scale).round().max(1.0) as u32,
            (height as f32 * self.resolution_scale).round().max(1.0) as u32,
        )
    }
}

impl Default for HeightfieldAoConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            resolution_scale: 0.5,
            directions: 6,
            steps: 16,
            max_distance: 200.0,
            strength: 1.0,
        }
    }
}

impl SunVisibilityConfig {
    pub fn validate(self) -> Result<Self> {
        if !self.resolution_scale.is_finite()
            || self.resolution_scale < 0.1
            || self.resolution_scale > 1.0
        {
            return Err(Forge3dError::InvalidInput {
                field: "sunVisibility.resolutionScale".to_string(),
                message: "sunVisibility resolutionScale must be between 0.1 and 1".to_string(),
            });
        }
        if self.samples == 0 || self.samples > 16 {
            return Err(Forge3dError::InvalidInput {
                field: "sunVisibility.samples".to_string(),
                message: "sunVisibility samples must be between 1 and 16".to_string(),
            });
        }
        if !self.softness.is_finite() || self.softness < 0.0 {
            return Err(Forge3dError::InvalidInput {
                field: "sunVisibility.softness".to_string(),
                message: "sunVisibility softness must be a finite non-negative value".to_string(),
            });
        }
        if self.steps == 0 || self.steps > 64 {
            return Err(Forge3dError::InvalidInput {
                field: "sunVisibility.steps".to_string(),
                message: "sunVisibility steps must be between 1 and 64".to_string(),
            });
        }
        if !self.max_distance.is_finite() || self.max_distance <= 0.0 {
            return Err(Forge3dError::InvalidInput {
                field: "sunVisibility.maxDistance".to_string(),
                message: "sunVisibility maxDistance must be a finite value greater than zero"
                    .to_string(),
            });
        }
        if !self.bias.is_finite() || self.bias < 0.0 {
            return Err(Forge3dError::InvalidInput {
                field: "sunVisibility.bias".to_string(),
                message: "sunVisibility bias must be a finite non-negative value".to_string(),
            });
        }
        let length = (self.direction[0] * self.direction[0]
            + self.direction[1] * self.direction[1]
            + self.direction[2] * self.direction[2])
            .sqrt();
        if !length.is_finite() || length <= 0.0 {
            return Err(Forge3dError::InvalidInput {
                field: "sunVisibility.direction".to_string(),
                message: "sunVisibility direction must be a finite non-zero vector".to_string(),
            });
        }
        let mut normalized = self;
        normalized.direction = [
            self.direction[0] / length,
            self.direction[1] / length,
            self.direction[2] / length,
        ];
        if normalized.mode == SunVisibilityMode::Hard {
            normalized.samples = 1;
            normalized.softness = 0.0;
        }
        Ok(normalized)
    }

    pub fn output_dimensions(&self, width: u32, height: u32) -> (u32, u32) {
        (
            (width as f32 * self.resolution_scale).round().max(1.0) as u32,
            (height as f32 * self.resolution_scale).round().max(1.0) as u32,
        )
    }
}

impl Default for SunVisibilityConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            mode: SunVisibilityMode::Hard,
            resolution_scale: 0.5,
            samples: 4,
            steps: 24,
            max_distance: 400.0,
            softness: 1.0,
            bias: 0.01,
            direction: [0.3, 0.7, 0.2],
        }
    }
}

impl TerrainHeightmapInput {
    pub fn new(width: u32, height: u32, heights: Vec<f32>) -> Result<Self> {
        Self::with_options(width, height, heights, TerrainGridOptions::default())
    }

    pub fn with_options(
        width: u32,
        height: u32,
        heights: Vec<f32>,
        options: TerrainGridOptions,
    ) -> Result<Self> {
        if width == 0 || height == 0 {
            return Err(Forge3dError::InvalidInput {
                field: "terrain.dimensions".to_string(),
                message: "terrain dimensions must be greater than zero".to_string(),
            });
        }

        let expected_len = width
            .checked_mul(height)
            .ok_or_else(|| Forge3dError::InvalidInput {
                field: "terrain.dimensions".to_string(),
                message: "terrain width * height overflows u32".to_string(),
            })? as usize;
        if heights.len() != expected_len {
            return Err(Forge3dError::InvalidInput {
                field: "terrain.heights".to_string(),
                message: format!(
                    "height length {} does not match width * height ({expected_len})",
                    heights.len()
                ),
            });
        }

        let spacing = options.spacing.unwrap_or([
            2.0 / width.saturating_sub(1).max(1) as f32,
            2.0 / height.saturating_sub(1).max(1) as f32,
        ]);
        if !spacing[0].is_finite()
            || spacing[0] <= 0.0
            || !spacing[1].is_finite()
            || spacing[1] <= 0.0
        {
            return Err(Forge3dError::InvalidInput {
                field: "terrain.spacing".to_string(),
                message: "terrain spacing must be finite and greater than zero".to_string(),
            });
        }

        let exaggeration = options.exaggeration.unwrap_or(0.7);
        if !exaggeration.is_finite() || exaggeration <= 0.0 {
            return Err(Forge3dError::InvalidInput {
                field: "terrain.exaggeration".to_string(),
                message: "terrain exaggeration must be finite and greater than zero".to_string(),
            });
        }

        if let Some(domain) = options.domain {
            if !domain[0].is_finite() || !domain[1].is_finite() || domain[0] > domain[1] {
                return Err(Forge3dError::InvalidInput {
                    field: "terrain.domain".to_string(),
                    message: "terrain domain must be finite and ordered".to_string(),
                });
            }
        }

        if let Some(crs) = &options.crs {
            if crs.is_empty() {
                return Err(Forge3dError::InvalidInput {
                    field: "terrain.crs".to_string(),
                    message: "terrain crs must be a non-empty string".to_string(),
                });
            }
        }

        if options.nodata.is_some_and(f32::is_infinite) {
            return Err(Forge3dError::InvalidInput {
                field: "terrain.nodata".to_string(),
                message: "terrain nodata must be finite or NaN".to_string(),
            });
        }

        let mut min_height = f32::INFINITY;
        let mut max_height = f32::NEG_INFINITY;
        let mut valid_count = 0usize;
        for &value in &heights {
            if value.is_infinite() {
                return Err(Forge3dError::InvalidInput {
                    field: "terrain.heights".to_string(),
                    message: "terrain height values must be finite".to_string(),
                });
            }
            if Self::is_valid_sample(value, options.nodata) {
                min_height = min_height.min(value);
                max_height = max_height.max(value);
                valid_count += 1;
            }
        }
        if valid_count == 0 {
            return Err(Forge3dError::InvalidInput {
                field: "terrain.heights".to_string(),
                message: "terrain heights must contain at least one valid sample".to_string(),
            });
        }

        let requested_domain = options.domain.unwrap_or([min_height, max_height]);
        let domain = if requested_domain[0] == requested_domain[1] {
            [requested_domain[0] - 0.5, requested_domain[1] + 0.5]
        } else {
            requested_domain
        };

        Ok(Self {
            width,
            height,
            heights,
            min_height,
            max_height,
            spacing,
            exaggeration,
            domain,
            nodata: options.nodata,
            crs: options.crs,
        })
    }

    pub fn is_valid_sample(value: f32, nodata: Option<f32>) -> bool {
        if !value.is_finite() {
            return false;
        }
        if let Some(marker) = nodata {
            if !marker.is_nan() && value == marker {
                return false;
            }
        }
        true
    }

    pub fn sample(&self, x: u32, y: u32) -> f32 {
        self.heights[y as usize * self.width as usize + x as usize]
    }

    pub fn is_valid(&self, x: u32, y: u32) -> bool {
        Self::is_valid_sample(self.sample(x, y), self.nodata)
    }

    pub fn sample_count(&self) -> usize {
        self.heights.len()
    }

    pub fn mesh_descriptor(&self) -> Result<TerrainMeshDescriptor> {
        if self.width < 2 {
            return Err(Forge3dError::InvalidInput {
                field: "terrain.width".to_string(),
                message: "terrain width must be at least 2 to draw a mesh".to_string(),
            });
        }
        if self.height < 2 {
            return Err(Forge3dError::InvalidInput {
                field: "terrain.height".to_string(),
                message: "terrain height must be at least 2 to draw a mesh".to_string(),
            });
        }

        let width = self.width as usize;
        let height = self.height as usize;
        let spacing_x = self.spacing[0];
        let spacing_z = self.spacing[1];
        let half_x = (self.width - 1) as f32 * spacing_x * 0.5;
        let half_z = (self.height - 1) as f32 * spacing_z * 0.5;
        let mut vertices = Vec::with_capacity(width * height);
        for y in 0..height {
            let v = y as f32 / (height - 1) as f32;
            let pz = y as f32 * spacing_z - half_z;
            for x in 0..width {
                let u = x as f32 / (width - 1) as f32;
                let px = x as f32 * spacing_x - half_x;
                vertices.push(TerrainMeshVertex {
                    position: [px, 0.0, pz],
                    uv: [u, v],
                });
            }
        }

        let index_capacity = (width - 1)
            .checked_mul(height - 1)
            .and_then(|count| count.checked_mul(6))
            .ok_or_else(|| Forge3dError::InvalidInput {
                field: "terrain".to_string(),
                message: "terrain mesh index count overflowed".to_string(),
            })?;
        if index_capacity > u32::MAX as usize {
            return Err(Forge3dError::InvalidInput {
                field: "terrain".to_string(),
                message: "terrain mesh is too large for u32 indices".to_string(),
            });
        }

        let mut indices = Vec::with_capacity(index_capacity);
        for y in 0..(height - 1) {
            for x in 0..(width - 1) {
                let top_left = (y * width + x) as u32;
                let top_right = top_left + 1;
                let bottom_left = top_left + width as u32;
                let bottom_right = bottom_left + 1;
                indices.extend_from_slice(&[
                    top_left,
                    bottom_left,
                    top_right,
                    top_right,
                    bottom_left,
                    bottom_right,
                ]);
            }
        }

        Ok(TerrainMeshDescriptor { vertices, indices })
    }

    fn world_height(&self, x: u32, y: u32) -> f32 {
        (self.sample(x, y) - self.domain[0]) * self.exaggeration
    }

    fn world_height_at_uv(&self, u: f32, v: f32) -> Option<f32> {
        let x = ((u * self.width as f32).trunc() as i64).clamp(0, self.width as i64 - 1) as u32;
        let y = ((v * self.height as f32).trunc() as i64).clamp(0, self.height as i64 - 1) as u32;
        if self.is_valid(x, y) {
            Some(self.world_height(x, y))
        } else {
            None
        }
    }

    fn gradient_at(&self, x: u32, y: u32) -> [f32; 2] {
        let center = self.sample(x, y);
        let xm = x.saturating_sub(1);
        let xp = (x + 1).min(self.width - 1);
        let ym = y.saturating_sub(1);
        let yp = (y + 1).min(self.height - 1);
        let left = if self.is_valid(xm, y) {
            self.sample(xm, y)
        } else {
            center
        };
        let right = if self.is_valid(xp, y) {
            self.sample(xp, y)
        } else {
            center
        };
        let below = if self.is_valid(x, ym) {
            self.sample(x, ym)
        } else {
            center
        };
        let above = if self.is_valid(x, yp) {
            self.sample(x, yp)
        } else {
            center
        };
        let dzdx = if xp == xm {
            0.0
        } else {
            (right - left) / ((xp - xm) as f32 * self.spacing[0]) * self.exaggeration
        };
        let dzdz = if yp == ym {
            0.0
        } else {
            (above - below) / ((yp - ym) as f32 * self.spacing[1]) * self.exaggeration
        };
        [dzdx, dzdz]
    }

    pub fn slope_aspect(&self) -> TerrainSlopeAspect {
        let count = self.width as usize * self.height as usize;
        let mut slope = vec![f32::NAN; count];
        let mut aspect = vec![f32::NAN; count];
        for y in 0..self.height {
            for x in 0..self.width {
                if !self.is_valid(x, y) {
                    continue;
                }
                let [dzdx, dzdz] = self.gradient_at(x, y);
                let index = y as usize * self.width as usize + x as usize;
                slope[index] = (dzdx * dzdx + dzdz * dzdz).sqrt().atan();
                aspect[index] = downslope_aspect(dzdx, dzdz);
            }
        }
        TerrainSlopeAspect {
            width: self.width,
            height: self.height,
            slope_radians: slope,
            aspect_radians: aspect,
        }
    }

    pub fn contours(&self, levels: &[f32]) -> Result<TerrainContours> {
        if levels.is_empty() {
            return Err(Forge3dError::InvalidInput {
                field: "terrain.contourLevels".to_string(),
                message: "contour levels must not be empty".to_string(),
            });
        }
        for &level in levels {
            if !level.is_finite() {
                return Err(Forge3dError::InvalidInput {
                    field: "terrain.contourLevels".to_string(),
                    message: "contour levels must be finite".to_string(),
                });
            }
        }
        if self.width < 2 || self.height < 2 {
            return Err(Forge3dError::InvalidInput {
                field: "terrain.dimensions".to_string(),
                message: "terrain dimensions must be at least 2 to extract contours".to_string(),
            });
        }

        let mut contours = TerrainContours::default();
        let half_x = (self.width - 1) as f32 * self.spacing[0] * 0.5;
        let half_z = (self.height - 1) as f32 * self.spacing[1] * 0.5;
        let to_physical = |x: f32, y: f32| -> [f32; 2] {
            [x * self.spacing[0] - half_x, y * self.spacing[1] - half_z]
        };
        // Corners: 0 = (x,y), 1 = (x+1,y), 2 = (x+1,y+1), 3 = (x,y+1).
        const CORNER_X: [f32; 4] = [0.0, 1.0, 1.0, 0.0];
        const CORNER_Y: [f32; 4] = [0.0, 0.0, 1.0, 1.0];

        for &level in levels {
            for y in 0..self.height - 1 {
                for x in 0..self.width - 1 {
                    let corners = [
                        self.sample(x, y),
                        self.sample(x + 1, y),
                        self.sample(x + 1, y + 1),
                        self.sample(x, y + 1),
                    ];
                    if !self.is_valid(x, y)
                        || !self.is_valid(x + 1, y)
                        || !self.is_valid(x + 1, y + 1)
                        || !self.is_valid(x, y + 1)
                    {
                        continue;
                    }
                    let case = corners
                        .iter()
                        .enumerate()
                        .fold(0u8, |acc, (i, &h)| acc | (u8::from(h >= level) << i));
                    if case == 0 || case == 15 {
                        continue;
                    }
                    let edge = |a: usize, b: usize| -> [f32; 2] {
                        let denominator = corners[b] - corners[a];
                        let t = if denominator == 0.0 {
                            0.5
                        } else {
                            (level - corners[a]) / denominator
                        };
                        let gx = x as f32 + CORNER_X[a] + (CORNER_X[b] - CORNER_X[a]) * t;
                        let gy = y as f32 + CORNER_Y[a] + (CORNER_Y[b] - CORNER_Y[a]) * t;
                        to_physical(gx, gy)
                    };
                    let push_segment =
                        |contours: &mut TerrainContours, a: [f32; 2], b: [f32; 2]| {
                            contours.polylines.push(TerrainContourPolyline {
                                level,
                                points: vec![a[0], a[1], b[0], b[1]],
                            });
                        };
                    match case {
                        1 | 14 => push_segment(&mut contours, edge(0, 3), edge(0, 1)),
                        2 | 13 => push_segment(&mut contours, edge(0, 1), edge(1, 2)),
                        3 | 12 => push_segment(&mut contours, edge(0, 3), edge(1, 2)),
                        4 | 11 => push_segment(&mut contours, edge(1, 2), edge(3, 2)),
                        6 | 9 => push_segment(&mut contours, edge(0, 1), edge(3, 2)),
                        7 | 8 => push_segment(&mut contours, edge(0, 3), edge(3, 2)),
                        5 => {
                            let determinant = (corners[0] - level) * (corners[2] - level)
                                - (corners[1] - level) * (corners[3] - level);
                            if determinant >= 0.0 {
                                push_segment(&mut contours, edge(0, 1), edge(1, 2));
                                push_segment(&mut contours, edge(0, 3), edge(3, 2));
                            } else {
                                push_segment(&mut contours, edge(0, 3), edge(0, 1));
                                push_segment(&mut contours, edge(1, 2), edge(3, 2));
                            }
                        }
                        10 => {
                            let determinant = (corners[0] - level) * (corners[2] - level)
                                - (corners[1] - level) * (corners[3] - level);
                            if determinant <= 0.0 {
                                push_segment(&mut contours, edge(0, 3), edge(0, 1));
                                push_segment(&mut contours, edge(1, 2), edge(3, 2));
                            } else {
                                push_segment(&mut contours, edge(0, 1), edge(1, 2));
                                push_segment(&mut contours, edge(0, 3), edge(3, 2));
                            }
                        }
                        _ => {}
                    }
                }
            }
        }
        Ok(contours)
    }

    pub fn query(&self, x: f32, z: f32) -> Option<TerrainQuerySample> {
        if !x.is_finite() || !z.is_finite() || self.width < 2 || self.height < 2 {
            return None;
        }
        let gx = x / self.spacing[0] + (self.width - 1) as f32 * 0.5;
        let gz = z / self.spacing[1] + (self.height - 1) as f32 * 0.5;
        if gx < 0.0 || gx > (self.width - 1) as f32 || gz < 0.0 || gz > (self.height - 1) as f32 {
            return None;
        }

        let x0 = (gx.floor() as i64).clamp(0, self.width as i64 - 2) as u32;
        let y0 = (gz.floor() as i64).clamp(0, self.height as i64 - 2) as u32;
        let x1 = x0 + 1;
        let y1 = y0 + 1;
        let fx = gx - x0 as f32;
        let fz = gz - y0 as f32;

        let h00 = self.sample(x0, y0);
        let h10 = self.sample(x1, y0);
        let h01 = self.sample(x0, y1);
        let h11 = self.sample(x1, y1);
        let all_valid = self.is_valid(x0, y0)
            && self.is_valid(x1, y0)
            && self.is_valid(x0, y1)
            && self.is_valid(x1, y1);
        if !all_valid {
            return Some(TerrainQuerySample {
                elevation: f32::NAN,
                slope_radians: f32::NAN,
                aspect_radians: f32::NAN,
                world_position: [x, f32::NAN, z],
                normal: [f32::NAN; 3],
                grid_position: [gx, gz],
            });
        }

        let elevation = h00 * (1.0 - fx) * (1.0 - fz)
            + h10 * fx * (1.0 - fz)
            + h01 * (1.0 - fx) * fz
            + h11 * fx * fz;
        let dhdx =
            ((h10 - h00) * (1.0 - fz) + (h11 - h01) * fz) / self.spacing[0] * self.exaggeration;
        let dhdz =
            ((h01 - h00) * (1.0 - fx) + (h11 - h10) * fx) / self.spacing[1] * self.exaggeration;
        let slope = (dhdx * dhdx + dhdz * dhdz).sqrt().atan();
        let aspect = downslope_aspect(dhdx, dhdz);
        let normal = normalize3([-dhdx, 1.0, -dhdz]);
        Some(TerrainQuerySample {
            elevation,
            slope_radians: slope,
            aspect_radians: aspect,
            world_position: [x, (elevation - self.domain[0]) * self.exaggeration, z],
            normal,
            grid_position: [gx, gz],
        })
    }

    pub fn height_ao(&self, config: &HeightfieldAoConfig) -> Result<Vec<f32>> {
        let config = config.validate()?;
        let (out_w, out_h) = config.output_dimensions(self.width, self.height);
        let mut output = vec![1.0f32; out_w as usize * out_h as usize];
        if !config.enabled {
            return Ok(output);
        }
        let extent = [
            self.spacing[0] * self.width as f32,
            self.spacing[1] * self.height as f32,
        ];
        let max_uv = config.max_distance / extent[0].max(extent[1]);
        let step_uv = max_uv / config.steps as f32;

        for py in 0..out_h {
            for px in 0..out_w {
                let uv = [
                    (px as f32 + 0.5) / out_w as f32,
                    (py as f32 + 0.5) / out_h as f32,
                ];
                let Some(center) = self.world_height_at_uv(uv[0], uv[1]) else {
                    output[py as usize * out_w as usize + px as usize] = f32::NAN;
                    continue;
                };
                let mut occlusion = 0.0f32;
                for direction in 0..config.directions {
                    let angle = TWO_PI * direction as f32 / config.directions as f32;
                    let dir = [angle.cos(), angle.sin()];
                    let mut max_tan = -999.0f32;
                    for step in 1..=config.steps {
                        let suv = [
                            uv[0] + dir[0] * step_uv * step as f32,
                            uv[1] + dir[1] * step_uv * step as f32,
                        ];
                        if suv[0] < 0.0 || suv[0] >= 1.0 || suv[1] < 0.0 || suv[1] >= 1.0 {
                            break;
                        }
                        let Some(sample) = self.world_height_at_uv(suv[0], suv[1]) else {
                            continue;
                        };
                        let dx = (suv[0] - uv[0]) * extent[0];
                        let dy = (suv[1] - uv[1]) * extent[1];
                        let distance = (dx * dx + dy * dy).sqrt();
                        if distance > 0.001 {
                            max_tan = max_tan.max((sample - center) / distance);
                        }
                    }
                    if max_tan > -999.0 {
                        occlusion += (max_tan.atan() / std::f32::consts::FRAC_PI_2).clamp(0.0, 1.0);
                    }
                }
                let ao = 1.0 - occlusion / config.directions as f32;
                output[py as usize * out_w as usize + px as usize] =
                    1.0 + (ao - 1.0) * config.strength;
            }
        }
        Ok(output)
    }

    pub fn sun_visibility(&self, config: &SunVisibilityConfig) -> Result<Vec<f32>> {
        let config = config.validate()?;
        let (out_w, out_h) = config.output_dimensions(self.width, self.height);
        let mut output = vec![1.0f32; out_w as usize * out_h as usize];
        if !config.enabled {
            return Ok(output);
        }
        let direction = config.direction;
        let horizontal = [direction[0], direction[2]];
        let horizontal_length =
            (horizontal[0] * horizontal[0] + horizontal[1] * horizontal[1]).sqrt();
        if horizontal_length < 0.001 {
            return Ok(output);
        }
        let march_dir = [
            horizontal[0] / horizontal_length,
            horizontal[1] / horizontal_length,
        ];
        let sun_tan = direction[1] / horizontal_length;
        let extent = [
            self.spacing[0] * self.width as f32,
            self.spacing[1] * self.height as f32,
        ];
        let max_uv = config.max_distance / extent[0].max(extent[1]);
        let step_uv = max_uv / config.steps as f32;
        let soft = config.softness > 0.0;

        for py in 0..out_h {
            for px in 0..out_w {
                let uv = [
                    (px as f32 + 0.5) / out_w as f32,
                    (py as f32 + 0.5) / out_h as f32,
                ];
                let Some(center) = self.world_height_at_uv(uv[0], uv[1]) else {
                    output[py as usize * out_w as usize + px as usize] = f32::NAN;
                    continue;
                };
                let mut total = 0.0f32;
                for sample_index in 0..config.samples {
                    let jitter = (sample_index as f32 - (config.samples as f32 - 1.0) * 0.5) * 0.1;
                    let jittered = [march_dir[0] + jitter, march_dir[1] - jitter];
                    let jittered_length =
                        (jittered[0] * jittered[0] + jittered[1] * jittered[1]).sqrt();
                    let jittered = [jittered[0] / jittered_length, jittered[1] / jittered_length];
                    let mut visibility = 1.0f32;
                    let mut occlusion = 0.0f32;
                    for step in 1..=config.steps {
                        let suv = [
                            uv[0] + jittered[0] * step_uv * step as f32,
                            uv[1] + jittered[1] * step_uv * step as f32,
                        ];
                        if suv[0] < 0.0 || suv[0] >= 1.0 || suv[1] < 0.0 || suv[1] >= 1.0 {
                            break;
                        }
                        let Some(sample) = self.world_height_at_uv(suv[0], suv[1]) else {
                            continue;
                        };
                        let dx = (suv[0] - uv[0]) * extent[0];
                        let dy = (suv[1] - uv[1]) * extent[1];
                        let distance = (dx * dx + dy * dy).sqrt();
                        if distance <= 0.001 {
                            continue;
                        }
                        let expected = center + config.bias + distance * sun_tan;
                        let diff = sample - expected;
                        if diff > 0.0 {
                            if soft {
                                let t = (diff / config.softness).clamp(0.0, 1.0);
                                occlusion = occlusion.max(t * t * (3.0 - 2.0 * t));
                            } else {
                                visibility = 0.0;
                                break;
                            }
                        }
                    }
                    if soft {
                        visibility = 1.0 - occlusion;
                    }
                    total += visibility;
                }
                output[py as usize * out_w as usize + px as usize] = total / config.samples as f32;
            }
        }
        Ok(output)
    }
}

fn downslope_aspect(dzdx: f32, dzdz: f32) -> f32 {
    if dzdx == 0.0 && dzdz == 0.0 {
        return 0.0;
    }
    let angle = (-dzdx).atan2(-dzdz);
    if angle < 0.0 {
        angle + TWO_PI
    } else {
        angle
    }
}

fn normalize3(v: [f32; 3]) -> [f32; 3] {
    let length = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
    [v[0] / length, v[1] / length, v[2] / length]
}

#[cfg(test)]
mod tests {
    use super::{
        HeightfieldAoConfig, SunVisibilityConfig, SunVisibilityMode, TerrainGridOptions,
        TerrainHeightmapInput,
    };

    const TWO_PI_T: f32 = std::f32::consts::TAU;

    #[test]
    fn terrain_heightmap_computes_min_max() {
        let input = TerrainHeightmapInput::new(2, 2, vec![0.25, -1.0, 0.5, 2.0]).unwrap();

        assert_eq!(input.sample_count(), 4);
        assert_eq!(input.min_height, -1.0);
        assert_eq!(input.max_height, 2.0);
    }

    #[test]
    fn terrain_heightmap_rejects_length_mismatch() {
        let error = TerrainHeightmapInput::new(2, 3, vec![0.0; 5]).unwrap_err();

        assert!(error.to_string().contains("width * height"));
    }

    #[test]
    fn terrain_heightmap_excludes_nodata_and_nan_from_min_max() {
        let input = TerrainHeightmapInput::with_options(
            3,
            2,
            vec![0.0, f32::NAN, 4.0, -9999.0, 1.0, 2.0],
            TerrainGridOptions {
                nodata: Some(-9999.0),
                ..TerrainGridOptions::default()
            },
        )
        .unwrap();

        assert_eq!(input.min_height, 0.0);
        assert_eq!(input.max_height, 4.0);
    }

    #[test]
    fn terrain_heightmap_rejects_non_finite_samples() {
        let error = TerrainHeightmapInput::new(2, 1, vec![0.0, f32::INFINITY]).unwrap_err();

        assert!(error.to_string().contains("finite"));
    }

    #[test]
    fn terrain_heightmap_rejects_no_valid_samples() {
        let error = TerrainHeightmapInput::with_options(
            2,
            2,
            vec![f32::NAN, f32::NAN, -9999.0, f32::NAN],
            TerrainGridOptions {
                nodata: Some(-9999.0),
                ..TerrainGridOptions::default()
            },
        )
        .unwrap_err();

        assert!(error.to_string().contains("valid"));
    }

    #[test]
    fn terrain_heightmap_rejects_invalid_metadata() {
        let spacing_error = TerrainHeightmapInput::with_options(
            2,
            2,
            vec![0.0; 4],
            TerrainGridOptions {
                spacing: Some([0.0, 1.0]),
                ..TerrainGridOptions::default()
            },
        )
        .unwrap_err();
        assert!(spacing_error.to_string().contains("spacing"));

        let domain_error = TerrainHeightmapInput::with_options(
            2,
            2,
            vec![0.0; 4],
            TerrainGridOptions {
                domain: Some([3.0, -1.0]),
                ..TerrainGridOptions::default()
            },
        )
        .unwrap_err();
        assert!(domain_error.to_string().contains("domain"));

        let exaggeration_error = TerrainHeightmapInput::with_options(
            2,
            2,
            vec![0.0; 4],
            TerrainGridOptions {
                exaggeration: Some(f32::NAN),
                ..TerrainGridOptions::default()
            },
        )
        .unwrap_err();
        assert!(exaggeration_error.to_string().contains("exaggeration"));
    }

    #[test]
    fn terrain_heightmap_rejects_infinite_nodata() {
        for marker in [f32::INFINITY, f32::NEG_INFINITY] {
            let error = TerrainHeightmapInput::with_options(
                2,
                2,
                vec![1.0, 2.0, 3.0, 4.0],
                TerrainGridOptions {
                    nodata: Some(marker),
                    ..TerrainGridOptions::default()
                },
            )
            .unwrap_err();
            assert!(error.to_string().contains("nodata"));
        }

        let input = TerrainHeightmapInput::with_options(
            2,
            2,
            vec![1.0, 2.0, 3.0, f32::NAN],
            TerrainGridOptions {
                nodata: Some(f32::NAN),
                ..TerrainGridOptions::default()
            },
        )
        .unwrap();
        assert_eq!(input.min_height, 1.0);
        assert_eq!(input.max_height, 3.0);
    }

    #[test]
    fn terrain_heightmap_defaults_to_legacy_normalized_extent() {
        let input = TerrainHeightmapInput::new(3, 3, vec![0.0; 9]).unwrap();

        assert_eq!(input.spacing[0], 1.0);
        assert_eq!(input.spacing[1], 1.0);
        assert_eq!(input.exaggeration, 0.7);
    }

    #[test]
    fn terrain_mesh_descriptor_builds_normalized_grid() {
        let input = TerrainHeightmapInput::new(2, 2, vec![0.0; 4]).unwrap();
        let mesh = input.mesh_descriptor().unwrap();

        assert_eq!(mesh.vertices.len(), 4);
        assert_eq!(mesh.indices, vec![0, 2, 1, 1, 2, 3]);
        assert_eq!(mesh.vertices[0].position, [-1.0, 0.0, -1.0]);
        assert_eq!(mesh.vertices[0].uv, [0.0, 0.0]);
        assert_eq!(mesh.vertices[3].position, [1.0, 0.0, 1.0]);
        assert_eq!(mesh.vertices[3].uv, [1.0, 1.0]);
    }

    #[test]
    fn terrain_mesh_descriptor_uses_physical_spacing() {
        let input = TerrainHeightmapInput::with_options(
            3,
            2,
            vec![0.0; 6],
            TerrainGridOptions {
                spacing: Some([30.0, 20.0]),
                ..TerrainGridOptions::default()
            },
        )
        .unwrap();
        let mesh = input.mesh_descriptor().unwrap();

        assert_eq!(mesh.vertices[0].position, [-30.0, 0.0, -10.0]);
        assert_eq!(mesh.vertices[5].position, [30.0, 0.0, 10.0]);
        assert_eq!(mesh.vertices[0].uv, [0.0, 0.0]);
        assert_eq!(mesh.vertices[5].uv, [1.0, 1.0]);
        assert_eq!(&mesh.indices[0..6], &[0, 3, 1, 1, 3, 4]);
    }

    #[test]
    fn terrain_mesh_descriptor_rejects_single_cell() {
        let input = TerrainHeightmapInput::new(1, 1, vec![0.0]).unwrap();

        assert!(input.mesh_descriptor().is_err());
    }

    fn plane_input(width: u32, height: u32, spacing: [f32; 2]) -> TerrainHeightmapInput {
        let mut heights = Vec::with_capacity((width * height) as usize);
        for y in 0..height {
            for x in 0..width {
                let xw = x as f32 * spacing[0];
                let zw = y as f32 * spacing[1];
                heights.push(2.0 * xw + 3.0 * zw + 7.0);
            }
        }
        TerrainHeightmapInput::with_options(
            width,
            height,
            heights,
            TerrainGridOptions {
                spacing: Some(spacing),
                exaggeration: Some(1.0),
                ..TerrainGridOptions::default()
            },
        )
        .unwrap()
    }

    fn wrapped_angle_difference(a: f32, b: f32) -> f32 {
        let mut diff = (a - b).abs() % TWO_PI_T;
        if diff > std::f32::consts::PI {
            diff = TWO_PI_T - diff;
        }
        diff
    }

    fn plane_aspect() -> f32 {
        let a = (-2.0f32).atan2(-3.0f32);
        if a < 0.0 {
            a + TWO_PI_T
        } else {
            a
        }
    }

    #[test]
    fn terrain_slope_aspect_matches_analytic_plane() {
        let input = plane_input(9, 7, [30.0, 20.0]);
        let result = input.slope_aspect();
        let expected_slope = (13.0f32).sqrt().atan();

        for index in 0..result.slope_radians.len() {
            assert!(
                (result.slope_radians[index] - expected_slope).abs() < 1e-4,
                "slope {index} = {}",
                result.slope_radians[index]
            );
            assert!(
                wrapped_angle_difference(result.aspect_radians[index], plane_aspect()) < 1e-4,
                "aspect {index} = {}",
                result.aspect_radians[index]
            );
        }
    }

    #[test]
    fn terrain_slope_aspect_handles_nodata_center() {
        let mut heights = vec![0.0f32; 25];
        heights[2 * 5 + 2] = f32::NAN;
        let input = TerrainHeightmapInput::with_options(
            5,
            5,
            heights,
            TerrainGridOptions {
                spacing: Some([1.0, 1.0]),
                exaggeration: Some(1.0),
                ..TerrainGridOptions::default()
            },
        )
        .unwrap();
        let result = input.slope_aspect();

        assert!(result.slope_radians[2 * 5 + 2].is_nan());
        assert!(result.aspect_radians[2 * 5 + 2].is_nan());
        assert!(result.slope_radians[2 * 5 + 1].is_finite());
        assert!(result.aspect_radians[2 * 5 + 3].is_finite());
    }

    #[test]
    fn terrain_contours_follow_linear_ramp() {
        let width = 9u32;
        let height = 9u32;
        let mut heights = Vec::new();
        for _y in 0..height {
            for x in 0..width {
                heights.push(x as f32);
            }
        }
        let input = TerrainHeightmapInput::with_options(
            width,
            height,
            heights,
            TerrainGridOptions {
                spacing: Some([1.0, 1.0]),
                exaggeration: Some(1.0),
                ..TerrainGridOptions::default()
            },
        )
        .unwrap();
        let contours = input.contours(&[3.5]).unwrap();

        assert!(!contours.polylines.is_empty());
        for polyline in &contours.polylines {
            assert_eq!(polyline.level, 3.5);
            for point in polyline.points.chunks_exact(2) {
                assert!(
                    (point[0] + 0.5).abs() < 0.25,
                    "contour point {:?} off the level line",
                    point
                );
            }
        }
    }

    #[test]
    fn terrain_contours_reject_invalid_levels() {
        let input = TerrainHeightmapInput::new(3, 3, vec![0.0; 9]).unwrap();

        assert!(input.contours(&[]).is_err());
        assert!(input.contours(&[f32::NAN]).is_err());
        assert!(input.contours(&[f32::INFINITY]).is_err());
    }

    #[test]
    fn terrain_query_reproduces_plane() {
        let input = plane_input(9, 7, [30.0, 20.0]);
        let query = input.query(12.0, -20.0).unwrap();

        let expected_elevation = 2.0 * (12.0 + 120.0) + 3.0 * (-20.0 + 60.0) + 7.0;
        let relative = (query.elevation - expected_elevation).abs() / expected_elevation;
        assert!(relative < 1e-6, "elevation {}", query.elevation);
        assert!((query.slope_radians - (13.0f32).sqrt().atan()).abs() < 1e-4);
        assert!(wrapped_angle_difference(query.aspect_radians, plane_aspect()) < 1e-4);
        assert!((query.grid_position[0] - (12.0 + 120.0) / 30.0).abs() < 1e-4);
        let normal_length = (query.normal[0] * query.normal[0]
            + query.normal[1] * query.normal[1]
            + query.normal[2] * query.normal[2])
            .sqrt();
        assert!((normal_length - 1.0).abs() < 1e-6);
        assert!(input.query(-200.0, 0.0).is_none());
        assert!(input.query(0.0, 200.0).is_none());
    }

    #[test]
    fn terrain_flat_ao_and_sun_are_fully_visible() {
        let input = TerrainHeightmapInput::with_options(
            8,
            8,
            vec![1.0; 64],
            TerrainGridOptions {
                spacing: Some([1.0, 1.0]),
                exaggeration: Some(1.0),
                ..TerrainGridOptions::default()
            },
        )
        .unwrap();

        let ao = input
            .height_ao(&HeightfieldAoConfig {
                enabled: true,
                resolution_scale: 1.0,
                directions: 8,
                steps: 8,
                max_distance: 8.0,
                strength: 1.0,
            })
            .unwrap();
        assert!(ao.iter().all(|&v| (v - 1.0).abs() <= f32::EPSILON));

        let sun = input
            .sun_visibility(&SunVisibilityConfig {
                enabled: true,
                mode: SunVisibilityMode::Hard,
                resolution_scale: 1.0,
                samples: 1,
                steps: 8,
                max_distance: 8.0,
                softness: 0.0,
                bias: 0.001,
                direction: [1.0, 0.35, 0.0],
            })
            .unwrap();
        assert!(sun.iter().all(|&v| (v - 1.0).abs() <= f32::EPSILON));
    }

    #[test]
    fn terrain_valley_is_occluded_by_ao_and_sun() {
        let mut heights = Vec::new();
        for _y in 0..9 {
            for x in 0..9 {
                heights.push((x as f32 - 4.0).abs() * 4.0);
            }
        }
        let input = TerrainHeightmapInput::with_options(
            9,
            9,
            heights,
            TerrainGridOptions {
                spacing: Some([1.0, 1.0]),
                exaggeration: Some(1.0),
                ..TerrainGridOptions::default()
            },
        )
        .unwrap();

        let ao = input
            .height_ao(&HeightfieldAoConfig {
                enabled: true,
                resolution_scale: 1.0,
                directions: 8,
                steps: 8,
                max_distance: 8.0,
                strength: 1.0,
            })
            .unwrap();
        assert!(ao.iter().any(|&v| v < 0.98), "valley AO must be occluded");

        let sun = input
            .sun_visibility(&SunVisibilityConfig {
                enabled: true,
                mode: SunVisibilityMode::Hard,
                resolution_scale: 1.0,
                samples: 1,
                steps: 8,
                max_distance: 8.0,
                softness: 0.0,
                bias: 0.001,
                direction: [1.0, 0.35, 0.0],
            })
            .unwrap();
        assert!(
            sun.iter().any(|&v| v < 0.98),
            "sun visibility must be shadowed"
        );
    }

    #[test]
    fn terrain_analysis_disabled_modes_return_full_visibility() {
        let input = TerrainHeightmapInput::new(4, 4, vec![1.0; 16]).unwrap();

        let ao = input.height_ao(&HeightfieldAoConfig::default()).unwrap();
        assert!(ao.iter().all(|&v| v == 1.0));
        let sun = input
            .sun_visibility(&SunVisibilityConfig::default())
            .unwrap();
        assert!(sun.iter().all(|&v| v == 1.0));
    }

    #[test]
    fn terrain_analysis_methods_reject_invalid_configs() {
        let input = TerrainHeightmapInput::new(4, 4, vec![1.0; 16]).unwrap();

        assert!(input
            .height_ao(&HeightfieldAoConfig {
                directions: 0,
                ..HeightfieldAoConfig::default()
            })
            .is_err());
        assert!(input
            .height_ao(&HeightfieldAoConfig {
                strength: 3.0,
                ..HeightfieldAoConfig::default()
            })
            .is_err());
        assert!(input
            .sun_visibility(&SunVisibilityConfig {
                samples: 0,
                ..SunVisibilityConfig::default()
            })
            .is_err());
        assert!(input
            .sun_visibility(&SunVisibilityConfig {
                softness: -1.0,
                ..SunVisibilityConfig::default()
            })
            .is_err());
        assert!(input
            .sun_visibility(&SunVisibilityConfig {
                direction: [0.0, 0.0, 0.0],
                ..SunVisibilityConfig::default()
            })
            .is_err());
    }

    #[test]
    fn terrain_analysis_config_validation() {
        assert!(HeightfieldAoConfig {
            enabled: true,
            resolution_scale: 0.05,
            ..HeightfieldAoConfig::default()
        }
        .validate()
        .is_err());
        assert!(HeightfieldAoConfig {
            enabled: true,
            directions: 17,
            ..HeightfieldAoConfig::default()
        }
        .validate()
        .is_err());
        assert!(HeightfieldAoConfig {
            enabled: true,
            steps: 0,
            ..HeightfieldAoConfig::default()
        }
        .validate()
        .is_err());
        assert!(HeightfieldAoConfig {
            enabled: true,
            max_distance: 0.0,
            ..HeightfieldAoConfig::default()
        }
        .validate()
        .is_err());
        assert!(HeightfieldAoConfig {
            enabled: true,
            strength: 3.0,
            ..HeightfieldAoConfig::default()
        }
        .validate()
        .is_err());
        assert!(HeightfieldAoConfig::default().validate().is_ok());

        assert!(SunVisibilityConfig {
            enabled: true,
            mode: SunVisibilityMode::Soft,
            samples: 0,
            ..SunVisibilityConfig::default()
        }
        .validate()
        .is_err());
        assert!(SunVisibilityConfig {
            enabled: true,
            mode: SunVisibilityMode::Soft,
            softness: -1.0,
            ..SunVisibilityConfig::default()
        }
        .validate()
        .is_err());
        assert!(SunVisibilityConfig {
            enabled: true,
            bias: -0.5,
            ..SunVisibilityConfig::default()
        }
        .validate()
        .is_err());
        assert!(SunVisibilityConfig {
            enabled: true,
            direction: [0.0, 0.0, 0.0],
            ..SunVisibilityConfig::default()
        }
        .validate()
        .is_err());

        assert!(SunVisibilityConfig {
            enabled: true,
            mode: SunVisibilityMode::Hard,
            samples: 0,
            ..SunVisibilityConfig::default()
        }
        .validate()
        .is_err());
        assert!(SunVisibilityConfig {
            enabled: true,
            mode: SunVisibilityMode::Hard,
            samples: 17,
            ..SunVisibilityConfig::default()
        }
        .validate()
        .is_err());
        assert!(SunVisibilityConfig {
            enabled: true,
            mode: SunVisibilityMode::Hard,
            softness: -1.0,
            ..SunVisibilityConfig::default()
        }
        .validate()
        .is_err());
        assert!(SunVisibilityConfig {
            enabled: true,
            mode: SunVisibilityMode::Hard,
            softness: f32::NAN,
            ..SunVisibilityConfig::default()
        }
        .validate()
        .is_err());

        let hard = SunVisibilityConfig {
            enabled: true,
            mode: SunVisibilityMode::Hard,
            samples: 9,
            softness: 7.0,
            direction: [3.0, 0.0, 4.0],
            ..SunVisibilityConfig::default()
        }
        .validate()
        .unwrap();
        assert_eq!(hard.samples, 1);
        assert_eq!(hard.softness, 0.0);
        assert!((hard.direction[0] - 0.6).abs() < 1e-6);
        assert!((hard.direction[2] - 0.8).abs() < 1e-6);
    }

    #[test]
    fn terrain_slope_aspect_handles_single_axis_dimensions() {
        let single = TerrainHeightmapInput::with_options(
            1,
            1,
            vec![3.0],
            TerrainGridOptions {
                spacing: Some([2.0, 2.0]),
                exaggeration: Some(1.0),
                ..TerrainGridOptions::default()
            },
        )
        .unwrap();
        let result = single.slope_aspect();
        assert_eq!(result.slope_radians, vec![0.0]);
        assert_eq!(result.aspect_radians, vec![0.0]);

        let column = TerrainHeightmapInput::with_options(
            1,
            3,
            vec![0.0, 2.0, 4.0],
            TerrainGridOptions {
                spacing: Some([1.0, 1.0]),
                exaggeration: Some(1.0),
                ..TerrainGridOptions::default()
            },
        )
        .unwrap();
        let result = column.slope_aspect();
        for index in 0..3 {
            assert!(result.slope_radians[index].is_finite());
            assert!(result.aspect_radians[index].is_finite());
        }
        assert!((result.slope_radians[1] - 2.0f32.atan()).abs() < 1e-4);
        assert!(result.slope_radians[0] > 0.0);
    }

    #[test]
    fn terrain_contours_uses_asymptotic_determinant() {
        let saddle_input = |heights: Vec<f32>| {
            TerrainHeightmapInput::with_options(
                2,
                2,
                heights,
                TerrainGridOptions {
                    spacing: Some([1.0, 1.0]),
                    ..TerrainGridOptions::default()
                },
            )
            .unwrap()
        };
        let endpoints = |input: &TerrainHeightmapInput| -> Vec<([f32; 2], [f32; 2])> {
            input
                .contours(&[1.0])
                .unwrap()
                .polylines
                .iter()
                .map(|polyline| {
                    (
                        [polyline.points[0], polyline.points[1]],
                        [polyline.points[2], polyline.points[3]],
                    )
                })
                .collect()
        };
        let assert_segments = |actual: Vec<([f32; 2], [f32; 2])>,
                               expected: [([f32; 2], [f32; 2]); 2]| {
            assert_eq!(actual.len(), 2);
            for (index, (a, b)) in actual.iter().enumerate() {
                let (ea, eb) = expected[index];
                assert!(
                    (a[0] - ea[0]).abs() < 1e-6
                        && (a[1] - ea[1]).abs() < 1e-6
                        && (b[0] - eb[0]).abs() < 1e-6
                        && (b[1] - eb[1]).abs() < 1e-6,
                    "segment {index}: {a:?} -> {b:?}, expected {ea:?} -> {eb:?}"
                );
            }
        };

        assert_segments(
            endpoints(&saddle_input(vec![2.0, 0.0, 0.0, 4.0])),
            [([0.0, -0.5], [0.5, -0.25]), ([-0.5, 0.0], [-0.25, 0.5])],
        );
        assert_segments(
            endpoints(&saddle_input(vec![2.0, -1.0, -1.0, 2.0])),
            [
                ([-0.5, -1.0 / 6.0], [-1.0 / 6.0, -0.5]),
                ([0.5, 1.0 / 6.0], [1.0 / 6.0, 0.5]),
            ],
        );
        assert_segments(
            endpoints(&saddle_input(vec![0.0, 2.0, 4.0, 0.0])),
            [([-0.5, -0.25], [0.0, -0.5]), ([0.5, 0.0], [0.25, 0.5])],
        );
        assert_segments(
            endpoints(&saddle_input(vec![-2.0, 2.0, 2.0, -2.0])),
            [([0.25, -0.5], [0.5, -0.25]), ([-0.5, 0.25], [-0.25, 0.5])],
        );
    }
}
