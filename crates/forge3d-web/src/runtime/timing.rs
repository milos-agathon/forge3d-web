use super::gpu_completion::Completion;

use forge3d_core::timing::{RenderStats, TimingSource};
use wasm_bindgen::JsValue;

use super::device_health::set_js_property;

pub(super) const TIMESTAMP_QUERIES_PER_SLOT: u32 = 4;
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
const TIMESTAMP_SLOTS: usize = 2;
const QUERY_RESULT_BYTES: u64 = TIMESTAMP_QUERIES_PER_SLOT as u64 * 8;

#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) struct GpuPassTiming {
    pub world_ms: f64,
    pub overlay_ms: f64,
}

struct TimestampSlot {
    resolve_buffer: wgpu::Buffer,
    map_buffer: wgpu::Buffer,
    completion: Completion,
}

pub(super) struct TimestampRing {
    query_set: wgpu::QuerySet,
    slots: Vec<TimestampSlot>,
    period_ns: f64,
    latest: Option<GpuPassTiming>,
}

impl TimestampRing {
    #[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
    pub(super) fn new(device: &wgpu::Device, queue: &wgpu::Queue) -> Self {
        let query_set = device.create_query_set(&wgpu::QuerySetDescriptor {
            label: Some("forge3d-web-timestamp-ring"),
            ty: wgpu::QueryType::Timestamp,
            count: TIMESTAMP_QUERIES_PER_SLOT * TIMESTAMP_SLOTS as u32,
        });
        let slots = (0..TIMESTAMP_SLOTS)
            .map(|_| TimestampSlot {
                resolve_buffer: device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some("forge3d-web-timestamp-resolve"),
                    size: QUERY_RESULT_BYTES,
                    usage: wgpu::BufferUsages::QUERY_RESOLVE | wgpu::BufferUsages::COPY_SRC,
                    mapped_at_creation: false,
                }),
                map_buffer: device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some("forge3d-web-timestamp-map"),
                    size: QUERY_RESULT_BYTES,
                    usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
                    mapped_at_creation: false,
                }),
                completion: Completion::default(),
            })
            .collect();
        Self {
            query_set,
            slots,
            period_ns: queue.get_timestamp_period() as f64,
            latest: None,
        }
    }

    pub(super) fn acquire(&mut self) -> Option<usize> {
        self.slots.iter().position(|slot| slot.completion.idle())
    }

    pub(super) fn pass_writes(
        &self,
        slot: usize,
        pass_group: u32,
    ) -> wgpu::RenderPassTimestampWrites<'_> {
        let base = slot as u32 * TIMESTAMP_QUERIES_PER_SLOT + pass_group * 2;
        wgpu::RenderPassTimestampWrites {
            query_set: &self.query_set,
            beginning_of_pass_write_index: Some(base),
            end_of_pass_write_index: Some(base + 1),
        }
    }

    pub(super) fn resolve_into(&mut self, encoder: &mut wgpu::CommandEncoder, slot: usize) {
        if !self.slots[slot].completion.submit() {
            return;
        }
        let first = slot as u32 * TIMESTAMP_QUERIES_PER_SLOT;
        encoder.resolve_query_set(
            &self.query_set,
            first..first + TIMESTAMP_QUERIES_PER_SLOT,
            &self.slots[slot].resolve_buffer,
            0,
        );
        encoder.copy_buffer_to_buffer(
            &self.slots[slot].resolve_buffer,
            0,
            &self.slots[slot].map_buffer,
            0,
            QUERY_RESULT_BYTES,
        );
    }

    pub(super) fn begin_map(&mut self, slot: usize) {
        let slot = &self.slots[slot];
        slot.completion
            .begin_map(&slot.map_buffer, QUERY_RESULT_BYTES);
    }
    pub(super) fn harvest(&mut self) {
        for slot in &self.slots {
            if let Some(Ok(values)) =
                slot.completion
                    .harvest(&slot.map_buffer, QUERY_RESULT_BYTES, |view| {
                        let mut values = [0u64; TIMESTAMP_QUERIES_PER_SLOT as usize];
                        for (i, chunk) in view.chunks_exact(8).take(4).enumerate() {
                            values[i] = u64::from_le_bytes(chunk.try_into().unwrap_or([0; 8]));
                        }
                        values
                    })
            {
                let world_ms =
                    values[1].saturating_sub(values[0]) as f64 * self.period_ns / 1_000_000.;
                let overlay_ms =
                    values[3].saturating_sub(values[2]) as f64 * self.period_ns / 1_000_000.;
                if world_ms.is_finite() && overlay_ms.is_finite() {
                    self.latest = Some(GpuPassTiming {
                        world_ms: world_ms.max(0.),
                        overlay_ms: overlay_ms.max(0.),
                    });
                }
            }
        }
    }

    pub(super) fn latest(&self) -> Option<GpuPassTiming> {
        self.latest
    }
}

pub(super) struct PassDraw {
    pub name: String,
    pub group: PassGroup,
    pub draws: u32,
    pub triangles: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum PassGroup {
    World,
    Overlay,
    Noop,
}

pub(super) fn world_draw_count(passes: &[PassDraw]) -> u32 {
    passes
        .iter()
        .filter(|pass| pass.group == PassGroup::World)
        .map(|pass| pass.draws)
        .sum()
}

pub(super) fn pass_milliseconds(
    pass: &PassDraw,
    world_ms: f64,
    overlay_ms: f64,
    world_draws: u32,
) -> Option<f64> {
    let milliseconds = match pass.group {
        PassGroup::World => {
            if world_draws == 0 {
                0.0
            } else {
                world_ms * f64::from(pass.draws) / f64::from(world_draws)
            }
        }
        PassGroup::Overlay => overlay_ms,
        PassGroup::Noop => 0.0,
    };
    if milliseconds.is_finite() && milliseconds >= 0.0 {
        Some(milliseconds)
    } else {
        None
    }
}

#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub(super) fn now_ms() -> f64 {
    js_sys::Date::now()
}

pub(super) fn stats_to_js(stats: &RenderStats) -> JsValue {
    let out = js_sys::Object::new();
    set_js_property(
        out.as_ref(),
        "frameIndex",
        &JsValue::from_f64(stats.frame_index as f64),
    );
    set_js_property(
        out.as_ref(),
        "frameTimeMs",
        &JsValue::from_f64(stats.frame_time_ms),
    );
    set_js_property(
        out.as_ref(),
        "drawCalls",
        &JsValue::from_f64(f64::from(stats.draw_calls)),
    );
    set_js_property(
        out.as_ref(),
        "triangles",
        &JsValue::from_f64(stats.triangles as f64),
    );
    let passes = js_sys::Array::new();
    for pass in &stats.passes {
        let entry = js_sys::Object::new();
        set_js_property(entry.as_ref(), "name", &JsValue::from_str(&pass.name));
        set_js_property(
            entry.as_ref(),
            "milliseconds",
            &JsValue::from_f64(pass.milliseconds),
        );
        set_js_property(
            entry.as_ref(),
            "timing",
            &JsValue::from_str(match pass.source {
                TimingSource::GpuTimestamp => "gpu-timestamp",
                TimingSource::Cpu => "cpu",
            }),
        );
        passes.push(entry.as_ref());
    }
    set_js_property(out.as_ref(), "passes", passes.as_ref());
    out.into()
}

#[cfg(test)]
mod tests;
