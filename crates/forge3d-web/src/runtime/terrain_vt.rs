//! W08 (E6): GPU-side terrain material virtual texturing.
//!
//! Wraps the GPU-free `forge3d_core::terrain_vt::VtRuntimeState` with the
//! real resources: the Rgba8UnormSrgb tile atlas (bound at the material
//! albedo slot, binding 8, with the VT sampler at binding 9), the
//! RGBA32Float page table (binding 17), the uniform block (binding 18) and
//! the fragment-written feedback ring (binding 19). Per frame the display
//! and capture paths reset stats, collect requests (rect + pending
//! feedback), stream newly requested tiles into atlas slots via
//! `queue.write_texture`, refresh dirty page-table layers, clear the
//! feedback buffer before the pass and copy it into a MAP_READ staging
//! buffer afterwards; `map_async` runs without blocking and the completed
//! readback feeds `apply_feedback` on a later frame.

use std::sync::{Arc, Mutex};

use forge3d_core::terrain_vt::{
    FeedbackEntry, TerrainVtSettings, VtLayerFamily, VtRuntimeState, VtSourceRegistry, VtStats,
    VtViewParams, TERRAIN_VT_MATERIAL_CAPACITY,
};
use wgpu::util::DeviceExt;

use crate::error::{map_core_error, WebError};

/// WGSL `TerrainVTUniforms` mirror (binding 18): 112 bytes.
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub(super) struct TerrainVTUniformsGpu {
    /// [enabled, tile_size, tile_border, atlas_size].
    pub config0: [u32; 4],
    /// [virtual_size_x, virtual_size_y, pages_x_mip0, pages_y_mip0].
    pub config1: [u32; 4],
    /// [max_mip_levels, material_count, unused, use_feedback].
    pub config2: [u32; 4],
    /// Per-material fallback colors.
    pub colors: [[f32; 4]; TERRAIN_VT_MATERIAL_CAPACITY],
}

/// WGSL `TerrainVTFeedbackEntry` mirror (binding 19 element): 16 bytes.
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct VtFeedbackEntryGpu {
    tile_x: u32,
    tile_y: u32,
    mip_level: u32,
    /// `material_index + 1`. The ring is zeroed before every frame, so an
    /// untouched slot reads `0` (and `0xFFFFFFFF` before the first clear);
    /// `decode_feedback` drops both.
    frame_number: u32,
}

#[derive(Debug, Default)]
enum FeedbackMapState {
    #[default]
    Idle,
    /// The map callback completed; the staging buffer can be read.
    Mapped,
}

/// Sub-millisecond clock for upload timing (`performance.now` in browsers,
/// `Date::now` fallback elsewhere).
#[cfg(target_arch = "wasm32")]
fn perf_now_ms() -> f64 {
    web_sys::window()
        .and_then(|window| window.performance())
        .map(|performance| performance.now())
        .unwrap_or_else(super::timing::now_ms)
}

#[cfg(not(target_arch = "wasm32"))]
fn perf_now_ms() -> f64 {
    0.0
}

/// `queue.write_texture` rejects row pitches that are not a multiple of
/// `COPY_BYTES_PER_ROW_ALIGNMENT`; tile slot sizes are user-controlled, so
/// rows are padded out to the alignment before upload.
pub(super) fn pad_rows(data: &[u8], row_bytes: usize, rows: usize) -> (Vec<u8>, u32) {
    let pitch = wgpu::util::align_to(row_bytes, wgpu::COPY_BYTES_PER_ROW_ALIGNMENT as usize);
    if pitch == row_bytes {
        return (data.to_vec(), row_bytes as u32);
    }
    let mut padded = vec![0u8; pitch * rows];
    for row in 0..rows {
        padded[row * pitch..row * pitch + row_bytes]
            .copy_from_slice(&data[row * row_bytes..(row + 1) * row_bytes]);
    }
    (padded, pitch as u32)
}

