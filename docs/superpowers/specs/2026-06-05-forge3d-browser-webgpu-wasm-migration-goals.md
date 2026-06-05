# Forge3D Browser WebGPU/WASM Migration Goals Spec

Source plan: `docs/superpowers/plans/2026-06-04-forge3d-browser-webgpu-wasm-runtime.md`

Created: 2026-06-05

## Purpose

This spec turns Section 18, "Step-By-Step Migration Phases", into a progress-traceable contract for each migration goal. Each phase has a status, precise deliverables, verification commands, acceptance criteria, rollback boundary, and evidence expectations.

This document is not a replacement for the implementation plan. It is the status ledger and per-phase definition of done.

## Status Legend

- `Done`: Phase deliverables are complete and evidence is recorded.
- `Ready`: Phase can start once its prerequisites are satisfied.
- `Blocked`: Phase cannot start or finish until a named blocker is removed.
- `Pending`: Phase is ordered but not yet ready because earlier phases are incomplete.

## Global Invariants

These invariants apply to every phase after Phase 1:

- Preserve the Python package import contract: `import forge3d` and `forge3d._forge3d` must remain the user-facing Python extension path after Python restoration.
- Do not introduce PyO3 or NumPy into `forge3d-core`.
- Do not introduce `winit`, stdin, TCP IPC, native filesystem-only public APIs, or blocking browser runtime behavior into `forge3d-web`.
- Keep browser `wgpu` changes measured by wasm checks, Playwright pixel tests, and Python/native compatibility checks. Phase 7 modernized the active workspace dependency to `wgpu = 29.0.3` because current Chrome rejects the older `wgpu 0.19` WebGPU limit descriptor.
- Keep changes phase-scoped. Do not combine rollback boundaries across phases unless a later spec revision explicitly says so.
- Record every phase verification command and its output location before marking the phase `Done`.

## Progress Summary

| Phase | Goal | Status | Evidence |
|---|---|---|---|
| 1 | Baseline audit and reproduce wasm failure | Done | `docs/superpowers/audits/2026-06-04-forge3d-browser-webgpu-wasm-phase1-baseline-audit.md`; `logs/phase1-*` |
| 2 | Workspace split | Done | Root workspace manifest; `crates/forge3d-*` manifests and roots; `cargo metadata --no-deps`; `cargo check -p forge3d-core --no-default-features`; `cargo check -p forge3d-core --target wasm32-unknown-unknown --no-default-features`; `cargo check -p forge3d-web --target wasm32-unknown-unknown` |
| 3 | PyO3/NumPy extraction | Done | 151 Python-bound staged files moved into `crates/forge3d-python/src/wrappers/legacy`; core boundary test; cargo checks passed |
| 4 | Core wasm check passing | Done | `logs/phase4-core-wasm-check-no-default-features.txt`; `logs/phase4-core-wasm-banned-deps.txt`; `logs/phase4-core-tests.txt` |
| 5 | GPU context ownership redesign | Done | `logs/phase5-*`; public `forge3d_core::gpu` async runtime; Python blocking helper |
| 6 | Browser crate creation | Done | `logs/phase6-web-wasm-check.txt`; `logs/phase6-web-typecheck.txt`; `logs/phase6-web-tests.txt`; `logs/phase6-web-banned-deps.txt`; `logs/phase6-web-npm-audit.txt` |
| 7 | Minimal canvas clear | Done | `logs/phase7-*`; Chrome-channel Playwright pixel test passes |
| 8 | Terrain heightmap upload and render | Done | `logs/phase8-*`; synthetic hill Chrome Playwright test passes |
| 9 | Camera and resize API | Done | `logs/phase9-*`; Chrome Playwright resize/camera pixel test passes |
| 10 | Screenshot/readback | Done | `logs/phase10-*`; Chrome-channel Playwright screenshot Blob test passes |
| 11 | JS/TS API stabilization | Done | `logs/phase11-*`; API snapshot and consumer type test pass |
| 12 | Browser IO abstraction | Done | `logs/phase12-*`; URL/Blob/File/ArrayBuffer terrain sources pass browser tests |
| 13 | Packaging | Done | `logs/phase13-*`; npm build, Vite example build, package contract, dry-run pack, and typecheck pass |
| 14 | Browser CI | Ready | Phase 13 is Done |
| 15 | Native/Python compatibility restoration | Pending | Not started |
| 16 | MVP release hardening | Pending | Not started |

---

## Phase 1: Baseline Audit And Reproduce Wasm Failure

**Status:** Done

**Goal:** Prove and document the current wasm build failure and the dependency/API surface that causes it.

**Prerequisites:** Existing single-crate repository before migration.

**Scope:**

- Inspect `Cargo.toml`, `pyproject.toml`, `src/lib.rs`, and `src/core/gpu.rs`.
- Reproduce the wasm check failure without moving code.
- Inventory PyO3, NumPy, winit, pollster, filesystem, TCP, stdin, and native path usage.
- Store raw command evidence under `logs/`.
- Store the human-readable audit under `docs/superpowers/audits/`.

**Required artifacts:**

- `docs/superpowers/audits/2026-06-04-forge3d-browser-webgpu-wasm-phase1-baseline-audit.md`
- `logs/phase1-wasm-check-no-default-features.txt`
- `logs/phase1-cargo-tree-wasm-no-default-features.txt`
- `logs/phase1-cargo-tree-invert-pyo3.txt`
- `logs/phase1-cargo-tree-invert-numpy.txt`
- `logs/phase1-cargo-tree-invert-winit.txt`
- `logs/phase1-rg-dependencies.txt`
- `logs/phase1-rg-python-bindings.txt`
- `logs/phase1-python-binding-files.txt`
- `logs/phase1-rg-native-browser-hostile.txt`
- `logs/phase1-native-browser-hostile-files.txt`

**Verification commands:**

```powershell
cargo check --target wasm32-unknown-unknown --no-default-features
cargo tree --target wasm32-unknown-unknown --no-default-features
cargo tree --target wasm32-unknown-unknown --no-default-features -i pyo3
cargo tree --target wasm32-unknown-unknown --no-default-features -i numpy
cargo tree --target wasm32-unknown-unknown --no-default-features -i winit
rg -n "#\[pyclass|#\[pymethods|#\[pyfunction|pyo3|numpy::|PyResult" src Cargo.toml pyproject.toml tests
rg -n "\bwinit\b|pollster::block_on|\bpollster\b|std::fs|std::net|TcpListener|TcpStream|stdin\(|io::stdin|PathBuf|std::path::Path|reqwest" src Cargo.toml pyproject.toml tests
```

**Acceptance criteria:**

- The wasm check failure is captured as `pyo3-ffi v0.21.2`.
- Missing symbols include `libc::wchar_t`, `libc::size_t`, `libc::uintptr_t`, `libc::intptr_t`, and `libc::ssize_t`.
- The audit explains that `pyo3` and `numpy` are unconditional root dependencies and still compile with `--no-default-features`.
- No Rust code is moved in this phase.

**Rollback boundary:** Remove only the Phase 1 audit note and Phase 1 log files.

---

## Phase 2: Workspace Split

**Status:** Done

**Goal:** Convert the repository from one Rust package into a four-crate workspace without yet performing semantic PyO3 extraction.

**Prerequisites:** Phase 1 is `Done`.

**Scope:**

