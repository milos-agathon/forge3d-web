use std::collections::BTreeMap;

use forge3d_core::memory::{MemoryCategory, MemoryTracker, QualityLevel};
use wasm_bindgen::JsValue;

use super::device_health::set_js_property;
use crate::error::{map_core_error, Forge3DErrorCode, WebError};

#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) struct LedgerDowngrade {
    pub requested: QualityLevel,
    pub effective: QualityLevel,
    pub requested_bytes: u64,
    pub admitted_bytes: u64,
}

#[derive(Debug, Clone)]
pub(super) struct MemoryLedger {
    tracker: MemoryTracker,
    keys: BTreeMap<String, forge3d_core::memory::AllocationId>,
    admitted: BTreeMap<String, u64>,
    downgrades: Vec<LedgerDowngrade>,
    effective_quality: QualityLevel,
}

impl MemoryLedger {
    #[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
    pub(super) fn new(budget_bytes: u64, quality: QualityLevel) -> Result<Self, WebError> {
        Ok(Self {
            tracker: MemoryTracker::new(budget_bytes).map_err(map_core_error)?,
            keys: BTreeMap::new(),
            admitted: BTreeMap::new(),
            downgrades: Vec::new(),
            effective_quality: quality,
        })
    }

    pub(super) fn budget_bytes(&self) -> u64 {
        self.tracker.report().budget_bytes
    }

    pub(super) fn current_bytes(&self) -> u64 {
        self.tracker.report().current_bytes
    }

    pub(super) fn fits_after_release(&self, released_keys: &[&str], additional_bytes: u64) -> bool {
        let released: u64 = released_keys
            .iter()
            .filter_map(|key| self.admitted.get(*key).copied())
            .sum();
        self.current_bytes()
            .saturating_sub(released)
            .checked_add(additional_bytes)
            .is_some_and(|total| total <= self.budget_bytes())
    }

    pub(super) fn replace(
        &mut self,
        key: &str,
        category: MemoryCategory,
        bytes: u64,
    ) -> Result<(), WebError> {
        if !self.fits_after_release(&[key], bytes) {
            return Err(WebError::new(
                Forge3DErrorCode::ResourceLimitExceeded,
                format!("allocation {key} of {bytes} bytes exceeds the memory budget"),
            ));
        }
        self.release(key);
        if bytes == 0 {
            return Ok(());
        }
        let id = self
            .tracker
            .allocate(key.to_string(), category, bytes)
            .map_err(map_core_error)?;
        self.keys.insert(key.to_string(), id);
        self.admitted.insert(key.to_string(), bytes);
        Ok(())
    }

    pub(super) fn release(&mut self, key: &str) {
        if let Some(id) = self.keys.remove(key) {
            self.tracker.release(id);
        }
        self.admitted.remove(key);
    }

    pub(super) fn record_downgrade(&mut self, downgrade: LedgerDowngrade) {
        self.effective_quality = downgrade.effective;
        self.downgrades.push(downgrade);
    }

    pub(super) fn clear(&mut self) {
        self.tracker.clear();
        self.keys.clear();
        self.admitted.clear();
    }

    #[allow(dead_code)]
    pub(super) fn admitted_bytes(&self, key: &str) -> Option<u64> {
        self.admitted.get(key).copied()
    }

    #[allow(dead_code)]
    pub(super) fn admitted_keys(&self) -> impl Iterator<Item = &str> {
        self.admitted.keys().map(String::as_str)
    }

