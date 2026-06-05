pub mod feature_gates;

pub mod error;

pub mod io;

#[cfg(feature = "gpu")]
pub mod gpu;

#[cfg(feature = "webgpu")]
pub mod camera;

#[cfg(feature = "webgpu")]
pub mod terrain;

#[cfg(feature = "webgpu")]
pub mod readback;

pub const WORKSPACE_SPLIT_PHASE: u8 = 5;

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

        for expected in ["gpu", "webgpu"] {
            assert!(
                features.contains(&expected),
                "missing browser-only core feature-gate manifest entry for {expected}"
            );
        }
    }

    #[test]
    fn default_core_root_does_not_expose_staged_native_or_offline_modules() {
        let lib_rs = fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/lib.rs"))
            .expect("failed to read core lib.rs");
        let production_root = lib_rs
            .split("#[cfg(test)]")
            .next()
            .expect("lib.rs must have production module declarations");

        for module_root in DEFAULT_WASM_INACTIVE_MODULE_ROOTS {
            let pub_mod = format!("pub mod {module_root};");
            let private_mod = format!("mod {module_root};");
            assert!(
                !production_root.contains(&pub_mod) && !production_root.contains(&private_mod),
                "{module_root} must remain behind an explicit non-default gate before it is compiled from forge3d-core"
            );
        }
    }

    #[test]
    fn removed_python_binding_roots_do_not_exist_in_browser_only_workspace() {
        let core_root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let workspace_root = core_root
            .parent()
            .and_then(Path::parent)
            .expect("core crate must live under crates/ in the workspace");

        for root in ["py_module", "py_functions", "py_types"] {
            assert!(
                !core_root.join("src").join(root).exists(),
                "Python binding root src/{root} must not remain in forge3d-core"
            );
        }
        assert!(
            !workspace_root.join("crates/forge3d-python").exists(),
            "forge3d-python must not exist in the browser/npm/WASM-only workspace"
        );
    }

    #[test]
    fn phase5_gpu_runtime_api_is_public_without_legacy_singleton() {
        let lib_rs = fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/lib.rs"))
            .expect("failed to read core lib.rs");
        let production_root = lib_rs
            .split("#[cfg(test)]")
            .next()
            .expect("lib.rs must have production module declarations");

        assert!(production_root.contains("pub mod gpu;"));
        assert!(
            !production_root.contains("pub mod core;"),
            "legacy core::gpu singleton tree must not be re-exposed from forge3d-core"
        );

        let gpu_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/gpu");
        for required in ["mod.rs", "runtime.rs", "surface.rs"] {
            assert!(
                gpu_dir.join(required).is_file(),
                "missing Phase 5 GPU runtime artifact src/gpu/{required}"
            );
        }
    }

    #[test]
    fn phase5_browser_gpu_sources_do_not_use_blocking_or_global_context() {
        let gpu_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/gpu");
        let mut offenders = Vec::new();
        scan_for_browser_gpu_ownership_offenders(&gpu_dir, &mut offenders);

        assert!(
            offenders.is_empty(),
            "browser-facing GPU runtime sources must not use global/blocking GPU state:\n{}",
            offenders.join("\n")
        );
    }

    #[test]
    fn phase5_core_source_tree_has_no_legacy_global_gpu_singleton() {
        let src_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut offenders = Vec::new();
        scan_for_legacy_global_gpu_tokens(&src_dir, &mut offenders);

        assert!(
            offenders.is_empty(),
            "legacy global GPU singleton tokens must not remain in forge3d-core source:\n{}",
            offenders.join("\n")
        );
    }

    #[test]
    fn phase5_core_production_sources_have_no_blocking_or_global_gpu_callsite_tokens() {
        let src_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut offenders = Vec::new();
        scan_for_phase5_production_gpu_callsite_tokens(&src_dir, &mut offenders);

        assert!(
            offenders.is_empty(),
            "Phase 5 production callsites must not retain legacy global/blocking GPU tokens:\n{}",
            offenders.join("\n")
        );
    }

    #[test]
    fn phase8_core_terrain_heightmap_contract_is_exposed() {
        let lib_rs = fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/lib.rs"))
            .expect("failed to read core lib.rs");
        let production_root = lib_rs
            .split("#[cfg(test)]")
            .next()
            .expect("lib.rs must have production module declarations");

        assert!(
            production_root.contains("pub mod terrain;"),
            "Phase 8 must expose a narrow wasm-safe forge3d_core::terrain module"
        );

        let terrain_rs = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/terrain.rs");
        assert!(
            terrain_rs.is_file(),
            "Phase 8 terrain contract must live in src/terrain.rs rather than re-exposing staged legacy terrain/"
        );
    }

    #[test]
    fn phase9_core_camera_contract_is_exposed() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let lib_rs =
            fs::read_to_string(root.join("src/lib.rs")).expect("failed to read core lib.rs");
        let production_root = lib_rs
            .split("#[cfg(test)]")
            .next()
            .expect("lib.rs must have production module declarations");

        assert!(
            production_root.contains("pub mod camera;"),
            "Phase 9 must expose a narrow wasm-safe forge3d_core::camera module"
        );
        assert!(
            root.join("src/camera/mod.rs").is_file(),
            "Phase 9 camera contract must live in src/camera/mod.rs"
        );
    }

    #[test]
    fn phase10_core_readback_contract_is_exposed() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let lib_rs =
            fs::read_to_string(root.join("src/lib.rs")).expect("failed to read core lib.rs");
        let production_root = lib_rs
            .split("#[cfg(test)]")
            .next()
            .expect("lib.rs must have production module declarations");

        assert!(
            production_root.contains("pub mod readback;"),
            "Phase 10 must expose a narrow wasm-safe forge3d_core::readback module"
        );
        assert!(
            root.join("src/readback/mod.rs").is_file(),
            "Phase 10 readback contract must live in src/readback/mod.rs"
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

    fn scan_for_browser_gpu_ownership_offenders(dir: &Path, offenders: &mut Vec<String>) {
        let entries = fs::read_dir(dir)
            .unwrap_or_else(|error| panic!("failed to read {}: {error}", dir.display()));

        for entry in entries {
            let path = entry
                .unwrap_or_else(|error| {
                    panic!("failed to read entry in {}: {error}", dir.display())
                })
                .path();

            if path.is_dir() {
                scan_for_browser_gpu_ownership_offenders(&path, offenders);
                continue;
            }

            if path.extension().and_then(|ext| ext.to_str()) != Some("rs") {
                continue;
            }

            let text = fs::read_to_string(&path)
                .unwrap_or_else(|error| panic!("failed to read {}: {error}", path.display()));
            for token in [
                concat!("OnceCell", "<GpuContext>"),
                concat!("core::gpu", "::ctx"),
                concat!("crate::core::gpu", "::ctx"),
                concat!("pollster", "::block_on"),
            ] {
                if text.contains(token) {
                    offenders.push(format!("{} contains {token}", path.display()));
                }
            }
        }
    }

    fn scan_for_legacy_global_gpu_tokens(dir: &Path, offenders: &mut Vec<String>) {
        let entries = fs::read_dir(dir)
            .unwrap_or_else(|error| panic!("failed to read {}: {error}", dir.display()));

        for entry in entries {
            let path = entry
                .unwrap_or_else(|error| {
                    panic!("failed to read entry in {}: {error}", dir.display())
                })
                .path();

            if path.is_dir() {
                scan_for_legacy_global_gpu_tokens(&path, offenders);
                continue;
            }

            if path.extension().and_then(|ext| ext.to_str()) != Some("rs") {
                continue;
            }

            let text = fs::read_to_string(&path)
                .unwrap_or_else(|error| panic!("failed to read {}: {error}", path.display()));
            for token in [
                concat!("OnceCell", "<GpuContext>"),
                concat!("crate::core::gpu", "::ctx"),
                concat!("core::gpu", "::ctx"),
            ] {
                if text.contains(token) {
                    offenders.push(format!("{} contains {token}", path.display()));
                }
            }
        }
    }

    fn scan_for_phase5_production_gpu_callsite_tokens(dir: &Path, offenders: &mut Vec<String>) {
        let entries = fs::read_dir(dir)
            .unwrap_or_else(|error| panic!("failed to read {}: {error}", dir.display()));

        for entry in entries {
            let path = entry
                .unwrap_or_else(|error| {
                    panic!("failed to read entry in {}: {error}", dir.display())
                })
                .path();

            if path.is_dir() {
                scan_for_phase5_production_gpu_callsite_tokens(&path, offenders);
                continue;
            }

            if path.extension().and_then(|ext| ext.to_str()) != Some("rs") {
                continue;
            }

            if path.file_name().and_then(|name| name.to_str()) == Some("tests.rs") {
                continue;
            }

            let text = fs::read_to_string(&path)
                .unwrap_or_else(|error| panic!("failed to read {}: {error}", path.display()));
            let production_text = text.split("#[cfg(test)]").next().unwrap_or(&text);

            for token in [
                concat!("core::gpu", "::ctx("),
                concat!("crate::core::gpu", "::ctx("),
                "ctx()",
                concat!("pollster", "::block_on"),
            ] {
                if production_text.contains(token) {
                    offenders.push(format!("{} contains {token}", path.display()));
                }
            }
        }
    }
}