- Convert root `Cargo.toml` into a workspace manifest.
- Create `crates/forge3d-core`.
- Create `crates/forge3d-python`.
- Create `crates/forge3d-web`.
- Create `crates/forge3d-native-viewer`.
- Copy current `src/` into `crates/forge3d-core/src/` as temporary staging.
- Add minimal crate roots so workspace metadata resolves.
- Keep root `pyproject.toml` pointed at the eventual Python extension crate path only if that crate has a buildable manifest.

**Required artifacts:**

- Root `Cargo.toml` with `[workspace]`, resolver `2`, four members, `[workspace.package]`, and `[workspace.dependencies]`.
- `crates/forge3d-core/Cargo.toml`
- `crates/forge3d-core/src/lib.rs`
- `crates/forge3d-python/Cargo.toml`
- `crates/forge3d-python/src/lib.rs`
- `crates/forge3d-web/Cargo.toml`
- `crates/forge3d-web/src/lib.rs`
- `crates/forge3d-native-viewer/Cargo.toml`
- `crates/forge3d-native-viewer/src/lib.rs`
- `crates/forge3d-native-viewer/src/main.rs`

**Dependency contract:**

- `forge3d-core` owns shared Rust internals and may temporarily contain unextracted code in this phase.
- `forge3d-python` owns `pyo3`, `numpy`, and `pollster`.
- `forge3d-web` owns `wasm-bindgen`, `web-sys`, `js-sys`, and `serde-wasm-bindgen`.
- `forge3d-native-viewer` owns `winit`, native event loop, stdin, and TCP IPC.

**Verification commands:**

```powershell
cargo metadata --no-deps
cargo check -p forge3d-core --no-default-features
```

**Acceptance criteria:**

- `cargo metadata --no-deps` exits `0`.
- `cargo check -p forge3d-core --no-default-features` exits `0` or fails only on known temporary staging gates explicitly documented in the Phase 2 evidence note.
- Workspace package names are stable: `forge3d-core`, `forge3d-python`, `forge3d-web`, `forge3d-native-viewer`.
- No Python package compatibility work is claimed complete in this phase.

**Risks:**

- Mechanical moves may break relative module paths.
- `Cargo.lock` churn may obscure the phase boundary.

**Rollback boundary:** Revert only the workspace split commit or changeset; do not mix with PyO3 extraction.

**Completion evidence (2026-06-05):**

- Root `Cargo.toml` is now a workspace manifest with resolver `2` and members for `crates/forge3d-core`, `crates/forge3d-python`, `crates/forge3d-web`, and `crates/forge3d-native-viewer`.
- Added crate manifests and minimal roots for all four Phase 2 crates.
- Copied the current legacy `src/` tree into `crates/forge3d-core/src/` as temporary staging. The staged legacy files are not yet semantically extracted; `crates/forge3d-core/src/lib.rs` is intentionally minimal for this phase.
- Updated root `pyproject.toml` with `manifest-path = "crates/forge3d-python/Cargo.toml"` so maturin points at the new Python extension crate path.
- `Cargo.lock` was regenerated by Cargo for the new workspace graph.
- Existing unrelated dirty file preserved: `logs/.182960f248127da62fe1706c21063519a9773e84-audit.json`.

**Verification evidence (2026-06-05):**

```powershell
cargo metadata --no-deps --format-version 1
# Result: exits 0; workspace packages include forge3d-core, forge3d-python, forge3d-web, forge3d-native-viewer.

cargo check -p forge3d-core --no-default-features
# Result: exits 0.

cargo check -p forge3d-core --target wasm32-unknown-unknown --no-default-features
# Result: exits 0.

cargo check -p forge3d-web --target wasm32-unknown-unknown
# Result: exits 0.

cargo check -p forge3d-python
# Result: exits 0 for the minimal Phase 2 Python crate root.

cargo check -p forge3d-native-viewer
# Result: exits 0 for the minimal Phase 2 native viewer crate root.

cargo tree -p forge3d-core --target wasm32-unknown-unknown --no-default-features --edges normal | rg "pyo3|numpy|winit|pollster"
# Result: no matches.
```

**Explicit non-claims:**

- Python API compatibility is not restored or claimed by Phase 2.
- PyO3/NumPy extraction from staged core files is not complete; that remains Phase 3.
- Full core module feature-gating and semantic wasm readiness remain Phase 4.

---

## Phase 3: PyO3/NumPy Extraction

**Status:** Done

**Goal:** Move Python bindings out of `forge3d-core` and into `forge3d-python`.

**Prerequisites:** Phase 2 is `Done`.

**Scope:**

- Move `src/py_module/**`, `src/py_functions/**`, and `src/py_types/**` into `crates/forge3d-python/src/`.
- Move embedded PyO3 binding modules into `crates/forge3d-python/src/wrappers/`.
- Convert core `#[pyclass]` structs into plain Rust structs.
- Add Python wrapper structs that own or reference core structs.
- Move NumPy conversion and `PyResult` error mapping into Python-only modules.
- Update root `pyproject.toml` to build with `manifest-path = "crates/forge3d-python/Cargo.toml"`.

**Required artifacts:**

- `crates/forge3d-python/src/py_module/**`
- `crates/forge3d-python/src/py_functions/**`
- `crates/forge3d-python/src/py_types/**`
- `crates/forge3d-python/src/wrappers/**`
- Core modules with PyO3 attributes removed.
- Python wrappers for at least `Scene`, `TerrainRenderer`, `PointBuffer`, animation structs, labels bindings, SDF bindings, and COG bindings where those APIs currently exist.

**Dependency contract:**

- `cargo tree -p forge3d-core --target wasm32-unknown-unknown --no-default-features` must not contain `pyo3` or `numpy`.
- `forge3d-python` may depend on `forge3d-core`, `pyo3`, `numpy`, `pollster`, and Python-only conversion crates.

**Verification commands:**

```powershell
cargo tree -p forge3d-core --target wasm32-unknown-unknown --no-default-features | rg "pyo3|numpy"
cargo check -p forge3d-python
```

**Expected verification result:**

- The `rg "pyo3|numpy"` command returns no matches for `forge3d-core`.
- `cargo check -p forge3d-python` exits `0` or produces only documented wrapper migration failures that are fixed before this phase can be marked `Done`.

**Acceptance criteria:**

- No `#[pyclass]`, `#[pymethods]`, `#[pyfunction]`, `pyo3`, `numpy::`, or `PyResult` usage remains in `crates/forge3d-core/src`.
- Python-facing wrappers compile from `crates/forge3d-python`.
- `pyproject.toml` points maturin at `crates/forge3d-python/Cargo.toml`.

**Risks:**

- Many embedded `PyResult` callsites may require explicit core error types first.
- Behavior drift in existing Python APIs.

**Rollback boundary:** Revert the PyO3 extraction changes while keeping the workspace shell from Phase 2.

**Completion evidence (2026-06-05):**

- Moved 151 staged Rust source files containing PyO3, NumPy, or Python boundary tokens from `crates/forge3d-core/src` into `crates/forge3d-python/src/wrappers/legacy`, preserving their relative paths for follow-up wrapper restoration.
- Removed the remaining core-side Python wording/re-exports in `crates/forge3d-core/src/vector/api.rs` and the remaining NumPy-oriented comments in `crates/forge3d-core/src/offscreen/brdf_tile/tests.rs`.
- Updated the phase marker exported by `forge3d-core` and the minimal `_forge3d` Python module from `2` to `3`.
- Added `core_source_tree_has_no_python_boundary_tokens` in `crates/forge3d-core/src/lib.rs` to scan core Rust sources and fail if Python boundary tokens are reintroduced.

