use crate::error::{Forge3dError, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BufferSlice {
    pub chunk: usize,
    pub offset: u64,
    pub size: u64,
}

#[derive(Debug)]
pub struct ChunkedBuffer {
    chunk_size: u64,
    max_chunks: usize,
    chunks: Vec<u64>,
}

impl ChunkedBuffer {
    pub fn new(chunk_size: u64, max_chunks: usize) -> Result<Self> {
        if chunk_size == 0 {
            return invalid("chunk_size", "must be greater than zero");
        }
        if max_chunks == 0 {
            return invalid("max_chunks", "must be greater than zero");
        }
        Ok(Self {
            chunk_size,
            max_chunks,
            chunks: Vec::new(),
        })
    }

    pub fn allocate(&mut self, size: u64, alignment: u64) -> Result<BufferSlice> {
        if size == 0 {
            return invalid("size", "must be greater than zero");
        }
        if size > self.chunk_size {
            return invalid("size", "request exceeds chunk size");
        }
        if alignment == 0 || !alignment.is_power_of_two() {
            return invalid("alignment", "must be a nonzero power of two");
        }

        if let Some(used) = self.chunks.last_mut() {
            let offset = align_up(*used, alignment)?;
            let end = offset
                .checked_add(size)
                .ok_or_else(|| Forge3dError::InvalidInput {
                    field: "size".to_string(),
                    message: "chunk offset overflowed".to_string(),
                })?;
            if end <= self.chunk_size {
                *used = end;
                return Ok(BufferSlice {
                    chunk: self.chunks.len() - 1,
                    offset,
                    size,
                });
            }
        }

        if self.chunks.len() >= self.max_chunks {
            return Err(Forge3dError::ResourceLimitExceeded {
                resource: "chunked_buffer".to_string(),
                message: "chunk capacity exhausted".to_string(),
            });
        }
        self.chunks.push(size);
        Ok(BufferSlice {
            chunk: self.chunks.len() - 1,
            offset: 0,
            size,
        })
    }

    pub fn reset(&mut self) {
        self.chunks.clear();
    }

    pub fn allocated_bytes(&self) -> u64 {
        self.chunks.iter().sum()
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
