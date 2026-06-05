#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CoreFeatureGate {
    pub feature: &'static str,
    pub purpose: &'static str,
}

pub const CORE_FEATURE_GATES: &[CoreFeatureGate] = &[
    CoreFeatureGate {
        feature: "gpu",
        purpose: "wgpu render internals and GPU resource builders",
    },
    CoreFeatureGate {
        feature: "webgpu",
        purpose: "browser-audited GPU paths built on top of gpu",
    },
];

pub const DEFAULT_WASM_INACTIVE_MODULE_ROOTS: &[&str] = &[
    "accel",
    "animation",
    "bin",
    "bundle",
    "cli",
    "colormap",
    "converters",
    "core",
    "export",
    "external_image",
    "formats",
    "geo",
    "geometry",
    "import",
    "labels",
    "license",
    "lighting",
    "loaders",
    "mesh",
    "offscreen",
    "p5",
    "passes",
    "path_tracing",
    "picking",
    "pipeline",
    "pointcloud",
    "py_functions",
    "py_module",
    "py_types",
    "render",
    "scene",
    "sdf",
    "shaders",
    "shadows",
    "style",
    "tiles3d",
    "util",
    "uv",
    "vector",
    "viewer",
];

pub fn phase4_core_wasm_boundary() -> &'static str {
    "forge3d-core exposes only browser-safe contracts for the browser/npm/WASM workspace"
}