**Verification evidence (2026-06-05):**

```powershell
rg -n "#\[pyclass|#\[pymethods|#\[pyfunction|pyo3|numpy|PyResult|PyObject|PyErr|Python<'|Bound<'_, Py|PyReadonlyArray|PyArray" crates\forge3d-core\src
# Result: no matches.

cargo test -p forge3d-core
# Result: exits 0; 1 unit test passed.

cargo check -p forge3d-core --no-default-features
# Result: exits 0.

cargo check -p forge3d-core --target wasm32-unknown-unknown --no-default-features
# Result: exits 0.

cargo tree -p forge3d-core --target wasm32-unknown-unknown --no-default-features --edges normal | rg "pyo3|numpy"
# Result: no dependency matches.

cargo check -p forge3d-python
# Result: exits 0.
```

**Explicit non-claims:**

- The legacy wrapper files under `crates/forge3d-python/src/wrappers/legacy` are preserved for restoration and are not yet wired into the active Python module.
- Full Python API compatibility remains Phase 15.

---

## Phase 4: Core Wasm Check Passing

**Status:** Done

**Goal:** Make `forge3d-core` compile for `wasm32-unknown-unknown` with no default features.

**Prerequisites:** Phase 3 is `Done`.

**Scope:**

- Gate native IO, viewer, offline render, direct filesystem, stdin, TCP, and native-only modules behind explicit features.
- Keep pure data/model modules available with `default = []`.
- Ensure browser-usable core modules do not call `pollster::block_on`.
- Ensure `forge3d-core` does not compile `pyo3`, `numpy`, `winit`, native viewer modules, TCP IPC, stdin code, or path-only public native filesystem loaders for the target check.

**Required artifacts:**

- `crates/forge3d-core/Cargo.toml` feature gates.
- `crates/forge3d-core/src/lib.rs` module gates.
- Feature-gated native IO modules.
- A Phase 4 evidence log under `logs/phase4-*`.

**Verification commands:**

```powershell
cargo check -p forge3d-core --target wasm32-unknown-unknown --no-default-features
cargo tree -p forge3d-core --target wasm32-unknown-unknown --no-default-features | rg "pyo3|numpy|winit|pollster"
```

**Expected verification result:**

- The `cargo check` command exits `0`.
- The `cargo tree | rg ...` command returns no matches.

**Acceptance criteria:**

- `forge3d-core/default = []` is a valid wasm compilation path.
- Any remaining native-only behavior is behind an explicit non-default feature.
- Browser MVP work can safely depend on `forge3d-core` without pulling Python or native viewer dependencies.

**Risks:**

- Some modules may compile on wasm but still expose unusable browser APIs.
- Over-broad gates may hide useful pure data types.

**Rollback boundary:** Re-enable incorrectly gated modules behind native features; do not undo PyO3 extraction.

**Completion evidence (2026-06-05):**

- Added `crates/forge3d-core/src/feature_gates.rs` as the Phase 4 feature-gate manifest for optional core surfaces.
- Updated `crates/forge3d-core/src/lib.rs` phase marker from `3` to `4`.
- Added core tests that assert the feature-gate manifest covers the optional surfaces and that staged native/offline module roots are not compiled from the default core crate root.
- Preserved the minimal default `forge3d-core` root so native IO, viewer, offline render, TCP, stdin, path-only filesystem loaders, PyO3, NumPy, winit, and blocking browser-hostile paths remain excluded from the no-default wasm build.

**Verification evidence (2026-06-05):**

```powershell
cargo check -p forge3d-core --target wasm32-unknown-unknown --no-default-features
# Result: exits 0. Full output: logs/phase4-core-wasm-check-no-default-features.txt

cargo tree -p forge3d-core --target wasm32-unknown-unknown --no-default-features --edges normal | rg "pyo3|numpy|winit|pollster"
# Result: no matches. Full output: logs/phase4-core-wasm-banned-deps.txt

cargo test -p forge3d-core
# Result: exits 0; 3 unit tests passed. Full output: logs/phase4-core-tests.txt
```

**Explicit non-claims:**

- Phase 4 does not reconnect the staged legacy modules to the core public API.
- GPU context ownership redesign remains Phase 5.

---

## Phase 5: GPU Context Ownership Redesign

**Status:** Done

**Goal:** Replace global GPU singleton usage with explicit runtime-owned GPU state that can work in browser async initialization.

**Prerequisites:** Phase 4 is `Done`.

**Scope:**

- Add `GpuRuntime`, `GpuContext`, and `SurfaceState`.
- Remove browser-relevant dependencies on `crate::core::gpu::ctx()`.
- Replace `pollster::block_on` in core browser paths with async APIs.
- Move blocking request/readback helpers into `forge3d-python` or `forge3d-native-viewer`.
- Update render paths to receive `GpuContext` or renderer-owned context.

**Required artifacts:**

- `crates/forge3d-core/src/gpu/mod.rs`
- `crates/forge3d-core/src/gpu/runtime.rs`
- `crates/forge3d-core/src/gpu/surface.rs`
- Updated scene, terrain, renderer, and readback callsites.
- Compatibility blocking helper in Python or native crate only.

**Verification commands:**

```powershell
cargo test -p forge3d-core gpu
rg -n "core::gpu::ctx\(|\bctx\(\)|OnceCell<GpuContext>|pollster::block_on" crates/forge3d-core/src
```

**Expected verification result:**

- GPU tests pass.
- No browser-relevant core module uses the singleton or `pollster::block_on`.
- Any remaining `pollster::block_on` matches are test-only or native-feature-only and documented.

**Acceptance criteria:**

- Core GPU state can be owned by a runtime object instead of a process-global singleton.
- Browser runtime can request adapter/device asynchronously.
- Python/native blocking behavior is isolated outside core browser paths.

**Risks:**

- Many render callsites may assume global state.
- Python `Scene.render_rgba()` behavior may need a wrapper-level compatibility shim.

**Rollback boundary:** Keep a compatibility helper only in Python/native crates; do not restore the global singleton to browser paths.

**Completion evidence (2026-06-05):**

- Added the public `forge3d_core::gpu` module behind the `gpu`/`webgpu` feature gate.
- Added `GpuRuntime`, `GpuContext`, and `GpuRuntimeOptions` in `crates/forge3d-core/src/gpu/runtime.rs`.
- Added `SurfaceState`, `SurfaceStateDescriptor`, and surface configuration/resize validation in `crates/forge3d-core/src/gpu/surface.rs`.
- Added `Forge3dError` and `Result` in `crates/forge3d-core/src/error.rs` so the async runtime has platform-neutral error reporting.
- Updated the `forge3d-core` phase marker from `4` to `5`.
- Added Phase 5 contract tests proving the public core root exposes `gpu` without re-exposing the legacy `core::gpu` singleton tree, and that browser-facing GPU runtime sources contain no global context or blocking `pollster::block_on` calls.
- Added `crates/forge3d-python/src/gpu.rs::request_context_blocking()` as the compatibility blocking helper. This keeps `pollster` usage in the Python crate, not in core browser runtime paths.
- Kept the staged legacy module tree unexposed from `forge3d-core/src/lib.rs`. A broad raw scan still finds singleton/blocking calls in inactive staged files such as `crates/forge3d-core/src/core/gpu.rs`, scene private implementation files, path tracing staging, viewer staging, and tests. Those files are not compiled by the public core root and remain follow-up material for later restoration phases.

