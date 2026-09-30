//! W08/T14a `terrain_vt` — GPU-free terrain material virtual texturing.
//!
//! Pure-Rust port of the native albedo-only VT contract
//! (`python/forge3d/terrain_params.py` VTLayerFamily / TerrainVTSettings /
//! validate_terrain_vt_support, `python/forge3d/diagnostics.py`
//! vt_unsupported_family_diagnostic, and the GPU-free parts of
//! `src/terrain/renderer/virtual_texture.rs`).
//!
//! The contract reserves `albedo`/`normal`/`mask` families; the runtime
//! pages only `albedo` — non-albedo sources are stored for forward
//! compatibility and produce deterministic `vt_unsupported_family`
//! diagnostics.

pub mod runtime;

#[cfg(test)]
mod tests;

pub use runtime::{
    build_rgba_mip_chain, ceil_div, full_pyramid_levels, page_table_mip_levels,
    pages_for_mip_counts, total_pages_for, FeedbackEntry, MipImage, PageTableEntry,
    PreparedVtSource, TileKey, TileUpload, VtRuntimeState, VtSource, VtSourceRegistry, VtStats,
    VtViewParams,
};

use std::collections::BTreeMap;

use crate::error::{Forge3dError, Result};

fn invalid(field: &str, message: String) -> Forge3dError {
    Forge3dError::InvalidInput {
        field: field.to_string(),
        message,
    }
}

/// The only family paged by the current native runtime.
pub const TERRAIN_VT_SUPPORTED_FAMILY: &str = "albedo";
/// Material slots reserved by the terrain VT pipeline.
pub const TERRAIN_VT_MATERIAL_CAPACITY: usize = 4;
/// RGBA8 bytes per texel.
pub const TERRAIN_VT_BYTES_PER_PIXEL: usize = 4;
/// Families accepted by the configuration contract (sorted).
pub const TERRAIN_VT_VALID_FAMILIES: [&str; 3] = ["albedo", "mask", "normal"];

/// One paged terrain material family (native `VTLayerFamily`).
#[derive(Debug, Clone, PartialEq)]
pub struct VtLayerFamily {
    /// `"albedo" | "normal" | "mask"`.
    pub family: String,
    /// Family-wide virtual extent in texels; default `(4096, 4096)`.
    pub virtual_size_px: (u32, u32),
    /// Content pixels per tile edge; default `248`.
    pub tile_size: u32,
    /// Gutter pixels per tile edge; default `4` (slot_size = 256).
    pub tile_border: u32,
    /// Last-resort per-family fallback color; default `[0.5, 0.5, 0.5, 1.0]`.
    pub fallback: [f32; 4],
}

impl VtLayerFamily {
    /// Construct with native defaults and validate.
    pub fn new(family: impl Into<String>) -> Result<Self> {
        let layer = Self {
            family: family.into(),
            virtual_size_px: (4096, 4096),
            tile_size: 248,
            tile_border: 4,
            fallback: [0.5, 0.5, 0.5, 1.0],
        };
        layer.validate()?;
        Ok(layer)
    }

    pub fn with_virtual_size(mut self, w: u32, h: u32) -> Self {
        self.virtual_size_px = (w, h);
        self
    }

    pub fn with_tile_size(mut self, tile_size: u32) -> Self {
        self.tile_size = tile_size;
        self
    }

    pub fn with_tile_border(mut self, tile_border: u32) -> Self {
        self.tile_border = tile_border;
        self
    }

    pub fn with_fallback(mut self, fallback: [f32; 4]) -> Self {
        self.fallback = fallback;
        self
    }

    /// Native `VTLayerFamily.__post_init__` validation.
    pub fn validate(&self) -> Result<()> {
        if !TERRAIN_VT_VALID_FAMILIES.contains(&self.family.as_str()) {
            return Err(invalid(
                "vt.family",
                "family must be one of ['albedo', 'mask', 'normal']".to_string(),
            ));
        }
        if self.tile_size < 16 {
            return Err(invalid(
                "vt.tile_size",
                "tile_size must be >= 16".to_string(),
            ));
        }
        if self.virtual_size_px.0 < self.tile_size || self.virtual_size_px.1 < self.tile_size {
            return Err(invalid(
                "vt.virtual_size_px",
                "virtual_size_px must be >= tile_size in both dimensions".to_string(),
            ));
        }
        Ok(())
    }

    /// Physical atlas slot size = content + 2 * border.
    pub fn slot_size(&self) -> u32 {
        self.tile_size + 2 * self.tile_border
    }

    /// Finest-level page count X.
    pub fn pages_x0(&self) -> u32 {
        ceil_div(self.virtual_size_px.0, self.tile_size)
    }

