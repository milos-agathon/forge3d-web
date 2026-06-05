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
    CoreFeatureGate {
        feature: "native-io",
        purpose: "native file decoders and filesystem adapters",
    },
    CoreFeatureGate {
        feature: "copc",
        purpose: "COPC point-cloud readers that depend on native IO",
    },
    CoreFeatureGate {
        feature: "copc_laz",
        purpose: "LAZ decompression support for COPC data",
    },
    CoreFeatureGate {
        feature: "gltf",
        purpose: "glTF import support",
    },
    CoreFeatureGate {
        feature: "images",
        purpose: "image decoding helpers",
    },
    CoreFeatureGate {
        feature: "enable-gpu-instancing",
        purpose: "instanced mesh GPU feature surface",
    },
];

pub const DEFAULT_WASM_INACTIVE_MODULE_ROOTS: &[&str] = &[
    "animation",
    "bin",
    "bundle",
    "cli",
    "converters",
    "core",
    "external_image",
    "formats",
    "geo",
    "import",
    "io",
    "loaders",
    "offscreen",
    "passes",
    "path_tracing",
    "pipeline",
    "pointcloud",
    "py_functions",
    "py_module",
    "py_types",
    "renderer",
    "scene",
    "terrain",
    "tiles3d",
    "util",
    "viewer",
];

pub fn phase4_core_wasm_boundary() -> &'static str {
    "forge3d-core default wasm builds expose only pure crate metadata and gate staged native/offline modules"
}
