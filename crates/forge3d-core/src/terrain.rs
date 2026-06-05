use crate::error::{Forge3dError, Result};

#[derive(Debug, Clone, PartialEq)]
pub struct TerrainHeightmapInput {
    pub width: u32,
    pub height: u32,
    pub heights: Vec<f32>,
    pub min_height: f32,
    pub max_height: f32,
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

    pub fn mesh_descriptor(&self) -> Result<TerrainMeshDescriptor> {
        if self.width < 2 {
            return Err(Forge3dError::InvalidInput {
                field: "width".to_string(),
                message: "terrain width must be at least 2 to draw a mesh".to_string(),
            });
        }
        if self.height < 2 {
            return Err(Forge3dError::InvalidInput {
                field: "height".to_string(),
                message: "terrain height must be at least 2 to draw a mesh".to_string(),
            });
        }

        let width = self.width as usize;
        let height = self.height as usize;
        let mut vertices = Vec::with_capacity(width * height);
        for y in 0..height {
            let v = y as f32 / (height - 1) as f32;
            for x in 0..width {
                let u = x as f32 / (width - 1) as f32;
                vertices.push(TerrainMeshVertex {
                    position: [u * 2.0 - 1.0, 0.0, v * 2.0 - 1.0],
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

    #[test]
    fn terrain_mesh_descriptor_builds_normalized_grid() {
        let input = TerrainHeightmapInput::new(2, 2, vec![0.0, 0.0, 0.0, 0.0]).unwrap();
        let mesh = input.mesh_descriptor().unwrap();

        assert_eq!(mesh.vertices.len(), 4);
        assert_eq!(mesh.indices, vec![0, 2, 1, 1, 2, 3]);
        assert_eq!(mesh.vertices[0].position, [-1.0, 0.0, -1.0]);
        assert_eq!(mesh.vertices[0].uv, [0.0, 0.0]);
        assert_eq!(mesh.vertices[3].position, [1.0, 0.0, 1.0]);
        assert_eq!(mesh.vertices[3].uv, [1.0, 1.0]);
    }
}