    /// Finest-level page count Y.
    pub fn pages_y0(&self) -> u32 {
        ceil_div(self.virtual_size_px.1, self.tile_size)
    }

    /// Maximum mip levels the virtual extent can support, derived from
    /// finest page counts: `floor(log2(max(px0, py0))) + 1`. This is the
    /// 1f4084a/1.38 public value (`full_pyramid_levels`,
    /// `actual_mip_count`); the runtime page pyramid bottoms out at 1x1
    /// (`page_table_mip_levels`, `ceil(log2)+1`) instead.
    pub fn full_pyramid_levels(&self) -> u32 {
        let max_dim = self.pages_x0().max(self.pages_y0()).max(1);
        u32::BITS - max_dim.leading_zeros()
    }

    /// Page count at `mip` (ceil-div, min 1).
    pub fn pages_at_mip(&self, mip: u32) -> (u32, u32) {
        pages_for_mip_counts(self.pages_x0(), self.pages_y0(), mip)
    }
}

/// Terrain material VT configuration (native `TerrainVTSettings`).
#[derive(Debug, Clone, PartialEq)]
pub struct TerrainVtSettings {
    /// Default false.
    pub enabled: bool,
    /// Default `[albedo]`.
    pub layers: Vec<VtLayerFamily>,
    /// Physical atlas edge in texels; default 4096.
    pub atlas_size: u32,
    /// Resident page budget in MiB; default 256.0.
    pub residency_budget_mb: f32,
    /// Requested mip levels; default 8.
    pub max_mip_levels: u32,
    /// Feedback-driven streaming; default true.
    pub use_feedback: bool,
}

impl Default for TerrainVtSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            layers: vec![VtLayerFamily::new("albedo").unwrap()],
            atlas_size: 4096,
            residency_budget_mb: 256.0,
            max_mip_levels: 8,
            use_feedback: true,
        }
    }
}

impl TerrainVtSettings {
    pub fn new() -> Self {
        Self::default()
    }

    /// Native `TerrainVTSettings.__post_init__` validation.
    pub fn validate(&self) -> Result<()> {
        let mut seen = std::collections::HashSet::new();
        for layer in &self.layers {
            if !seen.insert(layer.family.as_str()) {
                return Err(invalid(
                    "vt.layers",
                    "duplicate family in layers".to_string(),
                ));
            }
            layer.validate()?;
        }
        if self.atlas_size < 256 {
            return Err(invalid(
                "vt.atlas_size",
                "atlas_size must be >= 256".to_string(),
            ));
        }
        if self.residency_budget_mb <= 0.0 {
            return Err(invalid(
                "vt.residency_budget_mb",
                "residency_budget_mb must be > 0".to_string(),
            ));
        }
        if self.max_mip_levels < 1 {
            return Err(invalid(
                "vt.max_mip_levels",
                "max_mip_levels must be >= 1".to_string(),
            ));
        }
        for layer in &self.layers {
            if !self.atlas_size.is_multiple_of(layer.slot_size()) {
                return Err(invalid(
                    "vt.atlas_size",
                    format!(
                        "atlas_size ({}) must be divisible by slot_size ({}) for family '{}'",
                        self.atlas_size,
                        layer.slot_size(),
                        layer.family
                    ),
                ));
            }
        }
        Ok(())
    }

    /// E0: the VT atlas is one `atlas_size` x `atlas_size` 2D texture.
    pub fn validate_atlas_dimension(&self, max_texture_dimension_2d: u32) -> Result<()> {
        if self.atlas_size > max_texture_dimension_2d {
            return Err(Forge3dError::ResourceLimitExceeded {
                resource: "terrain.vt".to_string(),
                message: format!(
                    "vt.atlas_size {} exceeds maxTextureDimension2D {max_texture_dimension_2d}",
                    self.atlas_size
                ),
            });
        }
        Ok(())
    }

    /// Effective mip count for `family`: `min(requested, full pyramid)`.
    /// `None` when the family is not configured (native would raise
    /// `StopIteration`).
    pub fn actual_mip_count(&self, family: &str) -> Option<u32> {
        let layer = self.layers.iter().find(|l| l.family == family)?;
        Some(self.max_mip_levels.min(layer.full_pyramid_levels()))
    }

    /// The albedo layer selected by the native runtime (`None` when
    /// disabled or absent).
    pub fn selected_layer(&self) -> Option<&VtLayerFamily> {
        if !self.enabled {
            return None;
        }
        self.layers
            .iter()
            .find(|l| l.family == TERRAIN_VT_SUPPORTED_FAMILY)
    }
}

