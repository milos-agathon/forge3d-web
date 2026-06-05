pub mod feature_gates;

pub const WORKSPACE_SPLIT_PHASE: u8 = 4;

pub fn phase() -> u8 {
    WORKSPACE_SPLIT_PHASE
}

#[cfg(test)]
mod tests {
    use crate::feature_gates::{CORE_FEATURE_GATES, DEFAULT_WASM_INACTIVE_MODULE_ROOTS};
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

    #[test]
    fn phase4_feature_gate_manifest_tracks_core_optional_surfaces() {
        let features = CORE_FEATURE_GATES
            .iter()
            .map(|gate| gate.feature)
            .collect::<Vec<_>>();

        for expected in [
            "gpu",
            "webgpu",
            "native-io",
            "copc",
            "copc_laz",
            "gltf",
            "images",
            "enable-gpu-instancing",
        ] {
            assert!(
                features.contains(&expected),
                "missing Phase 4 feature-gate manifest entry for {expected}"
            );
        }
    }

    #[test]
    fn default_core_root_does_not_expose_staged_native_or_offline_modules() {
        let lib_rs = fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/lib.rs"))
            .expect("failed to read core lib.rs");

        for module_root in DEFAULT_WASM_INACTIVE_MODULE_ROOTS {
            let pub_mod = format!("pub mod {module_root};");
            let private_mod = format!("mod {module_root};");
            assert!(
                !lib_rs.contains(&pub_mod) && !lib_rs.contains(&private_mod),
                "{module_root} must remain behind an explicit non-default gate before it is compiled from forge3d-core"
            );
        }
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
