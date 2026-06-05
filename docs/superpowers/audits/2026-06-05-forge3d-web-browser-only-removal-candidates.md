# Forge3D Web Browser-Only Removal Candidate Audit

Date: 2026-06-05

Primary spec: `docs/superpowers/specs/2026-06-05-forge3d-browser-webgpu-wasm-migration-goals.md`

Related plan: `docs/superpowers/plans/2026-06-04-forge3d-browser-webgpu-wasm-runtime.md`

## Scope And Governing Assumption

This audit treats `forge3d-web` as a browser/npm/WASM-only repository. Under
that policy, the product surface to preserve is:

- `@forge3d/web` as an ESM npm package.
- Browser WebGPU rendering through an `HTMLCanvasElement`.
- wasm-bindgen, TypeScript facade/declarations, Vite/browser examples, and
  Playwright browser tests.
- Core Rust support for the current browser MVP: async GPU context ownership,
  error mapping, camera validation, Float32 terrain heightmaps, browser-safe
  byte-source IO, and RGBA readback helpers.
- Browser packaging and release docs under `crates/forge3d-web`.

The migration goals spec still records Phase 15, "Native/Python Compatibility
Restoration", as complete. That phase is incompatible with the browser-only
repo policy if interpreted as an ongoing objective. The removal candidates
below are safe only because the browser-only policy supersedes Python/native
restoration for this repository. If Phase 15 remains a hard objective, then
`crates/forge3d-python`, `crates/forge3d-native-viewer`, `python`, `pyproject.toml`,
root `tests`, and Python/native CI are not safe to remove.

No files were removed during this audit.

## Evidence Checked

- Root `Cargo.toml` is still a four-member workspace:
  `crates/forge3d-core`, `crates/forge3d-python`, `crates/forge3d-web`, and
  `crates/forge3d-native-viewer`.
- `crates/forge3d-web` is no longer a shell. It contains the Rust wasm crate,
  TypeScript facade, declarations, package metadata, npm lockfile, Vite example,
  package docs, API/package contract tests, and Playwright browser tests.
- `crates/forge3d-web/src` production code imports only the browser-safe core
  surface: `forge3d_core::error`, `gpu`, `camera`, `terrain`, `readback`, and
  `io::source`.
- `crates/forge3d-core/src/lib.rs` exposes only `feature_gates`, `error`, `io`,
  and, behind `webgpu`/`gpu`, `gpu`, `camera`, `terrain`, and `readback`.
- The active core terrain contract is `crates/forge3d-core/src/terrain.rs`.
  The staged legacy directory `crates/forge3d-core/src/terrain/` is not the
  active module root.
- The active camera contract is `crates/forge3d-core/src/camera/mod.rs`.
- The active readback contract is `crates/forge3d-core/src/readback/mod.rs`.
- The active browser-safe IO contract is `crates/forge3d-core/src/io/mod.rs`
  plus `crates/forge3d-core/src/io/source.rs`.
- Top-level `src/` is legacy source. The root manifest has no root package, so
  top-level `src/` is not active Cargo source.
- Tracked legacy-heavy areas include top-level `src` with 1074 tracked files,
  root `tests` with 211 files, `python` with 91 files, top-level `examples` with
  54 files, `crates/forge3d-python` with 160 files, and large staged legacy
  folders under `crates/forge3d-core/src`.
- `.github/workflows/web.yml` is the browser CI workflow. The other workflows
  are Python/docs/PyPI/legacy product workflows.

## Must Keep For Browser/npm/WASM Objectives

These are not removal candidates.

