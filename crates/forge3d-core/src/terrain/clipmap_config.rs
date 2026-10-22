use super::TerrainClipmapOptions;
use crate::error::{Forge3dError, Result};
/// Configuration for clipmap terrain generation (native `ClipmapConfig`).
#[derive(Debug, Clone, PartialEq)]
pub struct ClipmapConfig {
    /// Number of LOD rings around the center block (1..=16).
    pub ring_count: u32,
    /// Ring strip width in cells; even and >= 4.
    pub ring_resolution: u32,
    /// Center block cells per side; even and >= 4.
    pub center_resolution: u32,
    /// Skirt depth in world units (finite, >= 0).
    pub skirt_depth: f32,
    /// Geo-morph blend range as a fraction of ring width, clamped to [0, 1].
    pub morph_range: f32,
}

impl Default for ClipmapConfig {
    fn default() -> Self {
        Self {
            ring_count: 4,
            ring_resolution: 64,
            center_resolution: 64,
            skirt_depth: 10.0,
            morph_range: 0.3,
        }
    }
}

fn invalid_input(field: &str, message: impl Into<String>) -> Forge3dError {
    Forge3dError::InvalidInput {
        field: field.to_string(),
        message: message.into(),
    }
}

impl ClipmapConfig {
    /// Create and validate a clipmap configuration.
    ///
    /// `morph_range` is clamped to `[0, 1]` like native `with_morph_range`;
    /// NaN is rejected.
    pub fn new(
        ring_count: u32,
        ring_resolution: u32,
        center_resolution: u32,
        skirt_depth: f32,
        morph_range: f32,
    ) -> Result<Self> {
        if morph_range.is_nan() {
            return Err(invalid_input(
                "clipmap.morph_range",
                "morph_range must not be NaN",
            ));
        }
        let config = Self {
            ring_count,
            ring_resolution,
            center_resolution,
            skirt_depth,
            morph_range: morph_range.clamp(0.0, 1.0),
        };
        config.validate()?;
        Ok(config)
    }

    /// Validate the configuration (`clipmap.*` field prefix).
    pub fn validate(&self) -> Result<()> {
        if !(1..=16).contains(&self.ring_count) {
            return Err(invalid_input(
                "clipmap.ring_count",
                format!("ring_count must be in [1, 16], got {}", self.ring_count),
            ));
        }
        if self.ring_resolution < 4 || !self.ring_resolution.is_multiple_of(2) {
            return Err(invalid_input(
                "clipmap.ring_resolution",
                format!(
                    "ring_resolution must be even and >= 4, got {}",
                    self.ring_resolution
                ),
            ));
        }
        if self.center_resolution < 4 || !self.center_resolution.is_multiple_of(2) {
            return Err(invalid_input(
                "clipmap.center_resolution",
                format!(
                    "center_resolution must be even and >= 4, got {}",
                    self.center_resolution
                ),
            ));
        }
        if !self.skirt_depth.is_finite() || self.skirt_depth < 0.0 {
            return Err(invalid_input(
                "clipmap.skirt_depth",
                format!(
                    "skirt_depth must be finite and >= 0, got {}",
                    self.skirt_depth
                ),
            ));
        }
        Ok(())
    }

    /// Center block half extent in level-0 grid units (`Hc`).
    pub fn center_half_units(&self) -> i32 {
        (self.center_resolution / 2) as i32
    }

    /// Outer half extent of `ring` in that ring's cells (`M_r`).
    ///
    /// Ring 0: `M0 = Hc + R` rounded up to even. Ring r >= 1:
    /// `M_r = h_r + R` rounded up to even with `h_r = M_{r-1} / 2`.
    /// Ring width is therefore `R` or `R + 1` cells; topology is fixed.
    pub fn ring_outer_half_cells(&self, ring: u32) -> i32 {
        debug_assert!(ring < self.ring_count);
        let r = self.ring_resolution as i32;
        let mut outer = round_up_even(self.center_half_units() + r);
        for _ in 1..=ring {
            outer = round_up_even(outer / 2 + r);
        }
        outer
    }

    /// Hole half extent of `ring` in that ring's cells
    /// (`Hc` for ring 0, `M_{r-1} / 2` otherwise).
    pub fn ring_hole_half_cells(&self, ring: u32) -> i32 {
        if ring == 0 {
            self.center_half_units()
        } else {
            self.ring_outer_half_cells(ring - 1) / 2
        }
    }
}

fn round_up_even(value: i32) -> i32 {
    (value + 1) & !1
}

/// Resolved clipmap configuration (A1 defaults applied).
#[derive(Debug, Clone, PartialEq)]
pub struct TerrainClipmapGeometry {
    pub ring_count: u32,
    pub ring_resolution: u32,
    pub center_resolution: u32,
    pub skirt_depth: f32,
    pub morph_range: f32,
    /// World size of one level-0 grid unit per axis.
    pub base_cell_size: [f32; 2],
}

impl TerrainClipmapGeometry {
    pub fn resolve(options: Option<&TerrainClipmapOptions>, spacing: [f32; 2]) -> Result<Self> {
        let defaults = ClipmapConfig::default();
        let empty = TerrainClipmapOptions::default();
        let o = options.unwrap_or(&empty);
        let config = ClipmapConfig::new(
            o.ring_count.unwrap_or(defaults.ring_count),
            o.ring_resolution.unwrap_or(defaults.ring_resolution),
            o.center_resolution.unwrap_or(defaults.center_resolution),
            o.skirt_depth.unwrap_or(defaults.skirt_depth),
            o.morph_range.unwrap_or(defaults.morph_range),
        )?;
        let base_cell_size = o.base_cell_size.unwrap_or(spacing);
        if base_cell_size.iter().any(|v| !v.is_finite() || *v <= 0.) {
            return Err(invalid_input(
                "clipmap.base_cell_size",
                "base_cell_size must be finite and greater than zero",
            ));
        }
        Ok(Self {
            ring_count: config.ring_count,
            ring_resolution: config.ring_resolution,
            center_resolution: config.center_resolution,
            skirt_depth: config.skirt_depth,
            morph_range: config.morph_range,
            base_cell_size,
        })
    }
    pub fn clipmap_config(&self) -> Result<ClipmapConfig> {
        ClipmapConfig::new(
            self.ring_count,
            self.ring_resolution,
            self.center_resolution,
            self.skirt_depth,
            self.morph_range,
        )
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn omitted_explicit_and_invalid_options_share_resolution() {
        let omitted = TerrainClipmapGeometry::resolve(None, [2., 3.]).unwrap();
        let explicit = TerrainClipmapOptions {
            ring_count: Some(4),
            ring_resolution: Some(64),
            center_resolution: Some(64),
            skirt_depth: Some(10.),
            morph_range: Some(0.3),
            base_cell_size: Some([2., 3.]),
        };
        assert_eq!(
            omitted,
            TerrainClipmapGeometry::resolve(Some(&explicit), [9., 9.]).unwrap()
        );
        assert_eq!(omitted.clipmap_config().unwrap(), ClipmapConfig::default());
        let invalid = TerrainClipmapOptions {
            ring_count: Some(0),
            ..Default::default()
        };
        assert_eq!(
            TerrainClipmapGeometry::resolve(Some(&invalid), [1., 1.])
                .unwrap_err()
                .to_string(),
            ClipmapConfig::new(0, 64, 64, 10., 0.3)
                .unwrap_err()
                .to_string()
        );
    }
}
