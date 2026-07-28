use std::collections::HashMap;
use std::rc::Rc;
use std::sync::{Arc, Mutex};

use crate::error::{Forge3dError, Result};

#[derive(Debug, Clone)]
pub struct GpuRuntimeOptions {
    pub power_preference: wgpu::PowerPreference,
    pub required_features: wgpu::Features,
    pub required_limits: wgpu::Limits,
    pub label: Option<String>,
}

impl Default for GpuRuntimeOptions {
    fn default() -> Self {
        Self {
            power_preference: wgpu::PowerPreference::HighPerformance,
            required_features: wgpu::Features::empty(),
            required_limits: wgpu::Limits::downlevel_webgl2_defaults(),
            label: None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct GpuRuntime {
    pub instance: Rc<wgpu::Instance>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceHealthState {
    Ready,
    Lost,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceHealthSnapshot {
    pub state: DeviceHealthState,
    pub message: Option<String>,
    pub uncaptured_error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct DeviceHealth {
    inner: Arc<Mutex<DeviceHealthInner>>,
}

struct DeviceHealthInner {
    snapshot: DeviceHealthSnapshot,
    next_listener_id: u64,
    listeners: HashMap<u64, Arc<dyn Fn(String) + Send + Sync>>,
}

impl std::fmt::Debug for DeviceHealthInner {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("DeviceHealthInner")
            .field("snapshot", &self.snapshot)
            .field("next_listener_id", &self.next_listener_id)
            .field("listener_count", &self.listeners.len())
            .finish()
    }
}

impl Default for DeviceHealth {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(DeviceHealthInner {
                snapshot: DeviceHealthSnapshot {
                    state: DeviceHealthState::Ready,
                    message: None,
                    uncaptured_error: None,
                },
                next_listener_id: 1,
                listeners: HashMap::new(),
            })),
        }
    }
}

impl DeviceHealth {
    pub fn snapshot(&self) -> DeviceHealthSnapshot {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .snapshot
            .clone()
    }

    pub fn check(&self) -> Result<()> {
        let snapshot = self.snapshot();
        match snapshot.state {
            DeviceHealthState::Ready => match snapshot.uncaptured_error {
                Some(message) => Err(Forge3dError::Internal { message }),
                None => Ok(()),
            },
            DeviceHealthState::Lost => Err(Forge3dError::DeviceLost {
                message: snapshot
                    .message
                    .unwrap_or_else(|| "The WebGPU device was lost".to_string()),
            }),
        }
    }

    /// Records a device-loss event and notifies each registered listener once.
    pub fn report_device_lost(&self, reason: wgpu::DeviceLostReason, message: impl Into<String>) {
        self.mark_lost(reason, message.into());
    }

    fn mark_lost(&self, reason: wgpu::DeviceLostReason, message: String) {
        let notification = {
            let mut inner = self
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if inner.snapshot.state != DeviceHealthState::Ready {
                return;
            }
            inner.snapshot.state = DeviceHealthState::Lost;
            let message = if message.is_empty() {
                format!("{reason:?}")
            } else {
                format!("{reason:?}: {message}")
            };
            inner.snapshot.message = Some(message.clone());
            Some((
                message,
                inner.listeners.values().cloned().collect::<Vec<_>>(),
            ))
        };
        if let Some((message, listeners)) = notification {
            for listener in listeners {
                listener(message.clone());
            }
        }
    }

    fn record_uncaptured_error(&self, error: &wgpu::Error) {
        let should_mark_lost = matches!(
            error,
            wgpu::Error::Internal { .. } | wgpu::Error::OutOfMemory { .. }
        );
        {
            let mut inner = self
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if inner.snapshot.uncaptured_error.is_none() {
                inner.snapshot.uncaptured_error = Some(error.to_string());
            }
        }
        if should_mark_lost {
            self.mark_lost(wgpu::DeviceLostReason::Unknown, error.to_string());
        }
    }

    pub fn subscribe(&self, listener: Arc<dyn Fn(String) + Send + Sync>) -> u64 {
        let already_lost = {
            let mut inner = self
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let listener_id = inner.next_listener_id;
            inner.next_listener_id = inner.next_listener_id.saturating_add(1);
            let already_lost = if inner.snapshot.state == DeviceHealthState::Lost {
                inner.snapshot.message.clone()
            } else {
                inner.listeners.insert(listener_id, listener.clone());
                None
            };
            (listener_id, already_lost)
        };
        if let Some(message) = already_lost.1 {
            listener(message);
        }
        already_lost.0
    }

    pub fn unsubscribe(&self, listener_id: u64) {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .listeners
            .remove(&listener_id);
    }
}

impl GpuRuntime {
    pub fn new(instance: wgpu::Instance) -> Self {
        Self {
            instance: Rc::new(instance),
        }
    }

    pub async fn request_context(
        &self,
        compatible_surface: Option<&wgpu::Surface<'_>>,
        options: &GpuRuntimeOptions,
    ) -> Result<GpuContext> {
        let adapter = self
            .instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: options.power_preference,
                compatible_surface,
                force_fallback_adapter: false,
            })
            .await
            .map_err(|_| Forge3dError::AdapterUnavailable)?;

        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor {
                label: options.label.as_deref(),
                required_features: options.required_features,
                required_limits: options.required_limits.clone(),
                experimental_features: wgpu::ExperimentalFeatures::disabled(),
                memory_hints: wgpu::MemoryHints::Performance,
                trace: wgpu::Trace::Off,
            })
            .await
            .map_err(|error| Forge3dError::DeviceRequest {
                message: error.to_string(),
            })?;

