use crate::error::{Forge3DErrorCode, WebError};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BrowserByteSourceKind {
    Url,
    Blob,
    File,
    ArrayBuffer,
}

pub fn unsupported_source_for_phase6(kind: BrowserByteSourceKind) -> WebError {
    WebError::new(
        Forge3DErrorCode::UnsupportedFeature,
        format!("{kind:?} byte sources are scheduled for Phase 12"),
    )
}

#[cfg(test)]
mod tests {
    use super::{unsupported_source_for_phase6, BrowserByteSourceKind};

    #[test]
    fn phase6_browser_io_skeleton_reports_future_source_support() {
        let error = unsupported_source_for_phase6(BrowserByteSourceKind::Url);
        assert_eq!(error.code().as_str(), "UNSUPPORTED_FEATURE");
        assert!(error.message().contains("Phase 12"));
    }
}
