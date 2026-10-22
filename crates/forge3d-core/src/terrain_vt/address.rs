//! Immutable virtual-page, array-layer and feedback addressing contract.
use super::{TerrainVtSettings, VtLayerFamily, TERRAIN_VT_MATERIAL_CAPACITY};
#[derive(Debug, Clone)]
pub struct VtAddressPlan {
    pages: (u32, u32),
    public_levels: u32,
    runtime_levels: u32,
    materials: u32,
    atlas_size: u32,
}
impl VtAddressPlan {
    pub fn new(layer: &VtLayerFamily, settings: &TerrainVtSettings, materials: u32) -> Self {
        let pages = (layer.pages_x0(), layer.pages_y0());
        let max = pages.0.max(pages.1).max(1);
        Self {
            pages,
            public_levels: public_levels(pages.0, pages.1),
            runtime_levels: settings
                .max_mip_levels
                .min(super::runtime::page_table_mip_levels(max, max))
                .max(1),
            materials: materials.clamp(1, TERRAIN_VT_MATERIAL_CAPACITY as u32),
            atlas_size: settings.atlas_size,
        }
    }
    pub fn public_levels(&self) -> u32 {
        self.public_levels
    }
    pub fn runtime_levels(&self) -> u32 {
        self.runtime_levels
    }
    pub fn materials(&self) -> u32 {
        self.materials
    }
    pub fn base_pages(&self) -> (u32, u32) {
        self.pages
    }
    pub fn pages(&self, mip: u32) -> (u32, u32) {
        super::runtime::pages_for_mip_counts(self.pages.0, self.pages.1, mip)
    }
    pub fn layers(&self) -> u32 {
        self.materials * self.runtime_levels
    }
    pub fn layer(&self, material: u32, mip: u32) -> u32 {
        material * self.runtime_levels + mip
    }
    pub fn feedback_index(&self, material: u32, mip: u32, x: u32, y: u32) -> Option<u64> {
        let (w, h) = self.pages(mip);
        if material >= self.materials || mip >= self.runtime_levels || x >= w || y >= h {
            return None;
        }
        Some(
            (u64::from(self.layer(material, mip)) * u64::from(self.pages.1) + u64::from(y))
                * u64::from(self.pages.0)
                + u64::from(x),
        )
    }
    pub fn feedback_bytes(&self) -> u64 {
        u64::from(self.layers()) * u64::from(self.pages.0) * u64::from(self.pages.1) * 16
    }
    pub fn gpu_bytes(&self, uniform_bytes: u64) -> u64 {
        u64::from(self.atlas_size).pow(2) * 4 + self.feedback_bytes() * 3 + uniform_bytes
    }
    pub fn logical_pages(&self) -> u32 {
        (0..self.runtime_levels)
            .map(|m| {
                let (w, h) = self.pages(m);
                w.saturating_mul(h)
            })
            .fold(0, u32::saturating_add)
    }
}
pub fn public_levels(x: u32, y: u32) -> u32 {
    u32::BITS - x.max(y).max(1).leading_zeros()
}