| Path | Reason |
|---|---|
| `crates/forge3d-web/Cargo.toml` | Rust wasm package manifest for `forge3d-web`. |
| `crates/forge3d-web/src/**` | Browser wasm runtime, WebGPU canvas presentation, terrain upload/render, screenshot, browser IO, and error boundary. |
| `crates/forge3d-web/src-ts/index.ts` | Stable TypeScript facade that hides wasm-pack generated details. |
| `crates/forge3d-web/types/index.d.ts` | Public TypeScript API contract. |
| `crates/forge3d-web/package.json` | npm package metadata, exports, scripts, package allowlist, and dev dependencies. |
| `crates/forge3d-web/package-lock.json` | Reproducible npm dependency lock for CI/package verification. |
| `crates/forge3d-web/README.md` | Browser package README included in npm dry-run package. |
| `crates/forge3d-web/LICENSE`, `crates/forge3d-web/LICENSE-APACHE` | Package-local license files included in npm package. |
| `crates/forge3d-web/docs/**` | Browser API docs, support matrix, and release checklist. These are package artifacts. |
| `crates/forge3d-web/examples/test-*.html` | Browser test fixtures used by Playwright. |
| `crates/forge3d-web/examples/vite/**` | Package-consumer Vite example required by Phase 13 packaging. |
| `crates/forge3d-web/tests/**` | API/package contract tests and browser Playwright tests. |
| `crates/forge3d-web/playwright.config.ts` | Browser test runner configuration. |
| `crates/forge3d-web/tsconfig.json`, `crates/forge3d-web/tsconfig.api.json`, `crates/forge3d-web/vite.config.ts` | Required for typecheck, package build, and dev server. |
| `crates/forge3d-web/scripts/prepare-dist.mjs` | Builds package `dist` by copying wasm-pack output and rewriting local wasm bridge paths. |
| `crates/forge3d-core/Cargo.toml` | Core manifest for the browser-safe Rust support crate. |
| `crates/forge3d-core/src/lib.rs` | Active core public root and phase contract tests. |
| `crates/forge3d-core/src/error.rs` | Shared error type mapped into browser errors. |
| `crates/forge3d-core/src/feature_gates.rs` | Documents the core browser/native split and backs contract tests. |
| `crates/forge3d-core/src/gpu/**` | Async `GpuRuntime`, `GpuContext`, and `SurfaceState` used by the web runtime. |
| `crates/forge3d-core/src/camera/mod.rs` | Phase 9 browser-safe camera validation and matrix contract. |
| `crates/forge3d-core/src/terrain.rs` | Phase 8 browser-safe terrain heightmap validation and mesh descriptor. |
| `crates/forge3d-core/src/readback/mod.rs` | Phase 10 row-padding/readback helpers used by browser screenshots. |
| `crates/forge3d-core/src/io/mod.rs`, `crates/forge3d-core/src/io/source.rs` | Phase 12 browser-safe byte-source abstraction and f32 decoding. |
| `.github/workflows/web.yml` | Browser CI workflow required by Phase 14. |
| `Cargo.toml` | Keep as workspace manifest, but remove Python/native members and dependencies during cleanup. |
| `Cargo.lock` | Keep and regenerate after manifest cleanup. Do not hand-edit. |
| `LICENSE`, `LICENSE-APACHE`, `.gitattributes`, `.gitignore` | Repository source/package hygiene. |
| `AGENTS.md` | Local agent guidance. It can be rewritten later, but deleting it loses useful migration notes. |
| `docs/superpowers/specs/2026-06-05-forge3d-browser-webgpu-wasm-migration-goals.md` | Active migration objective ledger, even though it should be revised for browser-only policy. |
| `docs/superpowers/plans/2026-06-04-forge3d-browser-webgpu-wasm-runtime.md` | Active architecture and phase plan. |
| `docs/superpowers/audits/2026-06-04-forge3d-browser-webgpu-wasm-phase1-baseline-audit.md` | Referenced Phase 1 evidence. |
| `docs/superpowers/audits/2026-06-05-forge3d-web-browser-only-removal-candidates.md` | This audit. |

## High-Confidence Removal Candidates

These paths are outside the browser/npm/WASM objective. Removing them will
require the manifest, docs, and CI cleanup listed later, but they are not needed
for the aimed browser functionality.

### Python Package, PyO3, And Wheel Surface

