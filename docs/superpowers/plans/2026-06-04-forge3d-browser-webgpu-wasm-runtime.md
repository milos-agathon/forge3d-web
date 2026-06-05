# Forge3D Browser WebGPU/WASM Runtime Plan

> Revised 2026-06-05 after the browser-only cleanup.

## Goal

Maintain `forge3d-web` as a browser/npm/WASM-only repository centered on the
`@forge3d/web` package and its browser-safe Rust support crate.

## Active Architecture

- `forge3d-core`: Rust support crate for browser-safe error mapping, async GPU
  context ownership, camera validation, terrain heightmap validation/mesh
  descriptors, readback layout helpers, and byte-source IO contracts.
- `forge3d-web`: wasm-bindgen runtime, canvas-backed WebGPU presentation,
  browser URL/File/Blob/ArrayBuffer terrain IO, stable TypeScript facade,
  package metadata/docs, Vite example, API/package contracts, and Playwright
  browser tests.
- `.github/workflows/web.yml`: CI gate for wasm checks, npm install, package
  build, typecheck, WebGPU diagnostics, and browser render tests.

Python/PyO3, maturin, native desktop viewers, stdin/TCP IPC, CMake integration,
root Python tests, legacy examples, and legacy top-level Rust source are not
active deliverables in this repository.

## Active Tree

```text
Cargo.toml
Cargo.lock
crates/
  forge3d-core/
    Cargo.toml
    src/
      lib.rs
      error.rs
      feature_gates.rs
      gpu/
      io/
      camera/
      readback/
      terrain.rs
  forge3d-web/
    Cargo.toml
    package.json
    package-lock.json
    tsconfig.json
    tsconfig.api.json
    vite.config.ts
    scripts/prepare-dist.mjs
    src/
    src-ts/index.ts
    types/index.d.ts
    docs/
    examples/
    tests/
.github/workflows/web.yml
docs/superpowers/
```

## Dependency Ownership

| Dependency family | Owner | Notes |
|---|---|---|
| `wgpu`, `bytemuck`, `glam`, `async-trait`, `thiserror` | Core/web as needed | Browser-safe Rust runtime and data contracts. |
| `wasm-bindgen`, `wasm-bindgen-futures`, `web-sys`, `js-sys`, `serde`, `serde_json`, `serde-wasm-bindgen` | `forge3d-web` | JS/WASM/browser boundary. |
| PyO3, NumPy, maturin, winit, pollster, native IO/codec stacks | None | Removed from active manifests unless a future spec explicitly reintroduces them out of browser scope. |

## MVP Scope

Included:

- `Forge3DRuntime.create(canvas, options)`.
- Browser WebGPU adapter/device/surface initialization.
- Canvas-backed clear and terrain rendering.
- DPR-aware resize and camera API.
- Float32 terrain heightmap upload.
- URL/File/Blob/ArrayBuffer terrain byte sources.
- Async PNG screenshot.
- Stable TypeScript declarations and ESM npm packaging.
- Vite package-consumer example.
- Playwright browser render, screenshot, source, resize, and diagnostics tests.

Excluded:

- Python package compatibility and wheel builds.
- Native viewer and desktop IPC.
- COPC/EPT/LAZ streaming.
- 3D Tiles, COG/raster streaming, Mapbox Style parity, WebGL fallback, and
  native/offscreen rendering features.

## Release Checklist

Run from repository root unless noted:

```powershell
cargo fmt --all -- --check
cargo check -p forge3d-core --target wasm32-unknown-unknown --no-default-features
cargo check -p forge3d-web --target wasm32-unknown-unknown
cargo test -p forge3d-core
cargo test -p forge3d-web
cargo clippy -p forge3d-core --target wasm32-unknown-unknown --no-default-features -- -D warnings
cargo clippy -p forge3d-web --target wasm32-unknown-unknown -- -D warnings
cd crates\forge3d-web
npm ci
npm run typecheck
npm run build
npm run test:api
npm run test:package
npm run test:browser
npm pack --dry-run
```

After local verification, generated outputs may be deleted again:

- `target/`
- `crates/forge3d-web/node_modules/`
- `crates/forge3d-web/pkg/`
- `crates/forge3d-web/dist/`
- `crates/forge3d-web/test-results/`
- `crates/forge3d-web/examples/vite/node_modules/`
- `crates/forge3d-web/examples/vite/dist/`

## Current Cleanup Contract

The removal set is governed by
`docs/superpowers/audits/2026-06-05-forge3d-web-browser-only-removal-candidates.md`.
The “Must Keep” section in that audit is authoritative for preserved browser
package/core files. The manifest and contract files are rewritten rather than
deleted so the repository remains internally consistent after removals.