/// `vt_unsupported_family` diagnostic (native
/// `diagnostics.vt_unsupported_family_diagnostic`).
#[derive(Debug, Clone, PartialEq)]
pub struct VtDiagnostic {
    pub code: String,
    pub severity: String,
    pub message: String,
    pub remediation: String,
    pub support_level: String,
    pub layer_id: String,
    pub object_id: String,
    /// `family` then `supported_family`.
    pub details: Vec<(String, String)>,
}

/// Native `vt_unsupported_family_diagnostic`.
pub fn vt_unsupported_family_diagnostic(
    family: &str,
    layer_id: &str,
    object_id: &str,
) -> VtDiagnostic {
    VtDiagnostic {
        code: "vt_unsupported_family".to_string(),
        severity: "error".to_string(),
        message: "Requested terrain virtual-texturing family is not paged by the native runtime."
            .to_string(),
        remediation: "Use the albedo VT family or wait for native normal/mask runtime support."
            .to_string(),
        support_level: "unsupported".to_string(),
        layer_id: layer_id.to_string(),
        object_id: object_id.to_string(),
        details: vec![
            ("family".to_string(), family.to_string()),
            (
                "supported_family".to_string(),
                TERRAIN_VT_SUPPORTED_FAMILY.to_string(),
            ),
        ],
    }
}

/// The single `terrain.virtual_texture` layer summary (native
/// `LayerSummary`).
#[derive(Debug, Clone, PartialEq)]
pub struct VtLayerSummary {
    pub layer_id: String,
    /// `"terrain.virtual_texture"`.
    pub layer_type: String,
    /// `"supported" | "unsupported"`.
    pub support_level: String,
    pub diagnostic_codes: Vec<String>,
    /// `enabled`, `families` (sorted), `native_supported_family`.
    pub enabled: bool,
    pub families: Vec<String>,
    pub native_supported_family: String,
}

/// Native `ValidationReport` shape produced by
/// [`validate_terrain_vt_support`].
#[derive(Debug, Clone, PartialEq)]
pub struct VtSupportReport {
    /// `"ok"` when no diagnostics, else `"error"`.
    pub status: String,
    /// One diagnostic per non-albedo family, sorted by `object_id`.
    pub diagnostics: Vec<VtDiagnostic>,
    pub layer_summaries: Vec<VtLayerSummary>,
    /// `{"vt.albedo": "supported"}`.
    pub supported_features: BTreeMap<String, String>,
    /// `{"vt.<family>": "unsupported"}` for each non-albedo layer family.
    pub unsupported_features: BTreeMap<String, String>,
}

/// Native `validate_terrain_vt_support` (1f4084a shape). Diagnostics are
/// sorted by `object_id`, so `[albedo, normal, mask]` and
/// `[mask, albedo, normal]` produce equal reports.
pub fn validate_terrain_vt_support(
    settings: &TerrainVtSettings,
    layer_id: Option<&str>,
) -> VtSupportReport {
    let effective_layer_id = layer_id.unwrap_or("terrain.vt").to_string();
    let mut diagnostics: Vec<VtDiagnostic> = settings
        .layers
        .iter()
        .filter(|l| l.family != TERRAIN_VT_SUPPORTED_FAMILY)
        .map(|l| {
            vt_unsupported_family_diagnostic(
                &l.family,
                &effective_layer_id,
                &format!("vt.{}", l.family),
            )
        })
        .collect();
    diagnostics.sort_by(|a, b| a.object_id.cmp(&b.object_id));

    let mut families: Vec<String> = settings.layers.iter().map(|l| l.family.clone()).collect();
    families.sort();

    let mut supported_features = BTreeMap::new();
    supported_features.insert(
        format!("vt.{TERRAIN_VT_SUPPORTED_FAMILY}"),
        "supported".to_string(),
    );
    let mut unsupported_features = BTreeMap::new();
    for layer in &settings.layers {
        if layer.family != TERRAIN_VT_SUPPORTED_FAMILY {
            unsupported_features.insert(format!("vt.{}", layer.family), "unsupported".to_string());
        }
    }

    let summary = VtLayerSummary {
        layer_id: effective_layer_id,
        layer_type: "terrain.virtual_texture".to_string(),
        support_level: if diagnostics.is_empty() {
            "supported"
        } else {
            "unsupported"
        }
        .to_string(),
        diagnostic_codes: diagnostics.iter().map(|d| d.code.clone()).collect(),
        enabled: settings.enabled,
        families,
        native_supported_family: TERRAIN_VT_SUPPORTED_FAMILY.to_string(),
    };

    VtSupportReport {
        status: if diagnostics.is_empty() {
            "ok"
        } else {
            "error"
        }
        .to_string(),
        diagnostics,
        layer_summaries: vec![summary],
        supported_features,
        unsupported_features,
    }
}