| Path | Why it can go |
|---|---|
| `crates/forge3d-python/` | PyO3 extension crate, Python compatibility shims, NumPy boundary, and blocking Python helpers. Browser package does not import it. |
| `python/` | Python package, stubs, adapters, viewer wrappers, local dependency stubs, and Python tools. Not part of npm/WASM. |
| `pyproject.toml` | maturin/Python package metadata and wheel configuration. Browser package metadata lives in `crates/forge3d-web/package.json`. |
| `MANIFEST.in` | Python sdist/wheel packaging file. |
| `pytest.ini` | Root pytest configuration for old Python tests. |
| `conftest.py` | Root pytest setup. |
| `tests/` | Root Python/native/API/golden test suite. The browser package has its own tests under `crates/forge3d-web/tests`. |

### Native/Desktop Viewer Surface

| Path | Why it can go |
|---|---|
| `crates/forge3d-native-viewer/` | Native viewer binary/test crate owning `winit`, stdin/TCP IPC, and desktop snapshot behavior. |
| `cmake/` | Native/CMake integration artifacts, not npm/WASM packaging. |
| `CMakeLists.txt` | Native/Python build integration, including `python/forge3d` copying. |

### Legacy Root Rust Source

| Path | Why it can go |
|---|---|
| `src/` | Inactive legacy root source. Root `Cargo.toml` is a workspace manifest only, so this tree is not active Cargo source. Browser-needed camera/terrain/readback/IO/GPU logic already exists under `crates/forge3d-core` and `crates/forge3d-web`. |

### Inactive `forge3d-core` Staging Directories

Keep only the active core files/directories listed in "Must Keep". The
following directories under `crates/forge3d-core/src` are staged legacy source
or non-MVP feature surfaces and are not imported by the active browser core root.

| Path | Why it can go |
|---|---|
| `crates/forge3d-core/src/accel/` | BVH/acceleration staging for path tracing/native rendering, not current browser terrain MVP. |
| `crates/forge3d-core/src/animation/` | Offline/native frame queue workflow, not browser runtime. |
| `crates/forge3d-core/src/bin/` | Legacy binary entrypoint staging. |
| `crates/forge3d-core/src/bundle/` | Scene bundle workflow outside the browser MVP. |
| `crates/forge3d-core/src/cli/` | Native CLI parsing and viewer commands. |
| `crates/forge3d-core/src/colormap/` | Legacy colormap implementation not used by current web runtime. |
| `crates/forge3d-core/src/converters/` | Native/Python conversion staging. |
| `crates/forge3d-core/src/core/` | Legacy monolithic native/offline GPU tree, not re-exposed by browser-safe core root. |
| `crates/forge3d-core/src/export/` | SVG/native export paths outside browser MVP. |
| `crates/forge3d-core/src/external_image/` | Native image helper staging. |
| `crates/forge3d-core/src/formats/` | Legacy HDR/format staging not used by current web package. |
| `crates/forge3d-core/src/geo/` | GIS/native geospatial staging outside current browser API. |
| `crates/forge3d-core/src/geometry/` | Native/Python geometry utilities not exposed through `@forge3d/web`. |
| `crates/forge3d-core/src/import/` | Native import loaders. Browser IO uses `io::source` plus web adapters instead. |
| `crates/forge3d-core/src/labels/` | Label system is not in the browser MVP. |
| `crates/forge3d-core/src/license/` | Native/Python license gating, not browser MVP. |
| `crates/forge3d-core/src/lighting/` | Advanced native/Python lighting surface not exposed by current browser API. |
| `crates/forge3d-core/src/loaders/` | Native file/texture loaders outside browser-safe public API. |
| `crates/forge3d-core/src/mesh/` | Mesh helpers not exposed by current browser terrain MVP. |
| `crates/forge3d-core/src/offscreen/` | Native/headless rendering paths. Browser uses canvas presentation and async screenshot. |
| `crates/forge3d-core/src/p5/` | Legacy analysis/demo staging. |
| `crates/forge3d-core/src/passes/` | Advanced native/offline passes outside current browser API. |
| `crates/forge3d-core/src/path_tracing/` | Path tracing is explicitly outside the browser MVP. |
| `crates/forge3d-core/src/picking/` | Picking is not in the current browser MVP API. |
| `crates/forge3d-core/src/pipeline/` | Legacy PBR/offscreen pipeline staging not imported by web runtime. |
| `crates/forge3d-core/src/pointcloud/` | COPC/EPT/LAZ streaming is explicitly excluded from the browser MVP. |
| `crates/forge3d-core/src/render/` | Legacy native render helpers not imported by current web runtime. |
| `crates/forge3d-core/src/scene/` | Python/native scene surface not exposed through browser API. |
| `crates/forge3d-core/src/sdf/` | SDF/hybrid rendering is not in the browser MVP. |
| `crates/forge3d-core/src/shaders/` | Legacy shader library is not referenced by current `forge3d-web` or active core modules. |
| `crates/forge3d-core/src/shadows/` | Native/advanced shadow surface outside current browser API. |
| `crates/forge3d-core/src/style/` | Mapbox/style parity is explicitly excluded from browser MVP. |
| `crates/forge3d-core/src/terrain/` | Legacy terrain directory. The active browser contract is `crates/forge3d-core/src/terrain.rs`. |
| `crates/forge3d-core/src/tiles3d/` | 3D Tiles is explicitly excluded from browser MVP. |
| `crates/forge3d-core/src/util/` | Native/offline utilities not imported by active browser modules. |
| `crates/forge3d-core/src/uv/` | UV unwrapping not exposed by current browser API. |
| `crates/forge3d-core/src/vector/` | Vector/style rendering is outside current browser MVP API. |
| `crates/forge3d-core/src/viewer/` | Native viewer, stdin, TCP IPC, window/event-loop behavior. Explicitly not browser-safe. |