/// Bytes the VT block owns on the GPU (ledger `terrain:vt`): atlas + page
/// table + uniforms + feedback ring + readback staging.
pub(super) fn vt_gpu_bytes(
    settings: &TerrainVtSettings,
    layer: &VtLayerFamily,
    material_count: u32,
    max_mip_levels: u32,
) -> u64 {
    let atlas = u64::from(settings.atlas_size) * u64::from(settings.atlas_size) * 4;
    let base_pages = u64::from(layer.pages_x0()) * u64::from(layer.pages_y0());
    let page_table = base_pages * u64::from(material_count) * u64::from(max_mip_levels) * 16;
    let feedback = base_pages * u64::from(material_count) * u64::from(max_mip_levels) * 16;
    atlas + page_table + std::mem::size_of::<TerrainVTUniformsGpu>() as u64 + feedback * 2
}

pub(super) struct TerrainVtState {
    pub state: VtRuntimeState,
    residency_budget_mb: f32,
    use_feedback: bool,
    atlas: wgpu::Texture,
    /// D2Array view of the atlas — bound at material binding 8 under VT.
    pub atlas_view: wgpu::TextureView,
    /// Bound at material binding 9 under VT.
    pub atlas_sampler: wgpu::Sampler,
    page_table: wgpu::Texture,
    pub page_table_view: wgpu::TextureView,
    pub uniform_buffer: wgpu::Buffer,
    pub feedback_buffer: wgpu::Buffer,
    feedback_staging: wgpu::Buffer,
    feedback_bytes: u64,
    map_state: Arc<Mutex<FeedbackMapState>>,
    map_pending: bool,
    /// Owned GPU bytes (ledger `terrain:vt`).
    gpu_bytes: u64,
}

/// CPU half of a VT commit: the core runtime state prepared from the
/// registry and its `terrain:vt` ledger bytes, known before anything is
/// allocated so the commit can pre-check the whole W08 footprint.
pub(super) struct TerrainVtPlan {
    state: VtRuntimeState,
    pub gpu_bytes: u64,
}

impl TerrainVtPlan {
    pub(super) fn new(
        registry: &VtSourceRegistry,
        layer: &VtLayerFamily,
        settings: &TerrainVtSettings,
        material_count: u32,
    ) -> Result<Self, WebError> {
        let state = VtRuntimeState::new(registry, layer, settings, material_count)
            .map_err(map_core_error)?;
        let gpu_bytes = vt_gpu_bytes(
            settings,
            layer,
            state.material_count(),
            state.max_mip_levels(),
        );
        Ok(Self { state, gpu_bytes })
    }
}

impl TerrainVtState {
    /// Allocate the atlas/page-table/feedback block for a planned VT
    /// commit. Nothing is uploaded yet — the first `frame` streams the
    /// initially requested tiles.
    pub(super) fn new(
        context: &forge3d_core::gpu::GpuContext,
        plan: TerrainVtPlan,
        layer: &VtLayerFamily,
        settings: &TerrainVtSettings,
    ) -> Result<Self, WebError> {
        let device = &context.device;
        let TerrainVtPlan { state, gpu_bytes } = plan;
        let atlas_size = settings.atlas_size;

        let atlas = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("forge3d-web-terrain-vt-atlas"),
            size: wgpu::Extent3d {
                width: atlas_size,
                height: atlas_size,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8UnormSrgb,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        // Binding 8 declares `texture_2d_array<f32>`: view the single-layer
        // atlas as a one-layer array.
        let atlas_view = atlas.create_view(&wgpu::TextureViewDescriptor {
            label: Some("forge3d-web-terrain-vt-atlas"),
            dimension: Some(wgpu::TextureViewDimension::D2Array),
            ..Default::default()
        });
        let atlas_sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("forge3d-web-terrain-vt-sampler"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::MipmapFilterMode::Nearest,
            ..Default::default()
        });

        let layers = (state.material_count() * state.max_mip_levels()).max(1);
        let page_table = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("forge3d-web-terrain-vt-page-table"),
            size: wgpu::Extent3d {
                width: state.pages_x0(),
                height: state.pages_y0(),
                depth_or_array_layers: layers,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba32Float,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        let page_table_view = page_table.create_view(&wgpu::TextureViewDescriptor {
            label: Some("forge3d-web-terrain-vt-page-table"),
            dimension: Some(wgpu::TextureViewDimension::D2Array),
            ..Default::default()
        });

        let uniforms = TerrainVTUniformsGpu {
            config0: [1, state.tile_size(), state.tile_border(), atlas_size],
            config1: [
                layer.virtual_size_px.0,
                layer.virtual_size_px.1,
                state.pages_x0(),
                state.pages_y0(),
            ],
            config2: [
                state.max_mip_levels(),
                state.material_count(),
                0,
                u32::from(state.use_feedback()),
            ],
            colors: state.fallback_colors(layer.fallback),
        };
        let uniform_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("forge3d-web-terrain-vt-uniforms"),
            contents: bytemuck::bytes_of(&uniforms),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });

        let feedback_entries = u64::from(state.material_count())
            * u64::from(state.max_mip_levels())
            * u64::from(state.pages_x0())
            * u64::from(state.pages_y0());
        let feedback_bytes = feedback_entries.max(1) * 16;
        // 0xFF init: untouched slots decode to material index 0xFFFFFFFE
        // which `apply_feedback` drops (not a registered source).
        let feedback_init = vec![0xFFu8; feedback_bytes as usize];
        let feedback_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("forge3d-web-terrain-vt-feedback"),
            contents: &feedback_init,
            usage: wgpu::BufferUsages::STORAGE
                | wgpu::BufferUsages::COPY_DST
                | wgpu::BufferUsages::COPY_SRC,
        });
        let feedback_staging = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("forge3d-web-terrain-vt-feedback-staging"),
            size: feedback_bytes,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        Ok(Self {
            state,
            residency_budget_mb: settings.residency_budget_mb,
            use_feedback: settings.use_feedback,
            atlas,
            atlas_view,
            atlas_sampler,
            page_table,
            page_table_view,
            uniform_buffer,
            feedback_buffer,
            feedback_staging,
            feedback_bytes,
            map_state: Arc::new(Mutex::new(FeedbackMapState::Idle)),
            map_pending: false,
            gpu_bytes,
        })
    }

    /// Owned GPU bytes (ledger `terrain:vt`).
    pub(super) fn gpu_bytes(&self) -> u64 {
        self.gpu_bytes
    }

    fn view_params(
        &self,
        camera: &forge3d_core::camera::CameraInput,
        width: u32,
        height: u32,
        screen: bool,
        terrain_span: f32,
    ) -> VtViewParams {
        if screen {
            VtViewParams {
                camera_mode: "screen".to_string(),
                size_px: (width, height),
                cam_target: [0.0, 0.0, 0.0],
                terrain_span,
                cam_radius: 4.0,
                fov_y_deg: 50.0,
            }
        } else {
            let dx = camera.position[0] - camera.target[0];
            let dy = camera.position[1] - camera.target[1];
            let dz = camera.position[2] - camera.target[2];
            VtViewParams {
                camera_mode: "mesh".to_string(),
                size_px: (width, height),
                // Native cam_target is terrain-relative XZ (world X -> u,
                // world Z -> v).
                cam_target: [camera.target[0], camera.target[2], camera.target[1]],
                terrain_span,
                cam_radius: (dx * dx + dy * dy + dz * dz).sqrt().max(1e-3),
                fov_y_deg: camera.fov_y_degrees,
            }
        }
    }

    /// Per-frame residency pass (display + capture): harvest a completed
    /// feedback map, reset frame stats, collect requests, stream missing
    /// tiles into the atlas, upload dirty page-table layers.
    pub(super) fn frame(
        &mut self,
        context: &forge3d_core::gpu::GpuContext,
        camera: &forge3d_core::camera::CameraInput,
        width: u32,
        height: u32,
        screen: bool,
        terrain_span: f32,
    ) {
        self.harvest_feedback(context);
        self.state.reset_frame_stats(self.residency_budget_mb);
        let params = self.view_params(camera, width, height, screen, terrain_span);
        let requests = self
            .state
            .collect_requests(&params, width, height, self.use_feedback);
        for key in requests {
            if let Some(upload) = self.state.ensure_resident(key) {
                let start = perf_now_ms();
                let (data, pitch) =
                    pad_rows(&upload.rgba, upload.size as usize * 4, upload.size as usize);
                context.queue.write_texture(
                    wgpu::TexelCopyTextureInfo {
                        texture: &self.atlas,
                        mip_level: 0,
                        origin: wgpu::Origin3d {
                            x: upload.atlas_x,
                            y: upload.atlas_y,
                            z: 0,
                        },
                        aspect: wgpu::TextureAspect::All,
                    },
                    &data,
                    wgpu::TexelCopyBufferLayout {
                        offset: 0,
                        bytes_per_row: Some(pitch),
                        rows_per_image: Some(upload.size),
                    },
                    wgpu::Extent3d {
                        width: upload.size,
                        height: upload.size,
                        depth_or_array_layers: 1,
                    },
                );
                self.state.record_upload_ms((perf_now_ms() - start) as f32);
            }
        }
        let max_mip = self.state.max_mip_levels();
        for (material_index, mip) in self.state.take_dirty_layers() {
            if mip >= max_mip {
                continue;
            }
            let texels = self.state.page_table_texels(material_index, mip);
            let (pages_x, pages_y) = self.page_dims(mip);
            if texels.is_empty() || pages_x == 0 || pages_y == 0 {
                continue;
            }
            let flat: Vec<u8> = texels
                .iter()
                .flat_map(|entry| bytemuck::bytes_of(entry).to_vec())
                .collect();
            let (data, pitch) = pad_rows(&flat, pages_x as usize * 16, pages_y as usize);
            context.queue.write_texture(
                wgpu::TexelCopyTextureInfo {
                    texture: &self.page_table,
                    mip_level: 0,
                    origin: wgpu::Origin3d {
                        x: 0,
                        y: 0,
                        z: material_index * max_mip + mip,
                    },
                    aspect: wgpu::TextureAspect::All,
                },
                &data,
                wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(pitch),
                    rows_per_image: Some(pages_y),
                },
                wgpu::Extent3d {
                    width: pages_x,
                    height: pages_y,
                    depth_or_array_layers: 1,
                },
            );
        }
    }

    fn page_dims(&self, mip: u32) -> (u32, u32) {
        forge3d_core::terrain_vt::pages_for_mip_counts(
            self.state.pages_x0(),
            self.state.pages_y0(),
            mip,
        )
    }

    /// Clear the feedback ring before the render pass writes it (encoded
    /// ahead of the terrain pass each frame/capture, when feedback is on).
    pub(super) fn encode_frame_start(&self, encoder: &mut wgpu::CommandEncoder) {
        if self.use_feedback {
            encoder.clear_buffer(&self.feedback_buffer, 0, None);
        }
    }

    /// Copy the feedback ring into the MAP_READ staging buffer after the
    /// render pass. Skipped while a map is in flight — the newest completed
    /// copy always wins.
    pub(super) fn encode_frame_end(&self, encoder: &mut wgpu::CommandEncoder) {
        if self.use_feedback && !self.map_pending {
            encoder.copy_buffer_to_buffer(
                &self.feedback_buffer,
                0,
                &self.feedback_staging,
                0,
                self.feedback_bytes,
            );
        }
    }

    /// Start a non-blocking map of the staging buffer when a completed copy
    /// is waiting. `frame` harvests the result on a later pass.
    pub(super) fn begin_feedback_map(&mut self) {
        if !self.use_feedback || self.map_pending {
            return;
        }
        self.map_pending = true;
        let state = Arc::clone(&self.map_state);
        self.feedback_staging
            .slice(..)
            .map_async(wgpu::MapMode::Read, move |result| {
                if let Ok(mut guard) = state.lock() {
                    if result.is_ok() {
                        *guard = FeedbackMapState::Mapped;
                    }
                }
            });
    }

    /// Poll the device and apply a completed feedback readback without
    /// blocking (same shape as the LOD-select harvest).
    fn harvest_feedback(&mut self, context: &forge3d_core::gpu::GpuContext) {
        if !self.use_feedback || !self.map_pending {
            return;
        }
        let _ = context.device.poll(wgpu::PollType::Poll);
        let mut bytes = None;
        if let Ok(mut guard) = self.map_state.lock() {
            if matches!(*guard, FeedbackMapState::Mapped) {
                let view = self.feedback_staging.slice(..).get_mapped_range();
                bytes = Some(view.to_vec());
                drop(view);
                *guard = FeedbackMapState::Idle;
            }
        }
        if let Some(bytes) = bytes {
            self.feedback_staging.unmap();
            self.map_pending = false;
            let entries = decode_feedback(&bytes);
            self.state.apply_feedback(&entries);
        }
    }

    /// Snapshot stats for `getMaterialVtStats` (zero when disabled is
    /// handled by the caller — this state only exists when VT is enabled).
    pub(super) fn stats(&self) -> VtStats {
        self.state.stats()
    }
}

