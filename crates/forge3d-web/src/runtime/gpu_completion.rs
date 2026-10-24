//! Nonblocking staging ownership shared by VT, LOD and timestamp consumers.
use std::sync::{Arc, Mutex, Weak};
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    Idle,
    Submitted,
    Mapping,
    Completed,
    Failed,
    Disposed,
}
struct State {
    phase: Phase,
    generation: u64,
}
pub(super) struct Completion {
    state: Arc<Mutex<State>>,
}
struct Callback {
    state: Weak<Mutex<State>>,
    generation: u64,
}
impl Callback {
    fn complete(self, success: bool) {
        if let Some(state) = self.state.upgrade() {
            let mut state = state.lock().unwrap_or_else(|e| e.into_inner());
            if state.generation == self.generation && state.phase == Phase::Mapping {
                state.phase = if success {
                    Phase::Completed
                } else {
                    Phase::Failed
                };
            }
        }
    }
}
impl Default for Completion {
    fn default() -> Self {
        Self {
            state: Arc::new(Mutex::new(State {
                phase: Phase::Idle,
                generation: 0,
            })),
        }
    }
}
impl Drop for Completion {
    fn drop(&mut self) {
        self.dispose();
    }
}
impl Completion {
    pub fn idle(&self) -> bool {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).phase == Phase::Idle
    }
    // Reserve while encoding the copy; callers only begin mapping after submission.
    pub fn submit(&self) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.phase != Phase::Idle {
            return false;
        }
        state.generation = state.generation.wrapping_add(1);
        state.phase = Phase::Submitted;
        true
    }
    fn mapping(&self) -> Option<Callback> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.phase != Phase::Submitted {
            return None;
        }
        state.phase = Phase::Mapping;
        Some(Callback {
            state: Arc::downgrade(&self.state),
            generation: state.generation,
        })
    }
    pub fn begin_map(&self, buffer: &wgpu::Buffer, bytes: u64) {
        if let Some(callback) = self.mapping() {
            buffer
                .slice(..bytes)
                .map_async(wgpu::MapMode::Read, move |result| {
                    callback.complete(result.is_ok())
                });
        }
    }
    fn outcome(&self) -> Option<bool> {
        match self.state.lock().unwrap_or_else(|e| e.into_inner()).phase {
            Phase::Completed => Some(true),
            Phase::Failed => Some(false),
            _ => None,
        }
    }
    fn release(&self) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if matches!(state.phase, Phase::Completed | Phase::Failed) {
            state.phase = Phase::Idle;
        }
    }
    pub fn harvest<T>(
        &self,
        buffer: &wgpu::Buffer,
        bytes: u64,
        decode: impl FnOnce(&[u8]) -> T,
    ) -> Option<Result<T, ()>> {
        let success = self.outcome()?;
        let result = if success {
            let mapped = buffer.slice(..bytes).get_mapped_range();
            Ok(decode(&mapped))
        } else {
            Err(())
        };
        // Reuse becomes legal only after the mapped view has dropped and unmap ran.
        buffer.unmap();
        self.release();
        Some(result)
    }
    fn dispose(&self) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.generation = state.generation.wrapping_add(1);
        state.phase = Phase::Disposed;
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn failed_mapping_releases_a_slot_for_later_success() {
        let c = Completion::default();
        assert!(c.mapping().is_none());
        assert!(c.submit());
        assert!(!c.submit());
        let cb = c.mapping().unwrap();
        assert!(c.mapping().is_none());
        assert_eq!(c.outcome(), None);
        cb.complete(false);
        assert_eq!(c.outcome(), Some(false));
        assert!(!c.idle());
        c.release();
        assert!(c.idle());
        assert!(c.submit());
        c.mapping().unwrap().complete(true);
        assert_eq!(c.outcome(), Some(true));
        c.release();
        assert!(c.idle());
    }
    #[test]
    fn disposed_or_late_callbacks_cannot_reopen_or_complete_a_new_generation() {
        let c = Completion::default();
        c.submit();
        let cb = c.mapping().unwrap();
        let stale = Callback {
            state: cb.state.clone(),
            generation: cb.generation,
        };
        cb.complete(false);
        c.release();
        c.submit();
        let next = c.mapping().unwrap();
        stale.complete(true);
        assert_eq!(c.outcome(), None);
        c.dispose();
        next.complete(true);
        assert_eq!(c.outcome(), None);
        assert!(!c.submit());
        let c = Completion::default();
        c.submit();
        let cb = c.mapping().unwrap();
        drop(c);
        cb.complete(false);
    }
}