### Legacy CI, Hooks, And Automation

| Path | Why it can go |
|---|---|
| `.github/workflows/ci.yml` | Python wheels, pytest, native examples, Sphinx docs, and legacy cargo feature matrix. Replace with browser-only CI plus optional focused Rust checks. |
| `.github/workflows/docs.yml` | Sphinx/Python docs job triggered by Python paths. |
| `.github/workflows/publish.yml` | PyPI wheel/sdist publishing workflow. |
| `.github/workflows/public-funnel-monitor.yml` | PyPI/docs/dataset/public funnel monitor for old product. |
| `.cargo/config.toml` | Alias references old feature names such as `extension-module`, `weighted-oit`, `enable-pbr`, and other removed surfaces. Remove or rewrite for web/core checks. |
| `.pre-commit-config.yaml` | Only calls the stale `cargo forge3d-clippy` alias. Remove or rewrite after `.cargo/config.toml` cleanup. |
| `bench/` | Native wgpu upload benchmark with filesystem report output and non-browser runtime assumptions. |
| `.superpowers/` | Local superpowers runtime state, not browser source or documentation. |

### Old Examples, Assets, And Generated Outputs

| Path | Why it can go |
|---|---|
| `examples/` | Top-level Python/notebook/native examples. Browser examples live under `crates/forge3d-web/examples`. |
| `assets/colormaps/` | Legacy PNG colormap assets not used by current web runtime. |
| `assets/fonts/` | Label font atlas. Labels are not in browser MVP. |
| `assets/frames.mp4` | Generated/demo media, not source for web package. |
| `assets/fuji_labels.png` | Legacy gallery/example asset. |
| `assets/geojson/` | Building/vector fixtures for old Python/native workflows. |
| `assets/gpkg/` | GIS package fixtures for old examples/tests. |
| `assets/lidar/` | LAZ fixture for COPC/native/Python tests. COPC/LAZ is excluded. |
| `assets/objects/` | OBJ fixtures for native/offline/path-tracing examples. |
| `output/` | Tracked generated SVG outputs from old vector/export workflows. |

### Root Scripts For Old Product Workflows

All current root scripts are outside the browser package build/test path and can
be removed under browser-only policy:

| Path | Why it can go |
|---|---|
| `scripts/check_public_funnel.py` | Old public funnel/PyPI/dataset monitor. |
| `scripts/compare_images.py` | Python image comparison helper for old golden tests. |
| `scripts/detail_normals.py` | Python/native terrain image utility. |
| `scripts/gen_gallery_images.py` | Old gallery generator. |
| `scripts/generate_audit_snapshot.py` | Old product audit snapshot generator. |
| `scripts/generate_license_keypair.py` | Python/native license tooling. |
| `scripts/histogram_match.py` | Python image utility. |
| `scripts/install_compatible_wheel.py` | Python wheel install helper. |
| `scripts/regenerate_gallery.py` | Old docs/gallery generator. |
| `scripts/sign_license_key.py` | Python/native license tooling. |
| `scripts/style_match_eval.py` | Python style evaluation utility. |
| `scripts/terrain_ci_probe.py` | Native/Python terrain backend probe. |
| `scripts/terrain_validation.py` | Python terrain validation utility. |
| `scripts/transcribe_feedback.py` | Not referenced by browser migration objectives. |
| `scripts/validate_gore_strict.py` | Python/native terrain validation utility. |
| `scripts/validate_terrain.py` | Python/native terrain validation utility. |

### Old Docs And Specs

Keep the current browser migration docs under `docs/superpowers` until they are
rewritten. The rest below is not needed for browser/npm/WASM functionality.

| Path | Why it can go |
|---|---|
| `docs/api/` | Python/native API reference. |
| `docs/assets/` | Sphinx/gallery assets for old docs. |
| `docs/conf.py` | Sphinx config for old documentation site. |
| `docs/examples/` | Old Python/offline example docs. |
| `docs/gallery/` | Old Python/native gallery pages and images. |
| `docs/guides/` | Support matrices and workflows for Python/offline/native features. |
| `docs/index.rst` | Sphinx root. |
| `docs/Makefile` | Sphinx build wrapper. |
| `docs/start/` | Old quickstart/architecture docs aimed at Python package. |
| `docs/terrain/offline-render-quality.md` | Offline/native documentation. |
| `docs/tutorials/` | Python/GIS tutorial tracks and generated images. |
| `docs/viewer/` | Native viewer docs. |
| `docs/superpowers/plans/2026-04-25-khumbu-sentinel-timelapse-implementation.md` | Historical non-browser plan. |
| `docs/superpowers/plans/2026-05-05-khumbu-smooth-orbit-light-render-implementation.md` | Historical non-browser plan. |
| `docs/superpowers/plans/3d-map-rendering-gaps-assessment.md` | Python/native product gap analysis. |
| `docs/superpowers/specs/2026-04-25-khumbu-sentinel-timelapse-design.md` | Historical non-browser spec. |
| `docs/superpowers/specs/2026-05-05-khumbu-smooth-orbit-light-render-design.md` | Historical non-browser spec. |
| `specs/001-diagnostics-support-matrices/` | Product diagnostics spec targeting `python/forge3d`, root `tests`, and native viewer IPC. |

## Generated Or Local Artifacts Safe To Delete

These are not source-of-truth repository artifacts. They can be deleted locally
and regenerated by the documented build/test commands.

| Path | Why it can go |
|---|---|
| `target/` | Cargo build output. |
| `dist/` | Python/native wheel output at repo root. Browser package dist lives under `crates/forge3d-web/dist` and is generated. |
| `dist-test/` | Local test distribution output. |
| `__pycache__/` | Python bytecode cache. |
| `.pytest_cache/` | Pytest cache. |
| `.benchmarks/` | Benchmark output/cache. |
| `crates/forge3d-web/node_modules/` | npm install output; regenerate with `npm ci`. |
| `crates/forge3d-web/pkg/` | wasm-pack generated bridge/wasm output; regenerate with `npm run build:wasm`. |
| `crates/forge3d-web/dist/` | Generated npm package output; regenerate with `npm run build`. |
| `crates/forge3d-web/test-results/` | Playwright output. |
| `crates/forge3d-web/examples/vite/node_modules/` | Example dependency install output. |
| `crates/forge3d-web/examples/vite/dist/` | Example Vite build output. |

## Logs And Evidence: Conditional Cleanup

Logs are not needed for browser runtime functionality, but the migration goals
spec points at many `logs/phase*` files as verification evidence. Removing them
without updating the spec weakens the evidence ledger.