/// Native `parse_feedback_entries` (feedback_buffer.rs): empty slots
/// (`frame_number == 0`, or `u32::MAX` tile coordinates) are not requests,
/// and repeated entries collapse to one. First-seen order is kept (native
/// uses a `HashSet`) so `apply_feedback` stays deterministic.
fn decode_feedback(bytes: &[u8]) -> Vec<FeedbackEntry> {
    let mut seen = std::collections::HashSet::new();
    bytes
        .chunks_exact(std::mem::size_of::<VtFeedbackEntryGpu>())
        .filter_map(|chunk| {
            let entry: VtFeedbackEntryGpu = bytemuck::pod_read_unaligned(chunk);
            let empty =
                entry.frame_number == 0 || entry.tile_x == u32::MAX || entry.tile_y == u32::MAX;
            let key = (
                entry.tile_x,
                entry.tile_y,
                entry.mip_level,
                entry.frame_number,
            );
            (!empty && seen.insert(key)).then_some(FeedbackEntry {
                tile_x: entry.tile_x,
                tile_y: entry.tile_y,
                mip_level: entry.mip_level,
                frame_number: entry.frame_number,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ring(entries: &[[u32; 4]]) -> Vec<u8> {
        entries
            .iter()
            .flat_map(|&[tile_x, tile_y, mip_level, frame_number]| {
                bytemuck::bytes_of(&VtFeedbackEntryGpu {
                    tile_x,
                    tile_y,
                    mip_level,
                    frame_number,
                })
                .to_vec()
            })
            .collect()
    }

    #[test]
    fn decode_feedback_drops_empty_slots_and_duplicates() {
        let max = u32::MAX;
        let bytes = ring(&[
            [0, 0, 0, 0],
            [1, 2, 0, 1],
            [0, 0, 0, 0],
            [1, 2, 0, 1],
            [max, max, max, max],
            [3, 0, 1, 2],
            [max, 4, 0, 3],
            [0, 0, 0, 1],
        ]);
        let decoded: Vec<[u32; 4]> = decode_feedback(&bytes)
            .into_iter()
            .map(|e| [e.tile_x, e.tile_y, e.mip_level, e.frame_number])
            .collect();
        assert_eq!(decoded, vec![[1, 2, 0, 1], [3, 0, 1, 2], [0, 0, 0, 1]]);
    }

    #[test]
    fn decode_feedback_of_a_zeroed_ring_is_empty() {
        assert!(decode_feedback(&vec![0u8; 32 * 16]).is_empty());
        assert!(decode_feedback(&vec![0xFFu8; 32 * 16]).is_empty());
    }
}