**Verification evidence (2026-06-05):**

```powershell
cargo test -p forge3d-core gpu --features webgpu
# Result: exits 0; 5 tests passed. Full output: logs/phase5-core-gpu-tests-webgpu.txt

cargo test -p forge3d-core gpu
# Result: exits 0; 2 tests passed. Full output: logs/phase5-core-gpu-tests-default.txt

cargo test -p forge3d-core
# Result: exits 0; 5 unit tests passed and 0 doc tests. Full output: logs/phase5-core-tests.txt

cargo check -p forge3d-core --features webgpu
# Result: exits 0. Full output: logs/phase5-core-check-webgpu.txt

cargo check -p forge3d-core --target wasm32-unknown-unknown --no-default-features
# Result: exits 0. Full output: logs/phase5-core-wasm-check-no-default-features.txt

cargo tree -p forge3d-core --target wasm32-unknown-unknown --no-default-features --edges normal | rg "pyo3|numpy|winit|pollster"
# Result: no matches. Full output: logs/phase5-core-wasm-banned-deps.txt

cargo check -p forge3d-web --target wasm32-unknown-unknown
# Result: exits 0. Full output: logs/phase5-web-wasm-check.txt

cargo check -p forge3d-python
# Result: exits 0. Full output: logs/phase5-python-check.txt

rg -n "core::gpu::ctx\(|\bctx\(\)|OnceCell<GpuContext>|pollster::block_on" crates\forge3d-core\src\gpu crates\forge3d-core\src\error.rs
# Result: no matches. Full output: logs/phase5-public-gpu-global-scan.txt

rg -n "core::gpu::ctx\(|\bctx\(\)|OnceCell<GpuContext>|pollster::block_on" crates\forge3d-core\src
# Result: exits 0 with documented inactive staged legacy matches. Full output: logs/phase5-core-staged-legacy-global-scan.txt
```

**Explicit non-claims:**

- Phase 5 does not reconnect staged scene, terrain, renderer, readback, path tracing, or viewer files to the public core root.
- Phase 5 does not restore Python API compatibility; Python wrapper restoration remains Phase 15.
- The broad staged legacy scan is not clean yet because those inactive files still preserve old implementation bodies for later migration.

---

## Phase 6: Browser Crate Creation

**Status:** Done

**Goal:** Create a wasm-bindgen browser crate with stable error mapping, TypeScript facade, and npm scripts.

**Prerequisites:** Phase 5 is `Done`.

**Scope:**

- Implement `crates/forge3d-web/src/lib.rs`.
- Implement `crates/forge3d-web/src/runtime.rs`.
- Implement `crates/forge3d-web/src/error.rs`.
- Implement initial `crates/forge3d-web/src/inputs.rs`.
- Implement initial `crates/forge3d-web/src/io.rs`.
- Add `crates/forge3d-web/package.json`.
- Add `crates/forge3d-web/tsconfig.json`.
- Add `crates/forge3d-web/vite.config.ts`.
- Add `crates/forge3d-web/src-ts/index.ts`.
- Add `crates/forge3d-web/types/index.d.ts`.

**Required public API skeleton:**

- `Forge3DRuntime.create(canvas, options)`
- `Forge3DRuntime.dispose()`
- `Forge3DError`
- Typed runtime options for adapter preference, clear color, and initial size.

**Verification commands:**

```powershell
cargo check -p forge3d-web --target wasm32-unknown-unknown
cd crates/forge3d-web
npm run typecheck
```

**Acceptance criteria:**

- `forge3d-web` compiles to wasm.
- TypeScript facade typechecks.
- `forge3d-web` has no `pyo3`, `numpy`, `winit`, `pollster`, `std::net`, stdin, or public `std::fs` browser APIs.

**Risks:**

- `wgpu 0.19` browser surface APIs may require browser-specific adjustments.

**Rollback boundary:** Adjust browser surface creation inside `forge3d-web`; do not change core APIs to satisfy wasm-bindgen quirks unless the core boundary is wrong.

**Completion evidence (2026-06-05):**

- Implemented the `forge3d-web` browser crate modules: `src/lib.rs`, `src/runtime.rs`, `src/error.rs`, `src/inputs.rs`, and `src/io.rs`.
- Added wasm-bindgen exports for `Forge3DRuntime` and `Forge3DError`.
- Added async `Forge3DRuntime.create(canvas, options)` for wasm32 browser builds with `HtmlCanvasElement` surface creation, Phase 5 core `GpuRuntime`/`GpuContext` usage, runtime option parsing, stable error mapping, and `dispose()`.
- Added typed runtime options for `powerPreference`, initial `width`/`height`, `devicePixelRatio`, `clearColor`, `alphaMode`, `colorSpace`, and diagnostics.
- Added the browser npm/TypeScript skeleton: `package.json`, `package-lock.json`, `tsconfig.json`, `vite.config.ts`, `src-ts/index.ts`, and `types/index.d.ts`.
- Added Phase 6 Rust contract tests for required artifacts, public boundary exports, stable error mapping, runtime option validation, IO placeholder behavior, and browser-hostile token exclusion.
- Added web generated-artifact ignore rules for `crates/forge3d-web/node_modules/`, `dist/`, and `pkg/`.

**Verification evidence (2026-06-05):**

```powershell
cargo check -p forge3d-web --target wasm32-unknown-unknown
# Result: exits 0. Full output: logs/phase6-web-wasm-check.txt

cd crates/forge3d-web
npm run typecheck
# Result: exits 0. Full output: logs/phase6-web-typecheck.txt

cd ..\..
cargo test -p forge3d-web
# Result: exits 0; 9 unit tests passed and 0 doc tests. Full output: logs/phase6-web-tests.txt

cargo tree -p forge3d-web --target wasm32-unknown-unknown --edges normal | rg "pyo3|numpy|winit|pollster"
# Result: no matches. Full output: logs/phase6-web-banned-deps.txt

cd crates/forge3d-web
npm audit
# Result: exits 0; found 0 vulnerabilities. Full output: logs/phase6-web-npm-audit.txt
```

**Explicit non-claims:**

- Phase 6 does not implement canvas clear rendering; that remains Phase 7.
- Phase 6 does not implement terrain upload, camera/resize, screenshot/readback, browser IO sources, packaging dry-run, browser tests, or CI.

---

## Phase 7: Minimal Canvas Clear

**Status:** Done

**Goal:** Render a deterministic clear color to an `HtmlCanvasElement` through the browser WebGPU runtime.

**Prerequisites:** Phase 6 is `Done`.

**Scope:**

- Implement async runtime creation against a visible `HtmlCanvasElement`.
- Configure WebGPU surface for the canvas.
- Implement DPR-aware initial size and resize enough for the clear path.
- Implement clear-color render pass.
- Add browser test page and Playwright test that proves nonblank pixels.

**Required artifacts:**

- `crates/forge3d-web/src/runtime.rs`
- `crates/forge3d-core/src/render/**` clear helpers if shared logic is needed.
- `crates/forge3d-web/tests/playwright/**`
- `crates/forge3d-web/examples/test-clear.html` or equivalent served test fixture.

**Verification commands:**

