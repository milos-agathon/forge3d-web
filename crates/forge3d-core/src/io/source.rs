//! Browser-safe byte source contracts for frontend-owned IO adapters.

use crate::error::{Forge3dError, Result};
use async_trait::async_trait;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ByteSourceKind {
    Memory,
    Url,
    Blob,
    File,
    ArrayBuffer,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ByteRange {
    offset: u64,
    length: Option<u64>,
}

impl ByteRange {
    pub fn new(offset: u64, length: Option<u64>) -> Result<Self> {
        if let Some(length) = length {
            offset
                .checked_add(length)
                .ok_or_else(|| Forge3dError::InvalidInput {
                    field: "byteRange".to_string(),
                    message: "offset + length overflowed".to_string(),
                })?;
        }
        Ok(Self { offset, length })
    }

    pub fn offset(self) -> u64 {
        self.offset
    }

    pub fn length(self) -> Option<u64> {
        self.length
    }

    pub fn end_exclusive(self) -> Option<u64> {
        self.length.map(|length| self.offset + length)
    }

    fn bounds_for_len(self, len: usize) -> Result<(usize, usize)> {
        let start = usize::try_from(self.offset).map_err(|_| Forge3dError::InvalidInput {
            field: "byteRange.offset".to_string(),
            message: "offset does not fit in usize".to_string(),
        })?;
        if start > len {
            return Err(Forge3dError::InvalidInput {
                field: "byteRange.offset".to_string(),
                message: "offset is beyond the source length".to_string(),
            });
        }

        let end = match self.length {
            Some(length) => {
                let length = usize::try_from(length).map_err(|_| Forge3dError::InvalidInput {
                    field: "byteRange.length".to_string(),
                    message: "length does not fit in usize".to_string(),
                })?;
                start
                    .checked_add(length)
                    .filter(|end| *end <= len)
                    .ok_or_else(|| Forge3dError::InvalidInput {
                        field: "byteRange.length".to_string(),
                        message: "range extends beyond the source length".to_string(),
                    })?
            }
            None => len,
        };

        Ok((start, end))
    }
}

#[async_trait(?Send)]
pub trait ByteSource {
    fn kind(&self) -> ByteSourceKind;
    fn len(&self) -> Option<u64>;
    async fn read_range(&self, range: Option<ByteRange>) -> Result<Vec<u8>>;

    async fn read_all(&self) -> Result<Vec<u8>> {
        self.read_range(None).await
    }
}

#[derive(Debug, Clone)]
pub struct InMemoryByteSource {
    bytes: Vec<u8>,
}

impl InMemoryByteSource {
    pub fn new(bytes: Vec<u8>) -> Self {
        Self { bytes }
    }
}

#[async_trait(?Send)]
impl ByteSource for InMemoryByteSource {
    fn kind(&self) -> ByteSourceKind {
        ByteSourceKind::Memory
    }

    fn len(&self) -> Option<u64> {
        Some(self.bytes.len() as u64)
    }

    async fn read_range(&self, range: Option<ByteRange>) -> Result<Vec<u8>> {
        let range = range.unwrap_or(ByteRange {
            offset: 0,
            length: None,
        });
        let (start, end) = range.bounds_for_len(self.bytes.len())?;
        Ok(self.bytes[start..end].to_vec())
    }
}

pub fn bytes_to_f32_le(bytes: &[u8], expected_count: Option<usize>) -> Result<Vec<f32>> {
    if bytes.len() % std::mem::size_of::<f32>() != 0 {
        return Err(Forge3dError::InvalidInput {
            field: "source".to_string(),
            message: "height bytes length must be a multiple of 4".to_string(),
        });
    }

    let count = bytes.len() / std::mem::size_of::<f32>();
    if let Some(expected_count) = expected_count {
        if count != expected_count {
            return Err(Forge3dError::InvalidInput {
                field: "source".to_string(),
                message: format!(
                    "height byte source contains {count} f32 values, expected {expected_count}"
                ),
            });
        }
    }

    Ok(bytes
        .chunks_exact(std::mem::size_of::<f32>())
        .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::{bytes_to_f32_le, ByteRange, ByteSource, InMemoryByteSource};

    #[test]
    fn byte_range_rejects_overflow() {
        let error = ByteRange::new(u64::MAX, Some(2)).unwrap_err();

        assert!(error.to_string().contains("overflow"));
    }

    #[test]
    fn fake_source_reads_full_and_ranged_bytes() {
        let source = InMemoryByteSource::new(vec![1, 2, 3, 4, 5, 6]);

        let full = pollster::block_on(source.read_range(None)).unwrap();
        let ranged =
            pollster::block_on(source.read_range(Some(ByteRange::new(2, Some(3)).unwrap())))
                .unwrap();

        assert_eq!(full, vec![1, 2, 3, 4, 5, 6]);
        assert_eq!(ranged, vec![3, 4, 5]);
    }

    #[test]
    fn little_endian_f32_decoder_validates_length_and_expected_count() {
        let bytes = [0u8, 0, 0, 0, 0, 0, 128, 63];

        let values = bytes_to_f32_le(&bytes, Some(2)).unwrap();
        let error = bytes_to_f32_le(&bytes[..7], None).unwrap_err();

        assert_eq!(values, vec![0.0, 1.0]);
        assert!(error.to_string().contains("multiple of 4"));
    }
}
