use crate::error::{Forge3dError, Result};

#[derive(Debug, Clone, PartialEq)]
pub struct TerrainHeightmapInput {
    pub width: u32,
    pub height: u32,
    pub heights: Vec<f32>,
    pub min_height: f32,
    pub max_height: f32,
}

impl TerrainHeightmapInput {
    pub fn new(width: u32, height: u32, heights: Vec<f32>) -> Result<Self> {
        validate_dimensions(width, height, heights.len())?;

        let mut min_height = f32::INFINITY;
        let mut max_height = f32::NEG_INFINITY;
        for (index, height_value) in heights.iter().copied().enumerate() {
            if !height_value.is_finite() {
                return Err(Forge3dError::InvalidInput {
                    field: format!("heights[{index}]"),
                    message: "height values must be finite".to_string(),
                });
            }
            min_height = min_height.min(height_value);
            max_height = max_height.max(height_value);
        }

        Ok(Self {
            width,
            height,
            heights,
            min_height,
            max_height,
        })
    }

    pub fn sample_count(&self) -> usize {
        self.heights.len()
    }
}

fn validate_dimensions(width: u32, height: u32, len: usize) -> Result<()> {
    if width == 0 {
        return Err(Forge3dError::InvalidInput {
            field: "width".to_string(),
            message: "terrain width must be greater than zero".to_string(),
        });
    }

    if height == 0 {
        return Err(Forge3dError::InvalidInput {
            field: "height".to_string(),
            message: "terrain height must be greater than zero".to_string(),
        });
    }

    let expected = width
        .checked_mul(height)
        .ok_or_else(|| Forge3dError::InvalidInput {
            field: "width,height".to_string(),
            message: "terrain width * height overflows u32".to_string(),
        })? as usize;

    if len != expected {
        return Err(Forge3dError::InvalidInput {
            field: "heights".to_string(),
            message: format!("heights length must equal width * height ({expected})"),
        });
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::TerrainHeightmapInput;

    #[test]
    fn terrain_heightmap_tracks_min_and_max_height() {
        let input = TerrainHeightmapInput::new(2, 2, vec![0.0, 0.25, 1.0, -0.5]).unwrap();

        assert_eq!(input.sample_count(), 4);
        assert_eq!(input.min_height, -0.5);
        assert_eq!(input.max_height, 1.0);
    }

    #[test]
    fn terrain_heightmap_rejects_length_mismatch() {
        let error = TerrainHeightmapInput::new(2, 3, vec![0.0; 5]).unwrap_err();

        assert!(error.to_string().contains("width * height"));
    }

    #[test]
    fn terrain_heightmap_rejects_non_finite_samples() {
        let error =
            TerrainHeightmapInput::new(2, 2, vec![0.0, 1.0, f32::INFINITY, 0.5]).unwrap_err();

        assert!(error.to_string().contains("finite"));
    }
}