        let health = DeviceHealth::default();
        let lost_health = health.clone();
        device.set_device_lost_callback(move |reason, message| {
            lost_health.mark_lost(reason, message);
        });
        let error_health = health.clone();
        device.on_uncaptured_error(Arc::new(move |error| {
            error_health.record_uncaptured_error(&error);
        }));

        Ok(GpuContext {
            adapter: Rc::new(adapter),
            device: Rc::new(device),
            queue: Rc::new(queue),
            health,
        })
    }
}

#[derive(Debug, Clone)]
pub struct GpuContext {
    pub adapter: Rc<wgpu::Adapter>,
    pub device: Rc<wgpu::Device>,
    pub queue: Rc<wgpu::Queue>,
    pub health: DeviceHealth,
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    use super::{DeviceHealth, DeviceHealthState, GpuRuntimeOptions};

    #[test]
    fn gpu_runtime_options_default_to_browser_compatible_limits() {
        let options = GpuRuntimeOptions::default();

        assert_eq!(
            options.power_preference,
            wgpu::PowerPreference::HighPerformance
        );
        assert!(options.required_features.is_empty());
        assert_eq!(
            options.required_limits.max_texture_dimension_2d,
            wgpu::Limits::downlevel_webgl2_defaults().max_texture_dimension_2d
        );
        assert!(options.label.is_none());
    }

    #[test]
    fn device_health_notifies_each_listener_once_on_first_loss() {
        let health = DeviceHealth::default();
        let notifications = Arc::new(AtomicUsize::new(0));
        let listener_notifications = notifications.clone();
        health.subscribe(Arc::new(move |_| {
            listener_notifications.fetch_add(1, Ordering::SeqCst);
        }));

        health.mark_lost(wgpu::DeviceLostReason::Unknown, "first".to_string());
        health.mark_lost(wgpu::DeviceLostReason::Destroyed, "second".to_string());

        assert_eq!(notifications.load(Ordering::SeqCst), 1);
        assert_eq!(health.snapshot().state, DeviceHealthState::Lost);
        assert!(health.check().is_err());
    }

    #[test]
    fn device_health_unsubscribe_detaches_listener() {
        let health = DeviceHealth::default();
        let notifications = Arc::new(AtomicUsize::new(0));
        let listener_notifications = notifications.clone();
        let listener_id = health.subscribe(Arc::new(move |_| {
            listener_notifications.fetch_add(1, Ordering::SeqCst);
        }));
        health.unsubscribe(listener_id);

        health.mark_lost(wgpu::DeviceLostReason::Unknown, "lost".to_string());

        assert_eq!(notifications.load(Ordering::SeqCst), 0);
    }
}
