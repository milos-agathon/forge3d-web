use crate::error::{Forge3dError, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TimingSource {
    GpuTimestamp,
    Cpu,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PassTiming {
    pub name: String,
    pub milliseconds: f64,
    pub source: TimingSource,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RenderStats {
    pub frame_index: u64,
    pub frame_time_ms: f64,
    pub draw_calls: u32,
    pub triangles: u64,
    pub passes: Vec<PassTiming>,
}

#[derive(Debug)]
pub struct FrameTimer {
    timestamp_query_supported: bool,
    frame_index: u64,
    pending: Vec<PassTiming>,
}

impl FrameTimer {
    pub fn new(timestamp_query_supported: bool) -> Self {
        Self {
            timestamp_query_supported,
            frame_index: 0,
            pending: Vec::new(),
        }
    }

    pub fn source(&self) -> TimingSource {
        if self.timestamp_query_supported {
            TimingSource::GpuTimestamp
        } else {
            TimingSource::Cpu
        }
    }

    pub fn begin_frame(&mut self) {
        self.pending.clear();
    }

    pub fn record_cpu(&mut self, name: impl Into<String>, milliseconds: f64) -> Result<()> {
        self.record(name, milliseconds, TimingSource::Cpu)
    }

    pub fn record_gpu(&mut self, name: impl Into<String>, milliseconds: f64) -> Result<()> {
        self.record(name, milliseconds, self.source())
    }

    pub fn finish_frame(
        &mut self,
        frame_time_ms: f64,
        draw_calls: u32,
        triangles: u64,
    ) -> Result<RenderStats> {
        validate_milliseconds(frame_time_ms)?;
        let stats = RenderStats {
            frame_index: self.frame_index,
            frame_time_ms,
            draw_calls,
            triangles,
            passes: std::mem::take(&mut self.pending),
        };
        self.frame_index += 1;
        Ok(stats)
    }

    fn record(
        &mut self,
        name: impl Into<String>,
        milliseconds: f64,
        source: TimingSource,
    ) -> Result<()> {
        validate_milliseconds(milliseconds)?;
        self.pending.push(PassTiming {
            name: name.into(),
            milliseconds,
            source,
        });
        Ok(())
    }
}

fn validate_milliseconds(milliseconds: f64) -> Result<()> {
    if !milliseconds.is_finite() || milliseconds < 0.0 {
        return Err(Forge3dError::InvalidInput {
            field: "milliseconds".to_string(),
            message: "timing must be finite and nonnegative".to_string(),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests;
