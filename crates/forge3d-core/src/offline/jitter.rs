//! Deterministic sub-pixel jitter for offline accumulation.
//!
//! Ports the native `terrain::accumulation::JitterSequence` (R2 sequence with a
//! seeded start) and `core::jitter` (Halton 2/3) so browser accumulation visits
//! exactly the native sample offsets.

use glam::Mat4;

/// Plastic constant: the generalized golden ratio for two dimensions.
const PHI2: f64 = 1.324_717_957_244_746_025_96;

/// Radical-inverse Halton value for `index` in `base`, in `[0, 1)`.
pub fn halton(index: u32, base: u32) -> f32 {
    let mut result = 0.0f32;
    let mut f = 1.0f32;
    let mut i = index;
    while i > 0 {
        f /= base as f32;
        result += f * (i % base) as f32;
        i /= base;
    }
    result
}

/// Pixel-centered Halton(2,3) offset in `[-0.5, 0.5]` (native TAA jitter).
pub fn halton_2_3(frame_index: u32, sequence_length: u32) -> [f32; 2] {
    let index = (frame_index % sequence_length.max(1)) + 1;
    [halton(index, 2) - 0.5, halton(index, 3) - 0.5]
}

/// Native offline jitter: an R2 low-discrepancy sequence of pixel offsets in
/// `[-0.5, 0.5]`. A single-sample sequence is the unjittered pixel center.
#[derive(Debug, Clone, PartialEq)]
pub struct JitterSequence {
    offsets: Vec<[f32; 2]>,
    cursor: usize,
}

impl JitterSequence {
    pub fn new(sample_count: u32, seed: Option<u64>) -> Self {
        Self {
            offsets: r2_offsets(sample_count, seed),
            cursor: 0,
        }
    }

    pub fn len(&self) -> usize {
        self.offsets.len()
    }

    pub fn is_empty(&self) -> bool {
        self.offsets.is_empty()
    }

    pub fn get(&self, index: usize) -> [f32; 2] {
        self.offsets[index % self.offsets.len()]
    }

    /// Next offset; the sequence wraps like the native generator.
    pub fn next_offset(&mut self) -> [f32; 2] {
        let offset = self.offsets[self.cursor];
        self.cursor = (self.cursor + 1) % self.offsets.len();
        offset
    }

    pub fn reset(&mut self) {
        self.cursor = 0;
    }

    pub fn offsets(&self) -> &[[f32; 2]] {
        &self.offsets
    }
}

fn r2_offsets(count: u32, seed: Option<u64>) -> Vec<[f32; 2]> {
    if count <= 1 {
        return vec![[0.0, 0.0]];
    }
    let alpha1 = 1.0 / PHI2;
    let alpha2 = 1.0 / (PHI2 * PHI2);
    let start = seed.unwrap_or(0) as f64 * 0.5;
    (0..count)
        .map(|i| {
            let n = i as f64 + start;
            let x = ((n * alpha1) % 1.0) as f32;
            let y = ((n * alpha2) % 1.0) as f32;
            [x - 0.5, y - 0.5]
        })
        .collect()
}

/// Shifts a clip-space matrix by a sub-pixel offset: `T(ndc) * matrix`.
///
/// For perspective projections this is exactly the native
/// `apply_jitter_to_projection` (only column 2 carries clip `w`); applying it to
/// the full view-projection is equivalent because the translation acts in
/// clip space. Orthographic matrices shift through their translation column.
pub fn jitter_clip_matrix(matrix: Mat4, jitter: [f32; 2], width: u32, height: u32) -> Mat4 {
    let ndc_x = (2.0 * jitter[0]) / width.max(1) as f32;
    let ndc_y = (2.0 * jitter[1]) / height.max(1) as f32;
    let mut jittered = matrix;
    for column in 0..4 {
        let w = matrix.col(column).w;
        let target = jittered.col_mut(column);
        target.x += ndc_x * w;
        target.y += ndc_y * w;
    }
    jittered
}
