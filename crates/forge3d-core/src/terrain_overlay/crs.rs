//! W08/T11 `terrain_overlay::crs` — terrain georeference + CRS helpers.
//!
//! Terrain georeference maps terrain uv `(u, v)` to CRS coordinates
//! `(minx + u * (maxx - minx), maxy - v * (maxy - miny))` — `v = 0` is the
//! north edge (image row 0). Supported transforms: identical CRS (affine,
//! i.e. no reprojection) and `EPSG:4326 <-> EPSG:3857` analytic spherical
//! Mercator (`R = 6378137`, latitude clamped to ±85.05112878°).

use crate::error::Forge3dError;

/// WGS84 semi-major axis used by web Mercator.
pub const WEB_MERCATOR_R: f64 = 6_378_137.0;
/// Web-Mercator latitude clamp (degrees).
pub const WEB_MERCATOR_MAX_LAT: f64 = 85.05112878;

/// Terrain georeference: optional CRS id + optional CRS-space bounds
/// `[minx, miny, maxx, maxy]`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TerrainGeoreference {
    pub crs: Option<String>,
    pub bounds: Option<[f64; 4]>,
}

impl TerrainGeoreference {
    pub fn new(crs: impl Into<String>, bounds: [f64; 4]) -> Self {
        Self {
            crs: Some(crs.into()),
            bounds: Some(bounds),
        }
    }

    /// Unreferenced terrain (no CRS, no bounds).
    pub fn none() -> Self {
        Self::default()
    }

    /// Terrain uv `(u, v)` -> CRS point; `v = 0` is the north edge.
    /// `None` when the terrain has no crs+bounds.
    pub fn uv_to_crs(&self, u: f64, v: f64) -> Option<(f64, f64)> {
        let bounds = self.bounds?;
        self.crs.as_ref()?;
        Some((
            bounds[0] + u * (bounds[2] - bounds[0]),
            bounds[3] - v * (bounds[3] - bounds[1]),
        ))
    }

    /// CRS point -> terrain uv `(u, v)`; `v = 0` is the north edge.
    /// `None` when the terrain has no crs+bounds.
    pub fn crs_to_uv(&self, x: f64, y: f64) -> Option<(f64, f64)> {
        let bounds = self.bounds?;
        self.crs.as_ref()?;
        Some((
            (x - bounds[0]) / (bounds[2] - bounds[0]),
            (bounds[3] - y) / (bounds[3] - bounds[1]),
        ))
    }
}

/// Normalize a CRS identifier: `"epsg:4326"` / `"crs:84"` -> `"EPSG:4326"`,
/// `"EPSG:900913"` -> `"EPSG:3857"`, other `"epsg:<n>"` -> `"EPSG:<n>"`.
/// Anything unrecognized is returned trimmed but unchanged.
pub fn normalize_crs(crs: &str) -> String {
    let trimmed = crs.trim();
    let lower = trimmed.to_ascii_lowercase();
    match lower.as_str() {
        "crs:84" | "epsg:4326" => "EPSG:4326".to_string(),
        "epsg:900913" | "epsg:3857" => "EPSG:3857".to_string(),
        _ => {
            if let Some(code) = lower.strip_prefix("epsg:") {
                format!("EPSG:{}", code.trim())
            } else {
                trimmed.to_string()
            }
        }
    }
}

/// EPSG:4326 (lon/lat degrees) -> EPSG:3857 (meters). Latitude is clamped
/// to ±85.05112878°.
pub fn lonlat_to_mercator(lon_deg: f64, lat_deg: f64) -> (f64, f64) {
    let lat = lat_deg.clamp(-WEB_MERCATOR_MAX_LAT, WEB_MERCATOR_MAX_LAT);
    let x = WEB_MERCATOR_R * lon_deg.to_radians();
    let y = WEB_MERCATOR_R
        * (std::f64::consts::FRAC_PI_4 + lat.to_radians() / 2.0)
            .tan()
            .ln();
    (x, y)
}

/// EPSG:3857 (meters) -> EPSG:4326 (lon/lat degrees).
pub fn mercator_to_lonlat(x: f64, y: f64) -> (f64, f64) {
    let lon = (x / WEB_MERCATOR_R).to_degrees();
    let lat = (2.0 * (y / WEB_MERCATOR_R).exp().atan() - std::f64::consts::FRAC_PI_2).to_degrees();
    (lon, lat)
}

/// Whether the pair is supported: identical (normalized) CRS or
/// EPSG:4326 <-> EPSG:3857.
pub fn crs_pair_supported(from: &str, to: &str) -> bool {
    let a = normalize_crs(from);
    let b = normalize_crs(to);
    a == b || (a == "EPSG:4326" && b == "EPSG:3857") || (a == "EPSG:3857" && b == "EPSG:4326")
}

/// Transform a point between supported CRS pairs; `None` for unsupported
/// pairs (callers produce [`crs_mismatch_error`]).
pub fn crs_transform(from: &str, to: &str, x: f64, y: f64) -> Option<(f64, f64)> {
    let a = normalize_crs(from);
    let b = normalize_crs(to);
    if a == b {
        Some((x, y))
    } else if a == "EPSG:4326" && b == "EPSG:3857" {
        Some(lonlat_to_mercator(x, y))
    } else if a == "EPSG:3857" && b == "EPSG:4326" {
        Some(mercator_to_lonlat(x, y))
    } else {
        None
    }
}

/// Native `crs_mismatch` diagnostic as `UnsupportedFeature`.
pub fn crs_mismatch_error(layer_name: &str, layer_crs: &str, terrain_crs: &str) -> Forge3dError {
    Forge3dError::UnsupportedFeature {
        feature: format!(
            "crs_mismatch: overlay layer '{layer_name}' CRS {} cannot be placed on terrain CRS {terrain_crs} (supported: identical CRS, EPSG:4326<->EPSG:3857)",
            normalize_crs(layer_crs)
        ),
    }
}