    pub(super) fn report_js(&self) -> JsValue {
        let report = self.tracker.report();
        let out = js_sys::Object::new();
        set_js_property(
            out.as_ref(),
            "currentBytes",
            &JsValue::from_f64(report.current_bytes as f64),
        );
        set_js_property(
            out.as_ref(),
            "peakBytes",
            &JsValue::from_f64(report.peak_bytes as f64),
        );
        set_js_property(
            out.as_ref(),
            "budgetBytes",
            &JsValue::from_f64(report.budget_bytes as f64),
        );
        set_js_property(
            out.as_ref(),
            "utilization",
            &JsValue::from_f64(report.utilization),
        );
        set_js_property(
            out.as_ref(),
            "allocationCount",
            &JsValue::from_f64(report.allocation_count as f64),
        );
        let categories = js_sys::Object::new();
        for (name, category) in [
            ("buffers", MemoryCategory::Buffers),
            ("textures", MemoryCategory::Textures),
            ("staging", MemoryCategory::Staging),
            ("readback", MemoryCategory::Readback),
            ("tile-cache", MemoryCategory::TileCache),
            ("render-bundles", MemoryCategory::RenderBundles),
            ("other", MemoryCategory::Other),
        ] {
            let bytes = report.categories.get(&category).copied().unwrap_or(0);
            set_js_property(categories.as_ref(), name, &JsValue::from_f64(bytes as f64));
        }
        set_js_property(out.as_ref(), "categories", categories.as_ref());
        set_js_property(
            out.as_ref(),
            "effectiveQuality",
            &JsValue::from_str(quality_name(self.effective_quality)),
        );
        let downgrades = js_sys::Array::new();
        for downgrade in &self.downgrades {
            let entry = js_sys::Object::new();
            set_js_property(
                entry.as_ref(),
                "requested",
                &JsValue::from_str(quality_name(downgrade.requested)),
            );
            set_js_property(
                entry.as_ref(),
                "effective",
                &JsValue::from_str(quality_name(downgrade.effective)),
            );
            set_js_property(
                entry.as_ref(),
                "requestedBytes",
                &JsValue::from_f64(downgrade.requested_bytes as f64),
            );
            set_js_property(
                entry.as_ref(),
                "admittedBytes",
                &JsValue::from_f64(downgrade.admitted_bytes as f64),
            );
            downgrades.push(entry.as_ref());
        }
        set_js_property(out.as_ref(), "downgrades", downgrades.as_ref());
        out.into()
    }
}

pub(super) fn quality_name(quality: QualityLevel) -> &'static str {
    match quality {
        QualityLevel::Ultra => "ultra",
        QualityLevel::High => "high",
        QualityLevel::Medium => "medium",
        QualityLevel::Low => "low",
    }
}

pub(super) fn quality_scale_percent(quality: QualityLevel) -> u64 {
    match quality {
        QualityLevel::Ultra => 100,
        QualityLevel::High => 75,
        QualityLevel::Medium => 50,
        QualityLevel::Low => 25,
    }
}

pub(super) fn quality_ladder_from(requested: QualityLevel) -> &'static [QualityLevel] {
    match requested {
        QualityLevel::Ultra => &[
            QualityLevel::Ultra,
            QualityLevel::High,
            QualityLevel::Medium,
            QualityLevel::Low,
        ],
        QualityLevel::High => &[QualityLevel::High, QualityLevel::Medium, QualityLevel::Low],
        QualityLevel::Medium => &[QualityLevel::Medium, QualityLevel::Low],
        QualityLevel::Low => &[QualityLevel::Low],
    }
}

pub(super) fn downscaled_dimension(dimension: u32, relative_scale: f64) -> u32 {
    if dimension <= 2 {
        return dimension.max(2);
    }
    let scaled = ((dimension - 1) as f64 * relative_scale.sqrt()).floor() + 1.0;
    (scaled as u32).max(2)
}

pub(super) fn resample_heightmap(
    heights: &[f32],
    src_width: u32,
    src_height: u32,
    dst_width: u32,
    dst_height: u32,
) -> Vec<f32> {
    let mut out = Vec::with_capacity((dst_width * dst_height) as usize);
    for y in 0..dst_height {
        let src_y = if dst_height <= 1 {
            0
        } else {
            ((y as u64 * (src_height as u64 - 1) + (dst_height as u64 - 1) / 2)
                / (dst_height as u64 - 1)) as u32
        };
        for x in 0..dst_width {
            let src_x = if dst_width <= 1 {
                0
            } else {
                ((x as u64 * (src_width as u64 - 1) + (dst_width as u64 - 1) / 2)
                    / (dst_width as u64 - 1)) as u32
            };
            out.push(heights[(src_y * src_width + src_x) as usize]);
        }
    }
    out
}

#[cfg(test)]
mod tests;