```powershell
wasm-pack build crates/forge3d-web --target web
cd crates/forge3d-web
npm run test:browser
```

**Acceptance criteria:**

- Playwright detects more than 100 nonblack pixels or an equivalent deterministic threshold.
- Runtime creation is async.
- Clear render uses WebGPU presentation to canvas, not a mocked DOM-only pixel write.

**Risks:**

- Local and CI WebGPU availability may differ.

**Rollback boundary:** Keep capability probe diagnostics; do not weaken the pixel proof into only checking `navigator.gpu`.

**Completion evidence (2026-06-05):**

- Added `Forge3DRuntime.render()` in `crates/forge3d-web/src/runtime.rs` with a real WebGPU frame acquisition, clear-color render pass, queue submit, and `frame.present()`.
- Added TypeScript facade and declaration support for `runtime.render()`.
- Added `crates/forge3d-web/examples/test-clear.html` and `crates/forge3d-web/tests/playwright/clear.spec.ts`; the test samples the presented canvas bitmap and requires more than 100 nonblack pixels.
- Added `crates/forge3d-web/playwright.config.ts` using installed Chrome with `--enable-unsafe-webgpu --use-angle=d3d11`, matching the Windows Chrome lane requirement.
- Modernized the active workspace `wgpu` dependency to `29.0.3` and updated the small active GPU runtime/surface-status code needed for current Chrome WebGPU compatibility.

**Verification evidence (2026-06-05):**

```powershell
cargo test -p forge3d-web
# Result: exits 0; 11 unit tests passed and 0 doc tests. Full output: logs/phase7-web-tests.txt

cargo check -p forge3d-web --target wasm32-unknown-unknown
# Result: exits 0. Full output: logs/phase7-web-wasm-check.txt

.\crates\forge3d-web\node_modules\.bin\wasm-pack.cmd build crates/forge3d-web --target web
# Result: exits 0. Full output: logs/phase7-wasm-pack-build.txt

cd crates\forge3d-web
npm run typecheck
# Result: exits 0. Full output: logs/phase7-web-typecheck.txt

npm run test:browser
# Result: exits 0; 1 Chrome Playwright test passed. Full output: logs/phase7-browser-tests.txt

npm audit
# Result: exits 0; found 0 vulnerabilities. Full output: logs/phase7-web-npm-audit.txt

cd ..\..
cargo check -p forge3d-core --target wasm32-unknown-unknown --no-default-features
# Result: exits 0. Full output: logs/phase7-core-wasm-no-default-check.txt

cargo test -p forge3d-core
# Result: exits 0. Full output: logs/phase7-core-tests.txt

cargo check -p forge3d-python
# Result: exits 0. Full output: logs/phase7-python-check.txt

cargo check -p forge3d-native-viewer
# Result: exits 0. Full output: logs/phase7-native-viewer-check.txt

cargo tree -p forge3d-web --target wasm32-unknown-unknown --edges normal | rg "pyo3|numpy|winit|pollster"
# Result: no matches. Full output: logs/phase7-web-banned-deps.txt
```

---

## Phase 8: Terrain Heightmap Upload And Render

**Status:** Done

**Goal:** Upload a typed-array terrain heightmap from JavaScript and render visible terrain variation in browser.

**Prerequisites:** Phase 7 is `Done`.

**Scope:**

- Add `TerrainHeightmapInput` validation.
- Accept `Float32Array` data with explicit width and height.
- Reject wrong lengths, zero dimensions, and non-finite values.
- Upload terrain as `R32Float` or a fallback representation accepted by browser adapters.
- Draw a terrain mesh using core render resources.
- Add a synthetic hill browser pixel test.

**Required artifacts:**

- `crates/forge3d-core/src/terrain/**`
- `crates/forge3d-web/src/inputs.rs`
- `crates/forge3d-web/src/runtime.rs`
- `crates/forge3d-web/types/index.d.ts`
- `crates/forge3d-web/tests/playwright/**`

**Verification commands:**

```powershell
wasm-pack build crates/forge3d-web --target web
cd crates/forge3d-web
npm run typecheck
npm run test:browser
```

**Acceptance criteria:**

- Browser test renders a synthetic hill with measurable height/color variation.
- Invalid typed arrays fail with `Forge3DError("INVALID_INPUT")`.
- Rendering path handles missing `FLOAT32_FILTERABLE` by using a nearest-sampling or non-filtered fallback.

**Risks:**

- Browser adapters may not support the same float texture filtering as native adapters.

**Rollback boundary:** Keep terrain upload API shape; swap internal texture strategy if browser support requires it.

**Completion evidence (2026-06-05):**

- Added `crates/forge3d-core/src/terrain.rs` with the narrow wasm-safe `TerrainHeightmapInput` validation contract and kept the staged legacy terrain directory unexposed from the active core root.
- Added JS terrain parsing in `crates/forge3d-web/src/inputs.rs` for `{ width, height, heights: Float32Array }`, with wrong lengths, zero dimensions, and non-finite values mapped to `Forge3DError("INVALID_INPUT")`.
- Added `Forge3DRuntime.setTerrain()` in Rust and TypeScript, with hand-authored `TerrainHeightmapInput` declarations.
- Added WebGPU terrain resources in `crates/forge3d-web/src/runtime.rs`: R32Float height texture upload, nearest non-filtering sampler fallback, terrain mesh vertex/index buffers, WGSL shader, render pipeline, and `draw_indexed` path.
- Added `crates/forge3d-web/examples/test-terrain-hill.html` and `crates/forge3d-web/tests/playwright/terrain.spec.ts`; the browser test verifies invalid input error mapping and measurable color variation from a synthetic hill.

**Verification evidence (2026-06-05):**

```powershell
cargo test -p forge3d-core --features webgpu terrain_heightmap
# Result: exits 0; 4 tests passed. Full output: logs/phase8-core-terrain-tests.txt

cargo test -p forge3d-web
# Result: exits 0; 16 unit tests passed and 0 doc tests. Full output: logs/phase8-web-tests.txt

cargo check -p forge3d-web --target wasm32-unknown-unknown
# Result: exits 0. Full output: logs/phase8-web-wasm-check.txt

.\crates\forge3d-web\node_modules\.bin\wasm-pack.cmd build crates\forge3d-web --target web
# Result: exits 0. Full output: logs/phase8-wasm-pack-build.txt

cd crates\forge3d-web
npm run typecheck
# Result: exits 0. Full output: logs/phase8-web-typecheck.txt

npm run test:browser
# Result: exits 0; 2 Chrome Playwright tests passed. Full output: logs/phase8-browser-tests.txt

cd ..\..
cargo check -p forge3d-core --target wasm32-unknown-unknown --no-default-features
# Result: exits 0. Full output: logs/phase8-core-wasm-no-default-check.txt

cargo tree -p forge3d-web --target wasm32-unknown-unknown --edges normal | rg "pyo3|numpy|winit|pollster"
# Result: no matches. Full tree: logs/phase8-web-cargo-tree.txt; empty match log: logs/phase8-web-banned-deps.txt
```

**Explicit non-claims:**

- Phase 8 does not add camera controls, DPR resize API, screenshots/readback, browser IO sources, packaging dry-run, CI, or Python/native compatibility restoration.
- Terrain rendering is the browser MVP path only; the staged native/offline terrain renderer remains outside the active core root.

---

## Phase 9: Camera And Resize API

