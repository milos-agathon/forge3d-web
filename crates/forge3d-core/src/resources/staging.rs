use crate::error::{Forge3dError, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StagingSlice {
    pub ring_index: usize,
    pub offset: u64,
    pub size: u64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StagingStats {
    pub bytes_in_flight: u64,
    pub stalls: u64,
    pub ring_count: usize,
    pub capacity_per_ring: u64,
}

#[derive(Debug)]
struct Ring {
    head: u64,
    submitted_fence: Option<u64>,
    in_flight_bytes: u64,
}

#[derive(Debug)]
pub struct StagingRing {
    rings: Vec<Ring>,
    current: usize,
    stalls: u64,
    capacity_per_ring: u64,
}

impl StagingRing {
    pub fn new(ring_count: usize, capacity_per_ring: u64) -> Result<Self> {
        if ring_count == 0 {
            return invalid("ring_count", "must be greater than zero");
        }
        if capacity_per_ring == 0 {
            return invalid("capacity_per_ring", "must be greater than zero");
        }
        Ok(Self {
            rings: (0..ring_count)
                .map(|_| Ring {
                    head: 0,
                    submitted_fence: None,
                    in_flight_bytes: 0,
                })
                .collect(),
            current: 0,
            stalls: 0,
            capacity_per_ring,
        })
    }

    pub fn allocate(
        &mut self,
        size: u64,
        alignment: u64,
        completed_fence: u64,
    ) -> Result<StagingSlice> {
        if size == 0 {
            return invalid("size", "must be greater than zero");
        }
        if alignment == 0 || !alignment.is_power_of_two() {
            return invalid("alignment", "must be a nonzero power of two");
        }
        if size > self.capacity_per_ring {
            return Err(Forge3dError::ResourceLimitExceeded {
                resource: "staging_ring".to_string(),
                message: "allocation exceeds ring capacity".to_string(),
            });
        }

        self.complete(completed_fence);

        for probe in 0..self.rings.len() {
            let index = (self.current + probe) % self.rings.len();
            let ring = &mut self.rings[index];
            if ring.submitted_fence.is_some() {
                continue;
            }
            let offset = align_up(ring.head, alignment)?;
            let end = offset
                .checked_add(size)
                .ok_or_else(|| Forge3dError::InvalidInput {
                    field: "size".to_string(),
                    message: "staging offset overflowed".to_string(),
                })?;
            if end <= self.capacity_per_ring {
                ring.head = end;
                self.current = index;
                return Ok(StagingSlice {
                    ring_index: index,
                    offset,
                    size,
                });
            }
        }

        self.stalls += 1;
        Err(Forge3dError::ResourceLimitExceeded {
            resource: "staging_ring".to_string(),
            message: "all rings are in flight or full".to_string(),
        })
    }

    pub fn submit_current(&mut self, fence: u64) -> Result<()> {
        let ring = &mut self.rings[self.current];
        if ring.submitted_fence.is_some() {
            return invalid("fence", "current ring is already submitted");
        }
        ring.submitted_fence = Some(fence);
        ring.in_flight_bytes = ring.head;
        self.current = (self.current + 1) % self.rings.len();
        Ok(())
    }

    pub fn complete(&mut self, completed_fence: u64) {
        for ring in &mut self.rings {
            if let Some(fence) = ring.submitted_fence {
                if fence <= completed_fence {
                    ring.submitted_fence = None;
                    ring.head = 0;
                    ring.in_flight_bytes = 0;
                }
            }
        }
    }

    pub fn stats(&self) -> StagingStats {
        StagingStats {
            bytes_in_flight: self
                .rings
                .iter()
                .filter(|ring| ring.submitted_fence.is_some())
                .map(|ring| ring.in_flight_bytes)
                .sum(),
            stalls: self.stalls,
            ring_count: self.rings.len(),
            capacity_per_ring: self.capacity_per_ring,
        }
    }
}

fn align_up(value: u64, alignment: u64) -> Result<u64> {
    value
        .checked_add(alignment - 1)
        .map(|v| v / alignment * alignment)
        .ok_or_else(|| Forge3dError::InvalidInput {
            field: "alignment".to_string(),
            message: "aligned offset overflowed".to_string(),
        })
}

fn invalid<T>(field: &str, message: &str) -> Result<T> {
    Err(Forge3dError::InvalidInput {
        field: field.to_string(),
        message: message.to_string(),
    })
}
