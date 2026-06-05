# Forge3D Browser WebGPU/WASM Migration Goals Spec

Source audit: `docs/superpowers/audits/2026-06-05-forge3d-web-browser-only-removal-candidates.md`

Created: 2026-06-05
Revised: 2026-06-05 after browser-only cleanup

## Purpose

This spec records the active browser/npm/WASM objective for this repository. The
repo now preserves only the browser package, the browser-safe Rust core support
crate, browser CI, package docs, browser examples, package/API contracts, and the
current migration evidence trail.

## Browser-Only Policy

Active workspace members:

- `crates/forge3d-core`
- `crates/forge3d-web`

Removed or out of scope for this repository:

- Python package source, PyO3 bindings, maturin configuration, Python wheels,
  root Python tests, and Python compatibility gates.
- Native viewer crates, desktop window/event-loop code, stdin/TCP IPC, CMake
  integration, native examples, and native release gates.
- Legacy top-level Rust source, staged non-MVP core feature directories, legacy
  docs/assets/examples/scripts, and generated local build artifacts.

## Global Invariants

- Do not reintroduce PyO3 or NumPy into `forge3d-core`.
- Do not reintroduce `winit`, stdin, TCP IPC, native filesystem-only public APIs,
  or blocking browser runtime behavior into `forge3d-web`.
- Keep `@forge3d/web` as an ESM npm package with hand-authored TypeScript
  declarations and a generated wasm asset.
- Preserve browser WebGPU rendering through an `HTMLCanvasElement`.
- Keep browser verification centered on wasm checks, TypeScript checks, package
  contracts, npm dry-run packaging, and Playwright WebGPU tests.

## Active Scope

| Area | Required artifacts |
|---|---|
| Core | `crates/forge3d-core/Cargo.toml`, `src/lib.rs`, `error.rs`, `feature_gates.rs`, `gpu/**`, `camera/mod.rs`, `terrain.rs`, `readback/mod.rs`, `io/**` |
| Web package | `crates/forge3d-web/Cargo.toml`, `src/**`, `src-ts/index.ts`, `types/index.d.ts`, `package.json`, `package-lock.json`, `README.md`, `docs/**`, `examples/**`, `tests/**`, `playwright.config.ts`, `tsconfig*.json`, `vite.config.ts`, `scripts/prepare-dist.mjs` |
| CI | `.github/workflows/web.yml` |
| Repo docs | `README.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `SECURITY.md`, `AGENTS.md`, current browser migration plan/spec/audits under `docs/superpowers` |
| Packaging hygiene | `Cargo.toml`, `Cargo.lock`, root licenses, `.gitattributes`, `.gitignore` |

## Historical Phases

Phases 1 through 14 remain useful historical evidence for how the browser MVP was
split, built, packaged, and tested. Phase 15 native/Python compatibility
restoration is now historical and out of repo. Phase 16 release hardening is
browser-only.

## Current Acceptance Criteria

- Root `Cargo.toml` has only the active browser/core workspace members.
- `Cargo.lock` is regenerated for the reduced workspace.
- `crates/forge3d-core/Cargo.toml` contains only browser/core dependencies and
  the `gpu`/`webgpu` feature pair.
- `crates/forge3d-web/docs/release-checklist.md` contains no Python/native gates.
- `crates/forge3d-web/tests/api/release-hardening.mjs` rejects Python/native
  release gates.
- Root README and CONTRIBUTING describe browser/npm/WASM development.
- Removed paths from the 2026-06-05 cleanup audit remain absent.

## Verification Commands

```powershell
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

Generated artifacts from those commands (`target/`, `node_modules/`, `pkg/`,
`dist/`, Vite `dist/`, and Playwright `test-results/`) are local outputs and are
not source-of-truth repository artifacts.
