pub const WORKSPACE_SPLIT_PHASE: u8 = 3;

pub fn phase() -> u8 {
    WORKSPACE_SPLIT_PHASE
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;

    const BANNED_CORE_BOUNDARY_TOKENS: &[&str] = &[
        concat!("py", "o3"),
        concat!("num", "py"),
        concat!("Py", "Result"),
        concat!("Py", "Object"),
        concat!("Py", "Err"),
        concat!("Py", "ReadonlyArray"),
        concat!("Py", "Array"),
        concat!("#[", "pyclass"),
        concat!("#[", "pymethods"),
        concat!("#[", "pyfunction"),
    ];

    #[test]
    fn core_source_tree_has_no_python_boundary_tokens() {
        let src_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut offenders = Vec::new();
        scan_rs_files(&src_dir, &mut offenders);

        assert!(
            offenders.is_empty(),
            "forge3d-core must remain free of Python boundary tokens:\n{}",
            offenders.join("\n")
        );
    }

    fn scan_rs_files(dir: &Path, offenders: &mut Vec<String>) {
        let entries = fs::read_dir(dir)
            .unwrap_or_else(|error| panic!("failed to read {}: {error}", dir.display()));

        for entry in entries {
            let path = entry
                .unwrap_or_else(|error| {
                    panic!("failed to read entry in {}: {error}", dir.display())
                })
                .path();

            if path.is_dir() {
                scan_rs_files(&path, offenders);
                continue;
            }

            if path.extension().and_then(|ext| ext.to_str()) != Some("rs") {
                continue;
            }

            let text = fs::read_to_string(&path)
                .unwrap_or_else(|error| panic!("failed to read {}: {error}", path.display()));
            for token in BANNED_CORE_BOUNDARY_TOKENS {
                if text.contains(token) {
                    offenders.push(format!("{} contains {token}", path.display()));
                }
            }
        }
    }
}
