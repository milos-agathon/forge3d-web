pub mod error;
pub mod inputs;
pub mod io;
pub mod runtime;

pub use crate::error::Forge3DError;
pub use crate::runtime::Forge3DRuntime;

#[cfg(feature = "console_error_panic_hook")]
#[wasm_bindgen::prelude::wasm_bindgen(start)]
pub fn install_panic_hook() {
    console_error_panic_hook::set_once();
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;

    #[test]
    fn phase6_browser_crate_artifacts_exist() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));

        for required in [
            "src/lib.rs",
            "src/runtime.rs",
            "src/error.rs",
            "src/inputs.rs",
            "src/io.rs",
            "package.json",
            "tsconfig.json",
            "vite.config.ts",
            "src-ts/index.ts",
            "types/index.d.ts",
        ] {
            assert!(
                root.join(required).is_file(),
                "missing Phase 6 browser crate artifact {required}"
            );
        }
    }

    #[test]
    fn phase6_browser_crate_exports_runtime_and_error_boundary() {
        let lib_rs = fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/lib.rs"))
            .expect("failed to read forge3d-web lib.rs");

        for expected in [
            "pub mod error;",
            "pub mod inputs;",
            "pub mod io;",
            "pub mod runtime;",
            "Forge3DRuntime",
            "Forge3DError",
        ] {
            assert!(
                lib_rs.contains(expected),
                "forge3d-web lib.rs must expose {expected}"
            );
        }
    }

    #[test]
    fn phase7_canvas_clear_artifacts_exist() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));

        for required in [
            "playwright.config.ts",
            "examples/test-clear.html",
            "tests/playwright/clear.spec.ts",
        ] {
            assert!(
                root.join(required).is_file(),
                "missing Phase 7 canvas clear artifact {required}"
            );
        }
    }

    #[test]
    fn phase7_runtime_contains_real_webgpu_clear_pass() {
        let runtime_rs =
            fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/runtime.rs"))
                .expect("failed to read forge3d-web runtime.rs");

        for expected in [
            "pub fn render(&mut self)",
            "surface.get_current_texture()",
            "wgpu::LoadOp::Clear",
            "frame.present()",
            "ensure_not_disposed_error(self).map_err(to_js_error)?",
        ] {
            assert!(
                runtime_rs.contains(expected),
                "runtime.rs must contain Phase 7 clear-render code: {expected}"
            );
        }
    }

    #[test]
    fn phase6_browser_crate_has_no_browser_hostile_public_surface_tokens() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut offenders = Vec::new();
        scan_rs_files(&root, &mut offenders);

        assert!(
            offenders.is_empty(),
            "forge3d-web must not expose Python/native/browser-hostile APIs:\n{}",
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
            let production_text = text
                .split("#[cfg(test)]")
                .next()
                .expect("Rust source must have a production section");
            for token in [
                concat!("py", "o3"),
                concat!("num", "py"),
                "winit",
                "pollster",
                "std::net",
                "TcpListener",
                "TcpStream",
                "stdin",
                "std::fs::",
                "PathBuf",
            ] {
                if production_text.contains(token) {
                    offenders.push(format!("{} contains {token}", path.display()));
                }
            }
        }
    }
}