**Status:** Done

**Goal:** Expose stable camera controls and explicit DPR-aware resize behavior for browser runtime.

**Prerequisites:** Phase 8 is `Done`.

**Scope:**

- Add `setCamera` API.
- Validate finite camera position, target, up vector, field of view, near plane, and far plane.
- Add explicit resize API using CSS width, CSS height, and DPR.
- Reconfigure surface on resize.
- Update projection matrices after resize and camera changes.
- Add browser resize and camera-change pixel tests.

**Required artifacts:**

- `crates/forge3d-core/src/camera/**`
- `crates/forge3d-web/src/runtime.rs`
- `crates/forge3d-web/types/index.d.ts`
- `crates/forge3d-web/tests/playwright/**`

**Verification commands:**

```powershell
cd crates/forge3d-web
npm run typecheck
npm run test:browser
```

**Acceptance criteria:**

- Canvas backing dimensions match CSS dimensions multiplied by DPR.
- Camera changes alter rendered terrain pixels in a deterministic test.
- Invalid camera inputs fail with `Forge3DError("INVALID_INPUT")`.

**Risks:**

- CSS size, canvas backing size, and surface config size can diverge.

**Rollback boundary:** Keep the public API explicit; do not infer DPR from global browser state in a way tests cannot control.

**Completion evidence (2026-06-05):**

- Added `crates/forge3d-core/src/camera/mod.rs` with wasm-safe `CameraInput` validation for finite position, target, up vector, field of view, near plane, far plane, non-zero up vector, distinct position/target, and view-projection matrix generation.
- Exposed `forge3d_core::camera` behind the existing `webgpu` feature gate and added Phase 9 core contract tests.
- Added `CameraOptions` and `ResizeOptions` parsing in `crates/forge3d-web/src/inputs.rs`, mapping invalid browser inputs to `Forge3DError("INVALID_INPUT")`.
- Added `Forge3DRuntime.setCamera()` and `Forge3DRuntime.resize()` in Rust and TypeScript. Resize uses explicit CSS width, CSS height, and `devicePixelRatio`, sets the canvas backing dimensions, reconfigures `SurfaceState`, updates runtime dimensions, and refreshes terrain camera uniforms.
- Updated the browser terrain pipeline from fixed clip-space vertices to world-space terrain transformed by a camera uniform, so camera changes alter rendered terrain pixels.
- Added `CameraInput` and `ResizeInput` to the TypeScript facade and hand-authored declarations.
- Added `crates/forge3d-web/examples/test-camera-resize.html` and `crates/forge3d-web/tests/playwright/camera_resize.spec.ts`; the browser test verifies DPR backing dimensions, invalid camera error mapping, and deterministic camera-driven pixel changes.

**Verification evidence (2026-06-05):**

```powershell
cargo fmt --all -- --check
# Result: exits 0. Full output: logs/phase9-cargo-fmt-check.txt

cargo test -p forge3d-core --features webgpu camera
# Result: exits 0; 4 tests passed. Full output: logs/phase9-core-camera-tests.txt

cargo test -p forge3d-web
# Result: exits 0; 21 unit tests passed and 0 doc tests. Full output: logs/phase9-web-tests.txt

cargo check -p forge3d-core --target wasm32-unknown-unknown --no-default-features
# Result: exits 0. Full output: logs/phase9-core-wasm-no-default-check.txt

cargo check -p forge3d-web --target wasm32-unknown-unknown
# Result: exits 0. Full output: logs/phase9-web-wasm-check.txt

.\crates\forge3d-web\node_modules\.bin\wasm-pack.cmd build crates\forge3d-web --target web
# Result: exits 0. Full output: logs/phase9-wasm-pack-build.txt

cd crates\forge3d-web
npm run typecheck
# Result: exits 0. Full output: logs/phase9-web-typecheck.txt

npm run test:browser
# Result: exits 0; 3 Chrome Playwright tests passed. Full output: logs/phase9-browser-tests.txt

cd ..\..
cargo tree -p forge3d-web --target wasm32-unknown-unknown --edges normal | rg "pyo3|numpy|winit|pollster"
# Result: no matches. Full tree: logs/phase9-web-cargo-tree.txt; no-match log: logs/phase9-web-banned-deps.txt
```

---

## Phase 10: Screenshot/Readback

**Status:** Done

**Goal:** Provide an async browser screenshot API that returns a PNG `Blob`.

**Prerequisites:** Phase 9 is `Done`.

**Scope:**

- Add async padded GPU readback path.
- Respect `COPY_BYTES_PER_ROW_ALIGNMENT`.
- Encode readback pixels as PNG.
- Return a browser `Blob` with PNG MIME type.
- Reject screenshots after `dispose()`.
- Add browser screenshot test.

**Required artifacts:**

- `crates/forge3d-core/src/readback/**`
- `crates/forge3d-web/src/runtime.rs`
- `crates/forge3d-web/types/index.d.ts`
- `crates/forge3d-web/tests/playwright/**`

**Verification commands:**

```powershell
cargo test -p forge3d-core readback
cd crates/forge3d-web
npm run typecheck
npm run test:browser
```

**Acceptance criteria:**

- `await runtime.screenshot()` returns a `Blob`.
- Blob type is `image/png`.
- Blob size is greater than zero.
- Readback handles row padding correctly.

**Risks:**

- Rust-side PNG encoding may increase wasm size or runtime cost.

**Rollback boundary:** If Rust PNG is too heavy, keep public API and replace implementation with browser canvas/ImageData encoding.

**Completion evidence (2026-06-05):**

- Added `crates/forge3d-core/src/readback/mod.rs` with a narrow wasm-safe readback layout contract, WebGPU `COPY_BYTES_PER_ROW_ALIGNMENT` row padding, RGBA8 layout helpers, padded-buffer sizing, and row-unpadding tests.
- Exposed `forge3d_core::readback` behind the existing `webgpu` feature gate and added a Phase 10 core contract test.
- Added `Forge3DRuntime.screenshot()` in Rust and TypeScript. The runtime renders the current scene into an offscreen copyable WebGPU texture, copies it into a padded readback buffer, maps the buffer asynchronously, unpads rows, normalizes BGRA/RGBA canvas formats to RGBA, and uses browser `ImageData` plus `canvas.toBlob("image/png")` to return a PNG `Blob`.
- Added disposed-runtime rejection for `screenshot()` through the existing `RUNTIME_DISPOSED` error path.
- Added `crates/forge3d-web/examples/test-screenshot.html` and `crates/forge3d-web/tests/playwright/screenshot.spec.ts`; the browser test verifies `Blob.type === "image/png"`, nonzero PNG size, PNG signature bytes, exact screenshot dimensions, and disposed-runtime rejection.
- Added `screenshot(): Promise<Blob>` to the TypeScript facade and hand-authored declarations.

**Verification evidence (2026-06-05):**