Safe to remove after evidence is either folded into docs or declared no longer
needed:

| Path | Why it can go |
|---|---|
| `logs/.182960f248127da62fe1706c21063519a9773e84-audit.json` | Old generated audit snapshot. |
| `logs/.3c2cf94182465f0d10df58878528dd39234a1134-audit.json` | Old generated audit snapshot. |
| `logs/.9a9fb3a1aee4abd4cecd121a192f7ef77e352837-audit.json` | Old generated audit snapshot. |
| `logs/.f1bf37787b2c7ace8dcb1b483bab133f658b3b7d-audit.json` | Old generated audit snapshot. |
| `logs/buildings_gallery_obj.*` | Generated gallery OBJ/MTL assets. |
| `logs/buildings_true3d.*` | Generated gallery OBJ/MTL assets. |
| `logs/ci-job-*.html` | Old captured CI pages. |
| `logs/gallery-regen-20260315/` | Old gallery regeneration output. |
| `logs/mcp-puppeteer-*.log.gz` | Old local automation logs. |
| `logs/publish-job-*.html` | Old publish job capture. |
| `logs/phase15-*` | Python/native restoration evidence. Not needed under browser-only policy. |
| `logs/phase16-python-check.txt`, `logs/phase16-maturin-build.txt`, `logs/phase16-install-wheel.txt`, `logs/phase16-pytest.txt`, `logs/phase16-native-viewer-check.txt` | Python/native gates embedded in Phase 16 evidence. Remove after browser-only release checklist rewrite. |
| `logs/phase5-python-check.txt`, `logs/phase7-python-check.txt`, `logs/phase7-native-viewer-check.txt` | Compatibility checks for Python/native surfaces outside browser-only policy. |

Keep browser/core evidence logs if retaining the current migration ledger
unchanged, especially `logs/phase1-*`, `logs/phase4-*`, `logs/phase5-core-*`,
`logs/phase6-*`, `logs/phase7-web-*`, `logs/phase8-*`, `logs/phase9-*`,
`logs/phase10-*`, `logs/phase11-*`, `logs/phase12-*`, `logs/phase13-*`,
`logs/phase14-*`, and browser/core/package parts of `logs/phase16-*`.

## Manifest And Contract Cleanup Required After Removals

These are not deletion candidates themselves, but the repo will not honestly be
browser-only until they are updated.

| File | Required cleanup |
|---|---|
| `Cargo.toml` | Remove workspace members `crates/forge3d-python` and `crates/forge3d-native-viewer`. Remove workspace dependencies only used by deleted surfaces, including `pyo3`, `numpy`, `winit`, `proj`, `ed25519-dalek`, `las`, `laz`, `tiff`, `exr`, `reqwest`, and likely `tokio`, `ndarray`, `rstar`, `ttf-parser`, `lyon_*`, `half`, `env_logger`, `flate2`, and `sha2` unless a kept browser/core module still uses them. |
| `crates/forge3d-core/Cargo.toml` | Remove native/offline features such as `native-io`, `copc`, `copc_laz`, `gltf`, `images`, and `enable-gpu-instancing` if those modules are deleted. Remove `pollster` dev-dependency after the `io::source` tests stop using `pollster::block_on`. |
| `crates/forge3d-web/Cargo.toml` | Keep; it already has browser-only dependencies. Recheck after core dependency cleanup. |
| `Cargo.lock` | Regenerate after manifest cleanup. |
| `crates/forge3d-web/docs/release-checklist.md` | Remove Python/native compatibility gates if this repo is browser-only. |
| `crates/forge3d-web/tests/api/release-hardening.mjs` | Stop asserting that the release checklist contains the maturin/Python gate. |
| `docs/superpowers/specs/2026-06-05-forge3d-browser-webgpu-wasm-migration-goals.md` | Revise Phase 15 and Phase 16 evidence expectations or mark Python/native restoration as historical/out-of-repo. |
| `docs/superpowers/plans/2026-06-04-forge3d-browser-webgpu-wasm-runtime.md` | Revise architecture text that still describes Python/native as in-repo deliverables. |
| `README.md` | Replace Python-first root README with browser/npm/WASM repo README, or delete only if the repo intentionally relies on `crates/forge3d-web/README.md`. |
| `CONTRIBUTING.md` | Rewrite setup around Rust wasm target, npm, wasm-pack, TypeScript, and Playwright. |
| `CHANGELOG.md` | Currently read by `crates/forge3d-web/tests/api/release-hardening.mjs`; keep until the test is updated. Then rewrite/archive old Python history if desired. |
| `SECURITY.md` | Keep unless project policy says otherwise. It is not browser-hostile from the file name or current evidence. |
| `AGENTS.md` | Keep or rewrite. It contains useful local migration lessons, but many are Python/PyO3-specific. |

