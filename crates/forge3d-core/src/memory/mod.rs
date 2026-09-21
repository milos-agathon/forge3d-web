use crate::error::{Forge3dError, Result};
use std::collections::BTreeMap;

pub const DEFAULT_MEMORY_BUDGET_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct AllocationId(pub u64);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum MemoryCategory {
    Buffers,
    Textures,
    Staging,
    Readback,
    TileCache,
    RenderBundles,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum QualityLevel {
    Ultra,
    High,
    Medium,
    Low,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OverflowPolicy {
    Reject,
    Downscale,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BudgetDecision {
    pub requested_bytes: u64,
    pub admitted_bytes: u64,
    pub requested_quality: QualityLevel,
    pub effective_quality: QualityLevel,
    pub downscaled: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MemoryReport {
    pub current_bytes: u64,
    pub peak_bytes: u64,
    pub budget_bytes: u64,
    pub utilization: f64,
    pub allocation_count: usize,
    pub categories: BTreeMap<MemoryCategory, u64>,
}

#[derive(Debug, Clone, PartialEq)]
struct Allocation {
    key: String,
    category: MemoryCategory,
    requested_bytes: u64,
    admitted_bytes: u64,
    decision: BudgetDecision,
}

#[derive(Debug)]
pub struct MemoryTracker {
    budget_bytes: u64,
    current_bytes: u64,
    peak_bytes: u64,
    next_id: u64,
    allocations: BTreeMap<AllocationId, Allocation>,
    by_key: BTreeMap<String, AllocationId>,
    categories: BTreeMap<MemoryCategory, u64>,
}

impl MemoryTracker {
    pub fn new(budget_bytes: u64) -> Result<Self> {
        if budget_bytes == 0 {
            return invalid("budget_bytes", "budget must be greater than zero");
        }
        Ok(Self {
            budget_bytes,
            current_bytes: 0,
            peak_bytes: 0,
            next_id: 0,
            allocations: BTreeMap::new(),
            by_key: BTreeMap::new(),
            categories: BTreeMap::new(),
        })
    }

    pub fn default_budget() -> Self {
        Self::new(DEFAULT_MEMORY_BUDGET_BYTES).expect("default memory budget is nonzero")
    }

    pub fn admit(
        &self,
        requested_bytes: u64,
        quality: QualityLevel,
        policy: OverflowPolicy,
    ) -> Result<BudgetDecision> {
        if requested_bytes == 0 {
            return invalid("requested_bytes", "request must be greater than zero");
        }
        if self.fits(requested_bytes) {
            return Ok(BudgetDecision {
                requested_bytes,
                admitted_bytes: requested_bytes,
                requested_quality: quality,
                effective_quality: quality,
                downscaled: false,
            });
        }
        match policy {
            OverflowPolicy::Reject => Err(limit_exceeded(requested_bytes)),
            OverflowPolicy::Downscale => {
                for &level in quality_ladder(quality) {
                    if level == quality {
                        continue;
                    }
                    let scaled = requested_bytes
                        .checked_mul(quality_scale_percent(level))
                        .map(|value| value.div_ceil(100));
                    if let Some(bytes) = scaled {
                        if self.fits(bytes) {
                            return Ok(BudgetDecision {
                                requested_bytes,
                                admitted_bytes: bytes,
                                requested_quality: quality,
                                effective_quality: level,
                                downscaled: true,
                            });
                        }
                    }
                }
                Err(limit_exceeded(requested_bytes))
            }
        }
    }

    pub fn allocate(
        &mut self,
        key: impl Into<String>,
        category: MemoryCategory,
        bytes: u64,
    ) -> Result<AllocationId> {
        let key = key.into();
        if bytes == 0 {
            return invalid("bytes", "allocation must be greater than zero");
        }
        if let Some(&existing) = self.by_key.get(&key) {
            let allocation = &self.allocations[&existing];
            if allocation.category == category && allocation.admitted_bytes == bytes {
                return Ok(existing);
            }
            return invalid("key", "conflicting allocation key");
        }
        self.admit(bytes, QualityLevel::Ultra, OverflowPolicy::Reject)?;
        let decision = BudgetDecision {
            requested_bytes: bytes,
            admitted_bytes: bytes,
            requested_quality: QualityLevel::Ultra,
            effective_quality: QualityLevel::Ultra,
            downscaled: false,
        };
        Ok(self.record(key, category, bytes, decision))
    }

    pub fn allocate_with_policy(
        &mut self,
        key: impl Into<String>,
        category: MemoryCategory,
        requested_bytes: u64,
        quality: QualityLevel,
        policy: OverflowPolicy,
    ) -> Result<(AllocationId, BudgetDecision)> {
        let key = key.into();
        if requested_bytes == 0 {
            return invalid("requested_bytes", "request must be greater than zero");
        }
        if let Some(&existing) = self.by_key.get(&key) {
            let allocation = &self.allocations[&existing];
            if allocation.category == category && allocation.requested_bytes == requested_bytes {
                return Ok((existing, allocation.decision.clone()));
            }
            return invalid("key", "conflicting allocation key");
        }
        let decision = self.admit(requested_bytes, quality, policy)?;
        let id = self.record(key, category, requested_bytes, decision.clone());
        Ok((id, decision))
    }

    pub fn release(&mut self, id: AllocationId) -> bool {
        let Some(allocation) = self.allocations.remove(&id) else {
            return false;
        };
        self.current_bytes -= allocation.admitted_bytes;
        if let Some(total) = self.categories.get_mut(&allocation.category) {
            *total -= allocation.admitted_bytes;
            if *total == 0 {
                self.categories.remove(&allocation.category);
            }
        }
        self.by_key.remove(&allocation.key);
        true
    }

    pub fn clear(&mut self) {
        self.allocations.clear();
        self.by_key.clear();
        self.categories.clear();
        self.current_bytes = 0;
    }

    pub fn report(&self) -> MemoryReport {
        MemoryReport {
            current_bytes: self.current_bytes,
            peak_bytes: self.peak_bytes,
            budget_bytes: self.budget_bytes,
            utilization: self.current_bytes as f64 / self.budget_bytes as f64,
            allocation_count: self.allocations.len(),
            categories: self.categories.clone(),
        }
    }

    fn fits(&self, bytes: u64) -> bool {
        self.current_bytes
            .checked_add(bytes)
            .map_or(false, |total| total <= self.budget_bytes)
    }

    fn record(
        &mut self,
        key: String,
        category: MemoryCategory,
        requested_bytes: u64,
        decision: BudgetDecision,
    ) -> AllocationId {
        let id = AllocationId(self.next_id);
        self.next_id += 1;
        self.current_bytes += decision.admitted_bytes;
        self.peak_bytes = self.peak_bytes.max(self.current_bytes);
        *self.categories.entry(category).or_insert(0) += decision.admitted_bytes;
        self.by_key.insert(key.clone(), id);
        self.allocations.insert(
            id,
            Allocation {
                key,
                category,
                requested_bytes,
                admitted_bytes: decision.admitted_bytes,
                decision,
            },
        );
        id
    }
}

fn quality_ladder(requested: QualityLevel) -> &'static [QualityLevel] {
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

fn quality_scale_percent(level: QualityLevel) -> u64 {
    match level {
        QualityLevel::Ultra => 100,
        QualityLevel::High => 75,
        QualityLevel::Medium => 50,
        QualityLevel::Low => 25,
    }
}

fn invalid<T>(field: &str, message: &str) -> Result<T> {
    Err(Forge3dError::InvalidInput {
        field: field.to_string(),
        message: message.to_string(),
    })
}

fn limit_exceeded(requested_bytes: u64) -> Forge3dError {
    Forge3dError::ResourceLimitExceeded {
        resource: "memory_budget".to_string(),
        message: format!("request of {requested_bytes} bytes exceeds the memory budget"),
    }
}

#[cfg(test)]
mod tests;