```powershell
cargo fmt --all -- --check
# Result: exits 0. Full output: logs/phase10-cargo-fmt-check.txt

cargo test -p forge3d-core --features webgpu readback
# Result: exits 0; 4 tests passed. Full output: logs/phase10-core-readback-tests.txt

cargo test -p forge3d-web
# Result: exits 0; 22 unit tests passed and 0 doc tests. Full output: logs/phase10-web-tests.txt

cargo check -p forge3d-core --target wasm32-unknown-unknown --no-default-features
# Result: exits 0. Full output: logs/phase10-core-wasm-no-default-check.txt

cargo check -p forge3d-web --target wasm32-unknown-unknown
# Result: exits 0. Full output: logs/phase10-web-wasm-check.txt

.\crates\forge3d-web\node_modules\.bin\wasm-pack.cmd build crates\forge3d-web --target web
# Result: exits 0. Full output: logs/phase10-wasm-pack-build.txt

cd crates\forge3d-web
npm run typecheck
# Result: exits 0. Full output: logs/phase10-web-typecheck.txt

npm run test:browser
# Result: exits 0; 4 Chrome Playwright tests passed. Full output: logs/phase10-browser-tests.txt

cd ..\..
cargo tree -p forge3d-web --target wasm32-unknown-unknown --edges normal | rg "pyo3|numpy|winit|pollster"
# Result: no matches. Full tree: logs/phase10-web-cargo-tree.txt; no-match log: logs/phase10-web-banned-deps.txt
```

**Explicit non-claims:**

- Phase 10 does not freeze the JS/TS API beyond adding `screenshot()`; full API stabilization remains Phase 11.
- Phase 10 does not add URL/File/Blob/ArrayBuffer input adapters; browser IO abstraction remains Phase 12.

---

## Phase 11: JS/TS API Stabilization

**Status:** Done

**Goal:** Freeze the public browser API names, types, handles, error codes, and lifetime rules behind a stable TypeScript facade.

**Prerequisites:** Phase 10 is `Done`.

**Scope:**

- Hand-author `types/index.d.ts`.
- Keep wasm-bindgen generated names behind `src-ts/index.ts`.
- Document object lifetimes and disposed-runtime behavior.
- Stabilize terrain, camera, resize, render, screenshot, and dispose signatures.
- Add API snapshot or type-level tests.

**Required artifacts:**

- `crates/forge3d-web/types/index.d.ts`
- `crates/forge3d-web/src-ts/index.ts`
- `crates/forge3d-web/tests/api/public-api-consumer.ts`
- `crates/forge3d-web/tests/api/public-api-snapshot.mjs`
- `crates/forge3d-web/tests/api/index.d.ts.snapshot`
- `crates/forge3d-web/tsconfig.api.json`
- `crates/forge3d-web/docs/browser-api.md`

**Verification commands:**

```powershell
cd crates/forge3d-web
npm run typecheck
npm run test:api
npm run test:browser
```

**Acceptance criteria:**

- Public TypeScript API matches the source plan's MVP surface.
- Generated wasm-bindgen internals do not leak as the primary user API.
- Error codes are stable and documented.

**Risks:**

- wasm-bindgen generated exports may drift across builds.

**Rollback boundary:** Keep the stable facade separate from generated JS and adjust only the facade adapter if generated names change.

**Completion evidence (2026-06-05):**

- Added JSDoc to the hand-authored `crates/forge3d-web/types/index.d.ts` so the stable MVP browser API documents runtime creation, terrain, camera, resize, render, screenshot, dispose, diagnostics, and error behavior.
- Added `crates/forge3d-web/tests/api/index.d.ts.snapshot` as the public declaration lock and `crates/forge3d-web/tests/api/public-api-snapshot.mjs` to reject declaration drift or leaked wasm-bindgen/generated bridge details such as `WasmRuntime`, `WasmBridge`, `__wbg`, `free()`, and `../pkg/`.
- Added `crates/forge3d-web/tests/api/public-api-consumer.ts` plus `crates/forge3d-web/tsconfig.api.json` as a strict consumer type-level test for `Forge3DRuntime.create`, `setTerrain`, `setCamera`, `resize`, `render`, `screenshot`, `dispose`, runtime properties, `Forge3DError`, and `Forge3DErrorCode`.
- Updated `crates/forge3d-web/package.json` so `npm run typecheck` also compiles the API consumer test and `npm run test:api` runs the typecheck plus snapshot/doc guard.
- Added `crates/forge3d-web/docs/browser-api.md` documenting public API examples, lifetime rules, copied typed-array behavior, disposed-runtime behavior, and stable error codes.
- Added Rust artifact guards in `crates/forge3d-web/src/lib.rs` so Phase 11 docs and API contract tests are covered by `cargo test -p forge3d-web`.

**Verification evidence (2026-06-05):**

```powershell
cd crates/forge3d-web
npm run test:api
# Result: exits 0. Full output: logs/phase11-web-api-tests.txt

npm run typecheck
# Result: exits 0. Full output: logs/phase11-web-typecheck.txt

npm run test:browser
# Result: exits 0; Chrome Playwright tests passed. Full output: logs/phase11-browser-tests.txt

cd ../..
cargo test -p forge3d-web
# Result: exits 0. Full output: logs/phase11-web-cargo-tests.txt
```

---

## Phase 12: Browser IO Abstraction

**Status:** Done

**Goal:** Add browser-compatible byte source abstractions for URL, File, Blob, and ArrayBuffer terrain inputs.

**Prerequisites:** Phase 11 is `Done`.

**Scope:**

- Completed 2026-06-05: added core `ByteSource`/`ByteRange` contracts plus little-endian f32 byte decoding.
- Completed 2026-06-05: added browser adapters for URL/fetch, `File`, `Blob`, and `ArrayBuffer` terrain heightmap bytes.
- Completed 2026-06-05: added progress callback and `AbortSignal` cancellation mapping.
- Completed 2026-06-05: mapped fetch/CORS/body/range failures to `IO_ERROR` and aborts to `REQUEST_CANCELLED`.
- Completed 2026-06-05: added fake source unit tests, API contract coverage, and browser tests for all source adapters.

**Required artifacts:**

- `crates/forge3d-core/src/io/mod.rs`
- `crates/forge3d-core/src/io/source.rs`
- `crates/forge3d-web/src/io.rs`
- `crates/forge3d-web/types/index.d.ts`
- `crates/forge3d-web/tests/playwright/**`

**Verification commands:**

```powershell
cargo test -p forge3d-core io
cd crates/forge3d-web
npm run typecheck
npm run test:browser
```

**Acceptance criteria:**

- URL terrain input works in `tests/playwright/terrain_sources.spec.ts` via a fetch-backed data URL.
- Blob/File/ArrayBuffer terrain inputs work in the same browser test.
- CORS/fetch/range/body failures map to documented `IO_ERROR`; aborted reads map to `REQUEST_CANCELLED`.

**Risks:**

- Range request availability depends on server headers.

**Rollback boundary:** Keep core byte-source abstraction and replace only browser adapter behavior if fetch constraints require it.

---

## Phase 13: Packaging

**Status:** Done

**Goal:** Produce a publishable browser package with JS, wasm, TypeScript declarations, README, licenses, and a working Vite example.

**Prerequisites:** Phase 12 is `Done`.

**Scope:**

- Finalize `crates/forge3d-web/package.json`.
- Build wasm into package `dist`.
- Build TypeScript facade into package `dist`.
- Copy or reference licenses.
- Add package README with browser support, MIME, CORS, and MVP exclusions.
- Add Vite example that imports from package entrypoint.
- Add dry-run packaging verification.

**Required artifacts:**

- `crates/forge3d-web/package.json`
- `crates/forge3d-web/scripts/prepare-dist.mjs`
- `crates/forge3d-web/README.md`
- `crates/forge3d-web/examples/vite/**`
- `crates/forge3d-web/dist/**` generated during verification, not necessarily committed unless release policy requires it.

