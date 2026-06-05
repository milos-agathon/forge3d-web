# Forge3D Browser WebGPU/WASM Phase 1 Baseline Audit

Date: 2026-06-04

Plan: `docs/superpowers/plans/2026-06-04-forge3d-browser-webgpu-wasm-runtime.md`

## Scope

Phase 1 was documentation and reproduction only. No Rust crate moves or platform split changes were made.

The audit covered:

- Current root package dependency shape.
- The exact wasm build failure for the current single-crate layout.
- PyO3/NumPy API surface inventory.
- Native/browser-hostile API inventory for future crate separation.
- The current global GPU singleton and blocking async usage.

## Reproduced Wasm Failure

Command:

```powershell
cargo check --target wasm32-unknown-unknown --no-default-features
```

Result: failed with exit code `101`.

Primary failure:

- Crate: `pyo3-ffi v0.21.2`
- Error classes: `E0432`, `E0412`
- Missing wasm target libc symbols include `libc::wchar_t`, `libc::size_t`, `libc::uintptr_t`, `libc::intptr_t`, and `libc::ssize_t`.

Raw evidence:

- `logs/phase1-wasm-check-no-default-features.txt`

## Root Cause Evidence

The root `Cargo.toml` is still a single package named `forge3d` with unconditional Python and native dependencies. The wasm command uses `--no-default-features`, but these dependencies are not optional or feature-gated out:

- `pyo3 = { version = "0.21.2", features = ["abi3-py310", "macros", "multiple-pymethods"] }`
- `numpy = "0.21"`
- `wgpu = "0.19"`
- `winit = "0.29"`
- `pollster = "0.3"`
- `tiff = "0.9"`
- `las = { version = "0.8", features = ["laz"] }`

The inverse dependency tree confirms `pyo3` is pulled in directly by `forge3d` and again through `numpy`:

```text
pyo3 v0.21.2
├── forge3d v1.26.0
└── numpy v0.21.0
    └── forge3d v1.26.0
```

Raw evidence:

- `logs/phase1-cargo-tree-wasm-no-default-features.txt`
- `logs/phase1-cargo-tree-invert-pyo3.txt`
- `logs/phase1-cargo-tree-invert-numpy.txt`
- `logs/phase1-cargo-tree-invert-winit.txt`
- `logs/phase1-rg-dependencies.txt`

## Python Binding Inventory

Command:

```powershell
rg -n "#\[pyclass|#\[pymethods|#\[pyfunction|pyo3|numpy::|PyResult" src Cargo.toml pyproject.toml tests
```

Summary:

- Python/PyO3 inventory lines: 1,816
- Rust source files with Python binding hits: 145
- `pyo3` hits in `src`: 1,001
- `numpy::` hits in `src`: 60
- `#[pyclass]` hits in `src`: 38
- `#[pymethods]` hits in `src`: 76
- `#[pyfunction]` hits in `src`: 113
- `PyResult` hits in `src`: 550

Representative files include:

- `src/lib.rs`
- `src/scene/render_paths/rgba.rs`
- `src/animation/mod.rs`
- `src/camera/mod.rs`
- `src/geometry/py_bindings.rs`
- `src/import/cityjson/bindings.rs`
- `src/labels/py_bindings.rs`
- `src/lighting/py_bindings/*`
- `src/mesh/tbn.rs`
- `src/py_functions/**`
- `src/py_types/**`
- `src/sdf/py.rs`
- `src/terrain/cog/py_bindings.rs`

Raw evidence:

- `logs/phase1-rg-python-bindings.txt`
- `logs/phase1-python-binding-files.txt`

## Native/Browser-Hostile API Inventory

Command:

```powershell
rg -n "\bwinit\b|pollster::block_on|\bpollster\b|std::fs|std::net|TcpListener|TcpStream|stdin\(|io::stdin|PathBuf|std::path::Path|reqwest" src Cargo.toml pyproject.toml tests
```

Summary:

- Inventory lines: 217
- Rust source files with hits: 87

Representative files include:

- `src/core/gpu.rs`
- `src/viewer/event_loop/runner.rs`
- `src/viewer/ipc/server.rs`
- `src/pointcloud/copc.rs`
- `src/pointcloud/ept.rs`
- `src/tiles3d/renderer.rs`
- `src/terrain/cog/*`
- `src/viewer/terrain/scene/terrain_load.rs`
- `src/renderer/readback.rs`
- `src/vector/api/extrusion.rs`

Raw evidence:

- `logs/phase1-rg-native-browser-hostile.txt`
- `logs/phase1-native-browser-hostile-files.txt`

## GPU Runtime Findings

`src/core/gpu.rs` currently owns a global `OnceCell<GpuContext>` and blocking GPU initialization/readback helpers:

- `static CTX: OnceCell<GpuContext> = OnceCell::new();`
- `pub fn ctx() -> &'static GpuContext`
- multiple `pollster::block_on(...)` calls for `request_adapter`, `request_device`, and buffer mapping.

`src/core/context.rs` re-exports `ctx` and `GpuContext`, so callsites can depend on the singleton indirectly. Browser runtime work must replace this with runtime-owned async GPU state in later phases.

## Phase 1 Conclusion

The wasm failure is reproducible and explained by the current single-crate dependency graph: `pyo3` and `numpy` are unconditional root dependencies, so `cargo check --target wasm32-unknown-unknown --no-default-features` still compiles `pyo3-ffi`, which fails on wasm due to missing libc symbols.

This confirms the implementation plan's diagnosis: the next phase must begin with workspace/crate separation rather than a superficial wasm-bindgen wrapper around the current root crate.