## Items I Would Not Remove Yet

These may look removable, but deleting them now would either break current
browser verification or remove the active audit trail.

| Path | Reason to keep for now |
|---|---|
| `crates/forge3d-web/**` tracked files | All tracked files under this crate are part of the current browser package source, docs, tests, examples, or release contracts. |
| `crates/forge3d-core/src/gpu/**` | Used by `crates/forge3d-web/src/runtime.rs`. |
| `crates/forge3d-core/src/camera/mod.rs` | Used by browser camera API. |
| `crates/forge3d-core/src/terrain.rs` | Used by browser terrain heightmap API. Do not confuse this with removable `crates/forge3d-core/src/terrain/`. |
| `crates/forge3d-core/src/readback/mod.rs` | Used by browser screenshot/readback API. |
| `crates/forge3d-core/src/io/mod.rs`, `crates/forge3d-core/src/io/source.rs` | Used by browser URL/File/Blob/ArrayBuffer terrain source path. |
| `.github/workflows/web.yml` | Browser CI gate. |
| `Cargo.lock` | Keep, but regenerate after dependency/member cleanup. |
| `crates/forge3d-web/package-lock.json` | Required for reproducible npm CI. |
| `CHANGELOG.md` | Currently test-coupled by release-hardening contract. Rewrite before deletion. |
| Current browser migration docs under `docs/superpowers` | Active objective/evidence trail. Revise rather than delete until a new browser-only spec replaces them. |

## Recommended Removal Order

1. Make the policy explicit in docs: Phase 15 Python/native restoration is
   historical or out-of-repo, not an objective for `forge3d-web`.
2. Update `crates/forge3d-web/docs/release-checklist.md` and
   `crates/forge3d-web/tests/api/release-hardening.mjs` to remove Python/native
   release gates.
3. Remove `crates/forge3d-python/`, `crates/forge3d-native-viewer/`, `python/`,
   Python packaging files, root `tests/`, top-level `examples/`, `cmake/`,
   legacy workflows, and old root scripts.
4. Remove top-level `src/`.
5. Remove inactive staged directories under `crates/forge3d-core/src`, keeping
   only `lib.rs`, `error.rs`, `feature_gates.rs`, `gpu/`, `camera/`, `terrain.rs`,
   `readback/`, and `io/`.
6. Simplify `Cargo.toml`, `crates/forge3d-core/Cargo.toml`, `.cargo/config.toml`,
   and `.pre-commit-config.yaml`; regenerate `Cargo.lock`.
7. Run browser-only verification:

```powershell
cargo check -p forge3d-core --target wasm32-unknown-unknown --no-default-features
cargo check -p forge3d-web --target wasm32-unknown-unknown
cd crates\forge3d-web
npm ci
npm run typecheck
npm run build
npm run test:api
npm run test:package
npm run test:browser
npm pack --dry-run
```

## Bottom Line

For a browser/npm/WASM-only repo, the largest safe removals are the Python
package/build/test surface, the native viewer, the inactive top-level `src/`
tree, most copied legacy staging under `crates/forge3d-core/src`, old
Python/native docs/examples/assets, and legacy CI. The active browser package is
now under `crates/forge3d-web`, and the only core source that must survive for
the current MVP is the narrow browser-safe core surface listed above.