**Verification commands:**

```powershell
wasm-pack build crates/forge3d-web --target web
cd crates/forge3d-web
npm run build
npm pack --dry-run
npm run typecheck
```

**Acceptance criteria:**

- Dry-run package contains JS, wasm, `.d.ts`, README, and license files.
- Vite example builds against the package entrypoint.
- Published API is ESM-only as specified.

**Risks:**

- Bundlers may fail to resolve the wasm asset path.

**Rollback boundary:** Keep package API stable; adjust dist preparation and package exports only.

**Completion evidence (2026-06-05):**

- Finalized `crates/forge3d-web/package.json` as an ESM-only npm package with `dist/index.js`, `types/index.d.ts`, and `dist/forge3d_web_bg.wasm` exports.
- Added `crates/forge3d-web/scripts/prepare-dist.mjs` to copy wasm-pack browser artifacts into `dist`, copy package license files from the repo root, and rewrite the published facade so `dist/index.js` loads `./forge3d_web.js` instead of the local-only `../pkg` path.
- Added `crates/forge3d-web/README.md` with install instructions, browser support, WebGPU detection, wasm MIME guidance, CORS/Range guidance, public API summary, and MVP exclusions.
- Added `crates/forge3d-web/examples/vite/**`, a package-consumer Vite example that imports `Forge3DRuntime` from `@forge3d/web`.
- Added `crates/forge3d-web/tests/api/package-contract.mjs` and `npm run test:package` to assert package metadata, README guidance, Vite example import shape, dist wasm assets, local dist wasm bridge path, and `npm pack --dry-run` contents.
- Updated ignore rules for generated web package/example build artifacts.

**Verification evidence (2026-06-05):**

```powershell
cd crates\forge3d-web
npm run build
# Result: exits 0. Full output: logs/phase13-web-build.txt

npm run test:package
# Result: exits 0. Full output: logs/phase13-package-contract.txt

npm pack --dry-run
# Result: exits 0; dry run includes dist/index.js, dist/forge3d_web.js, dist/forge3d_web_bg.wasm, types/index.d.ts, README.md, LICENSE, and LICENSE-APACHE. Full output: logs/phase13-npm-pack-dry-run.txt

npm run typecheck
# Result: exits 0. Full output: logs/phase13-web-typecheck.txt
```

---

## Phase 14: Browser CI

**Status:** Pending

**Goal:** Add CI jobs that prove wasm compilation, package build, typecheck, and browser render tests.

**Prerequisites:** Phase 13 is `Done`.

**Scope:**

- Add `.github/workflows/web.yml`.
- Install Rust wasm target.
- Install Node 20.
- Install npm dependencies for `crates/forge3d-web`.
- Build/check `forge3d-core` and `forge3d-web`.
- Run `wasm-pack build`.
- Run TypeScript typecheck.
- Install Chromium for Playwright.
- Run required browser render tests with WebGPU diagnostics.

**Required artifacts:**

- `.github/workflows/web.yml`
- Playwright tests used by CI.
- CI documentation if required by repository conventions.

**Verification commands:**

```powershell
cargo check -p forge3d-core --target wasm32-unknown-unknown --no-default-features
cargo check -p forge3d-web --target wasm32-unknown-unknown
wasm-pack build crates/forge3d-web --target web
cd crates/forge3d-web
npm ci
npm run typecheck
npm run test:browser
```

**Acceptance criteria:**

- GitHub Actions web job is present and matches local required commands.
- CI requires a Windows Chromium lane for the MVP pixel test.
- Capability diagnostics make WebGPU failures distinguishable from test logic failures.

**Risks:**

- Hosted GPU/WebGPU availability may vary.

**Rollback boundary:** Keep local browser tests; adjust CI browser channel/flags and diagnostics rather than removing the lane.

---

## Phase 15: Native/Python Compatibility Restoration

**Status:** Pending

**Goal:** Restore Python wheel builds, Python import/API contracts, and native viewer build behavior after crate separation.

**Prerequisites:** Phase 14 is `Done`.

**Scope:**

- Reconnect Python wrappers to core.
- Build `forge3d._forge3d` from `crates/forge3d-python`.
- Preserve package-level Python exports in `python/forge3d`.
- Preserve `Scene.render_rgba()` as a Python-only blocking convenience API.
- Restore native viewer binary under `forge3d-native-viewer`.
- Ensure native viewer owns winit, stdin, TCP IPC, and desktop snapshot plumbing.

**Required artifacts:**

- `crates/forge3d-python/**`
- `crates/forge3d-native-viewer/**`
- Root `pyproject.toml`
- `python/forge3d/**`
- Python smoke and API contract tests.

**Verification commands:**

```powershell
python -m maturin build --manifest-path crates/forge3d-python/Cargo.toml --release --out dist
python scripts/install_compatible_wheel.py dist
pytest tests/test_install_smoke.py tests/test_api_contracts.py -v --tb=short
cargo check -p forge3d-native-viewer
```

**Acceptance criteria:**

- Built wheel exposes `forge3d._forge3d`.
- Existing install smoke tests pass.
- Existing API contract tests pass or intentional changes are explicitly documented and covered by updated tests.
- Native viewer code lives outside core/web paths.

**Risks:**

- Wrapper behavior drift from moving PyO3 classes.

**Rollback boundary:** Revert compatibility changes module-by-module while preserving already verified core/web boundaries.

---

## Phase 16: MVP Release Hardening

**Status:** Pending

**Goal:** Prepare the browser WebGPU/WASM MVP for prerelease with complete docs, release notes, examples, package metadata, and full verification.

**Prerequisites:** Phase 15 is `Done`.

**Scope:**

- Update browser README.
- Add browser support matrix.
- Document wasm MIME requirements.
- Document CORS and Range guidance.
- Document cache header guidance.
- Document MVP exclusions.
- Update changelog.
- Run full CI-equivalent verification locally.
- Produce npm package dry run.
- Produce Python wheel build.

**Required artifacts:**

- `crates/forge3d-web/README.md`
- Browser support matrix documentation.
- Release checklist documentation.
- `CHANGELOG.md`
- Package metadata updates.
- Example updates.

**Verification commands:**

```powershell
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --features default -- -D warnings
cargo test -p forge3d-core
cargo check -p forge3d-core --target wasm32-unknown-unknown --no-default-features
cargo check -p forge3d-web --target wasm32-unknown-unknown
wasm-pack build crates/forge3d-web --target web
cd crates/forge3d-web
npm ci
npm run typecheck
npm run test:browser
npm pack --dry-run
cd ..\..
python -m maturin build --manifest-path crates/forge3d-python/Cargo.toml --release --out dist
python scripts/install_compatible_wheel.py dist
pytest tests/test_install_smoke.py tests/test_api_contracts.py -v --tb=short
cargo check -p forge3d-native-viewer
```

**Acceptance criteria:**

- Full CI-equivalent verification passes.
- Browser package dry run contains expected assets.
- Python wheel build and API contracts pass.
- Release docs state browser support, MIME requirements, CORS/Range guidance, cache headers, and MVP exclusions.
- Post-MVP features remain behind explicit unsupported errors or documentation, not silent partial behavior.

**Risks:**

- Scope creep toward Python/native feature parity.

**Rollback boundary:** Keep post-MVP features out of the MVP release; remove or gate incomplete APIs rather than broadening release scope.
