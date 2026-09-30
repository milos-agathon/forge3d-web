//! W08/T08 B4: `TileRequestQueue` — synchronous state machine port of
//! native `page_table/height_loader.rs` (`AsyncTileLoader`)
//! request/drain/cancel semantics: dedup, LOD coalescing, backpressure,
//! cancellation, and counters.

use std::collections::HashSet;

use super::TileId;

/// LOD coalescing policy (native `CoalescePolicy`; default `PreferCoarse`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum CoalescePolicy {
    /// Prefer coarser tiles: drop a request if a pending ancestor exists;
    /// pending finer descendants are cancelled when the coarse tile is
    /// enqueued.
    #[default]
    PreferCoarse,
    /// Prefer finer tiles: drop a request if a pending descendant exists;
    /// pending coarser ancestors are cancelled when the fine tile is
    /// enqueued.
    PreferFine,
}

/// Outcome of [`TileRequestQueue::request`] (B4).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequestOutcome {
    Enqueued,
    Deduplicated,
    DroppedByPolicy,
    Backpressure,
}

/// Outcome of [`TileRequestQueue::complete`] (native drain semantics).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Completion {
    /// Delivered to the caller.
    Accepted,
    /// Result was cancelled while in flight; dropped silently.
    Discarded,
}

/// Cumulative request counters (B4).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct QueueCounters {
    /// `request()` attempts.
    pub requests: u64,
    /// Successfully enqueued.
    pub enqueued: u64,
    /// Re-requests of already-pending tiles.
    pub deduplicated: u64,
    /// Dropped by the coalescing policy.
    pub dropped_by_policy: u64,
    /// Tiles moved to the cancelled set.
    pub canceled: u64,
    /// Rejected because `pending.len() >= max_in_flight`.
    pub backpressure: u64,
    /// Results delivered by `complete()`.
    pub completed: u64,
}

/// Synchronous port of the native async loader's pending/cancelled sets.
#[derive(Debug)]
pub struct TileRequestQueue {
    pending: HashSet<TileId>,
    cancelled: HashSet<TileId>,
    max_in_flight: usize,
    policy: CoalescePolicy,
    counters: QueueCounters,
}

impl TileRequestQueue {
    pub fn new(max_in_flight: usize, policy: CoalescePolicy) -> Self {
        Self {
            pending: HashSet::new(),
            cancelled: HashSet::new(),
            max_in_flight: max_in_flight.max(1),
            policy,
            counters: QueueCounters::default(),
        }
    }

    /// Submit a request, exactly per native `AsyncTileLoader::request`:
    /// clear the cancelled mark on re-request, coalesce per policy,
    /// dedupe, backpressure at `max_in_flight`, then enqueue and cancel
    /// superseded pending tiles.
    pub fn request(&mut self, id: TileId) -> RequestOutcome {
        self.counters.requests += 1;
        // If previously canceled, clear that state when re-requested.
        self.cancelled.remove(&id);
        match self.policy {
            CoalescePolicy::PreferCoarse => {
                // Drop if any (coarser) ancestor is pending.
                if self.pending.iter().any(|p| id.is_descendant_of(p)) {
                    self.counters.dropped_by_policy += 1;
                    return RequestOutcome::DroppedByPolicy;
                }
                if self.pending.contains(&id) {
                    self.counters.deduplicated += 1;
                    return RequestOutcome::Deduplicated;
                }
                if self.pending.len() >= self.max_in_flight {
                    self.counters.backpressure += 1;
                    return RequestOutcome::Backpressure;
                }
                self.pending.insert(id);
                self.counters.enqueued += 1;
                // Cancel pending (finer) descendants of the new tile.
                let mut count = 0u64;
                let to_cancel: Vec<TileId> = self
                    .pending
                    .iter()
                    .copied()
                    .filter(|d| *d != id && d.is_descendant_of(&id))
                    .collect();
                for d in to_cancel {
                    self.pending.remove(&d);
                    self.cancelled.insert(d);
                    count += 1;
                }
                self.counters.canceled += count;
                RequestOutcome::Enqueued
            }
            CoalescePolicy::PreferFine => {
                // Drop if any (finer) descendant is pending.
                if self.pending.iter().any(|d| d.is_descendant_of(&id)) {
                    self.counters.dropped_by_policy += 1;
                    return RequestOutcome::DroppedByPolicy;
                }
                if self.pending.contains(&id) {
                    self.counters.deduplicated += 1;
                    return RequestOutcome::Deduplicated;
                }
                if self.pending.len() >= self.max_in_flight {
                    self.counters.backpressure += 1;
                    return RequestOutcome::Backpressure;
                }
                self.pending.insert(id);
                self.counters.enqueued += 1;
                // Cancel pending (coarser) ancestors. Native bumps the
                // counter once per successful fine request.
                let ancestors: Vec<TileId> = self
                    .pending
                    .iter()
                    .copied()
                    .filter(|p| id.is_descendant_of(p))
                    .collect();
                for p in ancestors {
                    self.pending.remove(&p);
                    self.cancelled.insert(p);
                }
                self.counters.canceled += 1;
                RequestOutcome::Enqueued
            }
        }
    }

    /// Deliver a completed tile (native `drain_completed` semantics):
    /// the result is marked not-pending; a cancelled result is dropped
    /// silently (`Discarded`), otherwise `Accepted` and counted.
    pub fn complete(&mut self, id: TileId) -> Completion {
        self.pending.remove(&id);
        if self.cancelled.remove(&id) {
            Completion::Discarded
        } else {
            self.counters.completed += 1;
            Completion::Accepted
        }
    }

    /// Cancel pending ids; returns how many were marked cancelled.
    pub fn cancel(&mut self, ids: &[TileId]) -> usize {
        let mut n = 0usize;
        for id in ids {
            if self.pending.remove(id) {
                self.cancelled.insert(*id);
                n += 1;
            }
        }
        if n > 0 {
            self.counters.canceled += n as u64;
        }
        n
    }

    /// The set of in-flight (enqueued, not completed/cancelled) tiles.
    pub fn pending(&self) -> &HashSet<TileId> {
        &self.pending
    }

    /// Tiles whose in-flight results will be discarded on completion.
    pub fn cancelled(&self) -> &HashSet<TileId> {
        &self.cancelled
    }

    pub fn counters(&self) -> QueueCounters {
        self.counters
    }
}
