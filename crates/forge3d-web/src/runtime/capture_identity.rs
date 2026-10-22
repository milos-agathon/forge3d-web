use crate::error::{Forge3DErrorCode, WebError};
pub(crate) const TERRAIN: u32 = 1;
pub(crate) const SCENE_BASE: u32 = 2;
pub(crate) const VECTOR: u32 = 0xffffffef;
pub(crate) const WATER_BASE: u32 = 0xfffffff0;
pub(crate) const SCATTER_BASE: u32 = 0x100000;
const FLOAT_EXACT_END: u32 = 1 << 24;
fn invalid(message: &str) -> WebError {
    WebError::new(Forge3DErrorCode::InvalidInput, message)
}
pub(crate) fn scene(node: u32) -> Result<u32, WebError> {
    node.checked_add(SCENE_BASE)
        .filter(|id| *id < VECTOR)
        .ok_or_else(|| invalid("scene node ID overlaps the reserved AOV namespace"))
}
/// Assign contiguous scatter IDs only after checking every competing scene ID.
pub(crate) fn scatter_starts(
    counts: impl IntoIterator<Item = usize>,
    scene_ids: &[u32],
) -> Result<Vec<u32>, WebError> {
    let mut end = SCATTER_BASE;
    let mut starts = Vec::new();
    for count in counts {
        starts.push(end);
        end = end
            .checked_add(u32::try_from(count).map_err(|_| invalid("scatter instance ID overflow"))?)
            .filter(|end| *end <= FLOAT_EXACT_END)
            .ok_or_else(|| invalid("scatter IDs exceed exact float payload range"))?;
    }
    if scene_ids.iter().any(|id| *id >= SCATTER_BASE && *id < end) {
        return Err(invalid("scene and scatter capture object IDs overlap"));
    }
    Ok(starts)
}
pub(crate) fn water(layer: u32) -> Result<u32, WebError> {
    WATER_BASE
        .checked_add(layer)
        .filter(|_| layer < forge3d_core::environment::payload::WATER_CAPACITY as u32)
        .ok_or_else(|| invalid("water capture layer out of range"))
}
#[derive(Debug, PartialEq, Eq)]
#[allow(dead_code)]
pub(crate) enum Producer {
    Background,
    Terrain,
    SceneNode(u32),
    Scatter { batch: usize, instance: u32 },
    VectorSurface,
    Water(u32),
}
/// Decode only against validated assignments; numeric scene/scatter ranges alone are ambiguous.
#[allow(dead_code)]
pub(crate) fn decode(
    id: u32,
    scene_ids: &[u32],
    scatter_counts: &[usize],
) -> Result<Producer, WebError> {
    let starts = scatter_starts(scatter_counts.iter().copied(), scene_ids)?;
    match id {
        0 => return Ok(Producer::Background),
        TERRAIN => return Ok(Producer::Terrain),
        VECTOR => return Ok(Producer::VectorSurface),
        WATER_BASE.. => {
            let layer = id - WATER_BASE;
            water(layer)?;
            return Ok(Producer::Water(layer));
        }
        _ => {}
    }
    if scene_ids.contains(&id) {
        return id
            .checked_sub(SCENE_BASE)
            .map(Producer::SceneNode)
            .ok_or_else(|| invalid("invalid scene capture ID"));
    }
    for (batch, (&start, &count)) in starts.iter().zip(scatter_counts).enumerate() {
        if id >= start && (id - start) < count as u32 {
            return Ok(Producer::Scatter {
                batch,
                instance: id - start,
            });
        }
    }
    Err(invalid("capture object ID has no assigned producer"))
}
pub(crate) fn specialize(source: String) -> String {
    source.replace("__CAPTURE_WATER_BASE__", &format!("{WATER_BASE}u"))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn capture_assignments_reject_collisions_and_float_overflow() {
        assert_eq!(scene(SCATTER_BASE - 2).unwrap(), SCATTER_BASE);
        assert!(scatter_starts([1], &[SCATTER_BASE]).is_err());
        assert_eq!(
            scatter_starts([2, 3], &[SCATTER_BASE - 1]).unwrap(),
            vec![SCATTER_BASE, SCATTER_BASE + 2]
        );
        assert!(scatter_starts([(FLOAT_EXACT_END - SCATTER_BASE) as usize + 1], &[]).is_err());
        assert!(scene(VECTOR - SCENE_BASE).is_err());
        assert_eq!(water(0).unwrap(), WATER_BASE);
        assert!(water(16).is_err());
    }
}

#[cfg(test)]
mod decoding_tests {
    use super::*;
    #[test]
    fn decoding_uses_validated_producer_assignments() {
        assert_eq!(
            decode(SCATTER_BASE, &[SCATTER_BASE], &[]).unwrap(),
            Producer::SceneNode(SCATTER_BASE - SCENE_BASE)
        );
        assert_eq!(
            decode(SCATTER_BASE + 2, &[2], &[2, 3]).unwrap(),
            Producer::Scatter {
                batch: 1,
                instance: 0
            }
        );
        assert!(decode(SCATTER_BASE, &[SCATTER_BASE], &[1]).is_err());
        assert_eq!(decode(VECTOR, &[], &[]).unwrap(), Producer::VectorSurface);
        assert_eq!(
            decode(water(0).unwrap(), &[], &[]).unwrap(),
            Producer::Water(0)
        );
        assert!(decode(999, &[], &[]).is_err());
    }
}
